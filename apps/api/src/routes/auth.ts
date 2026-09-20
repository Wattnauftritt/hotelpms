import { randomBytes } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { loadConfig } from '../platform/config.js'
import { propertyIds, type Principal } from '../platform/context.js'
import { tx } from '../platform/db.js'
import { neuesToken, hashToken, TOKEN_GUELTIGKEIT,
         renderPasswordResetEmail, renderInviteEmail,
         type AuthTokenKind } from '@hotelpms/domain'
import { kennwortZuKurz, KENNWORT_MIN } from '@hotelpms/contracts'
import { isSendableAddress, renderEmailChangeEmail,
         renderEmailChangeNotice, maskEmail } from '@hotelpms/domain'

const config = loadConfig()

/**
 * Anmeldung mit Sitzung im Cookie.
 *
 * **Warum Cookie und nicht ein Token im JavaScript.** Ein Token, das die
 * Oberfläche lesen kann, kann auch ein eingeschleustes Skript lesen. Ein
 * `HttpOnly`-Cookie kann es nicht. Der Preis dafür ist, dass Oberfläche und
 * Schnittstelle unter **einer** Herkunft laufen müssen; genau so ist Caddy
 * eingerichtet.
 *
 * **Zwei Ablaufzeiten.** `expires_at` ist die Untätigkeitsfrist und wandert
 * mit jeder Anfrage mit; `absolute_expires_at` steht fest. Ohne die zweite
 * bleibt eine einmal gestohlene Sitzung unbegrenzt gültig, solange sie
 * benutzt wird.
 */
const SITZUNG_UNTAETIG_STUNDEN = 12
const SITZUNG_ABSOLUT_STUNDEN = 24
const COOKIE = 'hp_session'

/**
 * Zehn Fehlversuche, dann fünfzehn Minuten Sperre — **je Paar aus Konto und
 * Herkunft**, nicht je Konto (H3, Dokument 25).
 *
 * Vorher galt die Sperre dem Konto, und damit war sie selbst eine Waffe: wer
 * die Dienstadresse einer Mitarbeiterin kannte, konnte sie von außen
 * aussperren, ohne je ein Kennwort zu treffen. Die Abwägung dahinter war in
 * ihrer Richtung richtig (ausgesperrt zu sein ist der größere Schaden), nur
 * einseitig — bei der PIN-Sperre eine Ebene tiefer war genau diese Falle
 * gesehen und vermieden worden.
 *
 * Je Paar heißt: wer sich am Tresen vertippt, sperrt seinen Arbeitsplatz;
 * die Kollegin am Nebenplatz und das Mobiltelefon der Leitung kommen weiter
 * herein. Ein Angreifer bekommt weiter zehn Versuche je Adresse, und dahinter
 * steht die Ratenbegrenzung je Herkunft, die Anmeldungen ausdrücklich mitzählt.
 */
const MAX_FEHLVERSUCHE = 10
const SPERRE_MINUTEN = 15

/**
 * Der Arbeitsplatz-PIN ist kurz, und das ist Absicht: er wird an einem
 * Tresen zwanzigmal am Tag getippt, während jemand danebensteht. Vier
 * Ziffern sind zehntausend Möglichkeiten — das hält nur, weil nach fünf
 * Fehlversuchen für eine Viertelstunde Schluss ist. Ohne die Sperre wäre er
 * in Sekunden geraten, mit ihr braucht es Jahre.
 *
 * Zwölf Ziffern als Obergrenze, damit niemand ein Kennwort hineinschreibt:
 * ein PIN ist kein Kennwort, und wer ihn dafür hält, benutzt am Ende
 * dasselbe Geheimnis für beides.
 */
const PIN_MIN_ZIFFERN = 4
const PIN_MAX_ZIFFERN = 12
const PIN_MAX_FEHLVERSUCHE = 5
const PIN_SPERRE_MINUTEN = 15

/**
 * Rechenzeit auch dann verbrauchen, wenn es den Benutzer nicht gibt.
 *
 * Sonst antwortet die Anmeldung für eine unbekannte Adresse in zwei
 * Millisekunden und für eine bekannte in hundert, und damit lässt sich die
 * Benutzerliste abfragen, ohne ein einziges Kennwort zu kennen.
 */
const BLIND_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsemVzYWx6ZXNhbHplcw$'
  + 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYg'

async function pruefeKennwort(hash: string | null, kennwort: string): Promise<boolean> {
  try {
    return await argonVerify(hash ?? BLIND_HASH, kennwort)
  } catch {
    return false
  }
}

export async function hashPassword(kennwort: string): Promise<string> {
  // Argon2id, Speicher vor Rechenzeit: Grafikkarten sind schnell beim
  // Rechnen und knapp beim Speicher.
  return argonHash(kennwort, { memoryCost: 19_456, timeCost: 2, parallelism: 1 })
}

function neueSitzungsKennung(): string {
  return randomBytes(32).toString('base64url')
}

export function authRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/login',
    permission: null,
    summary: 'Anmelden',
    handler: async (req, reply) => {
      const { email, password } = req.body as { email?: string; password?: string }
      if (!email || !password) {
        throw Errors.validation({ email: ['field.required'], password: ['field.required'] })
      }

      const herkunft = req.ip
      const { rows } = await req.pool.query<{
        id: number; password_hash: string | null; status: string
        locked_until: string | null; herkunft_gesperrt_bis: string | null }>(
        `SELECT u.id, u.password_hash, u.status, u.locked_until::text,
                f.locked_until::text AS herkunft_gesperrt_bis
           FROM app_user u
           LEFT JOIN login_failure f ON f.user_id = u.id AND f.origin = $2
          WHERE lower(u.email) = lower($1)`, [email, herkunft])
      const benutzer = rows[0]

      /*
       * Zwei Sperren: die eigene Herkunft nach zu vielen Fehlversuchen von
       * dort, und die am Konto, die nur noch von Hand gesetzt wird. Die
       * zweite bleibt stehen, weil die Aufsicht ein Konto stilllegen können
       * muss, ohne auf eine Herkunft zu zeigen.
       *
       * Beide werden geprüft, nicht die erste vorhandene: `??` nahm die
       * Herkunftssperre auch dann, wenn sie längst abgelaufen war, und
       * übersah dann die Sperre am Konto -- eine abgelaufene Zeile in
       * `login_failure` hätte eine Stilllegung von Hand ausgehebelt.
       */
      const sperren = [benutzer?.herkunft_gesperrt_bis, benutzer?.locked_until]
        .filter((s): s is string => s !== null && s !== undefined)
      if (sperren.some(s => Date.parse(s) > Date.now())) {
        // Auch hier keine genaue Auskunft: die Sperre selbst ist schon eine.
        throw Errors.unauthorized('auth.tooManyAttempts')
      }

      const passt = await pruefeKennwort(benutzer?.password_hash ?? null, password)
      const erlaubt = passt && benutzer !== undefined && benutzer.status === 'active'

      if (!erlaubt) {
        if (benutzer !== undefined) {
          /*
           * Der Zähler am Konto läuft weiter mit, er sperrt nur nicht mehr:
           * die Aufsicht sieht daran, dass jemand ein Konto durchprobiert,
           * auch wenn jede einzelne Herkunft unter ihrer Grenze bleibt.
           */
          await req.pool.query(
            `INSERT INTO login_failure (user_id, origin, failed_count, locked_until)
             VALUES ($1, $2, 1, NULL)
             ON CONFLICT (user_id, origin) DO UPDATE
                SET failed_count = login_failure.failed_count + 1,
                    last_failure_at = now(),
                    locked_until = CASE WHEN login_failure.failed_count + 1 >= $3
                                        THEN now() + ($4 || ' minutes')::interval END`,
            [benutzer.id, herkunft, MAX_FEHLVERSUCHE, SPERRE_MINUTEN])
          await req.pool.query(
            `UPDATE app_user SET failed_login_count = failed_login_count + 1
              WHERE id = $1`, [benutzer.id])
        }
        // Eine Meldung für alle Fälle: falsche Adresse, falsches Kennwort,
        // gesperrtes Konto. Wer unterscheidet, verrät, welche Adressen es gibt.
        throw Errors.unauthorized('auth.badCredentials')
      }

      const sessionId = neueSitzungsKennung()
      await req.pool.query(
        `INSERT INTO user_session (id, user_id, expires_at, absolute_expires_at,
                                   ip, user_agent)
         VALUES ($1,$2, now() + ($3 || ' hours')::interval,
                        now() + ($4 || ' hours')::interval, $5, $6)`,
        [sessionId, benutzer.id, SITZUNG_UNTAETIG_STUNDEN, SITZUNG_ABSOLUT_STUNDEN,
         req.ip, (req.headers['user-agent'] ?? '').slice(0, 300)])
      await req.pool.query(
        `UPDATE app_user SET failed_login_count = 0, locked_until = NULL,
                             last_login_at = now() WHERE id = $1`, [benutzer.id])
      // Nur diese Herkunft, nicht alle: sonst setzte jede erfolgreiche
      // Anmeldung den Zaehler des Angreifers an seiner eigenen Adresse
      // zurueck, und der bekaeme nach jedem Arbeitsbeginn zehn neue Versuche.
      await req.pool.query(
        `DELETE FROM login_failure WHERE user_id = $1 AND origin = $2`,
        [benutzer.id, herkunft])

      reply.setCookie(COOKIE, sessionId, {
        httpOnly: true,                       // kein Zugriff aus JavaScript
        /*
         * `strict`, nicht `lax` (H6, Dokument 25).
         *
         * `lax` schickt das Cookie bei einer **Navigation der obersten
         * Ebene** mit — ein `window.open`, ein Meta-Refresh, ein angeklickter
         * Link. Damit konnte eine fremde Seite `GET /v1/guests/:ref/
         * id-document` auslösen, und diese Route schreibt: jeder Abruf eines
         * Ausweismerkmals wird protokolliert. Lesen konnte die fremde Seite
         * die Antwort nicht — es war kein Datenabfluss —, aber sie konnte
         * einen Prüfeintrag erzeugen, der aussagt, das Opfer habe die
         * Ausweisnummer eines Gastes gelesen. Getroffen hätte das
         * ausgerechnet die Eigenschaft, für die es diesen Eintrag gibt: seine
         * Beweiskraft.
         *
         * Der Preis ist gering, weil die Anwendung **eine** Herkunft ist und
         * von außen niemand auf sie verlinkt: es gibt keinen Zugang, bei dem
         * ein Klick von einer anderen Seite in einer angemeldeten Sitzung
         * landen soll.
         */
        sameSite: 'strict',
        secure: config.nodeEnv === 'production',
        path: '/',
        maxAge: SITZUNG_ABSOLUT_STUNDEN * 3600
      })
      return { ok: true }
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/logout',
    permission: null,
    summary: 'Abmelden',
    handler: async (req, reply) => {
      const sessionId = req.cookies[COOKIE]
      if (sessionId !== undefined) {
        // Zurückziehen, nicht löschen: die Zeile bleibt als Spur, wann eine
        // Sitzung bestand und wann sie endete.
        await req.pool.query(
          `UPDATE user_session SET revoked_at = now()
            WHERE id = $1 AND revoked_at IS NULL`, [sessionId])
      }
      reply.clearCookie(COOKIE, { path: '/' })
      return { ok: true }
    }
  })

  /**
   * Wer bin ich und was darf ich.
   *
   * Die Oberfläche baut ihre Navigation daraus. Sie blendet damit aus, was
   * der Benutzer nicht darf — aber das ist Bequemlichkeit, keine Sicherheit:
   * jede Route prüft die Berechtigung selbst, und ein Test läuft über die
   * gesamte Routenliste.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/auth/me',
    permission: null,
    summary: 'Angemeldeten Benutzer und Berechtigungen lesen',
    handler: async (req) => {
      const p = req.principal as Principal
      if (p.userId === null) throw Errors.unauthorized()

      const benutzer = await req.pool.query<{ display_name: string; email: string
                                             hat_pin: boolean }>(
        `SELECT display_name, email, workstation_pin_hash IS NOT NULL AS hat_pin
           FROM app_user WHERE id = $1`, [p.userId])

      const haeuser = propertyIds(p)
      // In einer Transaktion mit gesetztem Mandantenkontext lesen. Ohne die
      // greift die Zeilenrichtlinie auf `property` mit leerem Kontext und
      // liefert nichts: der Benutzer saehe seine eigenen Haeuser nicht.
      interface PropertyRow {
        id: number; code: string; name: string; timezone: string; is_training: boolean
      }
      const properties = haeuser.length === 0
        ? { rows: [] as PropertyRow[] }
        : await tx(req.pool, req, client =>
            client.query<PropertyRow>(
              // is_training gehoert in die Antwort, damit die Oberflaeche es
              // dauerhaft anzeigen kann. Wer nicht sieht, dass er uebt, uebt
              // irgendwann versehentlich am echten Haus (C11).
              `SELECT id, code, name, timezone, is_training FROM property
                WHERE id = ANY($1::bigint[]) AND status = 'active' ORDER BY code`,
              [haeuser]))

      /*
       * Warum hier kein Haus steht, wenn keines dasteht.
       *
       * Ein gesperrter Kunde meldet sich weiterhin an -- gesperrt ist der
       * Account, nicht der Benutzer -- und bekaeme sonst "diesem Benutzer ist
       * kein Haus zugeordnet" zu lesen. Das ist der Satz, nach dem montags um
       * sieben jemand anruft und niemand weiss, warum. Gefragt wird nur im
       * einzigen Fall, in dem die Antwort zaehlt: kein Haus, und kein
       * Plattformpersonal (fuer das "kein Haus" der Normalzustand ist).
       */
      let accountSuspended = false
      if (haeuser.length === 0 && !p.isPlatformStaff) {
        const zustaende = await req.pool.query<{ status: string }>(
          `SELECT status FROM user_account_states($1)`, [p.userId])
        accountSuspended = zustaende.rowCount !== 0
          && zustaende.rows.every(z => z.status !== 'active')
      }

      return {
        userId: p.userId,
        accountSuspended,
        displayName: benutzer.rows[0]?.display_name ?? '',
        email: benutzer.rows[0]?.email ?? '',
        isPlatformStaff: p.isPlatformStaff,
        supportSession: p.supportSessionId !== null,
        /*
         * Arbeitsplatz: hat diese Person einen PIN, und handelt gerade
         * jemand anderes als der Angemeldete?
         *
         * Das zweite ist der Grund, warum es ueberhaupt in der Antwort
         * steht. Ein Wechsel, den man nicht sieht, wird vergessen, und dann
         * bucht eine Stunde lang jemand unter fremdem Namen -- was den
         * Personenwechsel genau um das bringt, wofuer es ihn gibt.
         */
        workstationPinSet: benutzer.rows[0]?.hat_pin ?? false,
        workstationSwitched: p.sessionUserId !== null && p.sessionUserId !== p.userId,
        accountPermissions: [...p.accountPermissions].sort(),
        /*
         * Die Plattformrechte. Sie haengen an keiner Property und standen
         * deshalb bisher in keiner Antwort -- das Adminpanel haette ohne sie
         * jedem Plattformbenutzer alle Reiter gezeigt und drei davon mit
         * einer 403 beantwortet. Sichtbarkeit ist hier Brauchbarkeit, nicht
         * Sicherheit: die liegt in der API und nirgends sonst.
         */
        platformPermissions: [...p.platformPermissions].sort(),
        properties: properties.rows.map(r => ({
          id: r.id, code: r.code, name: r.name, timezone: r.timezone,
          isTraining: r.is_training,
          permissions: [...(p.permissionsByProperty.get(r.id) ?? [])].sort()
        }))
      }
    }
  })

  /**
   * Den eigenen Arbeitsplatz-PIN setzen oder entfernen.
   *
   * **Warum das Kennwort dazugehört.** Der PIN ist der Schlüssel, mit dem
   * jemand an einem fremden Arbeitsplatz in seinem Namen weiterarbeitet. Wer
   * ihn setzen kann, kann diesen Schlüssel neu vergeben — und an einem
   * Tresen steht die Sitzung offen, während die Person Kaffee holt. Das
   * Kennwort ist die Stelle, an der sich beweisen lässt, dass wirklich der
   * Betroffene davorsitzt und nicht der nächste, der vorbeikommt.
   *
   * **Nur der eigene.** Es gibt bewusst keinen Weg, den PIN eines Kollegen
   * zu setzen — auch nicht für die Hausleitung. Ein von jemand anderem
   * vergebener PIN taugt nicht als Nachweis, wer gehandelt hat, und genau
   * dafür ist er da. Wer seinen PIN vergessen hat, setzt einen neuen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/workstation-pin',
    permission: null,
    summary: 'Eigenen Arbeitsplatz-PIN setzen oder entfernen',
    handler: async (req) => {
      const p = req.principal as Principal
      if (p.userId === null) throw Errors.unauthorized()
      const { password, pin } = req.body as { password?: string; pin?: string | null }
      if (!password) throw Errors.validation({ password: ['field.required'] })

      const u = await req.pool.query<{ password_hash: string | null }>(
        `SELECT password_hash FROM app_user WHERE id = $1`, [p.userId])
      if (!await pruefeKennwort(u.rows[0]?.password_hash ?? null, password)) {
        throw Errors.unauthorized('auth.badCredentials')
      }

      // Kein PIN mehr: der Personenwechsel auf diese Person ist damit zu.
      if (pin === null || pin === undefined || pin === '') {
        await req.pool.query(
          `UPDATE app_user
              SET workstation_pin_hash = NULL, workstation_pin_set_at = NULL,
                  workstation_pin_failed_count = 0, workstation_pin_locked_until = NULL
            WHERE id = $1`, [p.userId])
        return { ok: true, pinSet: false }
      }

      if (!/^[0-9]+$/.test(pin)
          || pin.length < PIN_MIN_ZIFFERN || pin.length > PIN_MAX_ZIFFERN) {
        throw Errors.validation({ pin: ['field.pinDigits'] },
          { min: PIN_MIN_ZIFFERN, max: PIN_MAX_ZIFFERN })
      }

      await req.pool.query(
        `UPDATE app_user
            SET workstation_pin_hash = $2, workstation_pin_set_at = now(),
                workstation_pin_failed_count = 0, workstation_pin_locked_until = NULL
          WHERE id = $1`, [p.userId, await hashPassword(pin)])
      return { ok: true, pinSet: true }
    }
  })

  /**
   * Arbeitsplatz-PIN: an einem geteilten Rezeptionsrechner wechselt die
   * handelnde Person, ohne dass sich jemand neu anmeldet. Die Sitzung bleibt,
   * `active_user_id` wechselt, und das Protokoll hält fest, wer gebucht hat.
   *
   * Drei Dinge prüft diese Route, die sie vorher nicht prüfte, und jedes
   * einzelne war ein offenes Tor:
   *
   * **Die Ratenbegrenzung greift hier nicht.** Sie nimmt angemeldete
   * Anfragen aus, und diese Route trägt immer ein gültiges Sitzungscookie —
   * der Pfad steht zwar auf der strengen Liste, wurde davon aber nie
   * erreicht. Ein vierstelliger PIN ließ sich damit in Sekunden
   * durchprobieren. Deshalb zählt sie ihre Fehlversuche selbst, je Zielperson
   * und getrennt von der Anmeldung (Migration 0035).
   *
   * **Das Ziel muss zum selben Arbeitsplatz gehören.** Vorher genügten
   * Adresse und PIN irgendeines Benutzers der ganzen Datenbank. Wer sich
   * hier ausweist, muss mindestens ein Haus mit der angemeldeten Person
   * teilen; sonst wäre dies ein Weg von einem Kunden zum nächsten.
   *
   * **Die angemeldete Person braucht selbst einen PIN.** Sonst käme sie nach
   * einem Wechsel nicht in ihre eigene Sitzung zurück — zurückwechseln
   * verlangt denselben Nachweis wie hinwechseln.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/workstation-switch',
    permission: null,
    summary: 'Handelnde Person am Arbeitsplatz wechseln',
    handler: async (req) => {
      const sessionId = req.cookies[COOKIE]
      if (sessionId === undefined) throw Errors.unauthorized()
      const p = req.principal as Principal
      if (p.sessionUserId === null) throw Errors.unauthorized()
      const { email, pin } = req.body as { email?: string; pin?: string }
      if (!email || !pin) {
        throw Errors.validation({ email: ['field.required'], pin: ['field.required'] })
      }

      const inhaber = await req.pool.query<{ hat_pin: boolean }>(
        `SELECT workstation_pin_hash IS NOT NULL AS hat_pin
           FROM app_user WHERE id = $1`, [p.sessionUserId])
      if (!inhaber.rows[0]?.hat_pin) {
        throw Errors.unprocessable('auth.ownerNeedsPin')
      }

      const { rows } = await req.pool.query<{
        id: number; workstation_pin_hash: string | null; status: string
        workstation_pin_locked_until: string | null }>(
        `SELECT id, workstation_pin_hash, status, workstation_pin_locked_until
           FROM app_user WHERE lower(email) = lower($1)`, [email])
      const ziel = rows[0]

      if (ziel?.workstation_pin_locked_until != null
          && Date.parse(ziel.workstation_pin_locked_until) > Date.now()) {
        throw Errors.unauthorized('auth.tooManyAttempts')
      }

      /*
       * Die Zugehoerigkeit wird **vor** dem Ausgang der PIN-Pruefung
       * ermittelt, aber erst danach ausgewertet. Sonst antwortete die Route
       * fuer einen fremden Benutzer schneller als fuer einen eigenen, und
       * damit liesse sich abfragen, wer im selben Haus arbeitet.
       */
      const gemeinsam = ziel === undefined ? { rowCount: 0 } : await req.pool.query(
        `SELECT 1 FROM user_property_scope($1) a
           JOIN user_property_scope($2) b USING (property_id) LIMIT 1`,
        [p.sessionUserId, ziel.id])

      const passt = await pruefeKennwort(ziel?.workstation_pin_hash ?? null, pin)
      const erlaubt = passt && ziel !== undefined && ziel.status === 'active'
        && (gemeinsam.rowCount ?? 0) > 0

      if (!erlaubt) {
        // Gezaehlt wird nur, wenn der PIN wirklich falsch war. Ein Zaehler,
        // der auch bei fremder Zugehoerigkeit steigt, waere ein Weg, einen
        // beliebigen Kollegen auszusperren, ohne seinen PIN je zu treffen.
        if (ziel !== undefined && !passt) {
          await req.pool.query(
            `UPDATE app_user
                SET workstation_pin_failed_count = workstation_pin_failed_count + 1,
                    workstation_pin_locked_until =
                      CASE WHEN workstation_pin_failed_count + 1 >= $2
                           THEN now() + ($3 || ' minutes')::interval END
              WHERE id = $1`,
            [ziel.id, PIN_MAX_FEHLVERSUCHE, PIN_SPERRE_MINUTEN])
        }
        // Eine Meldung fuer alle Faelle: falsche Adresse, falscher PIN,
        // fremdes Haus. Wer unterscheidet, verraet die Benutzerliste.
        throw Errors.unauthorized('auth.badPin')
      }

      const r = await req.pool.query(
        `UPDATE user_session SET active_user_id = $2
          WHERE id = $1 AND revoked_at IS NULL AND absolute_expires_at > now()`,
        [sessionId, ziel.id])
      if (r.rowCount === 0) throw Errors.unauthorized()
      await req.pool.query(
        `UPDATE app_user SET workstation_pin_failed_count = 0,
                             workstation_pin_locked_until = NULL WHERE id = $1`,
        [ziel.id])
      return { ok: true, activeUserId: ziel.id }
    }
  })

  /*
   * Kennwort vergessen. Oeffentlich, und deshalb die Stelle, an der man am
   * meisten falsch machen kann.
   *
   * **Die Antwort ist immer 202.** Auch fuer eine Adresse, die es nicht gibt.
   * Andernfalls waere dieser Endpunkt ein Verzeichnis: wer wissen will, ob
   * eine Adresse Kunde bei uns ist, tippt sie ein und liest die Antwort. Das
   * ist keine Kleinigkeit -- die Kundenliste eines Hotelsystems sagt, welche
   * Haeuser welche Software benutzen.
   *
   * Aus demselben Grund steht in der Antwort auch keine Andeutung: kein
   * "falls die Adresse bekannt ist" mit einem anderen Statuscode daneben,
   * keine unterschiedliche Antwortzeit, die sich messen liesse. Die
   * Ratenbegrenzung steht auf der strengen Liste (rateLimit.ts).
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/password-reset',
    permission: null,
    summary: 'Kennwort zuruecksetzen anfordern',
    handler: async (req, reply) => {
      const { email } = req.body as { email?: string }
      if (!email) throw Errors.validation({ email: ['field.required'] })

      await tx(req.pool, req, async client => {
        const u = await client.query<{ id: number; display_name: string; status: string }>(
          `SELECT id, display_name, status FROM app_user WHERE lower(email) = lower($1)`,
          [email])
        const benutzer = u.rows[0]
        // Ein stillgelegter Zugang bekommt keinen Link. Er koennte sich sonst
        // selbst wieder anmelden, und das Stilllegen waere wirkungslos.
        if (benutzer === undefined || benutzer.status === 'disabled') return

        await einmalTokenUndPost(client, {
          userId: benutzer.id, name: benutzer.display_name, email,
          kind: 'password_reset'
        })
      })

      reply.status(202)
      return { status: 'accepted' }
    }
  })

  /*
   * Den Link einloesen. Dieselbe Route fuer Einladung und Ruecksetzung: was
   * dahinter passiert, ist in beiden Faellen dasselbe -- ein Kennwort setzen,
   * ohne das alte zu kennen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/password-reset/confirm',
    permission: null,
    summary: 'Neues Kennwort setzen',
    handler: async (req) => {
      const { token, password } = req.body as { token?: string; password?: string }
      if (!token || !password) {
        throw Errors.validation({ token: ['field.required'], password: ['field.required'] })
      }
      if (kennwortZuKurz(password)) {
        throw Errors.validation({ password: ['auth.passwordTooShort'] }, { min: KENNWORT_MIN })
      }

      return tx(req.pool, req, async client => {
        /*
         * Das Token wird ueber seinen Hash gesucht und in derselben Anweisung
         * entwertet. Zwei Anweisungen -- erst suchen, dann als benutzt
         * markieren -- liessen zwei gleichzeitige Aufrufe beide durch; bei
         * einem Einmaltoken ist genau das der Fehler, den es nicht geben darf.
         */
        const t = await client.query<{ user_id: number }>(
          `UPDATE auth_token SET used_at = now()
            WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
            RETURNING user_id`, [hashToken(token)])
        if (t.rowCount === 0) throw Errors.validation({ token: ['auth.tokenInvalid'] })

        const userId = t.rows[0]!.user_id
        await client.query(
          `UPDATE app_user
              SET password_hash = $2,
                  -- Eine Einladung wird mit dem ersten Kennwort angenommen.
                  status = CASE WHEN status = 'invited' THEN 'active' ELSE status END,
                  -- Wer sich ausgesperrt hat, setzt deshalb sein Kennwort
                  -- zurueck. Bliebe die Sperre stehen, waere er es danach
                  -- immer noch -- mit einem Kennwort, das er gerade erst
                  -- vergeben hat.
                  failed_login_count = 0,
                  locked_until = NULL,
                  updated_at = now()
            WHERE id = $1`, [userId, await hashPassword(password)])

        // Und die Sperren je Herkunft, aus demselben Grund (H3, Dokument 25):
        // wer sich ausgesperrt hat, sitzt beim Zuruecksetzen an demselben
        // Rechner, von dem aus er sich vertippt hat.
        await client.query(`DELETE FROM login_failure WHERE user_id = $1`, [userId])

        /*
         * Alle Sitzungen beenden. Wer sein Kennwort zuruecksetzt, tut das oft
         * genug, weil jemand anderes es kennt -- und dann nuetzt das neue
         * Kennwort nichts, solange die alte Sitzung weiterlaeuft.
         */
        await client.query(
          `UPDATE user_session SET revoked_at = now()
            WHERE user_id = $1 AND revoked_at IS NULL`, [userId])

        // Weitere offene Token desselben Benutzers verfallen mit. Sonst laege
        // nach drei Anforderungen dreimal ein gueltiger Zugang im Postfach.
        await client.query(
          `UPDATE auth_token SET used_at = now()
            WHERE user_id = $1 AND used_at IS NULL`, [userId])

        return { status: 'ok' }
      })
    }
  })

  // -------------------------------------------------------- Das eigene Konto
  /*
   * Kennwort und Mailadresse selbst aendern.
   *
   * **Warum es das bisher nicht gab.** Es gab nur "Kennwort vergessen" --
   * also einen Link an die eigene Adresse. Fuer ein Kennwort ist das
   * umstaendlich, fuer eine Adressaenderung unbrauchbar: der Link ginge an
   * die Adresse, die man gerade loswerden will. Plattformpersonal kam
   * ausserdem gar nicht an diese Masken, weil das Adminpanel neben der
   * Kopfleiste stand statt darin.
   *
   * **Beide Handlungen verlangen das aktuelle Kennwort.** Eine Sitzung
   * genuegt nicht: an einer Rezeption steht ein Rechner, an dem jemand
   * kurz aufsteht. Wer die Sitzung vorfindet, koennte sonst in zwei Klicks
   * das Konto uebernehmen -- Adresse aendern, Kennwort aendern, fertig. Das
   * Kennwort ist die Stelle, an der sich beweisen laesst, dass wirklich der
   * Betroffene davorsitzt (dieselbe Begruendung wie beim Arbeitsplatz-PIN).
   *
   * **Und beide zaehlen ihre Fehlversuche selbst.** Die allgemeine
   * Ratenbegrenzung greift nur bei anonymen Anfragen und erreicht eine
   * angemeldete Sitzung nicht -- genau der Fehler, der bei
   * `workstation-switch` schon einmal passiert ist (H4, Dokument 25). Hier
   * wird dasselbe Geheimnis geprueft wie bei der Anmeldung, also zaehlt es
   * auf denselben Zaehler.
   */

  /** Einen Fehlversuch am eigenen Kennwort zaehlen, wie bei der Anmeldung. */
  async function zaehleFehlversuch(
    pool: FastifyRequest['pool'], userId: number, ip: string
  ): Promise<void> {
    await pool.query(
      `INSERT INTO login_failure (user_id, origin, failed_count, locked_until)
       VALUES ($1, $2, 1, NULL)
       ON CONFLICT (user_id, origin) DO UPDATE
          SET failed_count = login_failure.failed_count + 1,
              last_failure_at = now(),
              locked_until = CASE WHEN login_failure.failed_count + 1 >= $3
                                  THEN now() + ($4 || ' minutes')::interval END`,
      [userId, ip, MAX_FEHLVERSUCHE, SPERRE_MINUTEN])
    await pool.query(
      `UPDATE app_user SET failed_login_count = failed_login_count + 1
        WHERE id = $1`, [userId])
  }

  /**
   * Das eigene Kennwort und den Stand der Sperre lesen.
   *
   * Eine gesperrte Sitzung darf hier nicht weiterarbeiten: waere das
   * erlaubt, liesse sich die Sperre der Anmeldung einfach umgehen, indem
   * man in einer noch offenen Sitzung weiterprobiert.
   */
  async function eigenesKennwort(
    req: FastifyRequest, userId: number
  ): Promise<{ hash: string | null; name: string | null; email: string }> {
    const { rows } = await req.pool.query<{
      password_hash: string | null; display_name: string | null; email: string
      locked_until: string | null; herkunft_gesperrt_bis: string | null }>(
      `SELECT u.password_hash, u.display_name, u.email, u.locked_until::text,
              f.locked_until::text AS herkunft_gesperrt_bis
         FROM app_user u
         LEFT JOIN login_failure f ON f.user_id = u.id AND f.origin = $2
        WHERE u.id = $1`, [userId, req.ip])
    const u = rows[0]
    if (u === undefined) throw Errors.unauthorized()
    const sperren = [u.herkunft_gesperrt_bis, u.locked_until]
      .filter((s): s is string => s !== null && s !== undefined)
    if (sperren.some(s => Date.parse(s) > Date.now())) {
      throw Errors.unauthorized('auth.tooManyAttempts')
    }
    return { hash: u.password_hash, name: u.display_name, email: u.email }
  }

  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/password',
    permission: null,
    summary: 'Eigenes Kennwort aendern',
    handler: async (req) => {
      const p = req.principal as Principal
      if (p.userId === null) throw Errors.unauthorized()
      const b = req.body as { currentPassword?: string; newPassword?: string }
      if (!b.currentPassword || !b.newPassword) {
        throw Errors.validation({ currentPassword: ['field.required'],
                                  newPassword: ['field.required'] })
      }
      if (kennwortZuKurz(b.newPassword)) {
        throw Errors.validation({ newPassword: ['auth.passwordTooShort'] },
          { min: KENNWORT_MIN })
      }
      /*
       * Dasselbe Kennwort noch einmal zu setzen ist kein Fehler, aber es
       * sieht wie einer aus: der Benutzer glaubt, er habe es geaendert, und
       * alle seine anderen Sitzungen fliegen dabei heraus. Lieber sagen,
       * dass nichts passiert ist.
       */
      if (b.currentPassword === b.newPassword) {
        throw Errors.validation({ newPassword: ['auth.passwordUnchanged'] })
      }

      const eigen = await eigenesKennwort(req, p.userId)
      if (!await pruefeKennwort(eigen.hash, b.currentPassword)) {
        await zaehleFehlversuch(req.pool, p.userId, req.ip)
        throw Errors.unauthorized('auth.badCredentials')
      }

      const neu = await hashPassword(b.newPassword)
      const eigeneSitzung = req.cookies[COOKIE] ?? null

      return tx(req.pool, req, async client => {
        await client.query(
          `UPDATE app_user
              SET password_hash = $2, failed_login_count = 0, locked_until = NULL,
                  updated_at = now()
            WHERE id = $1`, [p.userId, neu])
        await client.query(`DELETE FROM login_failure WHERE user_id = $1`, [p.userId])

        /*
         * Alle **anderen** Sitzungen beenden, die eigene nicht. Wer sein
         * Kennwort aendert, tut das oft genug, weil jemand anderes es kennt;
         * dann nuetzt das neue nichts, solange die fremde Sitzung
         * weiterlaeuft. Die eigene stehen zu lassen ist der Unterschied zur
         * Ruecksetzung: hier sitzt der Benutzer davor und will weiterarbeiten,
         * nicht sich neu anmelden.
         */
        await client.query(
          `UPDATE user_session SET revoked_at = now()
            WHERE user_id = $1 AND revoked_at IS NULL AND id <> COALESCE($2,'')`,
          [p.userId, eigeneSitzung])

        // Offene Einmaltoken verfallen mit: nach einer Aenderung soll kein
        // aelterer Ruecksetzlink mehr im Postfach gelten.
        await client.query(
          `UPDATE auth_token SET used_at = now()
            WHERE user_id = $1 AND used_at IS NULL`, [p.userId])

        return { status: 'ok' }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/email',
    permission: null,
    summary: 'Eigene Mailadresse aendern',
    handler: async (req, reply) => {
      const p = req.principal as Principal
      if (p.userId === null) throw Errors.unauthorized()
      // Festgehalten, weil die Verengung im Closure der Transaktion sonst
      // verloren geht.
      const userId = p.userId
      const b = req.body as { currentPassword?: string; newEmail?: string }
      if (!b.currentPassword || !b.newEmail) {
        throw Errors.validation({ currentPassword: ['field.required'],
                                  newEmail: ['field.required'] })
      }
      const neueAdresse = b.newEmail.trim()
      if (!isSendableAddress(neueAdresse)) {
        throw Errors.validation({ newEmail: ['field.email'] })
      }

      const eigen = await eigenesKennwort(req, userId)
      if (!await pruefeKennwort(eigen.hash, b.currentPassword)) {
        await zaehleFehlversuch(req.pool, userId, req.ip)
        throw Errors.unauthorized('auth.badCredentials')
      }
      if (neueAdresse.toLowerCase() === eigen.email.toLowerCase()) {
        throw Errors.validation({ newEmail: ['auth.emailUnchanged'] })
      }

      return tx(req.pool, req, async client => {
        /*
         * Belegt? Dann hier abweisen und nicht erst beim Bestaetigen. Sonst
         * klickt jemand einen Link, der nie funktionieren konnte, und die
         * Meldung erreicht ihn in einem Browserfenster ohne Zusammenhang.
         *
         * Das verraet, dass es diese Adresse gibt -- anders als bei der
         * Anmeldung ist das hier hinnehmbar: der Aufrufer hat sich gerade
         * mit seinem Kennwort ausgewiesen, und eine eindeutige Spalte laesst
         * sich ohnehin durch Ausprobieren abtasten.
         */
        const belegt = await client.query(
          `SELECT 1 FROM app_user WHERE lower(email) = lower($1) AND id <> $2`,
          [neueAdresse, userId])
        if (belegt.rows.length > 0) {
          throw Errors.conflict('auth.emailTaken')
        }

        /*
         * Aeltere offene Aenderungen verfallen. Sonst laegen nach drei
         * Versuchen drei gueltige Links im Postfach, jeder auf eine andere
         * Adresse -- und welcher zuletzt geklickt wird, entscheidet der
         * Zufall.
         */
        await client.query(
          `UPDATE auth_token SET used_at = now()
            WHERE user_id = $1 AND kind = 'email_change' AND used_at IS NULL`,
          [userId])

        await einmalTokenUndPost(client, {
          userId: userId, name: eigen.name, email: neueAdresse,
          kind: 'email_change', newEmail: neueAdresse
        })

        /*
         * Der Hinweis an die alte Adresse. Ohne Link, und das ist Absicht:
         * eine Nachricht ueber eine Aenderung, die man nicht veranlasst hat,
         * mit einem Knopf darin, ist die Bauform jeder Phishing-Mail.
         */
        const hinweis = renderEmailChangeNotice({
          userName: eigen.name, maskedNewEmail: maskEmail(neueAdresse) })
        await client.query(
          `INSERT INTO platform_email (user_id, kind, to_email, to_name, subject,
                                       body_text, body_html)
           VALUES ($1,'email_change_notice',$2,$3,$4,$5,$6)`,
          [userId, eigen.email, eigen.name,
           hinweis.subject, hinweis.text, hinweis.html])

        reply.status(202)
        // Die neue Adresse geht nicht zurueck: sie stuende sonst in jeder
        // Antwort, und Antworten landen in Protokollen.
        return { status: 'pending' }
      })
    }
  })

  /*
   * Die neue Adresse bestaetigen. Oeffentlich wie die Ruecksetzung: der Link
   * wird oft in einem anderen Browser geoeffnet als dem, in dem die Sitzung
   * laeuft -- im Postfach auf dem Telefon etwa. Eine Sitzung zu verlangen
   * hiesse, genau den Weg zu sperren, den die meisten nehmen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/email/confirm',
    permission: null,
    summary: 'Neue Mailadresse bestaetigen',
    handler: async (req) => {
      const { token } = req.body as { token?: string }
      if (!token) throw Errors.validation({ token: ['field.required'] })

      return tx(req.pool, req, async client => {
        // Suchen und entwerten in einer Anweisung, wie bei der Ruecksetzung:
        // zwei Anweisungen liessen zwei gleichzeitige Aufrufe beide durch.
        const t = await client.query<{ user_id: number; new_email: string }>(
          `UPDATE auth_token SET used_at = now()
            WHERE token_hash = $1 AND kind = 'email_change'
              AND used_at IS NULL AND expires_at > now()
            RETURNING user_id, new_email`, [hashToken(token)])
        if (t.rows.length === 0) throw Errors.validation({ token: ['auth.tokenInvalid'] })
        const { user_id: userId, new_email: neueAdresse } = t.rows[0]!

        /*
         * Noch einmal pruefen, ob die Adresse inzwischen belegt ist. Zwischen
         * Anforderung und Klick liegt bis zu ein Tag, und in der Zeit kann
         * jemand anderes sie bekommen haben. Ohne diese Pruefung schluege
         * stattdessen der eindeutige Index zu, und der Benutzer saehe einen
         * Datenbankfehler.
         */
        const belegt = await client.query(
          `SELECT 1 FROM app_user WHERE lower(email) = lower($1) AND id <> $2`,
          [neueAdresse, userId])
        if (belegt.rows.length > 0) throw Errors.conflict('auth.emailTaken')

        await client.query(
          `UPDATE app_user SET email = $2, updated_at = now() WHERE id = $1`,
          [userId, neueAdresse])

        /*
         * Sitzungen bleiben. Anders als beim Kennwort ist hier nichts
         * kompromittiert -- wer bestaetigt hat, sass an beiden Enden --, und
         * jemanden an der Rezeption mitten im Check-in hinauszuwerfen, waere
         * Schaden ohne Gegenwert.
         */
        return { status: 'ok' }
      })
    }
  })
}

/**
 * Token anlegen und die Nachricht einreihen.
 *
 * **Warum nicht ueber email_enqueue.** Das ist Gastpost: hausgebunden, und es
 * weist Uebungshaeuser ab und haelt an, wenn der Versand am Haus nicht
 * eingeschaltet ist. Fuer eine Zugangsmail waere jede dieser Regeln falsch --
 * ein Kunde, der den Gastversand nie eingeschaltet hat, koennte sonst sein
 * Kennwort nie zuruecksetzen (Migration 0030).
 *
 * Das Token selbst steht **nur** in der Nachricht, nie in der Antwort der
 * API und nie im Protokoll. Wer die Antwort mitliest, bekommt keinen Zugang.
 */
export async function einmalTokenUndPost(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  opts: {
    userId: number; name: string | null; email: string; kind: AuthTokenKind
    /** Wer eingeladen hat. Bei einer Ruecksetzung durch den Benutzer selbst leer. */
    createdBy?: number | null
    /** Nur bei `email_change`: die gewuenschte Adresse, die am Token haengt. */
    newEmail?: string
  }
): Promise<void> {
  const { token, hash } = neuesToken()
  const gueltigMs = TOKEN_GUELTIGKEIT[opts.kind]

  await client.query(
    `INSERT INTO auth_token (user_id, kind, token_hash, expires_at, created_by,
                             new_email)
     VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval, $5, $6)`,
    [opts.userId, opts.kind, hash, String(gueltigMs), opts.createdBy ?? null,
     opts.newEmail ?? null])

  const PFAD: Record<AuthTokenKind, string> = {
    invite: 'einladung', password_reset: 'kennwort', email_change: 'mailadresse'
  }
  const link = `${config.publicAppUrl}/${PFAD[opts.kind]}?token=${token}`
  const stunden = Math.round(gueltigMs / 3_600_000)
  const text = opts.kind === 'invite'
    ? renderInviteEmail({ userName: opts.name, link, gueltigStunden: stunden })
    : opts.kind === 'email_change'
      ? renderEmailChangeEmail({ userName: opts.name, newEmail: opts.email, link,
                                 gueltigStunden: stunden })
      : renderPasswordResetEmail({ userName: opts.name, link,
                                   gueltigStunden: stunden })

  await client.query(
    `INSERT INTO platform_email (user_id, kind, to_email, to_name, subject,
                                 body_text, body_html)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [opts.userId, opts.kind, opts.email, opts.name,
     text.subject, text.text, text.html])
}
