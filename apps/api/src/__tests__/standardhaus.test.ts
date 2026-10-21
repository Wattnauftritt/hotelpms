import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Das Standardhaus je Benutzer (Migration 0194).
 *
 * Geprueft wird, was die Oberflaeche daraus macht: `/v1/auth/me` nennt das
 * Haus nur, solange der Benutzer Zugriff darauf hat -- sonst startete er in
 * einem Haus, das ihm auf jedem Bildschirm eine 403 gibt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let zweitesHaus: number
let fremdesHaus: number
let userId: number
let auth: Record<string, string>

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
  fx = await makeProperty(owner)
  const p = await owner.query<{ id: number }>(
    `INSERT INTO property (account_id, code, name, address_line1, postal_code, city, country)
     VALUES ($1, 'GH', 'Gaestehaus', 'Hafenstr. 3', '27472', 'Cuxhaven', 'DE')
     RETURNING id`, [fx.accountId])
  zweitesHaus = p.rows[0]!.id
  fremdesHaus = (await makeProperty(owner, { name: 'Fremd', code: 'FR' })).propertyId
  const u = await makeUser(owner,
    { email: 'rezeption@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  userId = u.userId
  await owner.query(
    `INSERT INTO user_property_role (user_id, property_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'reception' AND account_id IS NULL`,
    [userId, zweitesHaus])
  auth = { cookie: `hp_session=${u.sessionId}` }
})

const setzen = (propertyId: unknown) =>
  app.inject({ method: 'PUT', url: '/v1/auth/default-property', headers: auth,
               payload: { propertyId } })
const standard = async (): Promise<number | null> => {
  const r = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth })
  expect(r.statusCode).toBe(200)
  return r.json<{ defaultPropertyId: number | null }>().defaultPropertyId
}

describe('Standardhaus', () => {
  it('ist ohne Wahl leer, wird gesetzt und wieder geloest', async () => {
    expect(await standard()).toBeNull()

    expect((await setzen(zweitesHaus)).statusCode).toBe(200)
    expect(await standard()).toBe(zweitesHaus)

    expect((await setzen(null)).statusCode).toBe(200)
    expect(await standard()).toBeNull()
  })

  it('nimmt kein Haus an, auf das der Benutzer keinen Zugriff hat', async () => {
    const fremd = await setzen(fremdesHaus)
    expect(fremd.statusCode).toBe(422)
    // Ein nicht vorhandenes Haus bekommt dieselbe Antwort wie ein fremdes.
    expect((await setzen(999_999)).statusCode).toBe(422)
    expect((await setzen('2')).statusCode).toBe(422)
    expect((await setzen(undefined)).statusCode).toBe(422)
    expect(await standard()).toBeNull()
  })

  it('wird uebergangen, sobald der Zugriff wegfaellt, und kommt mit ihm zurueck', async () => {
    await setzen(zweitesHaus)
    await owner.query(
      `DELETE FROM user_property_role WHERE user_id = $1 AND property_id = $2`,
      [userId, zweitesHaus])
    expect(await standard()).toBeNull()

    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'reception' AND account_id IS NULL`,
      [userId, zweitesHaus])
    expect(await standard()).toBe(zweitesHaus)
  })

  it('braucht eine Anmeldung', async () => {
    const r = await app.inject({ method: 'PUT', url: '/v1/auth/default-property',
                                 payload: { propertyId: fx.propertyId } })
    expect(r.statusCode).toBe(401)
  })
})
