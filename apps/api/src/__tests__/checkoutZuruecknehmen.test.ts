import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Check-out zuruecknehmen und Zimmer tauschen (0094).
 *
 * Sven, 06.10.2026: ein eingecheckter Gast sollte nur in ein anderes Zimmer.
 * Die Ablage nahm ihn nicht, also wurde er ausgecheckt -- und war danach auf
 * eine Nacht gekuerzt, abgereist und nicht mehr zu bearbeiten.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let zimmer: number[]
let auth: Record<string, string>

const VON = '2026-10-01'
const BIS = '2026-10-04'

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
  await makeResources(owner, fx.propertyId, catId, 3)
  zimmer = (await owner.query<{ id: number }>(
    `SELECT id FROM resource WHERE property_id=$1 ORDER BY id`, [fx.propertyId]))
    .rows.map(r => r.id)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, VON)
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

const post = (url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: auth, payload })

async function buchung(resourceId: number, arrival = VON, departure = BIS): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...auth, 'idempotency-key': `k-${Math.random()}` },
    payload: { propertyId: fx.propertyId, categoryId: catId, arrival, departure } })
  expect(r.statusCode, r.body).toBe(201)
  const ref = (JSON.parse(r.body) as { reservationRef: string }).reservationRef
  const z = await post(`/v1/reservations/${ref}/assign-unit`, { resourceId })
  expect(z.statusCode, z.body).toBe(200)
  return ref
}

async function verkauft(date: string): Promise<number> {
  const r = await owner.query<{ sold: number }>(
    `SELECT sold FROM inventory_day
      WHERE property_id=$1 AND category_id=$2 AND date=$3`, [fx.propertyId, catId, date])
  return r.rows[0]!.sold
}

async function stand(ref: string) {
  const r = await owner.query<{ status: string; departure: string; resource_id: number
                                checked_out_at: string | null; checkout_undo: unknown }>(
    `SELECT status, departure::text, resource_id, checked_out_at, checkout_undo
       FROM reservation WHERE public_ref = $1`, [ref])
  const n = await owner.query<{ date: string; price_cent: string }>(
    `SELECT n.date::text, n.price_cent::text FROM reservation_night n
       JOIN reservation r ON r.id = n.reservation_id
      WHERE r.public_ref = $1 ORDER BY n.date`, [ref])
  return { ...r.rows[0]!, naechte: n.rows.map(x => [x.date, Number(x.price_cent)]) }
}

describe('Check-out zuruecknehmen', () => {
  it('stellt Abreise, Naechte mit Preis, Zimmer und Bestand wieder her', async () => {
    const ref = await buchung(zimmer[0]!)
    // Ein von Hand vereinbarter Preis fuer die zweite Nacht: ein Neurechnen
    // ueber den Durchschnitt verloere ihn.
    await owner.query(
      `UPDATE reservation_night SET price_cent = 12345
        WHERE date = '2026-10-02'
          AND reservation_id = (SELECT id FROM reservation WHERE public_ref = $1)`, [ref])
    const vorher = await stand(ref)

    expect((await post(`/v1/reservations/${ref}/check-in`)).statusCode).toBe(200)
    expect((await post(`/v1/reservations/${ref}/check-out`)).statusCode).toBe(200)
    const aus = await stand(ref)
    expect(aus).toMatchObject({ status: 'CheckedOut', departure: '2026-10-02' })
    expect(aus.naechte).toHaveLength(1)
    expect(await verkauft('2026-10-02')).toBe(0)

    const u = await post(`/v1/reservations/${ref}/undo-check-out`)
    expect(u.statusCode, u.body).toBe(200)
    expect(JSON.parse(u.body).status).toBe('InHouse')

    const danach = await stand(ref)
    expect(danach).toMatchObject({ status: 'InHouse', departure: BIS,
                                   resource_id: zimmer[0], checked_out_at: null,
                                   checkout_undo: null })
    expect(danach.naechte).toEqual(vorher.naechte)
    expect(await verkauft(VON)).toBe(1)
    expect(await verkauft('2026-10-03')).toBe(1)

    // Danach ist er wieder ein Gast im Haus: das Zimmer laesst sich wechseln.
    const z = await post(`/v1/reservations/${ref}/assign-unit`, { resourceId: zimmer[1] })
    expect(z.statusCode, z.body).toBe(200)
  })

  it('nimmt einen Check-out am naechsten Geschaeftstag nicht mehr zurueck', async () => {
    const ref = await buchung(zimmer[0]!)
    await post(`/v1/reservations/${ref}/check-in`)
    await post(`/v1/reservations/${ref}/check-out`)
    await openBusinessDay(owner, fx.propertyId, '2026-10-02')

    const u = await post(`/v1/reservations/${ref}/undo-check-out`)
    expect(u.statusCode, u.body).toBe(422)
    expect((await stand(ref)).status).toBe('CheckedOut')
  })

  it('laesst den Gast abgereist, wenn sein Zimmer inzwischen vergeben ist', async () => {
    const ref = await buchung(zimmer[0]!)
    await post(`/v1/reservations/${ref}/check-in`)
    await post(`/v1/reservations/${ref}/check-out`)
    await buchung(zimmer[0]!, '2026-10-02', '2026-10-03')

    const u = await post(`/v1/reservations/${ref}/undo-check-out`)
    expect(u.statusCode, u.body).toBe(409)
    expect((await stand(ref)).status).toBe('CheckedOut')
    expect(await verkauft(VON)).toBe(0)
  })

  it('nimmt einen Check-out ohne festgehaltenen Stand am selben Tag zurueck', async () => {
    // Ausgecheckt vor 0094: es gibt nichts wiederherzustellen ausser dem
    // Zustand; die Abreise setzt die Rezeption danach selbst.
    const ref = await buchung(zimmer[0]!)
    await post(`/v1/reservations/${ref}/check-in`)
    await post(`/v1/reservations/${ref}/check-out`)
    await owner.query(`UPDATE reservation SET checkout_undo = NULL WHERE public_ref = $1`, [ref])

    const u = await post(`/v1/reservations/${ref}/undo-check-out`)
    expect(u.statusCode, u.body).toBe(200)
    expect(await stand(ref)).toMatchObject({ status: 'InHouse', departure: '2026-10-02' })
    expect(await verkauft(VON)).toBe(1)

    // Und laesst sich wie jeder Gast im Haus verlaengern.
    const c = await post(`/v1/reservations/${ref}/change-stay`, { departure: BIS })
    expect(c.statusCode, c.body).toBe(200)
  })
})

describe('Zimmer tauschen', () => {
  it('tauscht einen Gast im Haus mit dem, der in seinem Wunschzimmer geplant ist',
    async () => {
      const a = await buchung(zimmer[0]!)
      const b = await buchung(zimmer[1]!)
      await post(`/v1/reservations/${a}/check-in`)

      // Direkt zuweisen geht nicht, das Zimmer ist belegt.
      expect((await post(`/v1/reservations/${a}/assign-unit`,
        { resourceId: zimmer[1] })).statusCode).toBe(409)

      const t = await post(`/v1/reservations/${a}/swap-room`, { withReservationRef: b })
      expect(t.statusCode, t.body).toBe(200)
      expect((await stand(a))).toMatchObject({ status: 'InHouse', resource_id: zimmer[1] })
      expect((await stand(b))).toMatchObject({ status: 'Confirmed', resource_id: zimmer[0] })
      expect(await verkauft(VON)).toBe(2)
    })

  it('tauscht nicht, wenn der andere nicht ins freie Zimmer passt', async () => {
    const a = await buchung(zimmer[0]!, VON, '2026-10-02')
    const b = await buchung(zimmer[1]!, VON, BIS)
    // Im Zimmer von a liegt ab dem zweiten schon jemand.
    await buchung(zimmer[0]!, '2026-10-02', BIS)

    const t = await post(`/v1/reservations/${a}/swap-room`, { withReservationRef: b })
    expect(t.statusCode, t.body).toBe(409)
    expect((await stand(a)).resource_id).toBe(zimmer[0])
    expect((await stand(b)).resource_id).toBe(zimmer[1])
  })
})
