import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Aufenthaltspreis nachtraeglich korrigieren. Der Fall ist Svens vom
 * 15.10.2026: drei Naechte, je Logis, Fruehstueck Speisen und Getraenke,
 * gebucht 268,00 -- vereinbart waren 268,80.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let categoryId: number
let lauf = 0
const key = (): string => `ap-${++lauf}-${Date.now()}`

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
  await openBusinessDay(owner, fx.propertyId, new Date().toISOString().slice(0, 10))
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  categoryId = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, categoryId, 1)
})

/** Eine Zeile, wie der Nachtlauf sie bucht: Netto aus dem Brutto. */
const zeile = (resId: number, folioId: number, datum: string, text: string,
               brutto: number, satz: number, konto: string, teil: string | null) =>
  owner.query<{ id: number }>(
    `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                         net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account,
                         reservation_id, package_part)
     VALUES ($1,$2,$3::date,$4,1,
             $5::bigint - round($5::bigint * $6 / (10000.0 + $6)),
             round($5::bigint * $6 / (10000.0 + $6)), $5::bigint, $6, $7, $8, $9)
     RETURNING id`,
    [fx.propertyId, folioId, datum, text, brutto, satz, konto, resId, teil])

async function aufenthalt(): Promise<{ resId: number; folioId: number; folioRef: string }> {
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId,
    arrival: '2026-10-08', departure: '2026-10-11',
    priceCent: 8_933, reserveInventory: false })
  const naechte: Array<[string, number]> =
    [['2026-10-08', 8_383], ['2026-10-09', 8_383], ['2026-10-10', 8_384]]
  for (const [datum, logis] of naechte) {
    const tag = datum.split('-').reverse().join('.')
    await zeile(res.reservationId, res.folioId, datum, `Übernachtung ${tag}`,
      logis, 700, '8300', null)
    await zeile(res.reservationId, res.folioId, datum, `Frühstück Speisen ${tag}`,
      385, 700, '8302', 'breakfast_food')
    await zeile(res.reservationId, res.folioId, datum, `Frühstück Getränke ${tag}`,
      165, 1900, '8400', 'breakfast_drinks')
  }
  await owner.query(`UPDATE reservation_night SET posted = true WHERE reservation_id = $1`,
    [res.reservationId])
  const f = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM folio WHERE id = $1`, [res.folioId])
  return { resId: res.reservationId, folioId: res.folioId, folioRef: f.rows[0]!.public_ref }
}

const korrigieren = (folioRef: string, totalCent: unknown, k = key()) =>
  app.inject({ method: 'POST', url: `/v1/folios/${folioRef}/stay-price`,
               headers: { ...auth, 'idempotency-key': k }, payload: { totalCent } })

async function offen(folioId: number): Promise<number> {
  const r = await owner.query<{ s: string }>(
    `SELECT COALESCE(sum(gross_cent), 0) AS s FROM charge
      WHERE folio_id = $1 AND invoice_id IS NULL`, [folioId])
  return Number(r.rows[0]!.s)
}

describe('Aufenthaltspreis nachtraeglich korrigieren', () => {
  it('verteilt den neuen Gesamtpreis, die Logis traegt den Unterschied', async () => {
    const a = await aufenthalt()
    expect(await offen(a.folioId)).toBe(26_800)

    const r = await korrigieren(a.folioRef, 26_880)
    expect(r.statusCode, r.body).toBe(201)
    expect(JSON.parse(r.body)).toEqual({ nights: 3, corrected: 3, totalCent: 26_880 })
    expect(await offen(a.folioId)).toBe(26_880)

    // Je Nacht 89,60: Fruehstueck bleibt, die Logis wird 84,10 -- mit dem
    // Geschaeftstag der Nacht, damit der Leistungszeitraum stimmt.
    const neu = await owner.query<{ business_date: string; gross_cent: string
                                     tax_cent: string; tax_rate_bp: number }>(
      `SELECT business_date::text, gross_cent, tax_cent, tax_rate_bp FROM charge
        WHERE folio_id = $1 AND reverses_id IS NULL AND package_part IS NULL
          AND NOT EXISTS (SELECT 1 FROM charge g WHERE g.reverses_id = charge.id)
        ORDER BY business_date`, [a.folioId])
    expect(neu.rows.map(z => [z.business_date, Number(z.gross_cent), z.tax_rate_bp])).toEqual([
      ['2026-10-08', 8_410, 700], ['2026-10-09', 8_410, 700], ['2026-10-10', 8_410, 700]])
    expect(Number(neu.rows[0]!.tax_cent)).toBe(550)

    // Die Buchung zeigt denselben Preis wie das Folio.
    const n = await owner.query<{ price_cent: string }>(
      `SELECT price_cent FROM reservation_night WHERE reservation_id = $1 ORDER BY date`,
      [a.resId])
    expect(n.rows.map(x => Number(x.price_cent))).toEqual([8_960, 8_960, 8_960])
  })

  it('bucht nichts doppelt, wenn derselbe Auftrag zweimal kommt', async () => {
    const a = await aufenthalt()
    const k = key()
    expect((await korrigieren(a.folioRef, 26_880, k)).statusCode).toBe(201)
    expect((await korrigieren(a.folioRef, 26_880, k)).statusCode).toBe(201)
    expect(await offen(a.folioId)).toBe(26_880)
  })

  it('weist eine schon berechnete Nacht ab', async () => {
    const a = await aufenthalt()
    const i = await owner.query<{ id: number }>(
      `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date,
                            issuer_snapshot, recipient_snapshot, totals)
       VALUES ($1,$2,'2026-000001',current_date,current_date,'{}'::jsonb,'{}'::jsonb,
               '{"grossCent":8383}'::jsonb) RETURNING id`, [fx.propertyId, a.folioId])
    await owner.query(
      `UPDATE charge SET invoice_id = $1
        WHERE id = (SELECT min(id) FROM charge WHERE folio_id = $2)`, [i.rows[0]!.id, a.folioId])
    const k = await korrigieren(a.folioRef, 26_880)
    expect(k.statusCode).toBe(409)
    expect(k.body).toContain('stayPrice.invoicedNight')
  })

  it('weist einen Preis ab, der das Fruehstueck nicht deckt', async () => {
    const a = await aufenthalt()
    const r = await korrigieren(a.folioRef, 1_500)
    expect(r.statusCode).toBe(422)
    expect(await offen(a.folioId)).toBe(26_800)
  })
})
