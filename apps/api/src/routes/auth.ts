import { randomBytes } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { loadConfig } from '../platform/config.js'
import { propertyIds, type Principal } from '../platform/context.js'
import { tx } from '../platform/db.js'
import { neuesToken, hashToken, kennwortZuKurz, KENNWORT_MIN, TOKEN_GUELTIGKEIT,
         renderPasswordResetEmail, renderInviteEmail,
         type AuthTokenKind } from '@hotelpms/domain'

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

/** Zehn Fehlversuche, dann fünfzehn Minuten Sperre. */
const MAX_FEHLVERSUCHE = 10
const SPERRE_MINUTEN = 15

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

      const { rows } = await req.pool.query<{
        id: number; password_hash: string | null; status: string
        failed_login_count: number; locked_until: string | null }>(
        `SELECT id, password_hash, status, failed_login_count, locked_until
           FROM app_user WHERE lower(email) = lower($1)`, [email])
      const benutzer = rows[0]

      if (benutzer?.locked_until !== null && benutzer?.locked_until !== undefined
          && Date.parse(benutzer.locked_until) > Date.now()) {
        // Auch hier keine genaue Auskunft: die Sperre selbst ist schon eine.
        throw Errors.unauthorized('auth.tooManyAttempts')
      }

      const passt = await pruefeKennwort(benutzer?.password_hash ?? null, password)
      const erlaubt = passt && benutzer !== undefined && benutzer.status === 'active'

      if (!erlaubt) {
        if (benutzer !== undefined) {
          await req.pool.query(
            `UPDATE app_user
                SET failed_login_count = failed_login_count + 1,
                    locked_until = CASE WHEN failed_login_count + 1 >= $2
                                        THEN now() + ($3 || ' minutes')::interval END
              WHERE id = $1`,
            [benutzer.id, MAX_FEHLVERSUCHE, SPERRE_MINUTEN])
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

      reply.setCookie(COOKIE, sessionId, {
        httpOnly: true,                       // kein Zugriff aus JavaScript
        sameSite: 'lax',                      // möglich, weil eine Herkunft
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

      const benutzer = await req.pool.query<{ display_name: string; email: string }>(
        `SELECT display_name, email FROM app_user WHERE id = $1`, [p.userId])

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

      return {
        userId: p.userId,
        displayName: benutzer.rows[0]?.display_name ?? '',
        email: benutzer.rows[0]?.email ?? '',
        isPlatformStaff: p.isPlatformStaff,
        supportSession: p.supportSessionId !== null,
        accountPermissions: [...p.accountPermissions].sort(),
        properties: properties.rows.map(r => ({
          id: r.id, code: r.code, name: r.name, timezone: r.timezone,
          isTraining: r.is_training,
          permissions: [...(p.permissionsByProperty.get(r.id) ?? [])].sort()
        }))
      }
    }
  })

  /**
   * Arbeitsplatz-PIN: an einem geteilten Rezeptionsrechner wechselt die
   * handelnde Person, ohne dass sich jemand neu anmeldet. Die Sitzung bleibt,
   * `active_user_id` wechselt, und das Protokoll hält fest, wer gebucht hat.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/workstation-switch',
    permission: null,
    summary: 'Handelnde Person am Arbeitsplatz wechseln',
    handler: async (req) => {
      const sessionId = req.cookies[COOKIE]
      if (sessionId === undefined) throw Errors.unauthorized()
      const { email, pin } = req.body as { email?: string; pin?: string }
      if (!email || !pin) {
        throw Errors.validation({ email: ['field.required'], pin: ['field.required'] })
      }

      const { rows } = await req.pool.query<{ id: number; workstation_pin_hash: string | null
                                              status: string }>(
        `SELECT id, workstation_pin_hash, status FROM app_user
          WHERE lower(email) = lower($1)`, [email])
      const ziel = rows[0]
      const passt = await pruefeKennwort(ziel?.workstation_pin_hash ?? null, pin)
      if (!passt || ziel === undefined || ziel.status !== 'active') {
        throw Errors.unauthorized('auth.badPin')
      }

      const r = await req.pool.query(
        `UPDATE user_session SET active_user_id = $2
          WHERE id = $1 AND revoked_at IS NULL AND absolute_expires_at > now()`,
        [sessionId, ziel.id])
      if (r.rowCount === 0) throw Errors.unauthorized()
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
  }
): Promise<void> {
  const { token, hash } = neuesToken()
  const gueltigMs = TOKEN_GUELTIGKEIT[opts.kind]

  await client.query(
    `INSERT INTO auth_token (user_id, kind, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval, $5)`,
    [opts.userId, opts.kind, hash, String(gueltigMs), opts.createdBy ?? null])

  const pfad = opts.kind === 'invite' ? 'einladung' : 'kennwort'
  const link = `${config.publicAppUrl}/${pfad}?token=${token}`
  const stunden = Math.round(gueltigMs / 3_600_000)
  const text = opts.kind === 'invite'
    ? renderInviteEmail({ userName: opts.name, link, gueltigStunden: stunden })
    : renderPasswordResetEmail({ userName: opts.name, link, gueltigStunden: stunden })

  await client.query(
    `INSERT INTO platform_email (user_id, kind, to_email, to_name, subject,
                                 body_text, body_html)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [opts.userId, opts.kind, opts.email, opts.name,
     text.subject, text.text, text.html])
}
