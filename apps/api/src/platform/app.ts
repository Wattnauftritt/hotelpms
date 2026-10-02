import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import { createPool, type Pool } from '@hotelpms/db'
import { loadConfig, type Config } from './config.js'
import { renderMessage } from '@hotelpms/contracts'
import { AppError, Errors } from './errors.js'
import { ANONYMOUS, type Principal } from './context.js'
import { loadPrincipal, applySupportSession, loadPrincipalFromToken } from './auth.js'
import { registerRateLimit } from './rateLimit.js'

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal
    pool: Pool
    /** Roher Rumpf vor dem Parsen. Der Stripe-Webhook braucht genau diese
     *  Bytes fuer die Signaturpruefung; ein neu serialisiertes JSON waere
     *  nicht mehr dieselbe Zeichenkette. */
    rawBody: Buffer
    /**
     * Was diese Anfrage die Datenbank gekostet hat.
     *
     * Steht am Ende in der Protokollzeile. Eine Antwort in 300 ms sah
     * vorher gleich aus, ob sie aus einer Abfrage kam oder aus
     * vierhundert -- und ein N+1 faellt im Betrieb an nichts anderem auf
     * (Befund P9, Dokument 29).
     */
    dbKosten: { anweisungen: number; dauerMs: number }
  }
}

/**
 * Ab wann eine Anfrage als auffaellig gilt.
 *
 * Fuenfzig, weil die Endpunkte Aggregate sind: ein Bildschirm ist ein
 * Aufruf, und der kommt mit einer Handvoll Anweisungen aus. Wer fuenfzig
 * ueberschreitet, laedt je Zeile nach -- oder hat einen Grund, den er
 * aufschreiben sollte. Die Zahl ist einstellbar, damit sie beim naechsten
 * Stapelendpunkt nicht zu einer Zeile Rauschen je Aufruf wird.
 */
const ANWEISUNGEN_WARNUNG = Number(process.env.DB_QUERY_WARN ?? 50)

export interface Server {
  app: FastifyInstance
  pool: Pool
  config: Config
}

export async function buildServer(
  overrides: { pool?: Pool; logStream?: NodeJS.WritableStream } = {}
): Promise<Server> {
  const config = loadConfig()
  /*
   * Die Poolgroesse aus der Umgebung, mit zehn als Vorgabe (Befund P5,
   * Dokument 29).
   *
   * Zehn ist nicht gegriffen und auch keine Obergrenze des Systems: Node
   * arbeitet in einem Faden, und mehr gleichzeitige Verbindungen als
   * PostgreSQL Kerne hat, machen eine Datenbank langsamer, nicht
   * schneller. Die Zahl gehoert trotzdem an die Maschine und nicht in den
   * Quelltext -- ein Haus mit 250 Zimmern und drei Arbeitsplaetzen hat
   * eine andere Gleichzeitigkeit als eine Pension mit zwoelf.
   */
  const pool = overrides.pool ?? createPool({
    kind: 'app', max: Number(process.env.DB_POOL_MAX ?? 10),
    applicationName: 'hotelpms-api'
  })

  /*
   * Ein Protokollziel, das der Aufrufer vorgibt. Nur ein Test setzt es, und
   * er braucht es: dass in der Adresszeile kein Gastname landet, zeigt sich
   * nur am **geschriebenen** Protokoll. Der Serialisierer allein laesst sich
   * pruefen, ohne dass bewiesen ist, dass pino ihn auch benutzt -- und genau
   * dort lag der Befund, denn die Redaktionsliste war vollstaendig und die
   * Regel trotzdem gebrochen (Befund B2, Dokument 25; Befund 3, Dokument 26).
   *
   * Die Stufe steht dabei fest auf `info`: mit `silent` aus der Umgebung
   * schriebe pino nichts, und der Test pruefte eine leere Senke gegen sich
   * selbst.
   */
  const logOptions = {
    level: overrides.logStream === undefined ? config.logLevel : 'info',
    // Gaestedaten gehoeren nicht ins Protokoll (C8, Dokument 13).
    redact: {
      // Der Link des Online-Check-ins reist in einer Kopfzeile (Dokument
      // 30). Der Serialisierer unten schreibt Kopfzeilen gar nicht mit; sie
      // steht trotzdem hier, falls ihn jemand erweitert.
      paths: ['req.headers.authorization', 'req.headers.cookie',
              'req.headers["x-staygrid-checkin-token"]',
              'req.body', 'res.body', '*.password', '*.idDocumentNumber'],
      remove: true
    },
    /*
     * Die Adresszeile traegt Gastdaten, und `redact` erreicht sie nicht.
     *
     * `GET /v1/guests?q=Petersen` schrieb den Nachnamen eines Gastes ins
     * Protokoll -- gegen die eigene Regel, und die Anonymisierung
     * erreicht ihn dort nicht mehr. Die Redaktionsliste deckt Kopfzeilen
     * und Ruempfe ab; die URL ist keines von beiden, sondern ein Feld,
     * das Fastify selbst erzeugt.
     *
     * Die Namen der Parameter bleiben stehen, nur ihre Werte fallen: an
     * einem Protokoll ist ablesbar, **wonach** gesucht wurde, ohne dass
     * dort steht, **wer** gesucht wurde. Ein Protokoll ohne Pfad waere
     * beim Suchen eines Fehlers wertlos.
     */
    serializers: {
      req (req: { method: string; url: string; id: string }) {
        const schnitt = req.url.indexOf('?')
        const url = schnitt < 0 ? req.url
          : req.url.slice(0, schnitt) + '?' + [...new URLSearchParams(
              req.url.slice(schnitt + 1)).keys()]
              .map(k => `${k}=[redigiert]`).join('&')
        return { id: req.id, method: req.method, url }
      }
    },
    ...(overrides.logStream === undefined ? {} : { stream: overrides.logStream })
  }

  const app = Fastify({
    logger: config.logLevel === 'silent' && overrides.logStream === undefined
      ? false
      : logOptions,
    genReqId: () => crypto.randomUUID(),
    /*
     * **Genau ein Proxy, nicht alle** (Befund S4).
     *
     * Hier stand `true`, und das heisst in `proxy-addr`: jede Adresse in
     * `X-Forwarded-For` ist vertrauenswuerdig, also gilt die **erste** --
     * und die erste ist die, die der Aufrufer selbst mitgeschickt hat.
     * Caddy haengt seine an, es ersetzt sie nicht. Eine Anmeldung mit
     * `X-Forwarded-For: 203.0.113.<zufall>` kam damit bei jedem Versuch
     * aus einer anderen Herkunft, und die Begrenzung je Herkunft war ein
     * Zaehler, der nie zweimal dieselbe Zahl sah. Das brauchte keinen
     * Zugang zum Rechner und keine falsche Konfiguration -- es ging durch
     * den regulaeren Weg ueber Caddy.
     *
     * Vertraut wird jetzt genau ein Sprung: nur der unmittelbare Nachbar
     * (Sprung 0, also Caddy selbst), und `proxy-addr` nimmt damit den
     * Eintrag, den Caddy gesetzt hat. Als Funktion und nicht als `1`, weil
     * Fastifys Typen die Zahl nicht annehmen -- gemeint ist dasselbe.
     *
     * Die zweite Haelfte steht im Caddyfile: es ueberschreibt die Kopfzeile
     * jetzt, statt sie zu ergaenzen. Zusammen bleibt von einer
     * mitgeschickten Kette nichts uebrig.
     */
    trustProxy: (_adresse: string, sprung: number) => sprung === 0,
    bodyLimit: 1_048_576
  })

  await app.register(cookie, { secret: config.sessionSecret })

  // decorateRequest mit einem Wert teilt ihn zwischen Anfragen. Wir setzen
  // die Felder im onRequest-Hook, deklariert wird hier nur der Platz.
  app.decorateRequest('principal')
  app.decorateRequest('pool')
  app.decorateRequest('rawBody')

  // Ersetzt den eingebauten JSON-Parser nur soweit, dass der rohe Rumpf
  // zusaetzlich erhalten bleibt. Ohne das koennte kein Aufrufer, der eine
  // Signatur ueber den Rumpf prueft (Stripe-Webhook), das je nachweisen:
  // ein erneut serialisiertes JSON ist nicht mehr byteidentisch mit dem
  // signierten Original.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      req.rawBody = body
      if (body.length === 0) { done(null, undefined); return }
      try {
        done(null, JSON.parse(body.toString('utf8')))
      } catch (err) {
        done(err as Error, undefined)
      }
    })

  /*
   * Der Tokenendpunkt nimmt formularkodierte Daten entgegen, nicht JSON.
   * RFC 6749 schreibt das so vor, und jede fremde OAuth-Bibliothek sendet
   * entsprechend; JSON zu verlangen machte aus jedem Standardclient einen
   * Sonderfall. Kein zusaetzliches Paket noetig, URLSearchParams genuegt.
   */
  app.addContentTypeParser('application/x-www-form-urlencoded',
    { parseAs: 'string' }, (_req, body: string, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body)))
      } catch (err) {
        done(err as Error, undefined)
      }
    })

  app.addHook('onRequest', async (req) => {
    req.pool = pool
    req.principal = ANONYMOUS
    req.dbKosten = { anweisungen: 0, dauerMs: 0 }
  })

  /*
   * Was die Anfrage die Datenbank gekostet hat, in **ihre** Protokollzeile.
   *
   * Nicht als eigene Zeile: zwei Zeilen je Anfrage verdoppeln das Protokoll
   * und muessen beim Lesen wieder zusammengesucht werden. Ueber der
   * Schwelle eine Warnung, darunter nichts -- im Normalfall ist die Zahl
   * uninteressant, und ein Protokoll, in dem alles steht, liest niemand.
   */
  app.addHook('onResponse', async (req, reply) => {
    const k = req.dbKosten
    if (k.anweisungen < ANWEISUNGEN_WARNUNG) return
    req.log.warn({
      anweisungen: k.anweisungen, dbMs: Math.round(k.dauerMs),
      antwortMs: Math.round(reply.elapsedTime)
    }, 'Viele Datenbankanweisungen in einer Anfrage')
  })

  // Aufrufer bestimmen. Der Mandantenkontext kommt ausschliesslich von hier.
  app.addHook('preValidation', async (req) => {
    // Maschinen kommen mit einem Bearer-Token, Menschen mit dem Cookie. Das
    // Token zuerst: ein Client schickt kein Cookie, und wer beides schickt,
    // meint das Token.
    const bearer = req.headers.authorization
    if (bearer?.startsWith('Bearer ')) {
      req.principal = await loadPrincipalFromToken(pool, bearer.slice(7))
      return
    }

    const sessionId = req.cookies['hp_session']
    if (!sessionId) return
    const { rows } = await pool.query<{ user_id: number; active_user_id: number | null }>(
      `SELECT user_id, active_user_id FROM user_session
        WHERE id = $1 AND revoked_at IS NULL
          AND expires_at > now() AND absolute_expires_at > now()`, [sessionId])
    if (rows.length === 0) return
    const row = rows[0]!
    // Arbeitsplatz-PIN wechselt die handelnde Person, ohne Neuanmeldung.
    const effectiveUser = row.active_user_id ?? row.user_id
    let principal = await loadPrincipal(pool, effectiveUser)
    principal = await applySupportSession(pool, principal)
    // Wer sich angemeldet hat, bleibt bekannt, auch wenn gerade jemand
    // anderes handelt: die Oberflaeche zeigt den Wechsel damit an.
    principal = { ...principal, sessionUserId: row.user_id }
    req.principal = principal
    await pool.query(`UPDATE user_session SET last_seen_at = now() WHERE id = $1`, [sessionId])
  })

  // Erst jetzt, nicht vorher: ausnehmen laesst sich nur, wer sich
  // tatsaechlich ausgewiesen hat, und das steht erst hier fest.
  registerRateLimit(app)

  app.setErrorHandler((err, req, reply) => {
    const instance = `urn:request:${req.id}`
    if (err instanceof AppError) {
      return reply.status(err.status).type('application/problem+json')
        .send(err.toProblem(instance))
    }
    const maybe = err as { validation?: unknown; message?: string }
    if (maybe.validation) {
      return reply.status(422).type('application/problem+json')
        .send(Errors.validation({ body: [maybe.message ?? 'field.invalid'] })
          .toProblem(instance))
    }
    req.log.error({ err }, 'Unbehandelter Fehler')
    // In Produktion keine Stapelspur, nur die Anfrage-ID fuer den Support.
    return reply.status(500).type('application/problem+json').send({
      type: 'urn:staygrid:internal', title: renderMessage('error.internal', 'de'),
      code: 'error.internal', status: 500,
      detail: config.nodeEnv === 'production' ? undefined : (err as Error).message,
      instance
    })
  })

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).type('application/problem+json')
      .send(Errors.notFound().toProblem(`urn:request:${req.id}`))
  })

  return { app, pool, config }
}
