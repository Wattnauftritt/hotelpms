import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory,         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'

// Vor dem Laden der Konfiguration: ohne Domain lassen sich keine Koeder anlegen.
vi.hoisted(() => { process.env.DECOY_EMAIL_DOMAIN = 'post-ablage.example' })

import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Koeder (Migration 0213, Bedrohungsanalyse 23.10.2026, E5). Festgehalten
 * wird, dass der Koedergast in jeder Ausgabe die Kennung des Aufrufers
 * traegt, dass der Kunde seinen Koederzugang nicht sieht und dass jeder
 * Versuch damit gemeldet wird.
 */
let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let admin: { cookie: string }
let chef: { cookie: string; userId: number }

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
  await makeCategory(owner, fx.propertyId)
  const a = await makeUser(owner, { email: 'admin@wir.de',
    platformRoleKey: 'platform_admin', isPlatformStaff: true })
  admin = { cookie: `hp_session=${a.sessionId}` }
  const u = await makeUser(owner, { email: 'chef@test.de', accountId: fx.accountId,
                                    roleKey: 'owner' })
  chef = { cookie: `hp_session=${u.sessionId}`, userId: u.userId }
})

async function anlegen(): Promise<{ address: string; guestRef: string }> {
  const r = await app.inject({ method: 'POST', headers: admin,
    url: `/v1/platform/accounts/${fx.accountId}/properties/${fx.propertyId}/decoy` })
  expect(r.statusCode, r.body).toBe(201)
  const { address } = r.json<{ address: string }>()
  const g = await owner.query<{ public_ref: string }>(
    'SELECT public_ref FROM guest WHERE email = $1', [address])
  return { address, guestRef: g.rows[0]!.public_ref }
}

describe('Koedergast', () => {
  it('liegt storniert in der Zukunft und bindet keine Kapazitaet', async () => {
    const { address } = await anlegen()
    expect(address).toMatch(/^[a-z]+\.[a-z]+\d{2}@post-ablage\.example$/)
    const r = await owner.query<{ status: string; zukunft: boolean }>(
      `SELECT r.status, r.arrival > current_date + 100 AS zukunft
         FROM decoy d JOIN reservation r ON r.id = d.reservation_id`)
    expect(r.rows[0]).toEqual({ status: 'Canceled', zukunft: true })

    const zweiter = await app.inject({ method: 'POST', headers: admin,
      url: `/v1/platform/accounts/${fx.accountId}/properties/${fx.propertyId}/decoy` })
    expect(zweiter.statusCode).toBe(409)
  })

  it('traegt in der Antwort die Kennung des Aufrufers', async () => {
    const { address, guestRef } = await anlegen()
    const [anfang, domain] = address.split('@')

    const r = await app.inject({ method: 'GET', url: `/v1/guests/${guestRef}`,
      headers: { cookie: chef.cookie } })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.body).toContain(`${anfang}-u${chef.userId}@${domain}`)
    expect(r.body).not.toContain(`"${address}"`)

    // Gespeichert bleibt die Grundform: sie verraet die Datenbank selbst.
    const g = await owner.query('SELECT 1 FROM guest WHERE email = $1', [address])
    expect(g.rowCount).toBe(1)
  })

  it('traegt im Mandantenexport die Kennung des Exports', async () => {
    const { address } = await anlegen()
    const [anfang] = address.split('@')
    const r = await app.inject({ method: 'GET', headers: { cookie: chef.cookie },
      url: `/v1/properties/${fx.propertyId}/exports/tenant` })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.body).toContain(`${anfang}-e${chef.userId}@`)
    expect(r.body).not.toContain(`"${address}"`)
  })

  it('traegt fuer einen Maschinenzugang dessen Kennung', async () => {
    const { address, guestRef } = await anlegen()
    const [anfang] = address.split('@')
    const z = await app.inject({ method: 'POST', url: '/v1/oauth-clients', headers: { cookie: chef.cookie },
      payload: { name: 'Umsystem', scopes: ['guest:read'], propertyIds: [fx.propertyId] } })
    expect(z.statusCode, z.body).toBe(201)
    const { clientId, clientSecret } = z.json<{ clientId: string; clientSecret: string }>()
    const t = await app.inject({ method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'client_credentials',
        client_id: clientId, client_secret: clientSecret }).toString() })
    expect(t.statusCode, t.body).toBe(200)

    const r = await app.inject({ method: 'GET', url: `/v1/guests/${guestRef}`,
      headers: { authorization: `Bearer ${t.json<{ access_token: string }>().access_token}` } })
    expect(r.statusCode, r.body).toBe(200)
    const kennung = clientId.toLowerCase().replace(/[^a-z0-9]/g, '')
    expect(r.body).toContain(`${anfang}-c${kennung}@`)
  })

  it('verschwindet beim Entfernen ueber die Gastloeschung', async () => {
    const { address } = await anlegen()
    const r = await app.inject({ method: 'DELETE', headers: admin,
      url: `/v1/platform/accounts/${fx.accountId}/properties/${fx.propertyId}/decoy` })
    expect(r.statusCode, r.body).toBe(200)
    const g = await owner.query('SELECT 1 FROM guest WHERE email = $1', [address])
    expect(g.rowCount).toBe(0)
    const d = await owner.query('SELECT 1 FROM decoy')
    expect(d.rowCount).toBe(0)
  })

  it('bleibt dem Kunden verschlossen', async () => {
    const r = await app.inject({ method: 'POST', headers: { cookie: chef.cookie },
      url: `/v1/platform/accounts/${fx.accountId}/properties/${fx.propertyId}/decoy` })
    expect(r.statusCode).toBe(403)
    const l = await app.inject({ method: 'GET', headers: { cookie: chef.cookie },
      url: `/v1/platform/accounts/${fx.accountId}/decoys` })
    expect(l.statusCode).toBe(403)
  })
})

describe('Koederzugang', () => {
  async function zugang(): Promise<{ clientId: string; clientSecret: string }> {
    const r = await app.inject({ method: 'POST', headers: admin,
      url: `/v1/platform/accounts/${fx.accountId}/decoy-clients`,
      payload: { name: 'Buchhaltung Export alt' } })
    expect(r.statusCode, r.body).toBe(201)
    return r.json()
  }

  it('traegt nie und meldet jeden Versuch', async () => {
    const z = await zugang()
    const t = await app.inject({ method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded',
                 'x-forwarded-for': '203.0.113.9' },
      payload: new URLSearchParams({ grant_type: 'client_credentials',
        client_id: z.clientId, client_secret: z.clientSecret }).toString() })
    expect(t.statusCode).toBe(401)
    expect(t.json<{ error: string }>().error).toBe('invalid_client')

    const e = await owner.query<{ ip: string; ref: string }>(
      `SELECT host(origin) AS ip, detail ->> 'ref' AS ref FROM security_event
        WHERE kind = 'honeytoken'`)
    expect(e.rows).toEqual([{ ip: '203.0.113.9', ref: z.clientId }])
  })

  it('steht nicht in der Liste des Kunden', async () => {
    await zugang()
    const r = await app.inject({ method: 'GET', url: '/v1/oauth-clients', headers: { cookie: chef.cookie } })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json<{ clients: unknown[] }>().clients).toHaveLength(0)

    const p = await app.inject({ method: 'GET', headers: admin,
      url: `/v1/platform/accounts/${fx.accountId}/decoys` })
    expect(p.json<{ clients: unknown[]; domainConfigured: boolean }>())
      .toMatchObject({ domainConfigured: true, clients: [{ name: 'Buchhaltung Export alt' }] })
  })
})
