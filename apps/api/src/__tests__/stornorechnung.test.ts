import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, makePaymentMethod,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildInvoiceCii } from '@hotelpms/domain'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Pruefung des Rechnungssystems vom 13.10.2026: Stornorechnung (Befund 2),
 * Anzahlungsrechnung als bezahlt (Befund 5), Check-out mit offenem Saldo
 * (Befund 6).
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
  method: 'POST', url, headers: { ...auth, 'idempotency-key': `st-${++lauf}` }, payload })

/** Reservierung mit Folio und Gast samt Anschrift. */
async function folio(): Promise<{ ref: string; id: number; reservationRef: string }> {
  const gast = await makeGuest(owner, fx.accountId)
  await owner.query(
    `UPDATE guest SET address_line1 = 'Strandweg 2', postal_code = '27476',
                      city = 'Cuxhaven', country = 'DE' WHERE id = $1`, [gast.id])
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId, arrival: '2026-10-01', departure: '2026-10-03' })
  const f = await owner.query<{ public_ref: string }>(
    `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`, [res.folioId, gast.id])
  const r = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [res.reservationId])
  return { ref: f.rows[0]!.public_ref, id: res.folioId, reservationRef: r.rows[0]!.public_ref }
}

async function buchen(folioRef: string, netCent: number, taxRateBp: number): Promise<void> {
  const r = await post(`/v1/folios/${folioRef}/charges`,
    { description: taxRateBp === 700 ? 'Uebernachtung' : 'Minibar', netCent, taxRateBp })
  expect(r.statusCode, r.body).toBe(201)
}

async function saldo(folioId: number): Promise<number> {
  const r = await owner.query<{ s: string }>(
    `SELECT (COALESCE((SELECT sum(gross_cent) FROM charge WHERE folio_id = $1), 0)
           - COALESCE((SELECT sum(amount_cent) FROM settlement WHERE folio_id = $1), 0))::text
            AS s`, [folioId])
  return Number(r.rows[0]!.s)
}

describe('Stornorechnung', () => {
  it('hebt die Rechnung auf und stellt die Positionen wieder offen', async () => {
    const f = await folio()
    await buchen(f.ref, 10_000, 700)
    await buchen(f.ref, 1_000, 1900)
    const r = await post(`/v1/folios/${f.ref}/invoice`)
    expect(r.statusCode, r.body).toBe(201)
    const original = JSON.parse(r.body) as { invoiceRef: string; number: string }
    const vorher = await saldo(f.id)

    const s = await post(`/v1/invoices/${original.invoiceRef}/cancel`)
    expect(s.statusCode, s.body).toBe(201)
    const storno = JSON.parse(s.body) as {
      number: string; reversesNumber: string
      totals: { grossCent: number; payableCent: number; prepaidCent: number } }
    expect(storno.reversesNumber).toBe(original.number)
    expect(storno.number).not.toBe(original.number)
    expect(storno.totals.grossCent).toBe(-11_890)
    // Mit dem Original verrechnet: nichts zu zahlen, nichts zu erstatten.
    expect(storno.totals.prepaidCent).toBe(storno.totals.payableCent)

    const i = await owner.query<{ kind: string; reverses: string | null }>(
      `SELECT i.kind, o.number AS reverses FROM invoice i
         LEFT JOIN invoice o ON o.id = i.reverses_id WHERE i.number = $1`, [storno.number])
    expect(i.rows[0]).toEqual({ kind: 'credit_note', reverses: original.number })

    // Saldo unveraendert, die Positionen wieder offen.
    expect(await saldo(f.id)).toBe(vorher)
    const offen = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM charge
        WHERE folio_id = $1 AND invoice_id IS NULL AND reverses_id IS NULL`, [f.id])
    expect(offen.rows[0]!.n).toBe(2)

    // Die richtige Rechnung entsteht danach wie jede andere.
    const neu = await post(`/v1/folios/${f.ref}/invoice`)
    expect(neu.statusCode, neu.body).toBe(201)
    expect(JSON.parse(neu.body).totals.grossCent).toBe(11_890)
  })

  it('uebertraegt die Zahlung des Originals auf die neue Rechnung', async () => {
    const f = await folio()
    await buchen(f.ref, 10_000, 700)
    const r = await post(`/v1/folios/${f.ref}/invoice`,
      { paid: { paymentMethodCode: 'BAR' } })
    expect(r.statusCode, r.body).toBe(201)
    const ref = (JSON.parse(r.body) as { invoiceRef: string }).invoiceRef

    expect((await post(`/v1/invoices/${ref}/cancel`)).statusCode).toBe(201)
    expect(await saldo(f.id)).toBe(0)

    const neu = await post(`/v1/folios/${f.ref}/invoice`)
    expect(neu.statusCode, neu.body).toBe(201)
    const t = (JSON.parse(neu.body) as {
      totals: { payableCent: number; prepaidCent: number } }).totals
    expect(t.prepaidCent).toBe(t.payableCent)
  })

  it('storniert einmal und keine Stornorechnung', async () => {
    const f = await folio()
    await buchen(f.ref, 10_000, 700)
    const ref = (JSON.parse((await post(`/v1/folios/${f.ref}/invoice`)).body) as
      { invoiceRef: string }).invoiceRef
    const s = await post(`/v1/invoices/${ref}/cancel`)
    expect(s.statusCode).toBe(201)

    const zweimal = await post(`/v1/invoices/${ref}/cancel`)
    expect(zweimal.statusCode).toBe(409)
    expect(JSON.parse(zweimal.body).code).toBe('invoice.alreadyCancelled')

    const stornoRef = (JSON.parse(s.body) as { invoiceRef: string }).invoiceRef
    const storno = await post(`/v1/invoices/${stornoRef}/cancel`)
    expect(storno.statusCode).toBe(409)
    expect(JSON.parse(storno.body).code).toBe('invoice.notCancellable')
  })

  it('nimmt keine Stornorechnung ueber das Festschreiben an', async () => {
    const f = await folio()
    await buchen(f.ref, 10_000, 700)
    const r = await post(`/v1/folios/${f.ref}/invoice`, { kind: 'credit_note' })
    expect(r.statusCode).toBe(422)
  })

  it('macht eine verrechnete Anzahlung wieder offen', async () => {
    const f = await folio()
    const z = await post(`/v1/folios/${f.ref}/settlements`,
      { amountCent: 5_350, paymentMethodCode: 'BAR' })
    expect(z.statusCode, z.body).toBe(201)
    const settlementId = (JSON.parse(z.body) as { settlementId: number }).settlementId
    const a = await post(`/v1/folios/${f.ref}/deposit-invoice`,
      { settlementId, taxRateBp: 700 })
    expect(a.statusCode, a.body).toBe(201)

    await buchen(f.ref, 10_000, 700)
    const r = await post(`/v1/folios/${f.ref}/invoice`)
    expect(r.statusCode, r.body).toBe(201)
    const erste = JSON.parse(r.body) as { invoiceRef: string; depositsApplied: unknown[] }
    expect(erste.depositsApplied).toHaveLength(1)

    expect((await post(`/v1/invoices/${erste.invoiceRef}/cancel`)).statusCode).toBe(201)
    const journal = await owner.query<{ kind: string }>(
      `SELECT kind FROM deposit_ledger WHERE folio_id = $1 ORDER BY id`, [f.id])
    expect(journal.rows.map(x => x.kind)).toEqual(['received', 'applied', 'unapplied'])

    // Die naechste Schlussrechnung verrechnet sie wieder.
    const neu = await post(`/v1/folios/${f.ref}/invoice`)
    expect(neu.statusCode, neu.body).toBe(201)
    expect((JSON.parse(neu.body) as { depositsApplied: unknown[] }).depositsApplied)
      .toHaveLength(1)
  })
})

describe('E-Rechnung der Stornorechnung', () => {
  it('ist eine Gutschrift mit positiven Betraegen und Bezug aufs Original', () => {
    const xml = buildInvoiceCii({
      number: 'S-1', issuedOn: '2026-10-13', kind: 'credit_note', currency: 'EUR',
      seller: { name: 'Haus', postalCode: '27476', city: 'Cuxhaven', country: 'DE',
                vatId: 'DE123456789' },
      buyer: { name: 'Gast', postalCode: '27476', city: 'Cuxhaven', country: 'DE' },
      serviceFrom: '2026-10-01', serviceTo: '2026-10-02',
      lines: [{ name: 'Storno Uebernachtung', quantity: 1, netCent: -10_000, rateBp: 700 }],
      prepaidCent: -10_700,
      precedingInvoice: { number: 'R-1', issuedOn: '2026-10-02' }
    })
    expect(xml).toContain('<ram:TypeCode>381</ram:TypeCode>')
    expect(xml).toContain('<ram:LineTotalAmount>100.00</ram:LineTotalAmount>')
    expect(xml).toContain('<ram:GrandTotalAmount>107.00</ram:GrandTotalAmount>')
    expect(xml).toContain('<ram:DuePayableAmount>0.00</ram:DuePayableAmount>')
    expect(xml).toContain('<ram:IssuerAssignedID>R-1</ram:IssuerAssignedID>')
    expect(xml).not.toContain('SpecifiedTradePaymentTerms')
  })
})

describe('Anzahlungsrechnung', () => {
  it('ist bezahlt und steht in der Liste nicht als offen', async () => {
    const f = await folio()
    const z = await post(`/v1/folios/${f.ref}/settlements`,
      { amountCent: 20_000, paymentMethodCode: 'BAR' })
    const settlementId = (JSON.parse(z.body) as { settlementId: number }).settlementId
    const a = await post(`/v1/folios/${f.ref}/deposit-invoice`,
      { settlementId, taxRateBp: 700 })
    expect(a.statusCode, a.body).toBe(201)

    const t = await owner.query<{ totals: { payableCent: number; prepaidCent: number } }>(
      `SELECT totals FROM invoice WHERE kind = 'deposit'`)
    expect(t.rows[0]!.totals.prepaidCent).toBe(20_000)
    expect(t.rows[0]!.totals.payableCent).toBe(20_000)

    const heute = (await owner.query<{ d: string }>(
      `SELECT issued_on::text AS d FROM invoice WHERE kind = 'deposit'`)).rows[0]!.d
    const l = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/invoices?from=${heute}&to=${heute}` })
    const zeile = (JSON.parse(l.body) as {
      invoices: Array<{ settledCent: number; payableCent: number }> }).invoices[0]!
    expect(zeile.settledCent).toBe(zeile.payableCent)
  })
})

describe('Check-out mit offenem Saldo', () => {
  async function imHaus(): Promise<{ ref: string; folioRef: string }> {
    const f = await folio()
    await owner.query(
      `UPDATE reservation SET status = 'InHouse',
              resource_id = (SELECT id FROM resource WHERE property_id = $2 LIMIT 1)
        WHERE public_ref = $1`, [f.reservationRef, fx.propertyId])
    return { ref: f.reservationRef, folioRef: f.ref }
  }

  it('fragt nach, solange Geld offen ist, und checkt nach Bestaetigung aus', async () => {
    const g = await imHaus()
    await buchen(g.folioRef, 10_000, 700)

    const r = await post(`/v1/reservations/${g.ref}/check-out`)
    expect(r.statusCode, r.body).toBe(409)
    const p = JSON.parse(r.body) as { code: string; params: { amount: string; items: number } }
    expect(p.code).toBe('checkout.openBalance')
    expect(p.params).toEqual({ amount: '107.00', items: 1 })

    const ok = await post(`/v1/reservations/${g.ref}/check-out`, { openBalance: 'accept' })
    expect(ok.statusCode, ok.body).toBe(200)
  })

  it('fragt nicht, wenn alles abgerechnet und bezahlt ist', async () => {
    const g = await imHaus()
    await buchen(g.folioRef, 10_000, 700)
    const r = await post(`/v1/folios/${g.folioRef}/invoice`,
      { paid: { paymentMethodCode: 'BAR' } })
    expect(r.statusCode, r.body).toBe(201)

    const ok = await post(`/v1/reservations/${g.ref}/check-out`)
    expect(ok.statusCode, ok.body).toBe(200)
  })
})
