import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Fruehstueckszahl fuer Kueche und Hausdame (Migration 0110, Baustein 5).
 *
 * Dieselbe Regel wie `GET /breakfast`: Personen der Vornacht, ab dem
 * offenen Geschaeftstag. Die Reinigungskraft sieht die Zahl nicht -- sie
 * braucht sie nicht.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture

const TAG = '2026-10-01'
const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

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
  fx = await makeProperty(owner, { name: 'Seerobbe' })
  await openBusinessDay(owner, fx.propertyId, TAG)
  const kategorie = await makeCategory(owner, fx.propertyId)
  const zimmer = await makeResources(owner, fx.propertyId, kategorie, 2)
  // Zwei Personen bis heute (Abreise heute: Fruehstueck heute ja), drei ab
  // heute (Anreise heute: Fruehstueck erst morgen).
  const a = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
    resourceId: zimmer[0], arrival: '2026-09-29', departure: TAG, status: 'InHouse',
    reserveInventory: false, withFolio: false })
  const b = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
    resourceId: zimmer[1], arrival: TAG, departure: '2026-10-03', status: 'Confirmed',
    reserveInventory: false, withFolio: false })
  await owner.query(`UPDATE reservation SET adults = 2, children = 0, guest_count = 2
                      WHERE id = $1`, [a.reservationId])
  await owner.query(`UPDATE reservation SET adults = 2, children = 1, guest_count = 3
                      WHERE id = $1`, [b.reservationId])
})

describe('Kueche', () => {
  it('zeigt der Kueche heute und die naechsten Tage nach der Vornacht', async () => {
    const kueche = await makeUser(owner, { email: 'kueche@kunde.de',
      propertyId: fx.propertyId, roleKey: 'kitchen' })
    const r = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/kitchen`, headers: auth(kueche.sessionId) })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.date).toBe(TAG)
    expect(b.days).toHaveLength(7)
    expect(b.days.slice(0, 4).map((d: { date: string; breakfasts: number; children: number }) =>
      [d.date, d.breakfasts, d.children])).toEqual([
      ['2026-10-01', 2, 0], ['2026-10-02', 3, 1], ['2026-10-03', 3, 1], ['2026-10-04', 0, 0]])
  })

  it('zeigt sie der Hausdame, nicht der Reinigungskraft', async () => {
    const hausdame = await makeUser(owner, { email: 'hd@kunde.de',
      propertyId: fx.propertyId, roleKey: 'housekeeping' })
    const kraft = await makeUser(owner, { email: 'kraft@kunde.de',
      propertyId: fx.propertyId, roleKey: 'housekeeping_staff' })
    const url = `/v1/properties/${fx.propertyId}/kitchen`
    expect((await app.inject({ method: 'GET', url, headers: auth(hausdame.sessionId) }))
      .statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url, headers: auth(kraft.sessionId) }))
      .statusCode).toBe(403)
  })
})
