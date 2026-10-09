import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Die Rezeption liest Anreisen, Abreisen und Hausliste nach Zimmernummer.
 *
 * Die Anreisen standen nach Nachname, die beiden anderen nach `res.code` als
 * Text -- "10" vor "2", "601" vor "9". Sven: "das ist verwirrend"
 * (09.10.2026).
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let admin: { userId: number; sessionId: string }

const TAG = '2026-10-10'

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
  catId = await makeCategory(owner, fx.propertyId)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
    [fx.propertyId])
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
})

async function zimmer(code: string): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `INSERT INTO resource (property_id, category_id, code) VALUES ($1,$2,$3) RETURNING id`,
    [fx.propertyId, catId, code])
  return r.rows[0]!.id
}

async function tagesgeschaeft(): Promise<Record<string, Array<{ roomCode: string | null }>>> {
  const r = await app.inject({
    method: 'GET', url: `/v1/properties/${fx.propertyId}/daily-sheet?date=${TAG}`,
    headers: { cookie: `hp_session=${admin.sessionId}` } })
  expect(r.statusCode, r.body).toBe(200)
  return JSON.parse(r.body) as Record<string, Array<{ roomCode: string | null }>>
}

describe('Tagesgeschaeft: Reihenfolge der Zimmer', () => {
  it('sortiert Anreisen, Abreisen und Hausliste nach Nummer, nicht als Text', async () => {
    for (const code of ['10', '601', '2', '9', '12a', '12']) {
      const id = await zimmer(code)
      // Abreise heute ...
      await makeReservation(owner, { propertyId: fx.propertyId, categoryId: catId,
        reserveInventory: false,
        arrival: '2026-10-07', departure: TAG, status: 'InHouse', resourceId: id })
      // ... und am selben Tag die naechste Anreise im selben Zimmer.
      await makeReservation(owner, { propertyId: fx.propertyId, categoryId: catId,
        reserveInventory: false,
        arrival: TAG, departure: '2026-10-12', status: 'Confirmed', resourceId: id })
    }
    // Eine Anreise ohne Zimmer gehoert ans Ende, nicht an den Anfang.
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: catId,
        reserveInventory: false,
      arrival: TAG, departure: '2026-10-12', status: 'Confirmed' })

    const d = await tagesgeschaeft()
    const erwartet = ['2', '9', '10', '12', '12a', '601']
    expect(d.arrivals!.map(r => r.roomCode)).toEqual([...erwartet, null])
    expect(d.departures!.map(r => r.roomCode)).toEqual(erwartet)
  })

  it('sortiert die Hausliste nach Nummer', async () => {
    for (const code of ['10', '601', '2', '9']) {
      await makeReservation(owner, { propertyId: fx.propertyId, categoryId: catId,
        reserveInventory: false,
        arrival: '2026-10-08', departure: '2026-10-12', status: 'InHouse',
        resourceId: await zimmer(code) })
    }
    const d = await tagesgeschaeft()
    expect(d.inHouse!.map(r => r.roomCode)).toEqual(['2', '9', '10', '601'])
  })
})
