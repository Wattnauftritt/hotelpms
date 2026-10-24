import { randomBytes } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { generateAuthenticationOptions, verifyAuthenticationResponse,
         type AuthenticationResponseJSON,
         type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server'
import type { PasskeyOptionen } from '@hotelpms/contracts'
import { loadConfig } from './config.js'
import { Errors } from './errors.js'

const config = loadConfig()

/**
 * Passkeys: das, was Anmeldung und Bestaetigung teilen (Migration 0207).
 *
 * **Woran ein Passkey haengt.** An der Domain, unter der die Oberflaeche
 * laeuft (`PUBLIC_APP_URL`), nicht an der Schnittstelle. Der Browser gibt
 * einen Passkey nur unter der Domain heraus, fuer die er angelegt wurde --
 * eine nachgebaute Anmeldeseite unter `staygrid-login.example` bekommt ihn
 * nie zu sehen. Das ist der Grund, warum ein Passkey gegen Phishing haelt
 * und ein Kennwort nicht.
 *
 * Daraus folgt: wer die oeffentliche Adresse aendert, entwertet alle
 * Passkeys. Sie bleiben gespeichert, der Browser bietet sie unter der neuen
 * Domain nur nicht mehr an; das Kennwort traegt weiter.
 */
export function passkeyPartei(): { rpID: string; origin: string; rpName: string } {
  const url = new URL(config.publicAppUrl)
  return { rpID: url.hostname, origin: url.origin, rpName: 'StayGrid' }
}

/**
 * Fuenf Minuten: genug, um das Telefon aus der Tasche zu holen und den
 * Finger aufzulegen, und kurz genug, dass eine liegengebliebene
 * Herausforderung nichts mehr taugt.
 */
export const HERAUSFORDERUNG_MS = 5 * 60_000

export async function herausforderungAblegen(
  req: FastifyRequest,
  opts: { purpose: 'register' | 'login'; challenge: string
          userId?: number | null; sessionId?: string | null }
): Promise<string> {
  const id = randomBytes(18).toString('base64url')
  await req.pool.query(
    `INSERT INTO webauthn_challenge (id, purpose, challenge, user_id, session_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' milliseconds')::interval)`,
    [id, opts.purpose, opts.challenge, opts.userId ?? null, opts.sessionId ?? null,
     String(HERAUSFORDERUNG_MS)])
  return id
}

/**
 * Die Herausforderung einloesen: lesen und loeschen in einer Anweisung. Zwei
 * Anweisungen liessen zwei gleichzeitige Antworten auf dieselbe
 * Herausforderung beide durch -- dasselbe Muster wie beim Einmaltoken der
 * Kennwortruecksetzung.
 */
export async function herausforderungEinloesen(
  req: FastifyRequest, id: unknown,
  opts: { purpose: 'register' | 'login'; userId?: number; sessionId?: string }
): Promise<string> {
  if (typeof id !== 'string' || id === '') throw Errors.unauthorized('auth.passkeyFailed')
  const r = await req.pool.query<{ challenge: string }>(
    `DELETE FROM webauthn_challenge
      WHERE id = $1 AND purpose = $2 AND expires_at > now()
        AND ($3::bigint IS NULL OR user_id = $3)
        AND ($4::text IS NULL OR session_id = $4)
      RETURNING challenge`,
    [id, opts.purpose, opts.userId ?? null, opts.sessionId ?? null])
  const c = r.rows[0]
  if (c === undefined) throw Errors.unauthorized('auth.passkeyFailed')
  return c.challenge
}

/**
 * Optionen fuer `navigator.credentials.get()`.
 *
 * Ohne Liste erlaubter Schluessel: der Browser bietet jeden Passkey an, den
 * er fuer diese Domain kennt, und der Benutzer muss vorher nichts tippen.
 * Damit verraet die Anfrage auch nicht, welche Konten Passkeys haben -- sie
 * nennt gar kein Konto.
 *
 * Mit Pruefung des Benutzers (`required`): ein Passkey, der nur Besitz
 * beweist, waere ein Schluessel, den jeder benutzt, der das Telefon
 * entsperrt in der Hand haelt.
 */
export async function anmeldeOptionen(
  req: FastifyRequest
): Promise<PasskeyOptionen<PublicKeyCredentialRequestOptionsJSON>> {
  const options = await generateAuthenticationOptions({
    rpID: passkeyPartei().rpID,
    userVerification: 'required',
    timeout: HERAUSFORDERUNG_MS
  })
  const challengeId = await herausforderungAblegen(req,
    { purpose: 'login', challenge: options.challenge })
  return { challengeId, options }
}

/**
 * Optionen fuer die Bestaetigung einer kritischen Handlung (0209): wie die
 * Anmeldung, aber nur mit den eigenen Passkeys. Der Browser bietet dann
 * keinen Schluessel eines anderen Kontos an, das auf diesem Rechner auch
 * einen hat -- am Tresen ist das der Normalfall. Gepruefte Zugehoerigkeit
 * macht trotzdem erst `pruefePasskeyAntwort` mit `nurFuer`.
 */
export async function bestaetigungsOptionen(
  req: FastifyRequest, userId: number
): Promise<PasskeyOptionen<PublicKeyCredentialRequestOptionsJSON>> {
  const eigene = await req.pool.query<{ credential_id: string; transports: string[] }>(
    `SELECT credential_id, transports FROM user_passkey WHERE user_id = $1`, [userId])
  if (eigene.rows.length === 0) throw Errors.unauthorized('auth.passkeyFailed')
  const options = await generateAuthenticationOptions({
    rpID: passkeyPartei().rpID,
    userVerification: 'required',
    timeout: HERAUSFORDERUNG_MS,
    allowCredentials: eigene.rows.map(k => ({ id: k.credential_id, transports: k.transports }))
  })
  const challengeId = await herausforderungAblegen(req,
    { purpose: 'login', challenge: options.challenge })
  return { challengeId, options }
}

function istAntwort(v: unknown): v is AuthenticationResponseJSON {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.response === 'object' && o.response !== null
}

/**
 * Eine Passkey-Antwort pruefen und sagen, wem der Passkey gehoert.
 *
 * Fuer die Anmeldung und fuer jede spaetere Stelle, die einen Passkey als
 * Nachweis nimmt (Bestaetigung einer kritischen Handlung). `nurFuer` legt
 * fest, dass der Passkey diesem Benutzer gehoeren muss; ohne ist jeder
 * eigene Passkey eines aktiven Zugangs recht.
 *
 * Jede Abweichung ergibt dieselbe Meldung: unbekannter Schluessel, falsche
 * Unterschrift, abgelaufene Herausforderung, stillgelegter Zugang. Wer
 * unterscheidet, verraet, welche Schluessel es gibt.
 */
export async function pruefePasskeyAntwort(
  req: FastifyRequest, challengeId: unknown, antwort: unknown, nurFuer: number | null
): Promise<number> {
  const challenge = await herausforderungEinloesen(req, challengeId, { purpose: 'login' })
  if (!istAntwort(antwort)) throw Errors.unauthorized('auth.passkeyFailed')

  const { rows } = await req.pool.query<{
    id: number; user_id: number; public_key: Buffer; sign_count: string
    transports: string[]; public_ref: string; status: string; locked_until: string | null }>(
    `SELECT k.id, k.user_id, k.public_key, k.sign_count::text, k.transports,
            u.public_ref, u.status, u.locked_until::text
       FROM user_passkey k JOIN app_user u ON u.id = k.user_id
      WHERE k.credential_id = $1`, [antwort.id])
  const k = rows[0]
  if (k === undefined) throw Errors.unauthorized('auth.passkeyFailed')
  if (nurFuer !== null && k.user_id !== nurFuer) throw Errors.unauthorized('auth.passkeyFailed')
  // Die Sperre von Hand gilt auch hier: die Aufsicht legt ein Konto still,
  // ohne zu wissen, womit sich jemand anmeldet.
  if (k.status !== 'active'
      || (k.locked_until !== null && Date.parse(k.locked_until) > Date.now())) {
    throw Errors.unauthorized('auth.passkeyFailed')
  }
  /*
   * Der Browser schickt mit, zu welchem Benutzer der Passkey angelegt wurde.
   * Er muss zu dem passen, dem der Schluessel hier gehoert -- sonst haette
   * jemand denselben Schluessel unter zwei Konten, und die Anmeldung waehlte
   * eines davon nach Zufall.
   */
  const handle = antwort.response.userHandle
  if (handle !== undefined && handle !== null
      && Buffer.from(handle, 'base64url').toString('utf8') !== k.public_ref) {
    throw Errors.unauthorized('auth.passkeyFailed')
  }

  const partei = passkeyPartei()
  let ergebnis: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
  try {
    ergebnis = await verifyAuthenticationResponse({
      response: antwort,
      expectedChallenge: challenge,
      expectedOrigin: partei.origin,
      expectedRPID: partei.rpID,
      requireUserVerification: true,
      credential: { id: antwort.id, publicKey: new Uint8Array(k.public_key),
                    counter: Number(k.sign_count), transports: k.transports }
    })
  } catch {
    throw Errors.unauthorized('auth.passkeyFailed')
  }
  if (!ergebnis.verified) throw Errors.unauthorized('auth.passkeyFailed')

  await req.pool.query(
    `UPDATE user_passkey SET sign_count = $2, last_used_at = now() WHERE id = $1`,
    [k.id, ergebnis.authenticationInfo.newCounter])
  return k.user_id
}
