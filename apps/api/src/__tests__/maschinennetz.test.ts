import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Maschinenzugang nur aus genannten Netzen (Migration 0212, Bedrohungsanalyse
 * 23.10.2026, A4). Festgehalten wird, dass ein abgeflossenes Geheimnis und
 * ein abgeflossenes Token ausserhalb des Netzes nichts tragen, dass es
 * gemeldet wird und dass ein Zugang ohne Liste weiter ueberall gilt.
 */
let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: { cookie: string }

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
  const u = await makeUser(owner, { email: 'chef@test.de', accountId: fx.accountId,
                                    roleKey: 'owner' })
  chef = { cookie: `hp_session=${u.sessionId}` }
})

const von = (ip: string) => ({ 'x-forwarded-for': ip })

async function zugang(allowedNetworks?: string[]) {
  const r = await app.inject({ method: 'POST', url: '/v1/oauth-clients', headers: chef,
    payload: { name: 'Adminpanel', scopes: ['housekeeping:read'],
               propertyIds: [fx.propertyId], allowedNetworks } })
  expect(r.statusCode, r.body).toBe(201)
  return r.json<{ clientId: string; clientSecret: string; allowedNetworks: string[] }>()
}

const tokenAnfrage = (z: { clientId: string; clientSecret: string }, ip: string) =>
  app.inject({ method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...von(ip) },
    payload: new URLSearchParams({ grant_type: 'client_credentials',
      client_id: z.clientId, client_secret: z.clientSecret }).toString() })

const abrufen = (token: string, ip: string) => app.inject({ method: 'GET',
  url: `/v1/properties/${fx.propertyId}/housekeeping?date=2026-10-01`,
  headers: { authorization: `Bearer ${token}`, ...von(ip) } })

describe('Maschinenzugang an Netze gebunden', () => {
  it('speichert Netze und einzelne Adressen als Netz', async () => {
    const z = await zugang(['203.0.113.7', '198.51.100.9/24'])
    expect(z.allowedNetworks).toEqual(['203.0.113.7/32', '198.51.100.0/24'])
    const falsch = await app.inject({ method: 'POST', url: '/v1/oauth-clients', headers: chef,
      payload: { name: 'x', scopes: ['housekeeping:read'], allowedNetworks: ['10.0.0.300'] } })
    expect(falsch.statusCode).toBe(422)
  })

  it('gibt aus dem Netz ein Token, von woanders nicht, und meldet es', async () => {
    const z = await zugang(['203.0.113.0/24'])
    expect((await tokenAnfrage(z, '203.0.113.50')).statusCode).toBe(200)

    const fremd = await tokenAnfrage(z, '192.0.2.1')
    expect(fremd.statusCode).toBe(401)
    // Dieselbe Antwort wie ein falsches Geheimnis: der Dieb erfaehrt nicht,
    // dass es stimmt.
    expect(fremd.json<{ error: string }>().error).toBe('invalid_client')
    await tokenAnfrage(z, '192.0.2.1')

    const e = await owner.query<{ origin: string; actor_ref: string }>(
      `SELECT host(origin) AS origin, actor_ref FROM security_event
        WHERE kind = 'client_origin_denied'`)
    // Einmal je Stunde, nicht je Versuch.
    expect(e.rows).toEqual([{ origin: '192.0.2.1', actor_ref: z.clientId }])
    const hinweis = await owner.query(
      `SELECT 1 FROM platform_email WHERE kind = 'security_notice'`)
    expect(hinweis.rows.length).toBeGreaterThan(0)
  })

  it('laesst ein abgegriffenes Token ausserhalb des Netzes nicht tragen', async () => {
    const z = await zugang(['203.0.113.0/24'])
    const t = (await tokenAnfrage(z, '203.0.113.50')).json<{ access_token: string }>()
      .access_token
    expect((await abrufen(t, '203.0.113.51')).statusCode).toBe(200)
    expect((await abrufen(t, '192.0.2.1')).statusCode).toBe(401)
    const e = await owner.query(`SELECT 1 FROM security_event WHERE kind = 'client_origin_denied'`)
    expect(e.rows).toHaveLength(1)
  })

  it('gilt ohne Liste ueberall, wie bisher', async () => {
    const z = await zugang()
    const t = (await tokenAnfrage(z, '192.0.2.1')).json<{ access_token: string }>().access_token
    expect((await abrufen(t, '198.51.100.1')).statusCode).toBe(200)
  })

  it('verlangt fuer das Aendern der Netze eine Bestaetigung', async () => {
    const z = await zugang(['203.0.113.0/24'])
    const u = await makeUser(owner, { email: 'zweiter@test.de', accountId: fx.accountId,
                                      roleKey: 'owner', confirmed: false })
    const r = await app.inject({ method: 'PATCH', url: `/v1/oauth-clients/${z.clientId}`,
      headers: { cookie: `hp_session=${u.sessionId}` }, payload: { allowedNetworks: [] } })
    expect(r.statusCode).toBe(403)
    const ok = await app.inject({ method: 'PATCH', url: `/v1/oauth-clients/${z.clientId}`,
      headers: chef, payload: { allowedNetworks: [] } })
    expect(ok.json<{ allowedNetworks: string[] }>().allowedNetworks).toEqual([])
  })
})
