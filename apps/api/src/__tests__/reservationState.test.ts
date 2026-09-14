import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Bestand bei Zustandswechseln.
 *
 * Gebunden wird nach **Zustand**, nicht nach Handlung. Das ist der Punkt,
 * an dem es vorher auseinanderlief: das Wiederbinden hing am Paar Storno
 * und Wiederherstellen, und der No-Show, der doch noch anreist, geht nicht
 * ueber dieses Paar, sondern direkt nach `InHouse`. Das Zimmer war belegt
 * und der Zaehler sagte frei.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let auth: Record<string, string>

const VON = '2026-10-01'
const BIS = '2026-10-03'

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
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  await makeResources(owner, fx.propertyId, catId, 5)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

const post = (url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: auth, payload })

async function buchung(): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...auth, 'idempotency-key': `k-${Math.random()}` },
    payload: { propertyId: fx.propertyId, categoryId: catId,
               arrival: VON, departure: BIS } })
  expect(r.statusCode, r.body).toBe(201)
  return (JSON.parse(r.body) as { reservationRef: string }).reservationRef
}

async function verkauft(date = VON): Promise<number> {
  const r = await owner.query<{ sold: number }>(
    `SELECT sold FROM inventory_day
      WHERE property_id=$1 AND category_id=$2 AND date=$3`, [fx.propertyId, catId, date])
  return r.rows[0]!.sold
}

async function setzeNoShow(ref: string): Promise<void> {
  // Den No-Show setzt sonst der Nachtlauf; hier genuegt der Zustand.
  await owner.query(
    `UPDATE reservation SET status='NoShow' WHERE public_ref=$1`, [ref])
  await owner.query(
    `SELECT inventory_release($1,$2,$3::date,$4::date,1)`,
    [fx.propertyId, catId, VON, BIS])
}

describe('Bestand bei Zustandswechseln', () => {
  it('bindet wieder, wenn ein No-Show doch noch eincheckt', async () => {
    const ref = await buchung()
    expect(await verkauft()).toBe(1)

    await setzeNoShow(ref)
    expect(await verkauft()).toBe(0)

    const zimmer = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE property_id=$1 LIMIT 1`, [fx.propertyId])
    const z = await post(`/v1/reservations/${ref}/assign-unit`,
      { resourceId: zimmer.rows[0]!.id })
    expect(z.statusCode, z.body).toBe(200)

    const c = await post(`/v1/reservations/${ref}/check-in`)
    expect(c.statusCode, c.body).toBe(200)

    // Das Zimmer ist belegt, also muss der Zaehler es auch sagen.
    expect(await verkauft()).toBe(1)
    expect(await verkauft('2026-10-02')).toBe(1)
  })

  it('nimmt einen Storno zurueck und bindet dabei erneut', async () => {
    const ref = await buchung()
    await post(`/v1/reservations/${ref}/cancel`)
    expect(await verkauft()).toBe(0)

    const w = await post(`/v1/reservations/${ref}/reinstate`)
    expect(w.statusCode, w.body).toBe(200)
    expect(JSON.parse(w.body).status).toBe('Confirmed')
    expect(await verkauft()).toBe(1)
  })

  it('bindet nicht zweimal, wenn eine bindende Handlung auf eine bindende folgt',
    async () => {
      const ref = await buchung()
      const zimmer = await owner.query<{ id: number }>(
        `SELECT id FROM resource WHERE property_id=$1 LIMIT 1`, [fx.propertyId])
      await post(`/v1/reservations/${ref}/assign-unit`,
        { resourceId: zimmer.rows[0]!.id })
      await post(`/v1/reservations/${ref}/check-in`)
      // Confirmed und InHouse binden beide: der Uebergang darf nichts tun.
      expect(await verkauft()).toBe(1)
    })

  it('weist das Wiederherstellen ab, wenn das Haus inzwischen voll ist', async () => {
    const ref = await buchung()
    await post(`/v1/reservations/${ref}/cancel`)
    // Die fuenf Zimmer der Kategorie inzwischen anderweitig verkauft.
    for (let i = 0; i < 5; i++) await buchung()

    const w = await post(`/v1/reservations/${ref}/reinstate`)
    expect(w.statusCode).toBe(409)
    expect(await verkauft()).toBe(5)
  })
})
