import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, makePaymentMethod,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Anzahlungen und ihre Steuerpflicht (Aufgabe 3).
 *
 * Abnahme: 200 Euro Anzahlung auf einen Aufenthalt von 500 Euro ergeben eine
 * Schlussrechnung ueber 500 Euro mit ausgewiesener Anrechnung und 300 Euro
 * offen. Die Steuer der Anzahlung wird im Monat der Vereinnahmung ausgewiesen.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let categoryId: number
let paymentMethod: string

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
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  categoryId = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, categoryId, 1)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  paymentMethod = 'BAR'
  await makePaymentMethod(owner, fx.propertyId, paymentMethod)
})

let lauf = 0

/** Reservierung mit Folio und Gast, wie eine Anzahlungsrechnung sie braucht. */
async function folioMitReservierung(
  opts: { arrival?: string; departure?: string } = {}
): Promise<{ folioRef: string; folioId: number }> {
  const gast = await makeGuest(owner, fx.accountId)
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId,
    arrival: opts.arrival ?? '2026-10-01', departure: opts.departure ?? '2026-10-04'
  })
  const f = await owner.query<{ public_ref: string }>(
    `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`,
    [res.folioId, gast.id])
  return { folioRef: f.rows[0]!.public_ref, folioId: res.folioId }
}

async function settlementAnlegen(
  folioRef: string, amountCent: number, businessDate?: string
): Promise<number> {
  if (businessDate !== undefined) {
    const f = await owner.query<{ id: number; property_id: number }>(
      `SELECT id, property_id FROM folio WHERE public_ref = $1`, [folioRef])
    const pm = await owner.query<{ id: number }>(
      `SELECT id FROM payment_method WHERE property_id = $1 AND code = $2`,
      [f.rows[0]!.property_id, paymentMethod])
    const s = await owner.query<{ id: number }>(
      `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent, payment_method_id)
       VALUES ($1,$2,$3::date,$4,$5) RETURNING id`,
      [f.rows[0]!.property_id, f.rows[0]!.id, businessDate, amountCent, pm.rows[0]!.id])
    return s.rows[0]!.id
  }
  const r = await app.inject({
    method: 'POST', url: `/v1/folios/${folioRef}/settlements`,
    headers: { ...auth, 'idempotency-key': `s-${++lauf}` },
    payload: { amountCent, paymentMethodCode: paymentMethod }
  })
  expect(r.statusCode, r.body).toBe(201)
  return (JSON.parse(r.body) as { settlementId: number }).settlementId
}

const anzahlungsrechnung = (folioRef: string, settlementId: number, taxRateBp = 700) =>
  app.inject({
    method: 'POST', url: `/v1/folios/${folioRef}/deposit-invoice`,
    headers: { ...auth, 'idempotency-key': `d-${++lauf}` },
    payload: { settlementId, taxRateBp }
  })

async function chargeAnlegen(folioRef: string, netCent: number, taxRateBp = 700): Promise<void> {
  const r = await app.inject({
    method: 'POST', url: `/v1/folios/${folioRef}/charges`,
    headers: { ...auth, 'idempotency-key': `c-${++lauf}` },
    payload: { description: 'Uebernachtung', netCent, taxRateBp }
  })
  expect(r.statusCode, r.body).toBe(201)
}

const fakturieren = (folioRef: string) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/invoice`,
  headers: { ...auth, 'idempotency-key': `i-${++lauf}` }, payload: {} })

describe('Anzahlungsrechnung', () => {
  it('stellt eine Anzahlungsrechnung aus eigener Nummernfolge aus', async () => {
    const { folioRef } = await folioMitReservierung()
    const settlementId = await settlementAnlegen(folioRef, 20_000)

    const r = await anzahlungsrechnung(folioRef, settlementId)
    expect(r.statusCode, r.body).toBe(201)
    const body = JSON.parse(r.body) as { number: string; grossCent: number }
    expect(body.number).toMatch(/^\d{4}-\d{5}$/)
    expect(body.grossCent).toBe(20_000)

    const inv = await owner.query<{ kind: string; number: string }>(
      `SELECT kind, number FROM invoice WHERE property_id = $1 AND kind = 'deposit'`,
      [fx.propertyId])
    expect(inv.rows).toHaveLength(1)

    // Dieselbe Nummernfolge wie eine Schlussrechnung: die naechste
    // Schlussrechnung des Hauses zaehlt daran weiter.
    await chargeAnlegen(folioRef, 46_729) // ~500 Euro brutto bei 7%
    const finale = await fakturieren(folioRef)
    const finaleNummer = (JSON.parse(finale.body) as { number: string }).number
    expect(finaleNummer).not.toBe(inv.rows[0]!.number)
  })

  it('traegt die Vereinnahmung in das Anzahlungsjournal ein', async () => {
    const { folioRef, folioId } = await folioMitReservierung()
    const settlementId = await settlementAnlegen(folioRef, 20_000)
    await anzahlungsrechnung(folioRef, settlementId)

    const eintrag = await owner.query<{ kind: string; amount_gross_cent: number
                                        settlement_id: number }>(
      `SELECT kind, amount_gross_cent, settlement_id FROM deposit_ledger WHERE folio_id = $1`,
      [folioId])
    expect(eintrag.rows).toEqual([
      { kind: 'received', amount_gross_cent: 20_000, settlement_id: settlementId }
    ])
  })

  it('laesst den Zahlungsvermerk selbst unangetastet', async () => {
    const { folioRef } = await folioMitReservierung()
    const settlementId = await settlementAnlegen(folioRef, 20_000)
    await anzahlungsrechnung(folioRef, settlementId)

    const s = await owner.query<{ invoice_id: number | null }>(
      `SELECT invoice_id FROM settlement WHERE id = $1`, [settlementId])
    expect(s.rows[0]!.invoice_id).toBeNull()
  })

  it('verweigert eine zweite Anzahlungsrechnung zum selben Zahlungsvermerk', async () => {
    const { folioRef } = await folioMitReservierung()
    const settlementId = await settlementAnlegen(folioRef, 20_000)
    await anzahlungsrechnung(folioRef, settlementId)

    const zweite = await anzahlungsrechnung(folioRef, settlementId)
    expect(zweite.statusCode).toBe(409)
  })

  it('verweigert eine Anzahlungsrechnung ohne Reservierung', async () => {
    const gast = await makeGuest(owner, fx.accountId)
    const f = await owner.query<{ public_ref: string }>(
      `INSERT INTO folio (property_id, kind, guest_id) VALUES ($1,'guest',$2)
       RETURNING public_ref`, [fx.propertyId, gast.id])
    const settlementId = await settlementAnlegen(f.rows[0]!.public_ref, 20_000)

    const r = await anzahlungsrechnung(f.rows[0]!.public_ref, settlementId)
    expect(r.statusCode).toBe(422)
  })

  /**
   * Die eigentliche Abnahme: 200 Euro Anzahlung auf 500 Euro Aufenthalt
   * ergeben eine Schlussrechnung ueber netto 500 Euro Leistung, mit einer
   * Position, die die Anzahlung verrechnet, und 300 Euro offen.
   */
  it('verrechnet die Anzahlung in der Schlussrechnung mit 300 Euro offen', async () => {
    const { folioRef, folioId } = await folioMitReservierung()
    const settlementId = await settlementAnlegen(folioRef, 20_000)
    const dep = await anzahlungsrechnung(folioRef, settlementId)
    const depBody = JSON.parse(dep.body) as { number: string; invoiceRef: string }

    // Aufenthalt von 500 Euro brutto bei 7 Prozent: 467,29 netto.
    await chargeAnlegen(folioRef, 46_729)

    const finale = await fakturieren(folioRef)
    expect(finale.statusCode, finale.body).toBe(201)
    const body = JSON.parse(finale.body) as {
      totals: { grossCent: number }
      depositsApplied: Array<{ depositInvoiceNumber: string; amountGrossCent: number }>
    }
    expect(body.totals.grossCent).toBe(30_000)
    expect(body.depositsApplied).toEqual([
      { depositInvoiceNumber: depBody.number, amountGrossCent: 20_000 }
    ])

    // Das Folio selbst zaehlt unabhaengig davon: 500 Euro Leistung, 200
    // Euro bereits bezahlt, 300 Euro offen. Die Anzahlungsrechnung hat
    // daran nichts veraendert.
    const folio = await app.inject({ method: 'GET', url: `/v1/folios/${folioRef}`, headers: auth })
    const folioBody = JSON.parse(folio.body) as { balanceCent: number }
    expect(folioBody.balanceCent).toBe(30_000)

    // Die Anzahlung ist verrechnet und darf keiner weiteren Schlussrechnung
    // mehr zugeschlagen werden.
    const ledger = await owner.query<{ kind: string }>(
      `SELECT kind FROM deposit_ledger WHERE folio_id = $1 ORDER BY id`, [folioId])
    expect(ledger.rows.map(r => r.kind)).toEqual(['received', 'applied'])
  })

  it('laesst eine Schlussrechnung ohne offene Anzahlung unveraendert', async () => {
    const { folioRef } = await folioMitReservierung()
    await chargeAnlegen(folioRef, 46_729)
    const r = await fakturieren(folioRef)
    const body = JSON.parse(r.body) as { totals: { grossCent: number }
                                          depositsApplied: unknown[] }
    expect(body.totals.grossCent).toBe(50_000)
    expect(body.depositsApplied).toEqual([])
  })
})
