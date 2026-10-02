import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from './errors.js'

/**
 * Ratenbegrenzung für unangemeldete Anfragen (C7, Dokument 12).
 *
 * **Was hier fehlte.** Die Anmeldung sperrt ein Konto nach zehn Fehlversuchen.
 * Das hilft gegen den Angreifer, der ein Kennwort rät, aber nicht gegen den,
 * der ein bekanntes Kennwort gegen **viele** Adressen probiert: jede Adresse
 * bleibt unter ihrer eigenen Grenze, und die Sperre greift nie. Dagegen hilft
 * nur eine Grenze je Herkunft.
 *
 * **Was diese Umsetzung leistet und was nicht.** Der Zähler liegt im
 * Arbeitsspeicher des Prozesses. Bei drei API-Prozessen ist die wirksame
 * Grenze also dreimal so hoch, und ein Neustart setzt sie zurück. Das ist
 * bewusst so: eine geteilte Grenze bräuchte Redis oder eine Schreiboperation
 * je Anfrage, und beides wäre für den Zweck zu teuer.
 *
 * Sie ist damit die **zweite** Linie, nicht die erste. Die erste gehört an
 * den Rand, also in Caddy, wo sie vor der Anwendung greift und über alle
 * Prozesse hinweg gilt. Diese hier fängt ab, was den Rand passiert hat, und
 * sie wirkt auch dann, wenn jemand die Anwendung ohne Caddy betreibt.
 */

interface Fenster {
  /** Zeitpunkt, an dem das aktuelle Fenster begann. */
  begonnen: number
  anzahl: number
}

export interface RateLimitOptions {
  /** Erlaubte Anfragen je Fenster. */
  limit: number
  /** Länge des Fensters in Millisekunden. */
  windowMs: number
  /** Obergrenze der beobachteten Herkünfte. Schützt vor dem Zähler selbst. */
  maxKeys?: number
}

export class RateLimiter {
  private readonly fenster = new Map<string, Fenster>()

  constructor(private readonly opts: RateLimitOptions) {}

  /**
   * Gibt zurück, wie viele Anfragen noch frei sind, oder null bei
   * Überschreitung. Ein festes Fenster, kein gleitendes: der Unterschied ist
   * ein kurzer Ausschlag an der Fenstergrenze, und der ist den geringeren
   * Aufwand wert.
   */
  check(key: string, now = Date.now()): number | null {
    const f = this.fenster.get(key)
    if (f === undefined || now - f.begonnen >= this.opts.windowMs) {
      this.aufraeumen(now)
      this.fenster.set(key, { begonnen: now, anzahl: 1 })
      return this.opts.limit - 1
    }
    if (f.anzahl >= this.opts.limit) return null
    f.anzahl++
    return this.opts.limit - f.anzahl
  }

  /**
   * Abgelaufene Einträge entfernen.
   *
   * Ohne das wächst die Karte mit jeder je gesehenen Adresse, und ein
   * Angreifer mit vielen Adressen bräuchte gar keine Anfragen zu senden, um
   * Schaden anzurichten: er füllte den Speicher. Die harte Obergrenze ist
   * die zweite Absicherung dagegen.
   */
  private aufraeumen(now: number): void {
    const max = this.opts.maxKeys ?? 10_000
    if (this.fenster.size < max) {
      if (this.fenster.size % 256 !== 0) return
    }
    for (const [k, v] of this.fenster) {
      if (now - v.begonnen >= this.opts.windowMs) this.fenster.delete(k)
    }
    // Immer noch zu voll: die ältesten Einträge fallen. Map bewahrt die
    // Einfügereihenfolge, die ersten sind damit die ältesten.
    if (this.fenster.size >= max) {
      let zuViel = this.fenster.size - Math.floor(max / 2)
      for (const k of this.fenster.keys()) {
        if (zuViel-- <= 0) break
        this.fenster.delete(k)
      }
    }
  }

  /**
   * Ist die Grenze fuer diesen Schluessel gerade erreicht -- ohne zu zaehlen?
   *
   * Fuer Zaehler, die nur **Fehlversuche** zaehlen (die Kopplung eines
   * Gaesteterminals): vor dem Versuch wird gefragt, gezaehlt wird erst,
   * wenn er scheitert. Ein `check` vorweg zaehlte jeden Versuch mit, auch
   * den richtigen.
   */
  erschoepft(key: string, now = Date.now()): boolean {
    const f = this.fenster.get(key)
    if (f === undefined || now - f.begonnen >= this.opts.windowMs) return false
    return f.anzahl >= this.opts.limit
  }

  /** Nur für Tests. */
  reset(): void { this.fenster.clear() }
  get size(): number { return this.fenster.size }
}

export function tooManyRequests(retryAfterSeconds: number): AppError {
  return new AppError(429, 'urn:staygrid:rate_limited', 'error.rateLimited',
    'error.rateLimited.detail', undefined, { seconds: retryAfterSeconds })
}

/**
 * Zwei Grenzen, weil zwei verschiedene Angriffe abzuwehren sind.
 *
 * **Die Höhe ist eine Abwägung, keine Formel.** Ein Haus hat mehrere
 * Arbeitsplätze hinter **einer** öffentlichen Adresse; beim Schichtwechsel
 * melden sich mehrere gleichzeitig an, und ein vertipptes Kennwort zählt
 * mit. Aus dem eigenen System ausgesperrt zu sein, während Gäste am Tresen
 * stehen, ist ein größerer Schaden als ein langsames Durchprobieren.
 *
 * Zwölf Versuche je Minute machen das Durchprobieren von Kennwörtern
 * aussichtslos — dafür braucht es Tausende — und liegen weit über allem,
 * was ein Betrieb je erreicht.
 */
export const LOGIN_LIMIT: RateLimitOptions = {
  limit: Number(process.env.RATE_LIMIT_LOGIN ?? 60), windowMs: 5 * 60_000
}
export const ANON_LIMIT: RateLimitOptions = {
  limit: Number(process.env.RATE_LIMIT_ANON ?? 300), windowMs: 60_000
}

/**
 * Fehlversuche beim Koppeln eines Gaesteterminals, je Herkunft.
 *
 * **Warum ein eigener Zaehler.** Die allgemeine Grenze greift nur bei
 * anonymen Anfragen. Wer koppelt, ist es meistens -- aber nicht immer: steht
 * im selben Browser noch eine Mitarbeitersitzung, ist die Anfrage
 * angemeldet und an der Grenze vorbei. Genau das ist bei
 * `workstation-switch` passiert (H4, Dokument 25). Gezaehlt werden deshalb
 * die **Fehlversuche** an der Route selbst, gleich wer fragt.
 *
 * **Warum zehn je Viertelstunde genuegen.** Der Code hat acht Zeichen aus
 * einem Alphabet von 30, also rund 6,5 * 10^11 Moeglichkeiten, und lebt zehn
 * Minuten. Wer zehn Versuche je Viertelstunde hat, braucht im Mittel
 * Jahrtausende -- auch mit tausend Adressen noch Jahrzehnte. Im Speicher wie
 * die anderen Zaehler hier: ein Neustart setzt ihn zurueck, und das aendert
 * an dieser Rechnung nichts.
 */
export const KOPPLUNG_FEHLVERSUCHE: RateLimitOptions = {
  limit: Number(process.env.RATE_LIMIT_PAIRING ?? 10), windowMs: 15 * 60_000
}

/**
 * Pfade, die die enge Grenze bekommen.
 *
 * `/oauth/token` gehoert dazu, und zwar aus demselben Grund wie die
 * Anmeldung: dort wird ein Geheimnis geprueft, und ohne Grenze liesse es
 * sich durchprobieren. Ein Client holt sich ein Token je Stunde, nicht je
 * Anfrage; die Grenze trifft ihn nie.
 */
// Die Kennwortruecksetzung gehoert dazu, auch wenn sie nichts prueft: sie
// verschickt eine Mail an eine frei waehlbare Adresse. Unter der lockeren
// Grenze waere sie ein Werkzeug, um ein fremdes Postfach zu fluten -- und
// die Absenderreputation dieses Systems gleich mit.
// Die Kopplung eines Gaesteterminals ebenso: dort wird ein Code geprueft.
// Sie zaehlt ihre Fehlversuche zusaetzlich selbst (`limiters.kopplung`),
// weil eine Anfrage mit gueltiger Sitzung diese Grenze nie erreicht.
const TEURE_PFADE = ['/v1/auth/login', '/v1/auth/workstation-switch',
                     '/v1/auth/password-reset', '/oauth/token',
                     '/v1/terminal/pair']

/**
 * Die aktiven Zaehler. Nach aussen gegeben, damit ein Test sie zuruecksetzen
 * kann: mehrere Testdateien teilen sich eine Serverinstanz und kaemen sonst
 * gemeinsam an die Grenze, ohne dass eine davon sie pruefen wollte.
 */
export const limiters = {
  anmeldung: new RateLimiter(LOGIN_LIMIT),
  allgemein: new RateLimiter(ANON_LIMIT),
  kopplung: new RateLimiter(KOPPLUNG_FEHLVERSUCHE),
  reset(): void { this.anmeldung.reset(); this.allgemein.reset(); this.kopplung.reset() }
}

/** Wurden ueberhaupt Zugangsdaten vorgelegt? Sagt nichts ueber ihre Gueltigkeit. */
function zeigtZugangsdaten(req: FastifyRequest): boolean {
  return req.cookies['hp_session'] !== undefined
      // Ein gekoppeltes Gaesteterminal fragt alle zwei Sekunden, dreissig
      // Mal je Minute, ohne Pause. Als anonym gezaehlt teilte es sich die
      // Grenze mit allem, was aus derselben Herkunft unangemeldet kommt --
      // an einer Rezeption hinter einem Anschluss sind das die
      // Anmeldemasken aller Arbeitsplaetze und jedes weitere Terminal --,
      // und ob es durchkommt, hinge an `RATE_LIMIT_ANON`, einer Zahl, die
      // jemand fuer etwas anderes einstellt. Gezaehlt wird es weiter unten,
      // falls sein Cookie nicht traegt.
      || req.cookies['hp_terminal'] !== undefined
      || req.headers.authorization?.startsWith('Bearer ') === true
}

function pruefe(req: FastifyRequest): void {
  const teuer = TEURE_PFADE.some(p => req.url.startsWith(p))
  const limiter = teuer ? limiters.anmeldung : limiters.allgemein
  const opts = teuer ? LOGIN_LIMIT : ANON_LIMIT

  if (limiter.check(herkunft(req)) === null) {
    throw tooManyRequests(Math.ceil(opts.windowMs / 1000))
  }
}

/**
 * Muss **nach** dem Hook registriert werden, der den Aufrufer bestimmt.
 *
 * **Der Fehler, den diese Aufteilung behebt.** Vorher genuegte das
 * *Vorhandensein* eines Cookies, um die Grenze zu ueberspringen -- der Wert
 * wurde nie angesehen. `hp_session=x` mitzuschicken hob die Begrenzung damit
 * vollstaendig auf, und genau das haette ein Angreifer als Erstes probiert.
 *
 * Ausnehmen laesst sich nur, wer sich tatsaechlich ausgewiesen hat, und das
 * steht erst nach der Aufloesung fest. Deshalb zwei Stellen:
 *
 *   onRequest      wer gar keine Zugangsdaten zeigt, wird sofort gezaehlt --
 *                  ohne eine einzige Datenbankabfrage, wie bisher.
 *   preValidation  wer welche gezeigt hat, wird gezaehlt, falls sie nicht
 *                  getragen haben.
 *
 * Der Preis: eine ungueltige Sitzung kostet eine indizierte Suche, bevor sie
 * an der Grenze scheitert. Das ist der Unterschied zwischen einer Grenze, die
 * sich mit sieben Zeichen umgehen laesst, und einer, die haelt.
 */
export function registerRateLimit(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    if (zeigtZugangsdaten(req)) return
    pruefe(req)
  })

  app.addHook('preValidation', async (req) => {
    if (!zeigtZugangsdaten(req)) return
    /*
     * Angemeldete Anfragen bleiben unbegrenzt: sie sind einer Person oder
     * einem Client zurechenbar, und eine Rezeption, die im Andrang gebremst
     * wird, ist ein Schaden ohne Gegenwert. Missbrauch durch einen
     * angemeldeten Benutzer ist ein Rollenproblem, kein Ratenproblem.
     */
    if (req.principal.clientKey !== 'anonymous') return
    pruefe(req)
  })
}

/**
 * Die Herkunft einer Anfrage.
 *
 * Fastify läuft mit `trustProxy`, `req.ip` ist also die Adresse aus
 * `X-Forwarded-For`, die Caddy setzt. Das ist richtig, solange **nur** Caddy
 * die Anwendung erreicht; der Unix-Socket sorgt genau dafür. Läge die
 * Anwendung auf einem offenen Port, könnte jeder die Kopfzeile fälschen und
 * die Grenze damit umgehen.
 */
function herkunft(req: FastifyRequest): string {
  return req.ip
}
