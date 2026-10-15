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
 * Aufenthalt beim Check-in vorab buchen (Sven, 15.10.2026, Migration 0176).
 *
 * Der Gast zahlt beim Check-in und will sofort die Rechnung. Der Knopf bucht
 * Logis, Fruehstueck und Kurtaxe aller offenen Naechte; der Nachtlauf darf
 * sie danach kein zweites Mal buchen. Der Nachtlauf selbst liegt in
 * `apps/worker`; seine zwei Buchungsschritte sind `postNights` und
 * `post_city_tax`, und genau die ruft der Test hier wie er.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let ctx: DbContext
let auth: Record<string, string>
let categoryId: number
let rooms: number[]

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
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  categoryId = await makeCategory(owner, fx.propertyId)
  rooms = await makeResources(owner, fx.propertyId, categoryId, 2)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  // Fruehstueck 15,00 je Person aus dem Nachtpreis, Kurtaxe 2,50 je Person.
  await owner.query(`UPDATE property SET breakfast_cent = 1500 WHERE id = $1`, [fx.propertyId])
  await owner.query(
    `INSERT INTO tax_rule (property_id, code, name, kind, basis, amount_cent, exempt_below_age)
     VALUES ($1,'KURTAXE','Kurtaxe','city_tax','per_person_night',250,16)`, [fx.propertyId])
})

async function aufenthalt(status: 'InHouse' | 'Confirmed' = 'InHouse'): Promise<{
  id: number; ref: string; folioId: number }> {
  const r = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId, arrival: TAG, departure: '2026-10-04',
    status, resourceId: rooms[0]!, priceCent: 11_000 })
  await owner.query(
    `INSERT INTO reservation_occupant (property_id, reservation_id, age_at_arrival)
     VALUES ($1,$2,40)`, [fx.propertyId, r.reservationId])
  const ref = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [r.reservationId])
  return { id: r.reservationId, ref: ref.rows[0]!.public_ref, folioId: r.folioId }
}

const aktion = (ref: string, was: 'post-stay' | 'unpost-stay') =>
  app.inject({ method: 'POST', url: `/v1/reservations/${ref}/${was}`, headers: auth })

/** Was der Nachtlauf fuer diesen Tag bucht: Logis, dann Kurtaxe. */
const nachtlauf = (datum: string) => withTransaction(pool, ctx, async c => {
  const naechte = await postNights(c, fx.propertyId, { date: datum })
  const k = await c.query<{ n: number }>(`SELECT post_city_tax($1, $2::date) AS n`,
    [fx.propertyId, datum])
  return { naechte: naechte.length, kurtaxe: k.rows[0]!.n }
})

async function folio(folioId: number): Promise<Array<[string, string, number]>> {
  const r = await owner.query<{ business_date: string; description: string; gross_cent: string }>(
    `SELECT business_date::text, description, gross_cent FROM charge
      WHERE folio_id = $1 ORDER BY id`, [folioId])
  return r.rows.map(z => [z.business_date, z.description, Number(z.gross_cent)])
}

async function saldo(folioId: number): Promise<number> {
  const r = await owner.query<{ s: string }>(
    `SELECT COALESCE(sum(gross_cent), 0) AS s FROM charge WHERE folio_id = $1`, [folioId])
  return Number(r.rows[0]!.s)
}

describe('Aufenthalt beim Check-in vorab buchen', () => {
  it('bucht alle Naechte mit Fruehstueck und Kurtaxe, jede mit ihrem Tag', async () => {
    const a = await aufenthalt()
    const r = await aktion(a.ref, 'post-stay')
    expect(r.statusCode, r.body).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ reservationRef: a.ref,
      postedNights: ['2026-10-01', '2026-10-02', '2026-10-03'], cityTaxCharges: 3 })

    const zeilen = await folio(a.folioId)
    // Je Nacht 110,00: Logis 95,00, Fruehstueck 15,00 (Getraenke 30 %), dazu
    // die Kurtaxe -- dieselbe Aufteilung wie im Nachtlauf.
    expect(zeilen.filter(z => z[0] === '2026-10-02')).toEqual([
      ['2026-10-02', 'Übernachtung 02.10.2026', 9_500],
      ['2026-10-02', 'Frühstück Speisen 02.10.2026', 1_050],
      ['2026-10-02', 'Frühstück Getränke 02.10.2026', 450],
      ['2026-10-02', 'Kurtaxe 02.10.2026', 250]])
    expect(await saldo(a.folioId)).toBe(3 * 11_250)
    const n = await owner.query<{ posted: boolean }>(
      `SELECT posted FROM reservation_night WHERE reservation_id = $1`, [a.id])
    expect(n.rows.every(x => x.posted)).toBe(true)
  })

  it('der Nachtlauf bucht danach nichts ein zweites Mal', async () => {
    const a = await aufenthalt()
    expect((await aktion(a.ref, 'post-stay')).statusCode).toBe(200)
    for (const tag of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      expect(await nachtlauf(tag)).toEqual({ naechte: 0, kurtaxe: 0 })
    }
    expect(await saldo(a.folioId)).toBe(3 * 11_250)
    // Und ein zweiter Klick auch nicht.
    const r = await aktion(a.ref, 'post-stay')
    expect(JSON.parse(r.body)).toMatchObject({ postedNights: [], cityTaxCharges: 0 })
    expect(await saldo(a.folioId)).toBe(3 * 11_250)
  })

  it('bucht nur diesen Aufenthalt, nicht die anderen Gaeste derselben Naechte', async () => {
    const a = await aufenthalt()
    const b = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId, arrival: TAG, departure: '2026-10-03',
      status: 'InHouse', resourceId: rooms[1]!, priceCent: 9_000 })
    await owner.query(
      `INSERT INTO reservation_occupant (property_id, reservation_id, age_at_arrival)
       VALUES ($1,$2,40)`, [fx.propertyId, b.reservationId])
    expect((await aktion(a.ref, 'post-stay')).statusCode).toBe(200)
    expect(await saldo(b.folioId)).toBe(0)
    // Der andere Gast wird weiter Nacht fuer Nacht gebucht.
    expect(await nachtlauf(TAG)).toEqual({ naechte: 1, kurtaxe: 1 })
    expect(await saldo(b.folioId)).toBe(9_250)
  })

  it('bucht nur fuer einen Gast im Haus', async () => {
    const a = await aufenthalt('Confirmed')
    const r = await aktion(a.ref, 'post-stay')
    expect(r.statusCode).toBe(409)
    expect(JSON.parse(r.body).code).toBe('stay.postAheadNotInHouse')
    expect(await saldo(a.folioId)).toBe(0)
  })

  it('kuerzen oder auschecken geht erst nach dem Zuruecknehmen', async () => {
    const a = await aufenthalt()
    expect((await aktion(a.ref, 'post-stay')).statusCode).toBe(200)
    // Ein Tag spaeter: der Gast will morgen statt uebermorgen abreisen.
    await owner.query(
      `UPDATE business_day SET status = 'closed' WHERE property_id = $1 AND date = $2::date`,
      [fx.propertyId, TAG])
    await openBusinessDay(owner, fx.propertyId, '2026-10-02')

    const kuerzen = () => app.inject({
      method: 'POST', url: `/v1/reservations/${a.ref}/change-stay`, headers: auth,
      payload: { departure: '2026-10-03' } })
    const r = await kuerzen()
    expect(r.statusCode, r.body).toBe(422)
    expect(JSON.parse(r.body).code).toBe('stay.postedAhead')

    const z = await aktion(a.ref, 'unpost-stay')
    expect(z.statusCode, z.body).toBe(200)
    expect(JSON.parse(z.body)).toEqual({ reservationRef: a.ref,
      reopenedNights: ['2026-10-02', '2026-10-03'] })
    // Die geschlafene Nacht bleibt, die beiden anderen sind gegengebucht,
    // mit dem Tag der Nacht.
    expect(await saldo(a.folioId)).toBe(11_250)
    const storno = await owner.query<{ business_date: string }>(
      `SELECT DISTINCT business_date::text FROM charge
        WHERE folio_id = $1 AND reverses_id IS NOT NULL ORDER BY 1`, [a.folioId])
    expect(storno.rows.map(s => s.business_date)).toEqual(['2026-10-02', '2026-10-03'])

    expect((await kuerzen()).statusCode).toBe(200)
    // Die Nacht bis zur neuen Abreise bucht wieder der Nachtlauf, samt
    // Kurtaxe: die gegengebuchte zaehlt nicht als gebucht.
    expect(await nachtlauf('2026-10-02')).toEqual({ naechte: 1, kurtaxe: 1 })
    expect(await saldo(a.folioId)).toBe(2 * 11_250)
  })

  it('nimmt nichts zurueck, was schon auf einer Rechnung steht', async () => {
    const a = await aufenthalt()
    expect((await aktion(a.ref, 'post-stay')).statusCode).toBe(200)
    const i = await owner.query<{ id: number }>(
      `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date,
                            issuer_snapshot, recipient_snapshot, totals)
       VALUES ($1,$2,'2026-000001',current_date,current_date,'{}'::jsonb,'{}'::jsonb,
               '{"grossCent":33000}'::jsonb) RETURNING id`, [fx.propertyId, a.folioId])
    await owner.query(`UPDATE charge SET invoice_id = $1 WHERE folio_id = $2`,
      [i.rows[0]!.id, a.folioId])

    const r = await aktion(a.ref, 'unpost-stay')
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).code).toBe('stay.postedAheadInvoiced')
    expect(await saldo(a.folioId)).toBe(3 * 11_250)
  })

  it('zeigt im Seitenfenster, was gebucht ist und ob vorab', async () => {
    const a = await aufenthalt()
    const vorher = JSON.parse((await app.inject({
      method: 'GET', url: `/v1/reservations/${a.ref}`, headers: auth })).body)
    expect(vorher.postedAhead).toBe(false)
    expect(vorher.nights.map((n: { posted: boolean }) => n.posted)).toEqual([false, false, false])

    await aktion(a.ref, 'post-stay')
    const danach = JSON.parse((await app.inject({
      method: 'GET', url: `/v1/reservations/${a.ref}`, headers: auth })).body)
    expect(danach.postedAhead).toBe(true)
    expect(danach.nights.map((n: { posted: boolean }) => n.posted)).toEqual([true, true, true])
  })
})
