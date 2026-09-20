import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Die Gruppe als Vorgang, nicht als acht lose Reservierungen.
 *
 * An der Rezeption wird eine Reisegruppe als **eine** Sache behandelt:
 * "die Gruppe Petersen kommt einen Tag spaeter", "wir brauchen noch ein
 * neuntes Zimmer". Bisher hiess das acht Aufrufe, und nach dem fuenften
 * einen Zustand, den niemand gewollt hat, falls der sechste scheiterte.
 *
 * Geprueft wird vor allem die Klammer: dass ein Zusammenstoss im fuenften
 * Zimmer die ersten vier **nicht** stehen laesst.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let dz: number
let suite: number
let dzZimmer: number[]
let suiteZimmer: number[]
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
  dz = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  suite = await makeCategory(owner, fx.propertyId, { code: 'SUI' })
  dzZimmer = await makeResources(owner, fx.propertyId, dz, 6, 'D')
  suiteZimmer = await makeResources(owner, fx.propertyId, suite, 2, 'S')
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

let schluessel = 0
const buchen = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...auth, 'idempotency-key': `k-${++schluessel}` },
    payload: { propertyId: fx.propertyId, arrival: VON, departure: BIS, ...payload } })

interface Angelegt { bookingRef: string; reservations: Array<{ reservationRef: string }> }

async function gruppe(zimmerZahl = 3): Promise<Angelegt> {
  const r = await buchen({
    rooms: dzZimmer.slice(0, zimmerZahl).map(id => ({ categoryId: dz, resourceId: id }))
  })
  expect(r.statusCode).toBe(201)
  return JSON.parse(r.body) as Angelegt
}

const lesen = (ref: string) =>
  app.inject({ method: 'GET', url: `/v1/bookings/${ref}`, headers: auth })

const verschieben = (ref: string, shiftDays: number) =>
  app.inject({ method: 'POST', url: `/v1/bookings/${ref}/change-stay`,
    headers: { ...auth, 'idempotency-key': `s-${++schluessel}` },
    payload: { shiftDays } })

const zimmerDazu = (ref: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/v1/bookings/${ref}/rooms`,
    headers: { ...auth, 'idempotency-key': `z-${++schluessel}` },
    payload: { propertyId: fx.propertyId, ...payload } })

async function aufenthalt(ref: string): Promise<{ arrival: string; departure: string }> {
  const r = await owner.query<{ arrival: string; departure: string }>(
    `SELECT arrival::text, departure::text FROM reservation WHERE public_ref = $1`, [ref])
  return r.rows[0]!
}

describe('Die Buchung mit allen ihren Zimmern lesen', () => {
  it('bringt jedes Zimmer der Gruppe in einem Aufruf', async () => {
    const g = await gruppe(3)
    const r = await lesen(g.bookingRef)
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body) as
      { bookingRef: string; rooms: Array<{ roomCode: string; nights: number }> }
    expect(body.bookingRef).toBe(g.bookingRef)
    expect(body.rooms).toHaveLength(3)
    expect(body.rooms.map(z => z.roomCode).sort()).toEqual(['D101', 'D102', 'D103'])
    // Drei Naechte je Zimmer -- das Aggregat rechnet, nicht der Client.
    expect(body.rooms.every(z => z.nights === 3)).toBe(true)
  })

  it('nennt die Summe der ganzen Gruppe', async () => {
    const r0 = await buchen({
      rooms: dzZimmer.slice(0, 2).map(id => ({ categoryId: dz, resourceId: id })),
      totalCent: 60_000
    })
    const g = JSON.parse(r0.body) as Angelegt
    const body = JSON.parse((await lesen(g.bookingRef)).body) as { totalCent: number }
    expect(body.totalCent).toBe(60_000)
  })

  it('gibt die laufende id nicht heraus', async () => {
    // Nach aussen geht die oeffentliche Referenz (C1, Dokument 13).
    const g = await gruppe(1)
    expect(JSON.parse((await lesen(g.bookingRef)).body)).not.toHaveProperty('id')
  })

  it('antwortet auf eine unbekannte Buchung mit 404', async () => {
    expect((await lesen('GIBTESNICHT')).statusCode).toBe(404)
  })
})

describe('Die ganze Gruppe in der Zeit verschieben', () => {
  it('verschiebt jedes Zimmer um dieselbe Zahl Tage', async () => {
    const g = await gruppe(3)
    const r = await verschieben(g.bookingRef, 2)
    expect(r.statusCode).toBe(200)
    for (const res of g.reservations) {
      expect(await aufenthalt(res.reservationRef))
        .toEqual({ arrival: '2026-10-03', departure: '2026-10-06' })
    }
  })

  it('erhaelt Abweichungen, statt die Gruppe wieder gleichzuziehen', async () => {
    /*
     * Nach einzelnen Aenderungen liegen die Zimmer nicht mehr
     * deckungsgleich. Ein gemeinsamer neuer Zeitraum machte daraus wieder
     * einen Block und loeschte genau das, was jemand von Hand eingetragen
     * hat. Der Versatz erhaelt es.
     */
    const g = await gruppe(2)
    const erstes = g.reservations[0]!.reservationRef
    await app.inject({ method: 'POST',
      url: `/v1/reservations/${erstes}/change-stay`,
      headers: { ...auth, 'idempotency-key': `c-${++schluessel}` },
      payload: { departure: '2026-10-06' } })

    expect((await verschieben(g.bookingRef, 1)).statusCode).toBe(200)
    expect(await aufenthalt(erstes))
      .toEqual({ arrival: '2026-10-02', departure: '2026-10-07' })
    expect(await aufenthalt(g.reservations[1]!.reservationRef))
      .toEqual({ arrival: '2026-10-02', departure: '2026-10-05' })
  })

  it('verschiebt auch nach hinten', async () => {
    const g = await gruppe(1)
    expect((await verschieben(g.bookingRef, -3)).statusCode).toBe(200)
    expect(await aufenthalt(g.reservations[0]!.reservationRef))
      .toEqual({ arrival: '2026-09-28', departure: '2026-10-01' })
  })

  it('laesst keine halbe Gruppe stehen, wenn ein Zimmer anstoesst', async () => {
    /*
     * **Der eigentliche Grund fuer den Endpunkt.** Acht Aufrufe
     * nacheinander haetten nach dem fuenften genau den Zustand, den
     * niemand gewollt hat: die halbe Gruppe eine Woche weiter als die
     * andere Haelfte.
     */
    const g = await gruppe(3)
    // Ein fremder Gast legt sich in das dritte Zimmer der Gruppe, genau
    // dorthin, wo die Gruppe nach dem Verschieben liegen wuerde.
    const fremd = await buchen({
      categoryId: dz, resourceId: dzZimmer[2],
      arrival: '2026-10-06', departure: '2026-10-08'
    })
    expect(fremd.statusCode).toBe(201)

    const r = await verschieben(g.bookingRef, 5)
    expect(r.statusCode).toBe(409)

    // Und zwar alle drei unveraendert, nicht nur das dritte.
    for (const res of g.reservations) {
      expect(await aufenthalt(res.reservationRef))
        .toEqual({ arrival: VON, departure: BIS })
    }
  })

  it('weist einen Versatz von null ab', async () => {
    const g = await gruppe(1)
    expect((await verschieben(g.bookingRef, 0)).statusCode).toBe(422)
  })

  it('verschiebt ein storniertes Zimmer nicht mit', async () => {
    const g = await gruppe(2)
    const storniert = g.reservations[1]!.reservationRef
    await app.inject({ method: 'POST', url: `/v1/reservations/${storniert}/cancel`,
      headers: { ...auth, 'idempotency-key': `x-${++schluessel}` }, payload: {} })

    expect((await verschieben(g.bookingRef, 1)).statusCode).toBe(200)
    // Das stornierte bleibt liegen: es haelt keinen Bestand, und es
    // mitzuschieben faende beim Zaehler keine Entsprechung.
    expect(await aufenthalt(storniert)).toEqual({ arrival: VON, departure: BIS })
  })
})

describe('Ein Zimmer zu einer bestehenden Gruppe', () => {
  it('haengt es an dieselbe Buchung, nicht an eine zweite', async () => {
    const g = await gruppe(2)
    const r = await zimmerDazu(g.bookingRef,
      { categoryId: suite, resourceId: suiteZimmer[0] })
    expect(r.statusCode).toBe(201)

    const body = JSON.parse((await lesen(g.bookingRef)).body) as
      { rooms: Array<{ roomCode: string }> }
    expect(body.rooms).toHaveLength(3)
    expect(body.rooms.map(z => z.roomCode)).toContain('S101')
  })

  it('nimmt den Zeitraum der Gruppe, wenn keiner dabeisteht', async () => {
    const g = await gruppe(1)
    const r = await zimmerDazu(g.bookingRef, { categoryId: dz, resourceId: dzZimmer[3] })
    const body = JSON.parse(r.body) as { arrival: string; departure: string }
    expect(body).toMatchObject({ arrival: VON, departure: BIS })
  })

  it('laesst abweichende Tage zu, wenn sie genannt werden', async () => {
    const g = await gruppe(1)
    const r = await zimmerDazu(g.bookingRef, {
      categoryId: dz, resourceId: dzZimmer[3],
      arrival: '2026-10-02', departure: '2026-10-03'
    })
    expect(r.statusCode).toBe(201)
    const body = JSON.parse(r.body) as { reservationRef: string; nights: number }
    expect(body.nights).toBe(1)
  })

  it('nimmt den Preis des Zimmers und teilt ihn auf die Naechte', async () => {
    const g = await gruppe(1)
    const r = await zimmerDazu(g.bookingRef,
      { categoryId: dz, resourceId: dzZimmer[3], totalCent: 10_000 })
    expect(JSON.parse(r.body)).toMatchObject({ totalCent: 10_000 })
    const n = await owner.query<{ price_cent: string }>(
      `SELECT n.price_cent FROM reservation_night n
         JOIN reservation r ON r.id = n.reservation_id
        WHERE r.public_ref = $1 ORDER BY n.date`,
      [(JSON.parse(r.body) as { reservationRef: string }).reservationRef])
    expect(n.rows.map(x => Number(x.price_cent))).toEqual([3334, 3333, 3333])
  })

  it('weist ein belegtes Zimmer ab', async () => {
    const g = await gruppe(2)
    // dzZimmer[0] liegt schon in dieser Gruppe.
    expect((await zimmerDazu(g.bookingRef,
      { categoryId: dz, resourceId: dzZimmer[0] })).statusCode).toBe(409)
  })

  it('weist eine Zimmergruppe aus einem anderen Haus ab', async () => {
    const anderes = await makeProperty(owner, { code: 'ZWEI' })
    const fremdeGruppe = await makeCategory(owner, anderes.propertyId, { code: 'FRD' })
    const g = await gruppe(1)
    expect((await zimmerDazu(g.bookingRef, { categoryId: fremdeGruppe })).statusCode)
      .toBe(404)
  })

  it('legt ein Folio an, damit das Zimmer abrechenbar ist', async () => {
    const g = await gruppe(1)
    const r = await zimmerDazu(g.bookingRef, { categoryId: dz, resourceId: dzZimmer[3] })
    const ref = (JSON.parse(r.body) as { reservationRef: string }).reservationRef
    const f = await owner.query(
      `SELECT 1 FROM folio f JOIN reservation r ON r.id = f.reservation_id
        WHERE r.public_ref = $1 AND f.kind = 'guest'`, [ref])
    expect(f.rowCount).toBe(1)
  })
})
