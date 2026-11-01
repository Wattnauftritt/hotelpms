import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { MCP_CLIENT_ID, MCP_REDIRECT_URIS } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { hashPassword } from '../routes/auth.js'
import { limiters } from '../platform/rateLimit.js'
import { Geraet } from './passkeyGeraet.js'

/*
 * Der Claude-Zugang von der Seite der API (0222, Dokument 38): Verbinden
 * ueber OAuth mit PKCE, der Notschalter und die Freigabe von Klartext mit
 * einem Passkey, der genau diese Anfrage unterschreibt.
 *
 * Festgehalten wird, wo der Zugang zur Hintertuer wuerde: ein Code ohne
 * passenden Verifier, ein Code zweimal, eine fremde Weiterleitung, Support
 * ohne das Recht, eine Freigabe mit einer allgemeinen Bestaetigung statt
 * mit der Unterschrift fuer die Anfrage.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let sven: { userId: number; sessionId: string }
let support: { userId: number; sessionId: string }

const KENNWORT = 'ein-ausreichend-langes-kennwort'
const REDIRECT = MCP_REDIRECT_URIS[0]!
const auth = (s: string) => ({ cookie: `hp_session=${s}` })

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
  sven = await makeUser(owner, { email: 'sven@wir.de', platformRoleKey: 'platform_admin',
                                 isPlatformStaff: true })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'owner' AND account_id IS NULL`,
    [sven.userId, fx.accountId])
  support = await makeUser(owner, { email: 'support@wir.de', platformRoleKey: 'platform_support',
                                    isPlatformStaff: true })
})

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers })

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function zustimmen(session = sven.sessionId, challenge = pkce().challenge) {
  return post('/v1/platform/mcp/consent', { clientId: MCP_CLIENT_ID, redirectUri: REDIRECT,
    codeChallenge: challenge, codeChallengeMethod: 'S256', state: 'xyz' }, auth(session))
}

async function verbinden(): Promise<string> {
  const p = pkce()
  const z = await zustimmen(sven.sessionId, p.challenge)
  expect(z.statusCode, z.body).toBe(200)
  const code = new URL(z.json<{ redirectTo: string }>().redirectTo).searchParams.get('code')!
  const t = await app.inject({ method: 'POST', url: '/v1/mcp/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'authorization_code', code,
      redirect_uri: REDIRECT, client_id: MCP_CLIENT_ID, code_verifier: p.verifier }).toString() })
  expect(t.statusCode, t.body).toBe(200)
  return t.json<{ access_token: string }>().access_token
}

describe('Verbinden', () => {
  it('registriert nur claude.ai', async () => {
    const r = await post('/v1/mcp/oauth/register', { redirect_uris: [REDIRECT] })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ client_id: MCP_CLIENT_ID })
    const f = await post('/v1/mcp/oauth/register', { redirect_uris: ['https://boese.example/cb'] })
    expect(f.statusCode).toBe(400)
  })

  it('gibt einen Code an claude.ai und tauscht ihn mit PKCE gegen ein Token', async () => {
    const p = pkce()
    const z = await zustimmen(sven.sessionId, p.challenge)
    expect(z.statusCode, z.body).toBe(200)
    const ziel = new URL(z.json<{ redirectTo: string }>().redirectTo)
    expect(`${ziel.origin}${ziel.pathname}`).toBe(REDIRECT)
    expect(ziel.searchParams.get('state')).toBe('xyz')
    const code = ziel.searchParams.get('code')!

    const tauschen = (verifier: string) => post('/v1/mcp/oauth/token', {
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
      client_id: MCP_CLIENT_ID, code_verifier: verifier })

    // Falscher Verifier: abgewiesen, und der Code ist danach verbraucht.
    expect((await tauschen(pkce().verifier)).statusCode).toBe(400)
    expect((await tauschen(p.verifier)).statusCode).toBe(400)

    const token = await verbinden()
    expect(token).toMatch(/^sgmcp_/)
    const v = await owner.query<{ token_hash: Buffer; expires_at: Date }>(
      `SELECT token_hash, expires_at FROM mcp_connection WHERE revoked_at IS NULL`)
    expect(v.rows).toHaveLength(1)
    expect(v.rows[0]!.token_hash.equals(createHash('sha256').update(token).digest())).toBe(true)
    const stunden = (new Date(v.rows[0]!.expires_at).getTime() - Date.now()) / 3_600_000
    expect(stunden).toBeGreaterThan(7.9)
    expect(stunden).toBeLessThanOrEqual(8)

    const e = await owner.query(`SELECT 1 FROM security_event WHERE kind = 'mcp_connected'`)
    expect(e.rows).toHaveLength(1)
  })

  it('verlangt das Recht: Support darf Claude nicht anschliessen', async () => {
    expect((await zustimmen(support.sessionId)).statusCode).toBe(403)
  })

  it('verlangt eine frische Bestaetigung', async () => {
    const u = await makeUser(owner, { email: 'zweiter@wir.de', platformRoleKey: 'platform_admin',
                                      isPlatformStaff: true, confirmed: false })
    const r = await zustimmen(u.sessionId)
    expect(r.statusCode).toBe(403)
    expect(r.body).toMatch(/confirmation_required|bestaetig/i)
  })

  it('nimmt keine fremde Weiterleitung an', async () => {
    const r = await post('/v1/platform/mcp/consent', { clientId: MCP_CLIENT_ID,
      redirectUri: 'https://boese.example/cb', codeChallenge: pkce().challenge,
      codeChallengeMethod: 'S256' }, auth(sven.sessionId))
    expect(r.statusCode).toBe(422)
  })
})

describe('Notschalter', () => {
  it('beendet Verbindungen und laesst kein neues Verbinden zu', async () => {
    await verbinden()
    const s = await post('/v1/platform/mcp/lock', { locked: true }, auth(sven.sessionId))
    expect(s.statusCode, s.body).toBe(200)
    const v = await owner.query(`SELECT 1 FROM mcp_connection WHERE revoked_at IS NULL`)
    expect(v.rows).toHaveLength(0)
    expect((await zustimmen()).statusCode).toBe(409)

    const o = await app.inject({ url: '/v1/platform/mcp', headers: auth(sven.sessionId) })
    expect(o.json()).toMatchObject({ locked: true })
  })

  it('loest die Sperre nur mit Bestaetigung', async () => {
    await post('/v1/platform/mcp/lock', { locked: true }, auth(sven.sessionId))
    await owner.query(`UPDATE user_session SET confirmed_at = NULL WHERE id = $1`,
                      [sven.sessionId])
    expect((await post('/v1/platform/mcp/lock', { locked: false },
                       auth(sven.sessionId))).statusCode).toBe(403)
  })
})

describe('Klartext freigeben', () => {
  let geraet: Geraet

  beforeEach(async () => {
    await owner.query(`UPDATE app_user SET password_hash = $2 WHERE id = $1`,
      [sven.userId, await hashPassword(KENNWORT)])
    geraet = new Geraet()
    const o = await post('/v1/auth/passkey/register/options', { currentPassword: KENNWORT },
                         auth(sven.sessionId))
    expect(o.statusCode, o.body).toBe(200)
    const { challengeId, options } = o.json<{ challengeId: string
      options: { challenge: string; user: { id: string } } }>()
    const r = await post('/v1/auth/passkey/register',
      { challengeId, name: 'Telefon', response: geraet.anlegen(options) }, auth(sven.sessionId))
    expect(r.statusCode, r.body).toBe(201)

    await verbinden()
  })

  async function anfragen(haus = fx.propertyId): Promise<{ ref: string; code: string }> {
    const v = await owner.query<{ id: string }>(`SELECT id FROM mcp_connection`)
    const r = await owner.query<{ ref: string; abgleich: string }>(
      `SELECT * FROM mcp_dienst.freigabe_anfragen($1, $2, 'Doppelte Anreise pruefen')`,
      [v.rows[0]!.id, haus])
    return { ref: r.rows[0]!.ref, code: r.rows[0]!.abgleich }
  }

  it('gibt mit dem Passkey frei, fuer genau diese Anfrage', async () => {
    const a = await anfragen()
    expect((await owner.query(`SELECT 1 FROM staff_push WHERE kind = 'mcp_release'`)).rows)
      .toHaveLength(1)
    const p = await app.inject({ url: '/v1/platform/mcp/pending', headers: auth(sven.sessionId) })
    expect(p.json()).toEqual({ pending: 1 })

    const o = await post(`/v1/platform/mcp/releases/${a.ref}/options`, {}, auth(sven.sessionId))
    expect(o.statusCode, o.body).toBe(200)
    const { challengeId, options, matchCode } = o.json<{ challengeId: string
      options: { challenge: string }; matchCode: string }>()
    expect(matchCode).toBe(a.code)

    const g = await post(`/v1/platform/mcp/releases/${a.ref}/grant`,
      { challengeId, response: geraet.anmelden(options.challenge) }, auth(sven.sessionId))
    expect(g.statusCode, g.body).toBe(200)

    const f = await owner.query<{ granted_by: string; expires_at: Date }>(
      `SELECT granted_by, expires_at FROM mcp_release`)
    expect(Number(f.rows[0]!.granted_by)).toBe(sven.userId)
    const minuten = (new Date(f.rows[0]!.expires_at).getTime() - Date.now()) / 60_000
    expect(minuten).toBeGreaterThan(59)
    expect(minuten).toBeLessThanOrEqual(60)
    expect((await owner.query(
      `SELECT 1 FROM security_event WHERE kind = 'mcp_release_granted'`)).rows).toHaveLength(1)
  })

  it('nimmt keine Unterschrift fuer eine andere Anfrage an', async () => {
    const a = await anfragen()
    const b = await anfragen()
    const o = await post(`/v1/platform/mcp/releases/${a.ref}/options`, {}, auth(sven.sessionId))
    const { challengeId, options } = o.json<{ challengeId: string
      options: { challenge: string } }>()
    const g = await post(`/v1/platform/mcp/releases/${b.ref}/grant`,
      { challengeId, response: geraet.anmelden(options.challenge) }, auth(sven.sessionId))
    expect(g.statusCode).not.toBe(200)
    expect((await owner.query(`SELECT 1 FROM mcp_release WHERE granted_at IS NOT NULL`)).rows)
      .toHaveLength(0)
  })

  it('nimmt keine allgemeine Bestaetigung als Freigabe', async () => {
    const a = await anfragen()
    const o = await post('/v1/auth/passkey/confirm/options', {}, auth(sven.sessionId))
    const { challengeId, options } = o.json<{ challengeId: string
      options: { challenge: string } }>()
    const g = await post(`/v1/platform/mcp/releases/${a.ref}/grant`,
      { challengeId, response: geraet.anmelden(options.challenge) }, auth(sven.sessionId))
    expect(g.statusCode).not.toBe(200)
  })

  it('gibt ein fremdes Haus ohne Support-Freigabe nicht frei', async () => {
    const fremd = await makeProperty(owner, { name: 'Fremd', code: 'FRMD' })
    const a = await anfragen(fremd.propertyId)
    const o = await post(`/v1/platform/mcp/releases/${a.ref}/options`, {}, auth(sven.sessionId))
    expect(o.statusCode).toBe(409)
  })

  it('lehnt ab und beendet', async () => {
    const a = await anfragen()
    const r = await post(`/v1/platform/mcp/releases/${a.ref}/close`, {}, auth(sven.sessionId))
    expect(r.json()).toEqual({ state: 'denied' })
    expect((await post(`/v1/platform/mcp/releases/${a.ref}/options`, {},
                       auth(sven.sessionId))).statusCode).toBe(409)
  })

  it('haelt hoechstens drei offene Anfragen', async () => {
    await anfragen(); await anfragen(); await anfragen()
    await expect(anfragen()).rejects.toThrow(/mcp_too_many_requests/)
  })
})
