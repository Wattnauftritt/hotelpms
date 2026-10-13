import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Pruefung Rechnungssystem, 13.10.2026: Kurtaxe und Rechnungskuerzel.
 *
 * Kurtaxe steht auf keiner Rechnung des Hauses -- sie ist die Abgabe der
 * Gemeinde, der Beleg ist die Kurkarte. Vorher wies die Pflichtangaben-
 * pruefung jede Rechnung ueber einen Aufenthalt mit Kurtaxe ab (0 Prozent
 * ohne Befreiungsgrund). Und zwei Haeuser eines Accounts vergaben beide
 * 2026-00001 (Migration 0157).
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
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
})

/** Folio mit einer Nacht zu 7 Prozent und, wie der Nachtlauf sie bucht, Kurtaxe. */
async function folioMitKurtaxe(): Promise<{ ref: string; id: number }> {
  const gast = await makeGuest(owner, fx.accountId)
  const f = await owner.query<{ public_ref: string; id: number }>(
    `INSERT INTO folio (property_id, kind, guest_id) VALUES ($1,'guest',$2)
     RETURNING public_ref, id`, [fx.propertyId, gast.id])
  const regel = await owner.query<{ id: number }>(
    `INSERT INTO tax_rule (property_id, code, name, kind, basis, amount_cent, rate_bp)
     VALUES ($1,'KUR','Kurtaxe','city_tax','per_person_night',320,0) RETURNING id`,
    [fx.propertyId])
  await owner.query(
    `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                         net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account)
     VALUES ($1,$2,'2026-10-01','Uebernachtung',1,10000,700,10700,700,'8300')`,
    [fx.propertyId, f.rows[0]!.id])
  await owner.query(
    `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                         net_cent, tax_cent, gross_cent, tax_rate_bp, tax_rule_id,
                         revenue_account)
     VALUES ($1,$2,'2026-10-01','Kurtaxe',2,640,0,640,0,$3,'8300')`,
    [fx.propertyId, f.rows[0]!.id, regel.rows[0]!.id])
  return { ref: f.rows[0]!.public_ref, id: f.rows[0]!.id }
}

const fakturieren = (folioRef: string) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/invoice`,
  headers: { ...auth, 'idempotency-key': `i-${++lauf}` }, payload: {} })

const zahlen = (folioRef: string, amountCent: number) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/settlements`,
  headers: { ...auth, 'idempotency-key': `s-${++lauf}` },
  payload: { amountCent, paymentMethodCode: 'CASH' } })

async function zahlartAnlegen(): Promise<void> {
  await owner.query(
    `INSERT INTO payment_method (property_id, code, name) VALUES ($1,'CASH','Bar')`,
    [fx.propertyId])
}

describe('Kurtaxe steht auf keiner Rechnung', () => {
  it('schreibt die Rechnung ohne Kurtaxe fest und laesst sie am Folio', async () => {
    const folio = await folioMitKurtaxe()
    const r = await fakturieren(folio.ref)
    expect(r.statusCode, r.body).toBe(201)
    const inv = JSON.parse(r.body) as { totals: { grossCent: number; payableCent: number } }
    expect(inv.totals.grossCent).toBe(10700)
    expect(inv.totals.payableCent).toBe(10700)

    const kur = await owner.query<{ invoice_id: number | null }>(
      `SELECT invoice_id FROM charge WHERE folio_id = $1 AND description = 'Kurtaxe'`,
      [folio.id])
    expect(kur.rows[0]!.invoice_id).toBeNull()

    // Der Saldo kennt sie weiter: kassiert wird am Folio.
    const g = await app.inject({ method: 'GET', url: `/v1/folios/${folio.ref}`, headers: auth })
    const body = JSON.parse(g.body) as {
      balanceCent: number; charges: Array<{ description: string; city_tax: boolean }> }
    expect(body.balanceCent).toBe(11340)
    expect(body.charges.find(c => c.description === 'Kurtaxe')!.city_tax).toBe(true)
    expect(body.charges.find(c => c.description === 'Uebernachtung')!.city_tax).toBe(false)
  })

  it('nimmt sie auch aus einer Auswahl heraus', async () => {
    const folio = await folioMitKurtaxe()
    const kur = await owner.query<{ id: number }>(
      `SELECT id FROM charge WHERE folio_id = $1 AND description = 'Kurtaxe'`, [folio.id])
    const r = await app.inject({
      method: 'POST', url: `/v1/folios/${folio.ref}/invoice`,
      headers: { ...auth, 'idempotency-key': `i-${++lauf}` },
      payload: { kind: 'interim', chargeIds: [kur.rows[0]!.id] } })
    expect(r.statusCode, r.body).toBe(422)
    expect(JSON.parse(r.body).code).toBe('folio.nothingOpen')
  })

  /**
   * Am Tresen zahlt der Gast Rechnung und Kurtaxe in einem Betrag. Ohne
   * Spielraum bliebe die Rechnung fuer immer "offen", weil der Vermerk ihren
   * Rest um die Kurtaxe uebersteigt.
   */
  it('ordnet die Zahlung von Rechnung und Kurtaxe in einem Betrag der Rechnung zu', async () => {
    await zahlartAnlegen()
    const folio = await folioMitKurtaxe()
    const inv = JSON.parse((await fakturieren(folio.ref)).body) as { invoiceRef: string }
    expect((await zahlen(folio.ref, 11340)).statusCode).toBe(201)

    const s = await owner.query<{ ref: string | null }>(
      `SELECT i.public_ref AS ref FROM settlement s LEFT JOIN invoice i ON i.id = s.invoice_id
        WHERE s.folio_id = $1`, [folio.id])
    expect(s.rows[0]!.ref).toBe(inv.invoiceRef)
  })

  it('weist eine Vorauszahlung samt Kurtaxe hoechstens bis zum Rechnungsbetrag aus', async () => {
    await zahlartAnlegen()
    const folio = await folioMitKurtaxe()
    expect((await zahlen(folio.ref, 11340)).statusCode).toBe(201)
    const r = await fakturieren(folio.ref)
    expect(r.statusCode, r.body).toBe(201)
    const t = (JSON.parse(r.body) as { totals: { prepaidCent: number; payableCent: number } })
      .totals
    // BT-113 nie ueber BT-115: der Beleg fordert null, nicht minus 6,40.
    expect(t.prepaidCent).toBe(10700)
    expect(t.payableCent).toBe(10700)
  })
})

describe('Rechnungskuerzel je Haus', () => {
  async function zweitesHaus(): Promise<number> {
    const p = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name, address_line1, postal_code,
                             city, country, tax_number)
       VALUES ($1,'GH','Gaestehaus','Hafenstr. 2','25813','Husum','DE','21/815/00123')
       RETURNING id`, [fx.accountId])
    return p.rows[0]!.id
  }
  const setzen = (propertyId: number, prefix: string) => app.inject({
    method: 'PUT', url: `/v1/properties/${propertyId}/invoice-settings`,
    headers: auth, payload: { prefix } })

  it('braucht ohne zweites Haus kein Kuerzel', async () => {
    const r = await fakturieren((await folioMitKurtaxe()).ref)
    expect(r.statusCode, r.body).toBe(201)
    expect(JSON.parse(r.body).number).toMatch(/^\d{4}-00001$/)
  })

  /**
   * Der Benutzer hat Recht nur auf das eine Haus und sieht das zweite ueber
   * die Zeilenrichtlinie nicht. Gerade dann muss die Rechnung verweigert
   * werden: er stellte sonst still dieselbe Nummer aus wie das Gaestehaus.
   */
  it('verweigert die Rechnung, solange der Account ein zweites Haus ohne Trennung fuehrt',
    async () => {
      await zweitesHaus()
      const folio = await folioMitKurtaxe()
      const r = await fakturieren(folio.ref)
      expect(r.statusCode, r.body).toBe(422)
      expect(JSON.parse(r.body).code).toBe('invoice.prefixMissing')

      const g = await app.inject({ method: 'GET',
        url: `/v1/properties/${fx.propertyId}/invoice-settings`, headers: auth })
      expect(JSON.parse(g.body)).toMatchObject({ prefix: null, missing: true, locked: false })

      expect((await setzen(fx.propertyId, 'h')).statusCode).toBe(200)
      const ok = await fakturieren(folio.ref)
      expect(ok.statusCode, ok.body).toBe(201)
      expect(JSON.parse(ok.body).number).toMatch(/^H-\d{4}-00001$/)
    })

  it('vergibt ein Kuerzel nur einmal im Account', async () => {
    const zweites = await zweitesHaus()
    await owner.query(`UPDATE property SET invoice_prefix = 'G' WHERE id = $1`, [zweites])
    const r = await setzen(fx.propertyId, 'G')
    expect(r.statusCode, r.body).toBe(409)
    expect(JSON.parse(r.body).code).toBe('invoice.prefixTaken')
  })

  it('haelt das Kuerzel fest, sobald darunter eine Rechnung steht', async () => {
    await zweitesHaus()
    expect((await setzen(fx.propertyId, 'H')).statusCode).toBe(200)
    expect((await fakturieren((await folioMitKurtaxe()).ref)).statusCode).toBe(201)

    const r = await setzen(fx.propertyId, 'HN')
    expect(r.statusCode, r.body).toBe(409)
    expect(JSON.parse(r.body).code).toBe('invoice.prefixInUse')
    const g = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/invoice-settings`, headers: auth })
    expect(JSON.parse(g.body)).toMatchObject({ prefix: 'H', locked: true })
    expect(JSON.parse(g.body).nextNumber).toMatch(/^H-\d{4}-00002$/)
  })

  it('weist ein unbrauchbares Kuerzel ab', async () => {
    for (const p of ['', 'ZU-LANG', 'H-', 'ÄB']) {
      expect((await setzen(fx.propertyId, p)).statusCode).toBe(422)
    }
  })
})
