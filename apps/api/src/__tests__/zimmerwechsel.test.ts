import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/*
 * Zimmerwechsel im Aufenthalt (Migration 0195, Sven 23.10.2026).
 *
 * Der Fall dahinter: ein Gast will nach zwei Naechten ein anderes Zimmer --
 * ein Upgrade oder eine Beschwerde. Bisher ging das nur ueber einen
 * vorzeitigen Check-out und eine neue Buchung mit neuem Folio, weil
 * `assign-unit` das neue Zimmer ab der Anreise prueft und die Naechte davor
 * dort von anderen Gaesten belegt waren.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let dz: number
let su: number
let d1: number
let d2: number
let s1: number
let auth: Record<string, string>

const HEUTE = '2026-11-10'

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
  su = await makeCategory(owner, fx.propertyId, { code: 'SU', name: 'Suite' })
  ;[d1, d2] = await makeResources(owner, fx.propertyId, dz, 2, 'D') as [number, number]
  s1 = (await makeResources(owner, fx.propertyId, su, 1, 'S'))[0]!
  await owner.query(`SELECT inventory_materialize($1,'2026-10-01'::date,'2027-01-01'::date)`,
    [fx.propertyId])
  await owner.query(
    `INSERT INTO business_day (property_id, date, status) VALUES ($1, $2, 'open')`,
    [fx.propertyId, HEUTE])
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: auth, payload })
const get = (url: string) => app.inject({ method: 'GET', url, headers: auth })

async function aufenthalt(opts: { arrival: string; departure: string; resourceId: number
                                  status?: 'Confirmed' | 'InHouse'; categoryId?: number })
  : Promise<{ id: number; ref: string }> {
  const r = await makeReservation(owner, { propertyId: fx.propertyId,
    categoryId: opts.categoryId ?? dz, ...opts })
  const q = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [r.reservationId])
  return { id: r.reservationId, ref: q.rows[0]!.public_ref }
}

async function bestand(categoryId: number, date: string): Promise<number> {
  const r = await owner.query<{ sold: number }>(
    `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
    [fx.propertyId, categoryId, date])
  return r.rows[0]!.sold
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

async function reinigung(resourceId: number): Promise<string | undefined> {
  const r = await owner.query<{ status: string }>(
    `SELECT status FROM housekeeping_status WHERE resource_id = $1`, [resourceId])
  return r.rows[0]?.status
}

async function zimmerHeute(id: number): Promise<{ resource_id: number; room_moved: boolean }> {
  const r = await owner.query<{ resource_id: number; room_moved: boolean }>(
    `SELECT resource_id::int, room_moved FROM reservation WHERE id = $1`, [id])
  return r.rows[0]!
}

describe('Zimmerwechsel beim Gast im Haus', () => {
  it('legt den Gast ab heute um, ein Folio, alte Naechte bleiben im alten Zimmer', async () => {
    const g = await aufenthalt({ arrival: '2026-11-08', departure: '2026-11-13',
                                 resourceId: d1, status: 'InHouse' })
    await owner.query(
      `UPDATE reservation_night SET posted = true WHERE reservation_id = $1 AND date < $2`,
      [g.id, HEUTE])

    const optionen = await get(`/v1/reservations/${g.ref}/room-move`)
    expect(optionen.statusCode, optionen.body).toBe(200)
    const o = JSON.parse(optionen.body)
    expect(o.from).toBe(HEUTE)
    expect(o.currentResourceId).toBe(d1)
    expect(o.rooms.find((z: { resourceId: number }) => z.resourceId === s1).free).toBe(true)
    expect(o.rooms.find((z: { resourceId: number }) => z.resourceId === d1).free).toBe(false)

    const r = await post(`/v1/reservations/${g.ref}/room-move`,
                         { resourceId: s1, priceCent: 15_000 })
    expect(r.statusCode, r.body).toBe(200)

    expect(await zimmerHeute(g.id)).toEqual({ resource_id: s1, room_moved: true })
    // Sven: das alte Zimmer geht sofort in die Reinigung.
    expect(await reinigung(d1)).toBe('dirty')
    expect(await reinigung(s1)).toBe('occupied')

    // Bestand je Nacht in der Gruppe des Zimmers, in dem der Gast schlaeft.
    expect(await bestand(dz, '2026-11-09')).toBe(1)
    expect(await bestand(su, '2026-11-09')).toBe(0)
    expect(await bestand(dz, HEUTE)).toBe(0)
    expect(await bestand(su, HEUTE)).toBe(1)
    expect(await abweichungen()).toEqual([])

    // Der Aufpreis als hoeherer Nachtpreis, nur fuer offene Naechte.
    const n = await owner.query<{ date: string; price_cent: string }>(
      `SELECT date::text, price_cent FROM reservation_night
        WHERE reservation_id = $1 ORDER BY date`, [g.id])
    expect(n.rows.map(x => Number(x.price_cent))).toEqual([11_000, 11_000, 15_000, 15_000, 15_000])

    const d = JSON.parse((await get(`/v1/reservations/${g.ref}`)).body)
    expect(d.roomParts.map((p: { resourceId: number; from: string; to: string
                                 movedOut: boolean }) => [p.resourceId, p.from, p.to, p.movedOut]))
      .toEqual([[d1, '2026-11-08', HEUTE, true], [s1, HEUTE, '2026-11-13', false]])
    expect(d.roomMoveUndoable).toBe(true)
  })

  it('gibt das alte Zimmer ab dem Wechseltag frei und belegt das neue', async () => {
    const g = await aufenthalt({ arrival: '2026-11-08', departure: '2026-11-13',
                                 resourceId: d1, status: 'InHouse' })
    expect((await post(`/v1/reservations/${g.ref}/room-move`, { resourceId: s1 })).statusCode)
      .toBe(200)

    const neu = await aufenthalt({ arrival: HEUTE, departure: '2026-11-12', resourceId: d2 })
    expect((await post(`/v1/reservations/${neu.ref}/assign-unit`, { resourceId: d1 })).statusCode)
      .toBe(200)
    const suite = await aufenthalt({ arrival: '2026-11-11', departure: '2026-11-12',
                                     resourceId: d2, categoryId: dz })
    expect((await post(`/v1/reservations/${suite.ref}/assign-unit`, { resourceId: s1 })).statusCode)
      .toBe(409)
    expect(await abweichungen()).toEqual([])
  })

  // Der Zustand bleibt der der Reservierung -- das Menue am Balken haengt
  // daran --, `moved_out` sagt, dass der Gast diesen Teil verlassen hat.
  it('zeigt im Plan zwei Balken, der alte als ausgezogen', async () => {
    const g = await aufenthalt({ arrival: '2026-11-08', departure: '2026-11-13',
                                 resourceId: d1, status: 'InHouse' })
    await post(`/v1/reservations/${g.ref}/room-move`, { resourceId: s1 })
    const r = await get(`/v1/properties/${fx.propertyId}/tape-chart?from=2026-11-05&to=2026-11-20`)
    expect(r.statusCode, r.body).toBe(200)
    const balken = (JSON.parse(r.body).reservations as Array<Record<string, unknown>>)
      .filter(x => x.public_ref === g.ref)
      .map(x => [x.resource_id, x.arrival, x.departure, x.status, x.moved_out, x.part_last,
                 x.stay_arrival, x.stay_departure])
    expect(balken).toEqual([
      [d1, '2026-11-08', HEUTE, 'InHouse', true, false, '2026-11-08', '2026-11-13'],
      [s1, HEUTE, '2026-11-13', 'InHouse', false, true, '2026-11-08', '2026-11-13']
    ])
  })

  it('nimmt den Wechsel am selben Tag zurueck', async () => {
    const g = await aufenthalt({ arrival: '2026-11-08', departure: '2026-11-13',
                                 resourceId: d1, status: 'InHouse' })
    await owner.query(`INSERT INTO housekeeping_status (property_id, resource_id, status)
                       VALUES ($1, $2, 'inspected')`, [fx.propertyId, s1])
    await post(`/v1/reservations/${g.ref}/room-move`, { resourceId: s1 })
    const r = await post(`/v1/reservations/${g.ref}/room-move/undo`, {})
    expect(r.statusCode, r.body).toBe(200)
    expect(await zimmerHeute(g.id)).toEqual({ resource_id: d1, room_moved: false })
    expect(await reinigung(d1)).toBe('occupied')
    // Das neue Zimmer bekommt den Stand von vor dem Wechsel zurueck.
    expect(await reinigung(s1)).toBe('inspected')
    expect(await abweichungen()).toEqual([])
    expect((await post(`/v1/reservations/${g.ref}/room-move/undo`, {})).statusCode).toBe(409)
  })

  it('weist einen Wechsel in die Vergangenheit und ins selbe Zimmer ab', async () => {
    const g = await aufenthalt({ arrival: '2026-11-08', departure: '2026-11-13',
                                 resourceId: d1, status: 'InHouse' })
    expect((await post(`/v1/reservations/${g.ref}/room-move`,
                       { from: '2026-11-09', resourceId: s1 })).statusCode).toBe(422)
    expect((await post(`/v1/reservations/${g.ref}/room-move`,
                       { resourceId: d1 })).statusCode).toBe(422)
    const belegt = await aufenthalt({ arrival: '2026-11-12', departure: '2026-11-14',
                                      resourceId: s1, categoryId: su })
    expect(belegt.ref).not.toBe('')
    expect((await post(`/v1/reservations/${g.ref}/room-move`,
                       { resourceId: s1 })).statusCode).toBe(409)
  })
})

describe('Geplanter Wechsel', () => {
  it('fuehrt der Nachtlauf am Wechseltag aus', async () => {
    const g = await aufenthalt({ arrival: '2026-11-09', departure: '2026-11-14',
                                 resourceId: d1, status: 'InHouse' })
    const r = await post(`/v1/reservations/${g.ref}/room-move`,
                         { from: '2026-11-12', resourceId: d2 })
    expect(r.statusCode, r.body).toBe(200)
    // Bis dahin schlaeft der Gast in D1, und nichts geht in die Reinigung.
    expect(await zimmerHeute(g.id)).toEqual({ resource_id: d1, room_moved: true })
    expect(await reinigung(d1)).not.toBe('dirty')

    await owner.query(`SELECT reservation_room_day_roll($1, '2026-11-11'::date)`, [fx.propertyId])
    expect((await zimmerHeute(g.id)).resource_id).toBe(d1)
    await owner.query(`SELECT reservation_room_day_roll($1, '2026-11-12'::date)`, [fx.propertyId])
    expect((await zimmerHeute(g.id)).resource_id).toBe(d2)
    expect(await reinigung(d1)).toBe('dirty')
    expect(await reinigung(d2)).toBe('occupied')
    expect(await abweichungen()).toEqual([])
  })

  it('entfaellt, wenn der Gast vorher abreist', async () => {
    const g = await aufenthalt({ arrival: '2026-11-09', departure: '2026-11-14',
                                 resourceId: d1, status: 'InHouse' })
    await post(`/v1/reservations/${g.ref}/room-move`, { from: '2026-11-12', resourceId: d2 })
    const r = await post(`/v1/reservations/${g.ref}/change-stay`, { departure: '2026-11-12' })
    expect(r.statusCode, r.body).toBe(200)
    expect(await zimmerHeute(g.id)).toEqual({ resource_id: d1, room_moved: false })
    expect(await bestand(dz, '2026-11-12')).toBe(0)
    expect(await abweichungen()).toEqual([])
  })
})

describe('Aufenthalt vor der Anreise teilen', () => {
  it('teilt in zwei Zimmergruppen und zaehlt jede Nacht dort, wo sie liegt', async () => {
    const g = await aufenthalt({ arrival: '2026-11-15', departure: '2026-11-18', resourceId: d1 })
    const r = await post(`/v1/reservations/${g.ref}/room-move`,
                         { from: '2026-11-16', resourceId: s1 })
    expect(r.statusCode, r.body).toBe(200)
    // Vor der Anreise steht am Aufenthalt das erste Zimmer.
    expect(await zimmerHeute(g.id)).toEqual({ resource_id: d1, room_moved: true })
    expect(await bestand(dz, '2026-11-15')).toBe(1)
    expect(await bestand(dz, '2026-11-16')).toBe(0)
    expect(await bestand(su, '2026-11-16')).toBe(1)
    expect(await bestand(su, '2026-11-17')).toBe(1)
    expect(await abweichungen()).toEqual([])
  })

  it('verlaengert im letzten Zimmer und kuerzt den Wechsel wieder weg', async () => {
    const g = await aufenthalt({ arrival: '2026-11-15', departure: '2026-11-18', resourceId: d1 })
    await post(`/v1/reservations/${g.ref}/room-move`, { from: '2026-11-16', resourceId: s1 })

    const laenger = await post(`/v1/reservations/${g.ref}/change-stay`,
                               { departure: '2026-11-19', resourceId: s1 })
    expect(laenger.statusCode, laenger.body).toBe(200)
    expect(await bestand(su, '2026-11-18')).toBe(1)
    expect(await abweichungen()).toEqual([])

    const kuerzer = await post(`/v1/reservations/${g.ref}/change-stay`,
                               { departure: '2026-11-16' })
    expect(kuerzer.statusCode, kuerzer.body).toBe(200)
    expect(await zimmerHeute(g.id)).toEqual({ resource_id: d1, room_moved: false })
    expect(await bestand(su, '2026-11-16')).toBe(0)
    expect(await abweichungen()).toEqual([])
  })

  it('weist ab, was den ganzen Aufenthalt in ein Zimmer legen wuerde', async () => {
    const g = await aufenthalt({ arrival: '2026-11-15', departure: '2026-11-18', resourceId: d1 })
    const andere = await aufenthalt({ arrival: '2026-11-15', departure: '2026-11-18',
                                      resourceId: d2 })
    await post(`/v1/reservations/${g.ref}/room-move`, { from: '2026-11-16', resourceId: s1 })

    const zuweisen = await post(`/v1/reservations/${g.ref}/assign-unit`, { resourceId: d2 })
    expect(zuweisen.statusCode).toBe(409)
    expect(JSON.parse(zuweisen.body).messageKey ?? zuweisen.body).toContain('roomMovedUseMove')
    expect((await post(`/v1/reservations/${g.ref}/swap-room`,
                       { withReservationRef: andere.ref })).statusCode).toBe(409)
    expect((await post(`/v1/reservations/${g.ref}/change-stay`,
                       { arrival: '2026-11-14' })).statusCode).toBe(409)
    expect(await abweichungen()).toEqual([])
  })
})

/*
 * Ins Band (0196, Sven 23.10.2026): im vollen Haus ist ab dem Wechseltag
 * oft kein Zimmer frei, solange nicht erst ein anderer Gast umgelegt ist.
 */
describe('Zimmerwechsel ins Ablageband', () => {
  it('legt den Gast ab heute ins Band und gibt ihm von dort ein Zimmer', async () => {
    const g = await aufenthalt({ arrival: '2026-11-08', departure: '2026-11-13',
                                 resourceId: d1, status: 'InHouse' })
    const r = await post(`/v1/reservations/${g.ref}/room-move`, { resourceId: null })
    expect(r.statusCode, r.body).toBe(200)
    // Am Aufenthalt bleibt das alte Zimmer: der Gast schlaeft dort, bis er
    // ein neues hat, und ein angereister Gast hat immer ein Zimmer.
    expect(await zimmerHeute(g.id)).toEqual({ resource_id: d1, room_moved: true })
    expect(await reinigung(d1)).not.toBe('dirty')
    // Ohne Zimmer zaehlt die Nacht in der gebuchten Gruppe, und D1 ist frei.
    expect(await bestand(dz, HEUTE)).toBe(1)
    expect(await abweichungen()).toEqual([])

    const plan = JSON.parse((await get(
      `/v1/properties/${fx.propertyId}/tape-chart?from=2026-11-05&to=2026-11-20`)).body)
    const balken = (plan.reservations as Array<Record<string, unknown>>)
      .filter(x => x.public_ref === g.ref).map(x => [x.resource_id, x.arrival, x.departure])
    expect(balken).toEqual([[d1, '2026-11-08', HEUTE], [null, HEUTE, '2026-11-13']])

    const neu = await aufenthalt({ arrival: HEUTE, departure: '2026-11-12', resourceId: d2 })
    expect((await post(`/v1/reservations/${neu.ref}/assign-unit`, { resourceId: d1 })).statusCode)
      .toBe(200)

    // Aus dem Band in eine Zeile gezogen: das Zimmer gilt fuer den Teil im Band.
    const z = await post(`/v1/reservations/${g.ref}/assign-unit`, { resourceId: s1 })
    expect(z.statusCode, z.body).toBe(200)
    expect(await zimmerHeute(g.id)).toEqual({ resource_id: s1, room_moved: true })
    expect(await reinigung(d1)).toBe('dirty')
    expect(await reinigung(s1)).toBe('occupied')
    expect(await bestand(su, HEUTE)).toBe(1)
    expect(await abweichungen()).toEqual([])

    const d = JSON.parse((await get(`/v1/reservations/${g.ref}`)).body)
    expect(d.roomParts.map((p: { resourceId: number | null }) => p.resourceId)).toEqual([d1, s1])
  })

  it('nimmt den Wechsel ins Band zurueck', async () => {
    const g = await aufenthalt({ arrival: '2026-11-15', departure: '2026-11-18', resourceId: d1 })
    expect((await post(`/v1/reservations/${g.ref}/room-move`,
                       { from: '2026-11-16', resourceId: null })).statusCode).toBe(200)
    expect(await bestand(dz, '2026-11-16')).toBe(1)
    const r = await post(`/v1/reservations/${g.ref}/room-move/undo`, {})
    expect(r.statusCode, r.body).toBe(200)
    expect(await zimmerHeute(g.id)).toEqual({ resource_id: d1, room_moved: false })
    expect(await abweichungen()).toEqual([])
  })

  it('weist das Zuweisen ab, solange der letzte Teil ein Zimmer hat', async () => {
    const g = await aufenthalt({ arrival: '2026-11-15', departure: '2026-11-18', resourceId: d1 })
    await post(`/v1/reservations/${g.ref}/room-move`, { from: '2026-11-16', resourceId: s1 })
    expect((await post(`/v1/reservations/${g.ref}/assign-unit`, { resourceId: d2 })).statusCode)
      .toBe(409)
  })
})
