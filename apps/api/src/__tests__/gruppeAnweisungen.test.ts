import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, countQueries, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Gruppenbuchung und Gruppenverschiebung: die Zahl der Anweisungen haengt
 * nicht an der Zahl der Zimmer (Performance-Audit 11.10.2026, Abschnitt 14).
 *
 * Beide Wege liefen je Zimmer: beim Anlegen Zimmerpruefung, Reservierung,
 * Naechte, Mitreisende, Folio und Ereignis, beim Verschieben rund fuenfzehn
 * Anweisungen je Aufenthalt. Fuenfzig Zimmer ergaben 250 bzw. 750
 * Anweisungen, weit ueber `DB_QUERY_WARN`. Gemessen wird mit zwei und mit
 * zwanzig Zimmern: gleich viele Anweisungen heisst, nichts laeuft mehr je
 * Zimmer -- eine feste Obergrenze allein liesse ein neues N+1 durch, solange
 * die Gruppe im Test klein genug ist.
 *
 * Geprueft wird daneben, was beim Buendeln still verloren gehen koennte: ein
 * Ereignis je Reservierung, der Bestand, die Naechte und die erste Meldung
 * in Zimmerreihenfolge.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let dz: number
let zimmer: number[]
let auth: Record<string, string>

const VON = '2026-10-01'
const BIS = '2026-10-04'
const GROSS = 20

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
  zimmer = await makeResources(owner, fx.propertyId, dz, GROSS + 2, 'D')
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  await owner.query(
    `INSERT INTO webhook_subscription (account_id, url, signing_secret)
     VALUES ($1,'https://kanal.example.de/hook','geheim')`, [fx.accountId])
})

let schluessel = 0
const buchen = (ids: number[], extra: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...auth, 'idempotency-key': `ga-${++schluessel}` },
    payload: { propertyId: fx.propertyId, arrival: VON, departure: BIS, priceCent: 9_000,
               rooms: ids.map(id => ({ categoryId: dz, resourceId: id })), ...extra } })

const verschieben = (bookingRef: string, shiftDays: number) =>
  app.inject({ method: 'POST', url: `/v1/bookings/${bookingRef}/change-stay`,
    headers: auth, payload: { shiftDays } })

async function sold(datum: string): Promise<number> {
  const r = await owner.query<{ sold: number }>(
    `SELECT sold FROM inventory_day
      WHERE property_id = $1 AND category_id = $2 AND date = $3`,
    [fx.propertyId, dz, datum])
  return r.rows[0]!.sold
}

async function ereignisse(typ: string): Promise<string[]> {
  const r = await owner.query<{ ref: string }>(
    `SELECT payload -> 'data' ->> 'reservationRef' AS ref FROM webhook_delivery
      WHERE property_id = $1 AND event_type = $2 ORDER BY id`, [fx.propertyId, typ])
  return r.rows.map(x => x.ref)
}

describe('Gruppe anlegen', () => {
  it('braucht fuer zwanzig Zimmer so viele Anweisungen wie fuer zwei', async () => {
    const klein = await countQueries(pool, () => buchen(zimmer.slice(0, 2)))
    expect(klein.result.statusCode, klein.result.body).toBe(201)
    await truncateAll()
    fx = await makeProperty(owner)
    dz = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
    zimmer = await makeResources(owner, fx.propertyId, dz, GROSS, 'D')
    await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
      [fx.propertyId])
    const u = await makeUser(owner,
      { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
    auth = { cookie: `hp_session=${u.sessionId}` }
    await owner.query(
      `INSERT INTO webhook_subscription (account_id, url, signing_secret)
       VALUES ($1,'https://kanal.example.de/hook','geheim')`, [fx.accountId])

    const gross = await countQueries(pool, () => buchen(zimmer.slice(0, GROSS)))
    expect(gross.result.statusCode, gross.result.body).toBe(201)

    // Anmeldung, Idempotenz, Pruefungen, je eine Anweisung fuer Reservierungen,
    // Naechte, Mitreisende, Folios und Ereignisse. Vorher: 27 bei zwei, 153 bei zwanzig.
    expect(gross.report.count).toBe(klein.report.count)
    expect(gross.report.count).toBeLessThanOrEqual(20)

    // Ein Ereignis je Reservierung, in Zimmerreihenfolge.
    const body = JSON.parse(gross.result.body) as {
      reservations: Array<{ reservationRef: string; resourceId: number }> }
    expect(body.reservations.map(r => r.resourceId)).toEqual(zimmer.slice(0, GROSS))
    expect(await ereignisse('reservation.created'))
      .toEqual(body.reservations.map(r => r.reservationRef))

    expect(await sold(VON)).toBe(GROSS)
    const n = await owner.query<{ naechte: number; folios: number; mit: number }>(
      `SELECT (SELECT count(*)::int FROM reservation_night WHERE property_id = $1) AS naechte,
              (SELECT count(*)::int FROM folio WHERE property_id = $1) AS folios,
              (SELECT count(*)::int FROM reservation_occupant WHERE property_id = $1) AS mit`,
      [fx.propertyId])
    expect(n.rows[0]).toEqual({ naechte: GROSS * 3, folios: GROSS, mit: 0 })

    // Jede Reservierung ihr Zimmer und ihr Folio, nicht vertauscht.
    const z = await owner.query<{ ok: boolean }>(
      `SELECT bool_and(f.reservation_id = r.id) AS ok
         FROM reservation r JOIN folio f ON f.reservation_id = r.id
        WHERE r.property_id = $1`, [fx.propertyId])
    expect(z.rows[0]!.ok).toBe(true)
  })

  it('meldet das erste belegte Zimmer der Reihe nach und legt nichts an', async () => {
    await buchen([zimmer[5]!])
    const vorher = await sold(VON)
    // Zimmer 3 der Gruppe ist ausser Betrieb, Zimmer 6 belegt: gemeldet
    // wird, was die Schleife frueher zuerst traf.
    await owner.query(
      `INSERT INTO maintenance_block (property_id, resource_id, kind, from_date, to_date, reason)
       VALUES ($1,$2,'out_of_order',$3,$4,'Wasserschaden')`,
      [fx.propertyId, zimmer[2]!, VON, BIS])
    const r = await buchen(zimmer.slice(0, 8))
    expect(r.statusCode).toBe(409)
    expect(JSON.parse(r.body).code).toBe('room.outOfOrder')
    expect(await sold(VON)).toBe(vorher)

    const r2 = await buchen([zimmer[0]!, zimmer[1]!, zimmer[5]!, zimmer[2]!])
    expect(JSON.parse(r2.body).code).toBe('room.occupied')
  })
})

describe('Gruppe verschieben', () => {
  it('braucht fuer zwanzig Zimmer so viele Anweisungen wie fuer zwei', async () => {
    const a = await buchen(zimmer.slice(0, 2))
    const b = await buchen(zimmer.slice(2, 2 + GROSS))
    expect(b.statusCode, b.body).toBe(201)
    const refA = (JSON.parse(a.body) as { bookingRef: string }).bookingRef
    const refB = (JSON.parse(b.body) as {
      bookingRef: string; reservations: Array<{ reservationRef: string }> })

    const klein = await countQueries(pool, () => verschieben(refA, 2))
    expect(klein.result.statusCode, klein.result.body).toBe(200)
    const gross = await countQueries(pool, () => verschieben(refB.bookingRef, 2))
    expect(gross.result.statusCode, gross.result.body).toBe(200)

    // Vorher: 32 bei zwei, 248 bei zwanzig Zimmern.
    expect(gross.report.count).toBe(klein.report.count)
    expect(gross.report.count).toBeLessThanOrEqual(20)

    const body = JSON.parse(gross.result.body) as {
      rooms: Array<{ reservationRef: string; arrival: string; departure: string
                     nights: number; removedNights: number; totalCent: number }> }
    expect(body.rooms).toHaveLength(GROSS)
    expect(body.rooms.every(r => r.arrival === '2026-10-03' && r.departure === '2026-10-06'
                              && r.nights === 3 && r.removedNights === 2
                              && r.totalCent === 27_000)).toBe(true)
    expect(body.rooms.map(r => r.reservationRef))
      .toEqual(refB.reservations.map(r => r.reservationRef))

    // Bestand: zwei Naechte frei, zwei neu gebunden, die mittlere bleibt.
    expect(await sold('2026-10-01')).toBe(0)
    expect(await sold('2026-10-03')).toBe(GROSS + 2)
    expect(await sold('2026-10-05')).toBe(GROSS + 2)
    expect(await sold('2026-10-06')).toBe(0)

    // Ein Ereignis je Reservierung, in Zimmerreihenfolge.
    expect((await ereignisse('reservation.changed')).slice(2))
      .toEqual(refB.reservations.map(r => r.reservationRef))
    const n = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reservation_night
        WHERE property_id = $1 AND date >= '2026-10-03' AND date < '2026-10-06'
          AND price_cent = 9000`, [fx.propertyId])
    expect(n.rows[0]!.n).toBe((GROSS + 2) * 3)
  })

  it('weist ab, wenn ein Zimmer im neuen Zeitraum belegt ist, und laesst alles stehen', async () => {
    const g = await buchen(zimmer.slice(0, 4))
    const ref = (JSON.parse(g.body) as { bookingRef: string }).bookingRef
    // Zimmer 3 der Gruppe ist ab dem 5. fremd belegt.
    await app.inject({ method: 'POST', url: '/v1/bookings',
      headers: { ...auth, 'idempotency-key': `ga-${++schluessel}` },
      payload: { propertyId: fx.propertyId, arrival: '2026-10-05', departure: '2026-10-07',
                 categoryId: dz, resourceId: zimmer[2]! } })
    const vorher = await sold('2026-10-05')
    const r = await verschieben(ref, 2)
    expect(r.statusCode).toBe(409)
    expect(JSON.parse(r.body).code).toBe('room.occupied')
    expect(await sold('2026-10-05')).toBe(vorher)
    expect(await sold(VON)).toBe(4)
  })

  /*
   * Zwei Zimmer der Gruppe im selben Zimmer hintereinander: A bis zum 3.,
   * B ab dem 3. Die Schleife verschob A zuerst und fand dann B noch an
   * seinem alten Platz -- belegt. Die gebuendelte Pruefung muss dasselbe
   * sagen und darf es nicht stillschweigend "reparieren".
   */
  it('prueft wie die Schleife: fruehere Zimmer am neuen, spaetere am alten Platz', async () => {
    const g = await buchen([zimmer[0]!, zimmer[1]!])
    const body = JSON.parse(g.body) as {
      bookingRef: string; reservations: Array<{ reservationRef: string }> }
    // Das zweite Zimmer in das erste legen, an die Tage danach.
    await owner.query(
      `UPDATE reservation SET resource_id = $1 WHERE public_ref = $2`,
      [zimmer[0]!, body.reservations[1]!.reservationRef])
    await owner.query(
      `UPDATE reservation SET arrival = '2026-10-04', departure = '2026-10-06'
        WHERE public_ref = $1`, [body.reservations[1]!.reservationRef])
    const r = await verschieben(body.bookingRef, 1)
    expect(r.statusCode).toBe(409)
    expect(JSON.parse(r.body).code).toBe('room.occupied')
    // Rueckwaerts: das erste Zimmer laeuft dem zweiten davon, die Schleife
    // fand den Platz frei.
    const z = await verschieben(body.bookingRef, -1)
    expect(z.statusCode, z.body).toBe(200)
  })
})
