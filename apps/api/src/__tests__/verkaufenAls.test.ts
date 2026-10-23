import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/*
 * Ein Zimmer an einzelnen Tagen als andere Kategorie verkaufen (Migration
 * 0197, Sven 23.10.2026).
 *
 * Der Fall: morgen ist kein Doppelzimmer mehr frei, aber ein Vierbettzimmer.
 * Das Haus verkauft es als Doppelzimmer -- und der Bestand, der an den Kanal
 * geht, muss das wissen: ein Doppelzimmer mehr, ein Vierbettzimmer weniger.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let dz: number
let vz: number
let dzZimmer: number
let vzZimmer: number
let vzZweites: number
let auth: Record<string, string>

const TAG = '2027-03-10'
const DANACH = '2027-03-11'
const UEBERNAECHSTER = '2027-03-12'

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
  ;[vzZimmer, vzZweites] = await makeResources(owner, fx.propertyId, vz, 2, 'V') as [number, number]
  await owner.query(`SELECT inventory_materialize($1,'2027-02-01'::date,'2027-05-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: auth, payload })
const verkaufen = (roomId: number, from: string, to: string, categoryId: number | null) =>
  app.inject({ method: 'PUT', url: `/v1/properties/${fx.propertyId}/room-sell-as`,
               headers: auth, payload: { roomId, from, to, categoryId } })

async function frei(categoryId: number, date = TAG): Promise<{ capacity: number; sold: number }> {
  const r = await owner.query<{ capacity: number; sold: number }>(
    `SELECT capacity, sold FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
    [fx.propertyId, categoryId, date])
  return r.rows[0]!
}

async function refVon(reservationId: number): Promise<string> {
  const r = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [reservationId])
  return r.rows[0]!.public_ref
}

/** Was der Zaehler sagen muss, gegen das, was er sagt -- der taegliche Abgleich. */
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

/** Dasselbe fuer die Kapazitaet: einmal von vorn gerechnet, darf sich nichts aendern. */
async function kapazitaetStimmt(): Promise<boolean> {
  const vorher = await owner.query(
    `SELECT category_id, date, capacity FROM inventory_day
      WHERE property_id = $1 ORDER BY 1, 2`, [fx.propertyId])
  await owner.query(`SELECT inventory_recalc_capacity($1, '2027-02-01', '2027-05-01')`,
    [fx.propertyId])
  const nachher = await owner.query(
    `SELECT category_id, date, capacity FROM inventory_day
      WHERE property_id = $1 ORDER BY 1, 2`, [fx.propertyId])
  return JSON.stringify(vorher.rows) === JSON.stringify(nachher.rows)
}

describe('Zimmer als andere Kategorie verkaufen', () => {
  it('verschiebt die Kapazitaet an genau diesen Tagen', async () => {
    const r = await verkaufen(vzZimmer, TAG, DANACH, dz)
    expect(r.statusCode, r.body).toBe(200)

    expect((await frei(dz)).capacity).toBe(2)
    expect((await frei(vz)).capacity).toBe(1)
    expect((await frei(0)).capacity).toBe(3)
    // Am Tag danach ist alles wie vorher.
    expect((await frei(dz, DANACH)).capacity).toBe(1)
    expect((await frei(vz, DANACH)).capacity).toBe(2)
    expect(await kapazitaetStimmt()).toBe(true)

    // Und so steht es in der Verfuegbarkeit, die das Adminpanel liest.
    const a = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/availability?from=${TAG}&to=${DANACH}` })
    const tage = JSON.parse(a.body).days as Array<{ category_id: number; available: number }>
    expect(tage.find(d => d.category_id === dz)!.available).toBe(2)
    expect(tage.find(d => d.category_id === vz)!.available).toBe(1)
  })

  it('verkauft das volle Doppelzimmer noch einmal, und der Gast zaehlt dort', async () => {
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      resourceId: dzZimmer, arrival: TAG, departure: DANACH })
    expect((await verkaufen(vzZimmer, TAG, DANACH, dz)).statusCode).toBe(200)

    // Wie vom Kanal: eine Doppelzimmerbuchung ohne Zimmer, dann ins VZ.
    const g = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: TAG, departure: DANACH })
    const ref = await refVon(g.reservationId)
    const z = await post(`/v1/reservations/${ref}/assign-unit`, { resourceId: vzZimmer })
    expect(z.statusCode, z.body).toBe(200)

    expect(await frei(dz)).toEqual({ capacity: 2, sold: 2 })
    expect(await frei(vz)).toEqual({ capacity: 1, sold: 0 })
    expect(await abweichungen()).toEqual([])
  })

  it('verlaengert im als Doppelzimmer verkauften Zimmer je Tag richtig', async () => {
    expect((await verkaufen(vzZimmer, TAG, DANACH, dz)).statusCode).toBe(200)
    const g = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      resourceId: vzZimmer, arrival: TAG, departure: DANACH })
    const ref = await refVon(g.reservationId)
    expect(await abweichungen()).toEqual([])

    // Die zweite Nacht ist das Zimmer wieder ein Vierbettzimmer.
    const r = await post(`/v1/reservations/${ref}/change-stay`, { departure: UEBERNAECHSTER })
    expect(r.statusCode, r.body).toBe(200)
    expect((await frei(dz)).sold).toBe(1)
    expect((await frei(vz)).sold).toBe(0)
    expect((await frei(dz, DANACH)).sold).toBe(0)
    expect((await frei(vz, DANACH)).sold).toBe(1)
    expect(await abweichungen()).toEqual([])
  })

  it('zieht ueber change-stay in das Zimmer, ohne am vollen Vierbettzimmer zu scheitern', async () => {
    // Das andere Vierbettzimmer ist belegt: als VZ ist nichts mehr frei.
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: vz,
      resourceId: vzZweites, arrival: TAG, departure: DANACH })
    expect((await verkaufen(vzZimmer, TAG, DANACH, dz)).statusCode).toBe(200)
    const g = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: TAG, departure: DANACH })
    const ref = await refVon(g.reservationId)

    const r = await post(`/v1/reservations/${ref}/change-stay`, { resourceId: vzZimmer })
    expect(r.statusCode, r.body).toBe(200)
    expect(await frei(dz)).toEqual({ capacity: 2, sold: 1 })
    expect(await frei(vz)).toEqual({ capacity: 1, sold: 1 })
    expect(await abweichungen()).toEqual([])
  })

  it('weist einen Tag ab, an dem ein Vierbettzimmer-Gast im Zimmer liegt', async () => {
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: vz,
      resourceId: vzZimmer, arrival: TAG, departure: DANACH })
    const r = await verkaufen(vzZimmer, TAG, UEBERNAECHSTER, dz)
    expect(r.statusCode, r.body).toBe(409)
    expect(JSON.parse(r.body).messageKey ?? r.body).toContain('sellAs.occupied')
    expect((await frei(dz)).capacity).toBe(1)
  })

  it('laesst den Umweg von frueher nachtraeglich markieren', async () => {
    // Das Doppelzimmer, das die Rezeption bisher ins Vierbettzimmer schob.
    const g = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: TAG, departure: DANACH })
    const ref = await refVon(g.reservationId)
    expect((await post(`/v1/reservations/${ref}/assign-unit`, { resourceId: vzZimmer }))
      .statusCode).toBe(200)
    expect(await frei(vz)).toEqual({ capacity: 2, sold: 1 })

    expect((await verkaufen(vzZimmer, TAG, DANACH, dz)).statusCode).toBe(200)
    expect(await frei(dz)).toEqual({ capacity: 2, sold: 1 })
    expect(await frei(vz)).toEqual({ capacity: 1, sold: 0 })
    expect(await abweichungen()).toEqual([])

    // Aufheben ginge nur, wenn der Doppelzimmer-Gast vorher geht.
    expect((await verkaufen(vzZimmer, TAG, DANACH, null)).statusCode).toBe(409)
  })

  it('hebt auf, auch ueber die eigene Kategorie, und alles steht wie vorher', async () => {
    expect((await verkaufen(vzZimmer, TAG, UEBERNAECHSTER, dz)).statusCode).toBe(200)
    const r = await verkaufen(vzZimmer, TAG, DANACH, vz)
    expect(r.statusCode, r.body).toBe(200)
    expect(JSON.parse(r.body).categoryId).toBeNull()
    expect((await frei(dz)).capacity).toBe(1)
    expect((await frei(dz, DANACH)).capacity).toBe(2)

    expect((await verkaufen(vzZimmer, TAG, UEBERNAECHSTER, null)).statusCode).toBe(200)
    expect((await frei(dz, DANACH)).capacity).toBe(1)
    expect((await frei(vz, DANACH)).capacity).toBe(2)
    expect(await kapazitaetStimmt()).toBe(true)
  })

  it('zeigt die Tage im Zimmerplan', async () => {
    expect((await verkaufen(vzZimmer, TAG, UEBERNAECHSTER, dz)).statusCode).toBe(200)
    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/tape-chart?from=2027-03-09&to=2027-03-16` })
    expect(r.statusCode, r.body).toBe(200)
    expect(JSON.parse(r.body).sell_as).toEqual([
      { resource_id: vzZimmer, date: TAG, category_id: dz,
        category_code: 'DZ', category_name: 'Doppelzimmer' },
      { resource_id: vzZimmer, date: DANACH, category_id: dz,
        category_code: 'DZ', category_name: 'Doppelzimmer' }
    ])
  })

  it('nimmt Out of Order an einem solchen Tag in der verkauften Kategorie weg', async () => {
    expect((await verkaufen(vzZimmer, TAG, DANACH, dz)).statusCode).toBe(200)
    await owner.query(
      `INSERT INTO maintenance_block (property_id, resource_id, from_date, to_date, kind, reason)
       VALUES ($1, $2, $3, $4, 'out_of_order', 'Wasser')`,
      [fx.propertyId, vzZimmer, TAG, DANACH])
    expect((await frei(dz)).capacity).toBe(1)
    expect((await frei(vz)).capacity).toBe(1)
    expect(await kapazitaetStimmt()).toBe(true)
  })

  it('weist ein Zimmer des Nachbarhauses und vergangene Tage ab', async () => {
    const nachbar = await makeProperty(owner, { code: 'NB', name: 'Nachbar' })
    const k = await makeCategory(owner, nachbar.propertyId)
    const fremd = (await makeResources(owner, nachbar.propertyId, k, 1, 'N'))[0]!
    expect((await verkaufen(fremd, TAG, DANACH, dz)).statusCode).toBe(404)
    expect((await verkaufen(vzZimmer, '2026-01-01', '2026-01-02', dz)).statusCode).toBe(422)
  })

  it('laesst das Zimmer nicht umgruppieren, solange es anderswo verkauft wird', async () => {
    expect((await verkaufen(vzZimmer, TAG, DANACH, dz)).statusCode).toBe(200)
    const chef = await makeUser(owner,
      { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
    const r = await app.inject({ method: 'PATCH', url: `/v1/rooms/${vzZimmer}`,
      headers: { cookie: `hp_session=${chef.sessionId}` }, payload: { categoryId: dz } })
    expect(r.statusCode, r.body).toBe(409)
  })
})
