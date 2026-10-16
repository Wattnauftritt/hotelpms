import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import { withTransaction, type DbContext, type Pool } from '@hotelpms/db'
import { postNights } from '@hotelpms/domain'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Gruppenfolio (Sven, 16.10.2026: "damit man nicht 10 zimmer einzeln auf
 * eines der zimmer umbuchen muss im folio").
 *
 * Ein Klick legt das Konto der Buchung an, leitet jedes Zimmer darauf um
 * und bucht, was schon offen steht, mit. Der Nachtlauf wird hier wie in
 * vorabBuchen.test.ts mit seinen zwei Buchungsschritten nachgestellt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let ctx: DbContext
let auth: Record<string, string>
let categoryId: number
let rooms: number[]
let lauf = 0

const TAG = '2026-10-01'

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
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
  await openBusinessDay(owner, fx.propertyId, TAG)
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  categoryId = await makeCategory(owner, fx.propertyId)
  rooms = await makeResources(owner, fx.propertyId, categoryId, 3)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  await owner.query(`UPDATE property SET breakfast_cent = 1500 WHERE id = $1`, [fx.propertyId])
  await owner.query(
    `INSERT INTO tax_rule (property_id, code, name, kind, basis, amount_cent, exempt_below_age)
     VALUES ($1,'KURTAXE','Kurtaxe','city_tax','per_person_night',250,16)`, [fx.propertyId])
})

const post = (url: string, payload: unknown = {}) => app.inject({
  method: 'POST', url, headers: { ...auth, 'idempotency-key': `gf-${++lauf}` }, payload })

/** Eine Buchung mit `n` Zimmern im Haus, je ein Erwachsener. */
async function gruppe(n: number): Promise<Array<{ folioId: number; folioRef: string
                                                   reservationId: number }>> {
  const out = []
  let bookingId: number | null = null
  for (let i = 0; i < n; i++) {
    const r = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId, arrival: TAG, departure: '2026-10-04',
      status: 'InHouse', resourceId: rooms[i]!, priceCent: 11_000 })
    if (bookingId === null) bookingId = r.bookingId
    else {
      await owner.query(`UPDATE reservation SET booking_id = $2 WHERE id = $1`,
        [r.reservationId, bookingId])
    }
    await owner.query(
      `INSERT INTO reservation_occupant (property_id, reservation_id, age_at_arrival)
       VALUES ($1,$2,40)`, [fx.propertyId, r.reservationId])
    const f = await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM folio WHERE id = $1`, [r.folioId])
    out.push({ folioId: r.folioId, folioRef: f.rows[0]!.public_ref,
               reservationId: r.reservationId })
  }
  return out
}

const nachtlauf = (datum: string) => withTransaction(pool, ctx, async c => {
  await postNights(c, fx.propertyId, { date: datum })
  await c.query(`SELECT post_city_tax($1, $2::date)`, [fx.propertyId, datum])
})

/** Text und Betrag der Positionen eines Folios, Gegenbuchungen eingeschlossen. */
async function positionen(folioRef: string): Promise<Array<[string, number]>> {
  const r = await owner.query<{ description: string; gross_cent: string }>(
    `SELECT c.description, c.gross_cent FROM charge c JOIN folio f ON f.id = c.folio_id
      WHERE f.public_ref = $1 ORDER BY c.id`, [folioRef])
  return r.rows.map(z => [z.description, Number(z.gross_cent)])
}

async function saldo(folioRef: string): Promise<number> {
  return (await positionen(folioRef)).reduce((s, [, b]) => s + b, 0)
}

interface Konto { folioRef: string; group: boolean; main: boolean; accommodationHere: boolean }

async function stay(folioRef: string): Promise<Konto[]> {
  const r = await app.inject({ method: 'GET', url: `/v1/folios/${folioRef}`, headers: auth })
  expect(r.statusCode, r.body).toBe(200)
  return (JSON.parse(r.body) as { stay: Konto[] }).stay
}

describe('Gruppenfolio', () => {
  it('nimmt Logis und Fruehstueck aller Zimmer, Kurtaxe und Extras bleiben', async () => {
    const [a, b] = await gruppe(2)
    await nachtlauf(TAG)
    const minibar = await post(`/v1/folios/${b!.folioRef}/charges`,
      { description: 'Minibar', grossCent: 450, taxRateBp: 1900 })
    expect(minibar.statusCode, minibar.body).toBe(201)

    const r = await post(`/v1/folios/${b!.folioRef}/group-folio`, { scope: 'accommodation' })
    expect(r.statusCode, r.body).toBe(201)
    const g = JSON.parse(r.body) as { folioRef: string; rooms: number; moved: number }
    // Je Zimmer Uebernachtung, Fruehstueck Speisen, Fruehstueck Getraenke.
    expect(g).toMatchObject({ rooms: 2, moved: 6 })

    expect(await saldo(g.folioRef)).toBe(22_000)
    expect(await saldo(a!.folioRef)).toBe(250)
    expect(await saldo(b!.folioRef)).toBe(250 + 450)

    // Haengt an der ersten Reservierung, gehoert der Buchung; Empfaenger
    // bleibt fuer .../recipient.
    const k = await owner.query<{ kind: string; reservation_id: string }>(
      `SELECT kind, reservation_id::text FROM folio WHERE public_ref = $1`, [g.folioRef])
    expect(k.rows[0]).toEqual({ kind: 'group', reservation_id: String(a!.reservationId) })

    // Der naechste Nachtlauf bucht die Nacht gleich dorthin, die Kurtaxe ans Zimmer.
    await nachtlauf('2026-10-02')
    expect(await saldo(g.folioRef)).toBe(44_000)
    expect(await saldo(a!.folioRef)).toBe(500)

    // Im Folio jedes Zimmers steht das Gruppenfolio vorn.
    const s = await stay(b!.folioRef)
    expect(s[0]).toMatchObject({ folioRef: g.folioRef, group: true, main: false,
                                 accommodationHere: true })

    // Ein zweiter Klick findet dasselbe Folio und bucht nichts doppelt.
    const nochmal = await post(`/v1/folios/${a!.folioRef}/group-folio`,
      { scope: 'accommodation' })
    expect(nochmal.statusCode, nochmal.body).toBe(201)
    expect(JSON.parse(nochmal.body)).toMatchObject({ folioRef: g.folioRef, moved: 0 })
    const regeln = await owner.query(`SELECT 1 FROM routing_rule`)
    expect(regeln.rowCount).toBe(2)
  })

  it('nimmt mit "alles" auch die Extras', async () => {
    const [, b] = await gruppe(2)
    await nachtlauf(TAG)
    await post(`/v1/folios/${b!.folioRef}/charges`,
      { description: 'Minibar', grossCent: 450, taxRateBp: 1900 })

    const r = await post(`/v1/folios/${b!.folioRef}/group-folio`, { scope: 'all' })
    expect(r.statusCode, r.body).toBe(201)
    const g = JSON.parse(r.body) as { folioRef: string; moved: number }
    expect(g.moved).toBe(7)
    expect(await saldo(g.folioRef)).toBe(22_450)
    expect(await saldo(b!.folioRef)).toBe(250)
    const k = await owner.query<{ match_kind: string }>(
      `SELECT DISTINCT match_kind FROM routing_rule`)
    expect(k.rows).toEqual([{ match_kind: 'all' }])
  })

  it('schaltet die Umleitung fuer alle Zimmer wieder ab', async () => {
    const [a] = await gruppe(3)
    const g = (JSON.parse((await post(`/v1/folios/${a!.folioRef}/group-folio`,
      { scope: 'all' })).body) as { folioRef: string }).folioRef
    const put = (accommodation: boolean) => app.inject({
      method: 'PUT', url: `/v1/folios/${g}/routing`, headers: auth,
      payload: { accommodation } })

    expect((await put(false)).statusCode).toBe(200)
    expect((await owner.query(`SELECT 1 FROM routing_rule`)).rowCount).toBe(0)
    expect((await put(true)).statusCode).toBe(200)
    const k = await owner.query<{ match_kind: string; n: number }>(
      `SELECT match_kind, count(*)::int AS n FROM routing_rule GROUP BY match_kind`)
    expect(k.rows).toEqual([{ match_kind: 'accommodation', n: 3 }])
  })

  it('gibt es nur fuer eine Buchung mit mehreren Zimmern', async () => {
    const [a] = await gruppe(1)
    const r = await post(`/v1/folios/${a!.folioRef}/group-folio`, { scope: 'accommodation' })
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).code).toBe('folio.noGroup')
    const falsch = await post(`/v1/folios/${a!.folioRef}/group-folio`, { scope: 'minibar' })
    expect(falsch.statusCode).toBe(422)
  })

  it('haelt das Gruppenfolio aus der Frage beim Check-out des ersten Zimmers', async () => {
    const [a, b] = await gruppe(2)
    await nachtlauf(TAG)
    await post(`/v1/folios/${b!.folioRef}/group-folio`, { scope: 'accommodation' })
    // Die Kurtaxe des ersten Zimmers bar bezahlt: am Zimmer ist nichts offen.
    const bar = await owner.query<{ id: number }>(
      `INSERT INTO payment_method (property_id, code, name) VALUES ($1,'BAR','Bar') RETURNING id`,
      [fx.propertyId])
    await owner.query(
      `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                               payment_method_id)
       VALUES ($1,$2,$3,250,$4)`, [fx.propertyId, a!.folioId, TAG, bar.rows[0]!.id])
    const ref = await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM reservation WHERE id = $1`, [a!.reservationId])
    const r = await post(`/v1/reservations/${ref.rows[0]!.public_ref}/check-out`)
    expect(r.statusCode, r.body).toBe(200)
  })
})
