import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/*
 * Eine Buchung bindet die Gruppe des Zimmers, in dem sie liegt (Migration
 * 0120, Sven 10.10.2026).
 *
 * Der Fall dahinter: ein als Doppelzimmer gebuchter Gast lag im
 * Vierbettzimmer. Das Doppelzimmer galt dadurch als voll, obwohl eines leer
 * im Plan stand, und wer die Luecke fuellen wollte, bekam "ausgebucht".
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let dz: number
let vz: number
let dzZimmer: number
let vzZimmer: number
let auth: Record<string, string>

const VON = '2026-11-10'
const BIS = '2026-11-12'

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
  dz = await makeCategory(owner, fx.propertyId, { code: 'DZ', name: 'Doppelzimmer' })
  vz = await makeCategory(owner, fx.propertyId, { code: 'VZ', name: 'Vierbettzimmer' })
  dzZimmer = (await makeResources(owner, fx.propertyId, dz, 1, 'D'))[0]!
  vzZimmer = (await makeResources(owner, fx.propertyId, vz, 1, 'V'))[0]!
  await owner.query(`SELECT inventory_materialize($1,'2026-10-01'::date,'2027-01-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: auth, payload })

async function bestand(categoryId: number, date = VON): Promise<number> {
  const r = await owner.query<{ sold: number }>(
    `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
    [fx.propertyId, categoryId, date])
  return r.rows[0]!.sold
}

async function refVon(reservationId: number): Promise<string> {
  const r = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [reservationId])
  return r.rows[0]!.public_ref
}

/** Was der Zaehler sagen muss, gegen das, was er sagt. */
async function abweichungen(): Promise<unknown[]> {
  const r = await owner.query(
    `SELECT i.category_id, i.date::text, i.sold, COALESCE(e.n, 0) AS erwartet
       FROM inventory_day i
       LEFT JOIN inventory_sold_expected($1, NULL) e
         ON e.category_id = i.category_id AND e.date = i.date
      WHERE i.property_id = $1 AND i.category_id <> 0
        AND i.sold <> COALESCE(e.n, 0)`, [fx.propertyId])
  return r.rows
}

/** Ein Doppelzimmer-Gast, der im Vierbettzimmer liegt. */
async function upgrade(): Promise<string> {
  const g = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
    arrival: VON, departure: BIS })
  const ref = await refVon(g.reservationId)
  const r = await post(`/v1/reservations/${ref}/assign-unit`, { resourceId: vzZimmer })
  expect(r.statusCode, r.body).toBe(200)
  return ref
}

describe('Bestand je Zimmer', () => {
  it('zaehlt ein Upgrade in der Gruppe des Zimmers', async () => {
    await upgrade()
    expect(await bestand(dz)).toBe(0)
    expect(await bestand(vz)).toBe(1)
    expect(await bestand(0)).toBe(1)
    expect(await abweichungen()).toEqual([])
  })

  it('laesst die Luecke im Doppelzimmer buchen, ohne Ueberbuchung', async () => {
    await upgrade()
    // Der Gast aus dem Bericht: im Doppelzimmer, spaeter, soll in die Luecke.
    const timm = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      resourceId: dzZimmer, arrival: '2026-11-14', departure: '2026-11-16' })
    const ref = await refVon(timm.reservationId)

    const vorschau = await post(`/v1/reservations/${ref}/change-stay/preview`,
      { arrival: VON, departure: BIS, resourceId: dzZimmer })
    expect(vorschau.statusCode, vorschau.body).toBe(200)
    expect(JSON.parse(vorschau.body).overbooking).toBe(false)

    const r = await post(`/v1/reservations/${ref}/change-stay`,
      { arrival: VON, departure: BIS, resourceId: dzZimmer })
    expect(r.statusCode, r.body).toBe(200)
    expect(await bestand(dz)).toBe(1)
    expect(await bestand(vz)).toBe(1)
    expect(await abweichungen()).toEqual([])
  })

  it('meldet das Vierbettzimmer als voll, in dem der Gast liegt', async () => {
    await upgrade()
    const andere = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: vz,
      arrival: '2026-11-14', departure: '2026-11-16' })
    const vorschau = await post(
      `/v1/reservations/${await refVon(andere.reservationId)}/change-stay/preview`,
      { arrival: VON, departure: BIS })
    expect(vorschau.statusCode, vorschau.body).toBe(200)
    expect(JSON.parse(vorschau.body).overbooking).toBe(true)
  })

  it('gibt beim Storno die richtige Gruppe frei', async () => {
    const ref = await upgrade()
    const r = await post(`/v1/reservations/${ref}/cancel`, {})
    expect(r.statusCode, r.body).toBe(200)
    expect(await bestand(dz)).toBe(0)
    expect(await bestand(vz)).toBe(0)
    expect(await bestand(0)).toBe(0)
    expect(await abweichungen()).toEqual([])
  })

  it('zieht beim Zurueck ins eigene Zimmer und beim Verlaengern mit', async () => {
    const ref = await upgrade()
    const r = await post(`/v1/reservations/${ref}/change-stay`,
      { departure: '2026-11-13' })
    expect(r.statusCode, r.body).toBe(200)
    expect(await bestand(vz, '2026-11-12')).toBe(1)
    expect(await bestand(dz, '2026-11-12')).toBe(0)

    const zurueck = await post(`/v1/reservations/${ref}/assign-unit`, { resourceId: dzZimmer })
    expect(zurueck.statusCode, zurueck.body).toBe(200)
    expect(await bestand(dz, '2026-11-12')).toBe(1)
    expect(await bestand(vz, '2026-11-12')).toBe(0)
    expect(await abweichungen()).toEqual([])
  })

  it('nimmt die Buchungen mit, wenn das Zimmer die Gruppe wechselt', async () => {
    await upgrade()
    await owner.query(`UPDATE resource SET category_id = $2 WHERE id = $1`, [vzZimmer, dz])
    expect(await bestand(dz)).toBe(1)
    expect(await bestand(vz)).toBe(0)
    expect(await abweichungen()).toEqual([])
  })

  it('nennt, woraus ein voller Tag voll ist', async () => {
    // Ein Zaehler ueber den Buchungen und eine Buchung ohne Zimmer: beides
    // zeigt der Plan nicht als belegtes Zimmer.
    await owner.query(
      `UPDATE inventory_day SET sold = sold + 1
        WHERE property_id = $1 AND category_id IN (0, $2) AND date = $3`,
      [fx.propertyId, dz, VON])
    const timm = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      resourceId: dzZimmer, arrival: '2026-11-14', departure: '2026-11-16' })
    const vorschau = await post(
      `/v1/reservations/${await refVon(timm.reservationId)}/change-stay/preview`,
      { arrival: VON, departure: BIS, resourceId: dzZimmer })
    expect(vorschau.statusCode, vorschau.body).toBe(200)
    const v = JSON.parse(vorschau.body) as { overbooking: boolean
      fullDays: Array<Record<string, unknown>> }
    expect(v.overbooking).toBe(true)
    expect(v.fullDays).toEqual([{ date: VON, capacity: 1, sold: 2, blocked: 0,
      withoutRoom: 0, inactiveRoom: 0, counterDrift: 1 }])
  })

  it('zaehlt eine Buchung im stillgelegten Zimmer als unsichtbar', async () => {
    const zweites = (await makeResources(owner, fx.propertyId, dz, 1, 'X'))[0]!
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      resourceId: zweites, arrival: VON, departure: BIS })
    // Am Planer vorbei stillgelegt: die Route liesse das mit Buchung nicht zu.
    await owner.query(`UPDATE resource SET active = false WHERE id = $1`, [zweites])
    const timm = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      resourceId: dzZimmer, arrival: '2026-11-14', departure: '2026-11-16' })
    const vorschau = await post(
      `/v1/reservations/${await refVon(timm.reservationId)}/change-stay/preview`,
      { arrival: VON, departure: BIS, resourceId: dzZimmer })
    const v = JSON.parse(vorschau.body) as { fullDays: Array<{ inactiveRoom: number }> }
    expect(v.fullDays[0]?.inactiveRoom).toBe(1)
  })
})
