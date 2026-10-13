import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, makePaymentMethod,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Rueckzahlung einer Anzahlung (0162). Bisher wies die Schlussrechnung sich
 * selbst ab, sobald die Anzahlung die Leistungen ueberstieg, und die Steuer
 * auf das zurueckgezahlte Geld blieb ausgewiesen.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let categoryId: number
let lauf = 0

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
  await openBusinessDay(owner, fx.propertyId)
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  await makePaymentMethod(owner, fx.propertyId, 'BAR')
  categoryId = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, categoryId, 1)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
})

const post = (url: string, payload: unknown = {}) => app.inject({
  method: 'POST', url, headers: { ...auth, 'idempotency-key': `rz-${++lauf}` }, payload })

/** Folio mit Gast samt Anschrift und einer bezahlten Anzahlung zu 7 %. */
async function angezahlt(cent: number): Promise<{ ref: string; id: number
                                                   depositRef: string }> {
  const gast = await makeGuest(owner, fx.accountId)
  await owner.query(
    `UPDATE guest SET address_line1 = 'Strandweg 2', postal_code = '27476',
                      city = 'Cuxhaven', country = 'DE' WHERE id = $1`, [gast.id])
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId, arrival: '2026-10-01', departure: '2026-10-03' })
  const f = await owner.query<{ public_ref: string }>(
    `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`, [res.folioId, gast.id])
  const ref = f.rows[0]!.public_ref
  const z = await post(`/v1/folios/${ref}/settlements`,
    { amountCent: cent, paymentMethodCode: 'BAR' })
  expect(z.statusCode, z.body).toBe(201)
  const a = await post(`/v1/folios/${ref}/deposit-invoice`,
    { settlementId: (JSON.parse(z.body) as { settlementId: number }).settlementId,
      taxRateBp: 700 })
  expect(a.statusCode, a.body).toBe(201)
  return { ref, id: res.folioId,
           depositRef: (JSON.parse(a.body) as { invoiceRef: string }).invoiceRef }
}

async function uebernachtung(folioRef: string, grossCent: number): Promise<void> {
  const r = await post(`/v1/folios/${folioRef}/charges`,
    { description: 'Uebernachtung', grossCent, taxRateBp: 700 })
  expect(r.statusCode, r.body).toBe(201)
}

describe('Rueckzahlung einer Anzahlung', () => {
  it('zahlt den Ueberschuss zurueck, danach geht die Schlussrechnung', async () => {
    const f = await angezahlt(50_000)
    await uebernachtung(f.ref, 30_000)

    const vorher = await post(`/v1/folios/${f.ref}/invoice`)
    expect(vorher.statusCode).toBe(422)
    expect(JSON.parse(vorher.body).code).toBe('deposit.exceedsServices')

    const r = await post(`/v1/invoices/${f.depositRef}/refund`,
      { amountCent: 20_000, paymentMethodCode: 'BAR' })
    expect(r.statusCode, r.body).toBe(201)
    expect(JSON.parse(r.body)).toMatchObject({ amountCent: 20_000, remainingCent: 30_000 })

    // Die Korrektur: eigene Nummer, Bezug auf die Anzahlungsrechnung,
    // negative Summen zum Satz der Anzahlung, Auszahlung an ihr.
    const k = await owner.query<{ kind: string; partial_reversal: boolean
                                  totals: { grossCent: number; taxCent: number }
                                  bezug: string; auszahlung: string }>(
      `SELECT k.kind, k.partial_reversal, k.totals, d.public_ref AS bezug,
              (SELECT sum(amount_cent) FROM settlement WHERE invoice_id = k.id)::text
                AS auszahlung
         FROM invoice k JOIN invoice d ON d.id = k.reverses_id
        WHERE k.kind = 'credit_note'`)
    expect(k.rows).toHaveLength(1)
    expect(k.rows[0]).toMatchObject({ kind: 'credit_note', partial_reversal: true,
                                      bezug: f.depositRef, auszahlung: '-20000' })
    expect(k.rows[0]!.totals.grossCent).toBe(-20_000)
    expect(k.rows[0]!.totals.taxCent).toBe(-1_308)

    const s = await post(`/v1/folios/${f.ref}/invoice`)
    expect(s.statusCode, s.body).toBe(201)
    const schluss = JSON.parse(s.body) as {
      totals: { grossCent: number }; depositsApplied: { amountGrossCent: number }[] }
    expect(schluss.depositsApplied.map(d => d.amountGrossCent)).toEqual([30_000])
    expect(schluss.totals.grossCent).toBe(0)

    const saldo = await owner.query<{ s: string }>(
      `SELECT (COALESCE((SELECT sum(gross_cent) FROM charge WHERE folio_id = $1), 0)
             - COALESCE((SELECT sum(amount_cent) FROM settlement WHERE folio_id = $1), 0))::text
              AS s`, [f.id])
    expect(Number(saldo.rows[0]!.s)).toBe(0)

    // Die Anzahlungsrechnung gilt weiter, nur kleiner: nicht "storniert".
    const liste = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/invoices?from=2026-01-01&to=2026-12-31`,
      headers: auth })
    const anz = (JSON.parse(liste.body) as { invoices: { kind: string
      cancelledBy: string | null }[] }).invoices.find(i => i.kind === 'deposit')!
    expect(anz.cancelledBy).toBeNull()
  })

  it('erlaubt mehrere Teile, aber nicht mehr als offen ist', async () => {
    const f = await angezahlt(10_000)
    expect((await post(`/v1/invoices/${f.depositRef}/refund`,
      { amountCent: 3_000, paymentMethodCode: 'BAR' })).statusCode).toBe(201)
    const zuviel = await post(`/v1/invoices/${f.depositRef}/refund`,
      { amountCent: 7_001, paymentMethodCode: 'BAR' })
    expect(zuviel.statusCode).toBe(422)
    expect(JSON.parse(zuviel.body).code).toBe('deposit.refundTooHigh')
    expect((await post(`/v1/invoices/${f.depositRef}/refund`,
      { amountCent: 7_000, paymentMethodCode: 'BAR' })).statusCode).toBe(201)

    // Ganz zurueck: auch Netto und Steuer gehen auf null, kein Cent bleibt.
    const rest = await owner.query<{ g: string; n: string; t: string }>(
      `SELECT sum(CASE kind WHEN 'received' THEN amount_gross_cent ELSE -amount_gross_cent END)::text AS g,
              sum(CASE kind WHEN 'received' THEN net_cent ELSE -net_cent END)::text AS n,
              sum(CASE kind WHEN 'received' THEN tax_cent ELSE -tax_cent END)::text AS t
         FROM deposit_ledger WHERE folio_id = $1`, [f.id])
    expect(rest.rows[0]).toEqual({ g: '0', n: '0', t: '0' })

    const p = await app.inject({ method: 'GET', url: `/v1/folios/${f.ref}/prepayments`,
                                 headers: auth })
    const d = (JSON.parse(p.body) as { deposits: { refundedCent: number }[] }).deposits[0]!
    expect(d.refundedCent).toBe(10_000)
  })

  it('weist eine schon verrechnete Anzahlung und eine Rechnung ab', async () => {
    const f = await angezahlt(10_000)
    await uebernachtung(f.ref, 30_000)
    const s = await post(`/v1/folios/${f.ref}/invoice`)
    expect(s.statusCode, s.body).toBe(201)

    const r = await post(`/v1/invoices/${f.depositRef}/refund`,
      { amountCent: 1_000, paymentMethodCode: 'BAR' })
    expect(r.statusCode).toBe(409)
    expect(JSON.parse(r.body).code).toBe('deposit.refundApplied')

    const ref = (JSON.parse(s.body) as { invoiceRef: string }).invoiceRef
    const r2 = await post(`/v1/invoices/${ref}/refund`,
      { amountCent: 1_000, paymentMethodCode: 'BAR' })
    expect(r2.statusCode).toBe(409)
    expect(JSON.parse(r2.body).code).toBe('deposit.refundOnlyDeposit')

    // Nach dem Storno der Schlussrechnung ist sie wieder offen.
    expect((await post(`/v1/invoices/${ref}/cancel`)).statusCode).toBe(201)
    expect((await post(`/v1/invoices/${f.depositRef}/refund`,
      { amountCent: 1_000, paymentMethodCode: 'BAR' })).statusCode).toBe(201)
  })
})
