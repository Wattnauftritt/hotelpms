import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, makePaymentMethod,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Pruefung des Rechnungssystems vom 13.10.2026, Eingaben am Folio: Positionen
 * mit beliebigem Steuersatz, Menge 0 oder Kommamenge gingen durch; das Erloes-
 * konto war fuer jeden Satz 8300; die Grenze zur Kleinbetragsrechnung wurde
 * nach Abzug der Anzahlung gezogen.
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
  method: 'POST', url, headers: { ...auth, 'idempotency-key': `be-${++lauf}` }, payload })

/** Folio mit Gast; `mitAnschrift` steuert, ob der Gast eine Strasse hat. */
async function folio(mitAnschrift = true): Promise<{ ref: string; id: number }> {
  const gast = await makeGuest(owner, fx.accountId)
  if (mitAnschrift) {
    await owner.query(
      `UPDATE guest SET address_line1 = 'Strandweg 2', postal_code = '27476',
                        city = 'Cuxhaven', country = 'DE' WHERE id = $1`, [gast.id])
  } else {
    await owner.query(
      `UPDATE guest SET address_line1 = NULL, postal_code = '27476',
                        city = 'Cuxhaven', country = 'DE' WHERE id = $1`, [gast.id])
  }
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId, arrival: '2026-10-01', departure: '2026-10-03' })
  const f = await owner.query<{ public_ref: string }>(
    `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`, [res.folioId, gast.id])
  return { ref: f.rows[0]!.public_ref, id: res.folioId }
}

describe('Position buchen', () => {
  it('weist unzulaessige Eingaben mit 422 ab und bucht nichts', async () => {
    const f = await folio()
    const falsch: Record<string, unknown>[] = [
      { description: 'Minibar', grossCent: 500, taxRateBp: 1600 },
      { description: 'Minibar', grossCent: 500, taxRateBp: 1900, quantity: 0 },
      { description: 'Minibar', grossCent: 500, taxRateBp: 1900, quantity: 1.5 },
      { description: 'Minibar', grossCent: 500, netCent: 420, taxRateBp: 1900 },
      { description: 'Minibar', grossCent: 12.5, taxRateBp: 1900 },
      { description: 'Minibar', grossCent: 1_000_000_000, taxRateBp: 1900 },
      { description: '', grossCent: 500, taxRateBp: 1900 },
      { description: 'x'.repeat(201), grossCent: 500, taxRateBp: 1900 },
      { description: 'Minibar', grossCent: 500, taxRateBp: 1900, revenueAccount: 'abc' }
    ]
    for (const b of falsch) {
      const r = await post(`/v1/folios/${f.ref}/charges`, b)
      expect(r.statusCode, JSON.stringify(b)).toBe(422)
    }
    const n = await owner.query(`SELECT 1 FROM charge WHERE folio_id = $1`, [f.id])
    expect(n.rowCount).toBe(0)
  })

  it('nimmt einen Bruttobetrag und waehlt das Erloeskonto nach dem Satz', async () => {
    const f = await folio()
    for (const [taxRateBp, grossCent] of [[1900, 1_190], [700, 10_700], [0, 300]] as const) {
      const r = await post(`/v1/folios/${f.ref}/charges`,
        { description: `Satz ${taxRateBp}`, grossCent, taxRateBp })
      expect(r.statusCode, r.body).toBe(201)
    }
    const c = await owner.query<{ tax_rate_bp: number; net_cent: string; gross_cent: string
                                  revenue_account: string }>(
      `SELECT tax_rate_bp, net_cent::text, gross_cent::text, revenue_account
         FROM charge WHERE folio_id = $1 ORDER BY id`, [f.id])
    expect(c.rows.map(r => [r.tax_rate_bp, Number(r.net_cent), Number(r.gross_cent),
                            r.revenue_account])).toEqual([
      [1900, 1_000, 1_190, '8400'],
      [700, 10_000, 10_700, '8300'],
      [0, 300, 300, '8200']
    ])
  })
})

describe('Rechnung am Folio', () => {
  it('zieht die Grenze zur Kleinbetragsrechnung vor Abzug der Anzahlung', async () => {
    // 200 Euro Anzahlung, 300 Euro Aufenthalt: offen sind 100 Euro, die
    // Rechnung ueber den Aufenthalt ist trotzdem keine Kleinbetragsrechnung
    // und braucht die Anschrift.
    const f = await folio(false)
    const z = await post(`/v1/folios/${f.ref}/settlements`,
      { amountCent: 20_000, paymentMethodCode: 'BAR' })
    expect(z.statusCode, z.body).toBe(201)
    const settlementId = (JSON.parse(z.body) as { settlementId: number }).settlementId
    const a = await post(`/v1/folios/${f.ref}/deposit-invoice`, { settlementId, taxRateBp: 700 })
    expect(a.statusCode, a.body).toBe(201)
    const b = await post(`/v1/folios/${f.ref}/charges`,
      { description: 'Uebernachtung', grossCent: 30_000, taxRateBp: 700 })
    expect(b.statusCode, b.body).toBe(201)

    const v = await post(`/v1/folios/${f.ref}/invoice-preview`)
    expect(v.statusCode, v.body).toBe(200)
    const keys = (JSON.parse(v.body) as { findings: { key: string }[] }).findings.map(m => m.key)
    expect(keys).toContain('recipient_address')
  })

  it('listet die Rechnungen des Folios mit Storno und Beleg', async () => {
    const f = await folio()
    const b = await post(`/v1/folios/${f.ref}/charges`,
      { description: 'Minibar', grossCent: 1_190, taxRateBp: 1900 })
    expect(b.statusCode, b.body).toBe(201)
    const r = await post(`/v1/folios/${f.ref}/invoice`)
    expect(r.statusCode, r.body).toBe(201)
    const inv = JSON.parse(r.body) as { invoiceRef: string; number: string }
    const s = await post(`/v1/invoices/${inv.invoiceRef}/cancel`)
    expect(s.statusCode, s.body).toBe(201)

    const g = await app.inject({ method: 'GET', url: `/v1/folios/${f.ref}`, headers: auth })
    expect(g.statusCode, g.body).toBe(200)
    const liste = (JSON.parse(g.body) as { invoices: { invoiceRef: string; number: string
      kind: string; grossCent: number; cancelledBy: string | null
      documentReady: boolean }[] }).invoices
    expect(liste.map(i => i.kind)).toEqual(['final', 'credit_note'])
    expect(liste[0]!.invoiceRef).toBe(inv.invoiceRef)
    expect(liste[0]!.grossCent).toBe(1_190)
    expect(liste[0]!.cancelledBy).toBe(liste[1]!.number)
    // Der Beleg entsteht gleich mit dem Festschreiben.
    expect(liste[0]!.documentReady).toBe(true)
  })
})
