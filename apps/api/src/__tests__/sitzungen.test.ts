import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Eigene Anmeldungen sehen und beenden, und die eines Mitarbeiters
 * (Bedrohungsanalyse 23.10.2026, A5).
 */
let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture

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
})

const cookie = (id: string) => ({ cookie: `hp_session=${id}` })

async function zweiteSitzung(userId: number, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0'): Promise<string> {
  const id = `sess_zwei_${Math.random().toString(36).slice(2)}`
  await owner.query(
    `INSERT INTO user_session (id, user_id, expires_at, absolute_expires_at, ip, user_agent)
     VALUES ($1, $2, now() + interval '1 hour', now() + interval '8 hours', '192.0.2.44', $3)`,
    [id, userId, ua])
  return id
}

interface Liste { sessions: Array<{ ref: string; current: boolean; ip: string | null }> }

describe('Eigene Anmeldungen', () => {
  it('listet ohne die Kennung und beendet eine fremde', async () => {
    const u = await makeUser(owner, { email: 'r@test.de', propertyId: fx.propertyId,
                                      roleKey: 'reception' })
    const zweite = await zweiteSitzung(u.userId)
    const l = await app.inject({ method: 'GET', url: '/v1/auth/sessions',
                                 headers: cookie(u.sessionId) })
    expect(l.statusCode).toBe(200)
    expect(l.body).not.toContain(u.sessionId)
    expect(l.body).not.toContain(zweite)
    const { sessions } = l.json<Liste>()
    expect(sessions).toHaveLength(2)
    const fremd = sessions.find(s => !s.current)!
    expect(fremd.ip).toBe('192.0.2.44')

    const r = await app.inject({ method: 'POST', url: `/v1/auth/sessions/${fremd.ref}/revoke`,
                                 headers: cookie(u.sessionId) })
    expect(r.statusCode).toBe(200)
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: cookie(zweite) })
    expect(me.statusCode).toBe(401)
  })

  it('beendet keine Anmeldung eines anderen ueber dessen Abdruck', async () => {
    const a = await makeUser(owner, { email: 'a@test.de', propertyId: fx.propertyId,
                                      roleKey: 'reception' })
    const b = await makeUser(owner, { email: 'b@test.de', propertyId: fx.propertyId,
                                      roleKey: 'reception' })
    const { sessions } = (await app.inject({ method: 'GET', url: '/v1/auth/sessions',
      headers: cookie(b.sessionId) })).json<Liste>()
    const r = await app.inject({ method: 'POST',
      url: `/v1/auth/sessions/${sessions[0]!.ref}/revoke`, headers: cookie(a.sessionId) })
    expect(r.statusCode).toBe(404)
  })

  it('beendet alle anderen und laesst die eigene stehen', async () => {
    const u = await makeUser(owner, { email: 'r@test.de', propertyId: fx.propertyId,
                                      roleKey: 'reception' })
    await zweiteSitzung(u.userId)
    await zweiteSitzung(u.userId)
    const r = await app.inject({ method: 'POST', url: '/v1/auth/sessions/revoke-others',
                                 headers: cookie(u.sessionId) })
    expect(r.json<{ revoked: number }>().revoked).toBe(2)
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: cookie(u.sessionId) })
    expect(me.statusCode).toBe(200)
  })
})

describe('Anmeldungen eines Mitarbeiters beenden', () => {
  it('die Hausleitung beendet die Anmeldungen der Rezeption', async () => {
    const chef = await makeUser(owner, { email: 'chef@test.de', propertyId: fx.propertyId,
                                         roleKey: 'hotel_director' })
    const r = await makeUser(owner, { email: 'r@test.de', propertyId: fx.propertyId,
                                      roleKey: 'reception' })
    await zweiteSitzung(r.userId)
    const { rows: [ref] } = await owner.query<{ public_ref: string }>(
      'SELECT public_ref FROM app_user WHERE id = $1', [r.userId])
    const a = await app.inject({ method: 'POST',
      url: `/v1/properties/${fx.propertyId}/users/${ref!.public_ref}/sessions/revoke`,
      headers: cookie(chef.sessionId) })
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json<{ revoked: number }>().revoked).toBe(2)
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: cookie(r.sessionId) })
    expect(me.statusCode).toBe(401)
  })

  it('aber nicht den Inhaber des Betriebs', async () => {
    const chef = await makeUser(owner, { email: 'chef@test.de', propertyId: fx.propertyId,
                                         roleKey: 'hotel_director' })
    const inhaber = await makeUser(owner, { email: 'inhaber@test.de', accountId: fx.accountId,
                                            roleKey: 'owner' })
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'reception' AND account_id IS NULL`,
      [inhaber.userId, fx.propertyId])
    const { rows: [ref] } = await owner.query<{ public_ref: string }>(
      'SELECT public_ref FROM app_user WHERE id = $1', [inhaber.userId])
    const a = await app.inject({ method: 'POST',
      url: `/v1/properties/${fx.propertyId}/users/${ref!.public_ref}/sessions/revoke`,
      headers: cookie(chef.sessionId) })
    expect(a.statusCode).toBe(403)
  })
})
