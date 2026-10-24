import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { hashPassword } from '../routes/auth.js'
import { limiters } from '../platform/rateLimit.js'
import { passkeyPartei } from '../platform/passkey.js'

/**
 * Passkeys (Migration 0207), gegen ein Geraet aus Software.
 *
 * Kein Mock der Bibliothek: die Pruefung von Unterschrift, Herkunft,
 * Domain und Herausforderung ist genau das, was hier stimmen muss. Der Test
 * baut deshalb, was ein Telefon baut -- ein Schluesselpaar, die
 * Authenticator-Daten, CBOR, die Unterschrift --, und schickt es durch die
 * echten Routen.
 *
 * Was festgehalten wird, sind die Stellen, an denen ein Passkey zur
 * Hintertuer wuerde: Anlegen ohne Kennwort, dieselbe Antwort zweimal, eine
 * Herausforderung aus einer fremden Sitzung, ein stillgelegter Zugang, eine
 * fremde Herkunft.
 */

// ---------------------------------------------------------------- CBOR, knapp
function kopf(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 256) return Buffer.from([(major << 5) | 24, n])
  const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b
}
function cbor(v: unknown): Buffer {
  if (typeof v === 'number') return v >= 0 ? kopf(0, v) : kopf(1, -1 - v)
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([kopf(3, b.length), b]) }
  if (Buffer.isBuffer(v)) return Buffer.concat([kopf(2, v.length), v])
  if (v instanceof Map) {
    return Buffer.concat([kopf(5, v.size), ...[...v].flatMap(([k, w]) => [cbor(k), cbor(w)])])
  }
  throw new Error('nicht unterstuetzt')
}
const b64u = (b: Buffer): string => b.toString('base64url')
const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest()

/** Ein Passkey aus Software, mit Pruefung des Benutzers. */
class Geraet {
  readonly credId = randomBytes(16)
  readonly privat: KeyObject
  readonly oeffentlich: KeyObject
  zaehler = 0
  constructor(readonly herkunft = passkeyPartei().origin,
              readonly rpId = passkeyPartei().rpID) {
    const p = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privat = p.privateKey
    this.oeffentlich = p.publicKey
  }

  private coseSchluessel(): Buffer {
    const jwk = this.oeffentlich.export({ format: 'jwk' })
    return cbor(new Map<number, unknown>([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]))
  }

  anlegen(options: { challenge: string; user: { id: string } }): unknown {
    const clientData = Buffer.from(JSON.stringify({
      type: 'webauthn.create', challenge: options.challenge, origin: this.herkunft,
      crossOrigin: false }))
    const laenge = Buffer.alloc(2); laenge.writeUInt16BE(this.credId.length)
    const authData = Buffer.concat([
      sha256(this.rpId), Buffer.from([0x45]) /* UP, UV, AT */, Buffer.alloc(4),
      Buffer.alloc(16), laenge, this.credId, this.coseSchluessel()])
    this.benutzer = options.user.id
    return {
      id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientData),
        attestationObject: b64u(cbor(new Map<string, unknown>([
          ['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))),
        transports: ['internal']
      }
    }
  }

  benutzer = ''

  anmelden(challenge: string, flags = 0x05 /* UP, UV */): unknown {
    this.zaehler++
    const clientData = Buffer.from(JSON.stringify({
      type: 'webauthn.get', challenge, origin: this.herkunft, crossOrigin: false }))
    const z = Buffer.alloc(4); z.writeUInt32BE(this.zaehler)
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([flags]), z])
    const signatur = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privat)
    return {
      id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientData), authenticatorData: b64u(authData),
        signature: b64u(signatur), userHandle: this.benutzer
      }
    }
  }
}

// ---------------------------------------------------------------- Aufbau
let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let userId: number
let auth: Record<string, string>

const KENNWORT = 'ein-ausreichend-langes-kennwort'

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(10) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

beforeEach(async () => {
  await truncateAll()
  limiters.reset()
  fx = await makeProperty(owner)
  // Unbestaetigt: sonst saehe die Bestaetigung per Passkey unten nichts.
  const u = await makeUser(owner, { email: 'rezeption@test.de', propertyId: fx.propertyId,
                                    roleKey: 'reception', confirmed: false })
  userId = u.userId
  await owner.query(`UPDATE app_user SET password_hash = $2 WHERE id = $1`,
    [userId, await hashPassword(KENNWORT)])
  auth = { cookie: `hp_session=${u.sessionId}` }
})

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers })

async function anlegen(geraet: Geraet, headers = auth, name = 'Mein Telefon') {
  const o = await post('/v1/auth/passkey/register/options',
    { currentPassword: KENNWORT }, headers)
  expect(o.statusCode, o.body).toBe(200)
  const { challengeId, options } = o.json<{ challengeId: string
    options: { challenge: string; user: { id: string } } }>()
  return post('/v1/auth/passkey/register',
    { challengeId, name, response: geraet.anlegen(options) }, headers)
}

async function anmeldeHerausforderung(): Promise<{ challengeId: string; challenge: string }> {
  const o = await post('/v1/auth/passkey/login/options', {})
  expect(o.statusCode, o.body).toBe(200)
  const j = o.json<{ challengeId: string; options: { challenge: string } }>()
  return { challengeId: j.challengeId, challenge: j.options.challenge }
}

// ---------------------------------------------------------------- Faelle
describe('Passkey anlegen', () => {
  it('legt ihn an, meldet es per Mail ohne Link und protokolliert ohne Bezeichnung', async () => {
    const r = await anlegen(new Geraet())
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ name: 'Mein Telefon', lastUsedAt: null })

    const post_ = await owner.query<{ body_text: string }>(
      `SELECT body_text FROM platform_email WHERE kind = 'passkey_added' AND user_id = $1`,
      [userId])
    expect(post_.rows).toHaveLength(1)
    expect(post_.rows[0]!.body_text).not.toMatch(/https?:\/\//)

    const a = await owner.query<{ changed: Record<string, unknown> }>(
      `SELECT changed FROM audit_log WHERE table_name = 'user_passkey' AND action = 'INSERT'`)
    expect(a.rows).toHaveLength(1)
    expect(a.rows[0]!.changed.name).toBe('[redigiert]')
  })

  it('verlangt das aktuelle Kennwort, nicht nur die Sitzung', async () => {
    const r = await post('/v1/auth/passkey/register/options',
      { currentPassword: 'falsch-aber-lang-genug' }, auth)
    expect(r.statusCode).toBe(401)
    const f = await owner.query(`SELECT 1 FROM login_failure WHERE user_id = $1`, [userId])
    expect(f.rows).toHaveLength(1)
  })

  it('nimmt die Herausforderung nicht aus einer anderen Sitzung an', async () => {
    /*
     * Wer am Tresen das Kennwort mitgelesen hat, soll die Herausforderung
     * nicht in einer zweiten Sitzung desselben Benutzers einloesen koennen.
     */
    const o = await post('/v1/auth/passkey/register/options',
      { currentPassword: KENNWORT }, auth)
    const { challengeId, options } = o.json<{ challengeId: string
      options: { challenge: string; user: { id: string } } }>()
    const zweite = `sess_zweite_${Date.now()}`
    await owner.query(
      `INSERT INTO user_session (id, user_id, expires_at, absolute_expires_at)
       VALUES ($1, $2, now() + interval '1 hour', now() + interval '8 hours')`,
      [zweite, userId])
    const r = await post('/v1/auth/passkey/register',
      { challengeId, name: 'x', response: new Geraet().anlegen(options) },
      { cookie: `hp_session=${zweite}` })
    expect(r.statusCode).toBe(401)
  })

  it('weist eine Antwort von fremder Herkunft ab', async () => {
    const r = await anlegen(new Geraet('https://staygrid-login.example'))
    expect(r.statusCode).toBe(422)
  })

  it('verlangt eine Sitzung', async () => {
    const r = await post('/v1/auth/passkey/register/options', { currentPassword: KENNWORT })
    expect(r.statusCode).toBe(401)
  })
})

describe('Mit Passkey anmelden', () => {
  it('meldet an und gibt eine Sitzung, die traegt', async () => {
    const g = new Geraet()
    expect((await anlegen(g)).statusCode).toBe(201)

    const { challengeId, challenge } = await anmeldeHerausforderung()
    const r = await post('/v1/auth/passkey/login', { challengeId, response: g.anmelden(challenge) })
    expect(r.statusCode, r.body).toBe(200)
    const cookie = r.cookies.find(c => c.name === 'hp_session')
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite).toBe('Strict')

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me',
      headers: { cookie: `hp_session=${cookie!.value}` } })
    expect(me.statusCode).toBe(200)

    const k = await owner.query<{ last_used_at: string | null; sign_count: string }>(
      `SELECT last_used_at, sign_count::text FROM user_passkey WHERE user_id = $1`, [userId])
    expect(k.rows[0]!.last_used_at).not.toBeNull()
    expect(k.rows[0]!.sign_count).toBe('1')
  })

  it('nimmt dieselbe Antwort kein zweites Mal', async () => {
    const g = new Geraet()
    await anlegen(g)
    const { challengeId, challenge } = await anmeldeHerausforderung()
    const antwort = g.anmelden(challenge)
    expect((await post('/v1/auth/passkey/login', { challengeId, response: antwort }))
      .statusCode).toBe(200)
    expect((await post('/v1/auth/passkey/login', { challengeId, response: antwort }))
      .statusCode).toBe(401)
  })

  it('verlangt die Pruefung des Benutzers, nicht nur Besitz', async () => {
    const g = new Geraet()
    await anlegen(g)
    const { challengeId, challenge } = await anmeldeHerausforderung()
    const r = await post('/v1/auth/passkey/login',
      { challengeId, response: g.anmelden(challenge, 0x01 /* nur UP */) })
    expect(r.statusCode).toBe(401)
  })

  it('laesst einen stillgelegten Zugang nicht herein', async () => {
    const g = new Geraet()
    await anlegen(g)
    await owner.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [userId])
    const { challengeId, challenge } = await anmeldeHerausforderung()
    const r = await post('/v1/auth/passkey/login', { challengeId, response: g.anmelden(challenge) })
    expect(r.statusCode).toBe(401)
  })

  it('kennt keinen Schluessel, der nie angelegt wurde', async () => {
    const g = new Geraet()
    g.benutzer = 'irgendwer'
    const { challengeId, challenge } = await anmeldeHerausforderung()
    const r = await post('/v1/auth/passkey/login', { challengeId, response: g.anmelden(challenge) })
    expect(r.statusCode).toBe(401)
  })
})

describe('Eigene Passkeys verwalten', () => {
  it('listet ohne Schluessel und entfernt nur die eigenen', async () => {
    expect((await anlegen(new Geraet())).statusCode).toBe(201)
    const l = await app.inject({ method: 'GET', url: '/v1/auth/passkeys', headers: auth })
    const { passkeys } = l.json<{ passkeys: Array<Record<string, unknown>> }>()
    expect(passkeys).toHaveLength(1)
    expect(Object.keys(passkeys[0]!).sort())
      .toEqual(['backedUp', 'createdAt', 'id', 'lastUsedAt', 'name'])

    const andere = await makeUser(owner,
      { email: 'andere@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const fremd = await app.inject({ method: 'DELETE',
      url: `/v1/auth/passkeys/${passkeys[0]!.id}`,
      headers: { cookie: `hp_session=${andere.sessionId}` } })
    expect(fremd.statusCode).toBe(404)

    const eigen = await app.inject({ method: 'DELETE',
      url: `/v1/auth/passkeys/${passkeys[0]!.id}`, headers: auth })
    expect(eigen.statusCode).toBe(204)
    const rest = await owner.query(`SELECT 1 FROM user_passkey WHERE user_id = $1`, [userId])
    expect(rest.rows).toHaveLength(0)
  })
})

describe('Kritische Handlung mit Passkey bestaetigen (0209)', () => {
  const bestaetigt = async (headers: Record<string, string>): Promise<boolean> =>
    (await app.inject({ method: 'GET', url: '/v1/auth/confirm', headers }))
      .json<{ confirmed: boolean }>().confirmed

  async function bestaetigen(g: Geraet, headers: Record<string, string>) {
    const o = await post('/v1/auth/passkey/confirm/options', {}, headers)
    if (o.statusCode !== 200) return o
    const j = o.json<{ challengeId: string; options: { challenge: string
      allowCredentials: Array<{ id: string }> } }>()
    return post('/v1/auth/passkey/confirm',
      { challengeId: j.challengeId, response: g.anmelden(j.options.challenge) }, headers)
  }

  it('bestaetigt die Sitzung und bietet nur die eigenen Passkeys an', async () => {
    const g = new Geraet()
    await anlegen(g)
    expect(await bestaetigt(auth)).toBe(false)
    const o = await post('/v1/auth/passkey/confirm/options', {}, auth)
    expect(o.json<{ options: { allowCredentials: Array<{ id: string }> } }>()
      .options.allowCredentials.map(c => c.id)).toEqual([g.credId.toString('base64url')])
    const r = await bestaetigen(g, auth)
    expect(r.statusCode, r.body).toBe(200)
    expect(await bestaetigt(auth)).toBe(true)
  })

  it('nimmt keinen Passkey einer anderen Person', async () => {
    /*
     * Am Tresen liegen Passkeys mehrerer Leute im selben Browser. Wer in
     * der Sitzung von A steht, darf mit dem Passkey von B nicht bestaetigen.
     */
    const gA = new Geraet()
    await anlegen(gA)
    const b = await makeUser(owner,
      { email: 'b@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    await owner.query(`UPDATE app_user SET password_hash = $2 WHERE id = $1`,
      [b.userId, await hashPassword(KENNWORT)])
    const authB = { cookie: `hp_session=${b.sessionId}` }
    const gB = new Geraet()
    expect((await anlegen(gB, authB)).statusCode).toBe(201)

    const r = await bestaetigen(gB, auth)
    expect(r.statusCode).toBe(401)
    expect(await bestaetigt(auth)).toBe(false)
    const e = await owner.query(
      `SELECT 1 FROM security_event WHERE kind = 'confirmation_failed'`)
    expect(e.rows.length).toBeGreaterThan(0)
  })

  it('verlangt einen eigenen Passkey', async () => {
    const r = await post('/v1/auth/passkey/confirm/options', {}, auth)
    expect(r.statusCode).toBe(401)
  })

  it('eine Passkey-Anmeldung beginnt bestaetigt, eine mit Kennwort nicht', async () => {
    const g = new Geraet()
    await anlegen(g)
    const { challengeId, challenge } = await anmeldeHerausforderung()
    const r = await post('/v1/auth/passkey/login', { challengeId, response: g.anmelden(challenge) })
    const cookie = r.cookies.find(c => c.name === 'hp_session')!
    expect(await bestaetigt({ cookie: `hp_session=${cookie.value}` })).toBe(true)

    const k = await post('/v1/auth/login', { email: 'rezeption@test.de', password: KENNWORT })
    const kc = k.cookies.find(c => c.name === 'hp_session')!
    expect(await bestaetigt({ cookie: `hp_session=${kc.value}` })).toBe(false)
  })
})
