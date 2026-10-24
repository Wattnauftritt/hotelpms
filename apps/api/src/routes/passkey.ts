import type { FastifyInstance, FastifyRequest } from 'fastify'
import { generateRegistrationOptions, verifyRegistrationResponse,
         type RegistrationResponseJSON } from '@simplewebauthn/server'
import { PASSKEY_MAX, PASSKEY_NAME_MAX, BESTAETIGUNG_MINUTEN,
         type PasskeyInfo } from '@hotelpms/contracts'
import { renderPasskeyAddedNotice } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'
import { tx } from '../platform/db.js'
import { meldeSicherheitsereignis } from '../platform/bestaetigung.js'
import { passkeyPartei, herausforderungAblegen, herausforderungEinloesen,
         anmeldeOptionen, bestaetigungsOptionen, pruefePasskeyAntwort, HERAUSFORDERUNG_MS } from '../platform/passkey.js'
import { plattformPasskeyAendern, plattformPasskeyMelden } from '../platform/plattformPasskey.js'
import { kennwortBestaetigen, sitzungAnlegen } from './auth.js'

/**
 * Passkeys anlegen, auflisten, entfernen und damit anmelden (Migration 0207).
 *
 * **Ein Passkey ersetzt das Kennwort nicht, er steht daneben.** Das Kennwort
 * bleibt der Weg, auf dem man an ein neues Geraet kommt, und die Ruecksetzung
 * per Mail der Weg, wenn man es vergessen hat. Ein Zugang nur mit Passkey
 * hiesse: Telefon verloren, Zugang verloren, und an einer Rezeption mit
 * wechselndem Personal ist das kein Randfall.
 *
 * **Anlegen verlangt das aktuelle Kennwort**, wie Kennwort und Mailadresse
 * aendern (CLAUDE.md, „Das eigene Konto"). Wer eine offene Sitzung am Tresen
 * vorfindet, legte sich sonst einen eigenen Passkey an das fremde Konto und
 * kaeme damit wieder herein, auch nachdem der Inhaber sein Kennwort
 * geaendert hat. Entfernen verlangt es nicht: wer einen fremden Passkey
 * entfernt, sperrt niemanden aus, das Kennwort traegt weiter.
 *
 * **In der App gibt es den Weg nicht.** Die WebView der App laeuft unter
 * `capacitor://localhost` bzw. `https://localhost`, und ein Passkey fuer
 * app.staygrid.cloud gilt dort nicht. Die App schuetzt ihre Sitzung mit
 * Fingerabdruck oder Gesicht des Telefons (Plan app/plan.md, Abschnitt 5);
 * die Oberflaeche zeigt den Passkey-Knopf dort nicht an.
 */

/** Die angemeldete Person und ihre Sitzung, sonst 401. */
function eigeneSitzung(req: FastifyRequest): { userId: number; sessionId: string } {
  const p = req.principal as Principal | undefined
  if (p?.userId == null || req.sitzung == null) throw Errors.unauthorized()
  return { userId: p.userId, sessionId: req.sitzung.id }
}

function bezeichnung(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : ''
  if (name === '') return 'Passkey'
  if ([...name].length > PASSKEY_NAME_MAX) {
    throw Errors.validation({ name: ['field.maxLength'] }, { max: PASSKEY_NAME_MAX })
  }
  return name
}

export function passkeyRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/passkey/register/options',
    permission: null,
    summary: 'Passkey anlegen: Herausforderung anfordern',
    handler: async (req) => {
      const { userId, sessionId } = eigeneSitzung(req)
      const b = req.body as { currentPassword?: string }
      if (!b.currentPassword) {
        throw Errors.validation({ currentPassword: ['field.required'] })
      }
      await kennwortBestaetigen(req, userId, b.currentPassword)
      await plattformPasskeyAendern(req, userId)

      const { rows: [u] } = await req.pool.query<{
        public_ref: string; email: string | null; username: string | null
        display_name: string }>(
        `SELECT public_ref, email, username, display_name FROM app_user WHERE id = $1`,
        [userId])
      if (u === undefined) throw Errors.unauthorized()
      const vorhanden = await req.pool.query<{ credential_id: string; transports: string[] }>(
        `SELECT credential_id, transports FROM user_passkey WHERE user_id = $1`, [userId])
      if (vorhanden.rows.length >= PASSKEY_MAX) {
        throw Errors.unprocessable('auth.passkeyLimit', { max: PASSKEY_MAX })
      }

      const partei = passkeyPartei()
      const options = await generateRegistrationOptions({
        rpName: partei.rpName,
        rpID: partei.rpID,
        // Die oeffentliche Kennung, nicht die Mailadresse: das Feld landet im
        // Geraet und wird bei der Anmeldung zurueckgeschickt. Eine
        // Mailadresse darin aenderte sich mit der Adresse und stuende in
        // jeder Antwort.
        userID: new Uint8Array(Buffer.from(u.public_ref, 'utf8')),
        userName: u.email ?? u.username ?? u.public_ref,
        userDisplayName: u.display_name,
        timeout: HERAUSFORDERUNG_MS,
        // Keine Herstellerbescheinigung: sie sagt, welches Geraet jemand
        // benutzt, und StayGrid hat keine Liste zugelassener Geraete.
        attestationType: 'none',
        excludeCredentials: vorhanden.rows.map(k => ({
          id: k.credential_id, transports: k.transports })),
        // Auffindbar (`residentKey`), damit die Anmeldung ohne Eingabe einer
        // Adresse geht; mit Pruefung des Benutzers aus dem Grund in
        // platform/passkey.ts.
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
      })
      const challengeId = await herausforderungAblegen(req, {
        purpose: 'register', challenge: options.challenge, userId, sessionId })
      return { challengeId, options }
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/passkey/register',
    permission: null,
    summary: 'Passkey anlegen',
    handler: async (req, reply) => {
      const { userId, sessionId } = eigeneSitzung(req)
      const b = req.body as { challengeId?: string; name?: string; response?: unknown }
      const name = bezeichnung(b.name)
      const challenge = await herausforderungEinloesen(req, b.challengeId,
        { purpose: 'register', userId, sessionId })

      const partei = passkeyPartei()
      let info
      try {
        const r = await verifyRegistrationResponse({
          response: b.response as RegistrationResponseJSON,
          expectedChallenge: challenge,
          expectedOrigin: partei.origin,
          expectedRPID: partei.rpID,
          requireUserVerification: true
        })
        if (!r.verified) throw new Error('nicht bestaetigt')
        info = r.registrationInfo
      } catch {
        throw Errors.unprocessable('auth.passkeyFailed')
      }

      return tx(req.pool, req, async client => {
        // Noch einmal zaehlen: zwischen Herausforderung und Antwort kann ein
        // zweiter Reiter einen Passkey angelegt haben.
        const n = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM user_passkey WHERE user_id = $1`, [userId])
        if ((n.rows[0]?.n ?? 0) >= PASSKEY_MAX) {
          throw Errors.unprocessable('auth.passkeyLimit', { max: PASSKEY_MAX })
        }
        const neu = await client.query<{ id: number; created_at: string }>(
          `INSERT INTO user_passkey (user_id, credential_id, public_key, sign_count,
                                     transports, backed_up, name)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (credential_id) DO NOTHING
           RETURNING id, created_at`,
          [userId, info.credential.id, Buffer.from(info.credential.publicKey),
           info.credential.counter, info.credential.transports ?? [],
           info.credentialBackedUp, name])
        const zeile = neu.rows[0]
        if (zeile === undefined) throw Errors.conflict('auth.passkeyExists')
        await plattformPasskeyMelden(client, req, 'added', name)

        /*
         * Der Hinweis an die eigene Adresse, ohne Link. Wer bisher keine
         * Adresse hat (Personal, Migration 0105), bekommt keinen.
         */
        const u = await client.query<{ email: string | null; display_name: string }>(
          `SELECT email, display_name FROM app_user WHERE id = $1`, [userId])
        const empfaenger = u.rows[0]
        if (empfaenger?.email != null) {
          const hinweis = renderPasskeyAddedNotice({
            userName: empfaenger.display_name, passkeyName: name })
          await client.query(
            `INSERT INTO platform_email (user_id, kind, to_email, to_name, subject,
                                         body_text, body_html)
             VALUES ($1,'passkey_added',$2,$3,$4,$5,$6)`,
            [userId, empfaenger.email, empfaenger.display_name,
             hinweis.subject, hinweis.text, hinweis.html])
        }

        reply.status(201)
        const antwort: PasskeyInfo = {
          id: zeile.id, name, backedUp: info.credentialBackedUp,
          createdAt: zeile.created_at, lastUsedAt: null }
        return antwort
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/auth/passkeys',
    permission: null,
    summary: 'Eigene Passkeys',
    handler: async (req) => {
      const { userId } = eigeneSitzung(req)
      const { rows } = await req.pool.query<PasskeyInfo>(
        `SELECT id, name, backed_up AS "backedUp", created_at AS "createdAt",
                last_used_at AS "lastUsedAt"
           FROM user_passkey WHERE user_id = $1 ORDER BY created_at`, [userId])
      return { passkeys: rows }
    }
  })

  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/auth/passkeys/:id',
    permission: null,
    summary: 'Eigenen Passkey entfernen',
    handler: async (req, reply) => {
      const { userId } = eigeneSitzung(req)
      const id = Number((req.params as { id: string }).id)
      if (!Number.isSafeInteger(id) || id <= 0) throw Errors.notFound('res.passkey')
      await plattformPasskeyAendern(req, userId)
      return tx(req.pool, req, async client => {
        // Nur die eigenen: dieselbe Kennung eines fremden Passkeys ergibt
        // dasselbe 404 wie eine, die es nicht gibt.
        const r = await client.query(
          `DELETE FROM user_passkey WHERE id = $1 AND user_id = $2`, [id, userId])
        if (r.rowCount === 0) throw Errors.notFound('res.passkey')
        await plattformPasskeyMelden(client, req, 'removed', null)
        reply.status(204)
        return null
      })
    }
  })

  /*
   * Anmelden. Zwei Schritte, beide oeffentlich, beide auf der engen
   * Ratenbegrenzung der Anmeldung (rateLimit.ts): der erste legt eine Zeile
   * an, und ohne Grenze waere er ein Weg, die Tabelle zu fuellen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/passkey/login/options',
    permission: null,
    summary: 'Mit Passkey anmelden: Herausforderung anfordern',
    handler: async (req) => anmeldeOptionen(req)
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/passkey/login',
    permission: null,
    summary: 'Mit Passkey anmelden',
    handler: async (req, reply) => {
      const b = req.body as { challengeId?: string; response?: unknown }
      const userId = await pruefePasskeyAntwort(req, b.challengeId, b.response, null)
      /*
       * Nur der Browser. Die App kann hier keinen Passkey vorlegen (siehe
       * oben); bekaeme sie ein Token aus dieser Route, waere das ein Weg,
       * den niemand benutzt und deshalb niemand prueft.
       */
      // Bestaetigt von Anfang an: dieselbe Pruefung wie /passkey/confirm.
      const antwort = await sitzungAnlegen(req, reply, userId, false, true)
      await req.pool.query(`UPDATE app_user SET last_login_at = now() WHERE id = $1`, [userId])
      return antwort
    }
  })

  /*
   * Eine kritische Handlung mit Passkey bestaetigen (0209), der zweite Weg
   * neben dem Kennwort in `POST /v1/auth/confirm`. Setzt dasselbe: die
   * Sitzung gilt fuer einige Minuten als bestaetigt, fuer genau die Person,
   * die gerade handelt -- nach einem Personenwechsel am Tresen ist das die
   * gewechselte, und es muss ihr eigener Passkey sein.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/passkey/confirm/options',
    permission: null,
    summary: 'Mit Passkey bestaetigen: Herausforderung anfordern',
    handler: async (req) => bestaetigungsOptionen(req, eigeneSitzung(req).userId)
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/passkey/confirm',
    permission: null,
    summary: 'Sitzung mit Passkey fuer kritische Handlungen bestaetigen',
    handler: async (req) => {
      const { userId, sessionId } = eigeneSitzung(req)
      const p = req.principal as Principal
      const b = req.body as { challengeId?: string; response?: unknown }
      try {
        await pruefePasskeyAntwort(req, b.challengeId, b.response, userId)
      } catch (e) {
        // Wie beim Kennwort: nur an uns, ohne Hinweis an den Betrieb.
        await tx(req.pool, req, client => meldeSicherheitsereignis(client, req, {
          kind: 'confirmation_failed', accountId: p.accountIds[0] ?? null }))
        throw e
      }
      const { rows } = await req.pool.query<{ until: string }>(
        `UPDATE user_session SET confirmed_at = now(), confirmed_user_id = $2
          WHERE id = $1
          RETURNING (now() + make_interval(mins => $3))::text AS until`,
        [sessionId, userId, BESTAETIGUNG_MINUTEN])
      return { confirmedUntil: new Date(rows[0]!.until).toISOString() }
    }
  })
}
