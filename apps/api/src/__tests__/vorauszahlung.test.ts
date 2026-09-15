import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, makePaymentMethod,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Die Sicht der Vorauszahlung am Folio (B8, B9).
 *
 * Geprüft wird, was die Maske nicht selbst herausfinden kann und worauf sie
 * sich verlässt:
 *
 * 1. **Ein Zahlungsvermerk erscheint einmal**, auch wenn seine
 *    Anzahlungsrechnung zwei Steuersätze trägt. Das Journal hat eine Zeile
 *    je Satzgruppe; ein unbedachter Verbund zeigte den Vermerk doppelt, und
 *    die Maske böte an, ihn ein zweites Mal zu fakturieren.
 * 2. **Verrechnet ist etwas anderes als angezahlt.** Erst die
 *    Schlussrechnung verrechnet, und dann steht ihre Nummer an der
 *    Anzahlung.
 * 3. **Ein Zahlungslink ist keine Zahlung**, solange der Dienstleister
 *    nichts gemeldet hat.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let categoryId: number

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

let lauf = 0
const key = (): string => `vz-${++lauf}-${Date.now()}`

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  await openBusinessDay(owner, fx.propertyId, new Date().toISOString().slice(0, 10))
  await makePaymentMethod(owner, fx.propertyId, 'TRANSFER')
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  categoryId = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, categoryId, 1)
})

async function aufenthalt(): Promise<{ folioRef: string; folioId: number }> {
  const gast = await makeGuest(owner, fx.accountId)
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId,
    arrival: '2027-05-01', departure: '2027-05-04',
    priceCent: 10_000, reserveInventory: false })
  const f = await owner.query<{ public_ref: string }>(
    `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`,
    [res.folioId, gast.id])
  return { folioRef: f.rows[0]!.public_ref, folioId: res.folioId }
}

async function eingang(folioId: number, amountCent: number): Promise<number> {
  const pm = await owner.query<{ id: number }>(
    `SELECT id FROM payment_method WHERE property_id = $1 AND code = 'TRANSFER'`,
    [fx.propertyId])
  const s = await owner.query<{ id: number }>(
    `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                             payment_method_id)
     VALUES ($1,$2,current_date,$3,$4) RETURNING id`,
    [fx.propertyId, folioId, amountCent, pm.rows[0]!.id])
  return s.rows[0]!.id
}

interface Sicht {
  canIssueDeposit: boolean
  settlements: Array<{ id: number; amountCent: number; method: string
                       depositInvoiceNumber: string | null }>
  deposits: Array<{ number: string; amountGrossCent: number; taxCent: number
                    settlementId: number | null
                    groups: Array<{ rateBp: number; grossCent: number; taxCent: number }>
                    appliedInvoiceNumber: string | null; appliedOn: string | null }>
  paymentLinks: Array<{ id: number; amountCent: number; status: string
                        hasSettlement: boolean }>
}

const sicht = (folioRef: string, wer = auth) => app.inject({
  method: 'GET', url: `/v1/folios/${folioRef}/prepayments`, headers: wer })

const anzahlungsrechnung = (folioRef: string, payload: unknown) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/deposit-invoice`,
  headers: { ...auth, 'idempotency-key': key() }, payload })

const buchen = (folioRef: string, netCent: number) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/charges`,
  headers: { ...auth, 'idempotency-key': key() },
  payload: { description: 'Uebernachtung', netCent, taxRateBp: 700 } })

const fakturieren = (folioRef: string) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/invoice`,
  headers: { ...auth, 'idempotency-key': key() }, payload: {} })

describe('Vorauszahlung am Folio', () => {
  it('nennt jeden Zahlungsvermerk und sagt, welcher noch keine Anzahlungsrechnung hat',
    async () => {
      const { folioRef, folioId } = await aufenthalt()
      const a = await eingang(folioId, 10_000)
      await eingang(folioId, 5_000)

      const vorher = (await sicht(folioRef)).json() as Sicht
      expect(vorher.settlements).toHaveLength(2)
      expect(vorher.settlements.every(s => s.depositInvoiceNumber === null)).toBe(true)
      expect(vorher.canIssueDeposit).toBe(true)

      const r = await anzahlungsrechnung(folioRef, { settlementId: a, taxRateBp: 700 })
      expect(r.statusCode).toBe(201)

      const nachher = (await sicht(folioRef)).json() as Sicht
      const fakturiert = nachher.settlements.find(s => s.id === a)
      expect(fakturiert?.depositInvoiceNumber).toBe((r.json() as { number: string }).number)
      // Der zweite Eingang bleibt offen und bleibt anbietbar.
      expect(nachher.settlements.filter(s => s.depositInvoiceNumber === null))
        .toHaveLength(1)
    })

  it('zeigt einen Vermerk mit zwei Steuersätzen trotzdem nur einmal', async () => {
    const { folioRef, folioId } = await aufenthalt()
    const s = await eingang(folioId, 10_000)
    await anzahlungsrechnung(folioRef, { settlementId: s, lines: [
      { grossCent: 7_000, taxRateBp: 700 },
      { grossCent: 3_000, taxRateBp: 1900 }] })

    const v = (await sicht(folioRef)).json() as Sicht
    // Das Journal traegt zwei Zeilen, die Liste eine: der Verbund gegen die
    // gruppierte Unterabfrage ist genau dafuer da.
    expect(v.settlements).toHaveLength(1)
    expect(v.deposits).toHaveLength(1)
    const d = v.deposits[0]!
    expect(d.settlementId).toBe(s)
    expect(d.amountGrossCent).toBe(10_000)
    // Die Satzgruppen stehen einzeln da: der Beleg weist sie einzeln aus.
    expect(d.groups.map(g => g.rateBp).sort((x, y) => x - y)).toEqual([700, 1900])
    expect(d.groups.reduce((sum, g) => sum + g.grossCent, 0)).toBe(10_000)
    expect(d.taxCent).toBe(d.groups.reduce((sum, g) => sum + g.taxCent, 0))
  })

  it('unterscheidet angezahlt von verrechnet', async () => {
    const { folioRef, folioId } = await aufenthalt()
    const s = await eingang(folioId, 10_000)
    await anzahlungsrechnung(folioRef, { settlementId: s, taxRateBp: 700 })

    const offen = (await sicht(folioRef)).json() as Sicht
    expect(offen.deposits[0]!.appliedInvoiceNumber).toBeNull()
    expect(offen.deposits[0]!.appliedOn).toBeNull()

    await buchen(folioRef, 30_000)
    const schluss = await fakturieren(folioRef)
    expect(schluss.statusCode).toBe(201)

    const verrechnet = (await sicht(folioRef)).json() as Sicht
    expect(verrechnet.deposits[0]!.appliedInvoiceNumber)
      .toBe((schluss.json() as { number: string }).number)
    expect(verrechnet.deposits[0]!.appliedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('führt einen Zahlungslink als offen, solange keine Zahlung gemeldet ist', async () => {
    const { folioRef, folioId } = await aufenthalt()
    await owner.query(
      `INSERT INTO payment_intent (property_id, folio_id, provider, provider_reference,
                                   amount_cent)
       VALUES ($1,$2,'stripe','cs_test_offen',12_000)`,
      [fx.propertyId, folioId])

    const v = (await sicht(folioRef)).json() as Sicht
    expect(v.paymentLinks).toHaveLength(1)
    expect(v.paymentLinks[0]!.status).toBe('pending')
    // Der Kern der Aussage: ohne Zahlungsvermerk ist aus dem Link kein Geld
    // geworden, und der Saldo des Folios weiss nichts davon.
    expect(v.paymentLinks[0]!.hasSettlement).toBe(false)
    expect(v.settlements).toHaveLength(0)
  })

  it('verweigert die Anzahlungsrechnung ohne Reservierung, und sagt es vorher', async () => {
    const gast = await makeGuest(owner, fx.accountId)
    const f = await owner.query<{ id: number; public_ref: string }>(
      `INSERT INTO folio (property_id, guest_id, kind, status)
       VALUES ($1,$2,'guest','open') RETURNING id, public_ref`,
      [fx.propertyId, gast.id])
    const folioRef = f.rows[0]!.public_ref
    const s = await eingang(f.rows[0]!.id, 5_000)

    const v = (await sicht(folioRef)).json() as Sicht
    expect(v.canIssueDeposit).toBe(false)

    // Die Maske sagt es vorher; die API weist es hinterher ab. Beides muss
    // zusammenpassen, sonst zeigt die Maske einen Knopf ins Leere.
    const r = await anzahlungsrechnung(folioRef, { settlementId: s, taxRateBp: 700 })
    expect(r.statusCode).toBe(422)
  })

  it('gibt das Folio eines fremden Hauses nicht heraus', async () => {
    const { folioRef } = await aufenthalt()
    const fremd = await makeProperty(owner)
    const u = await makeUser(owner,
      { email: 'fremd@test.de', propertyId: fremd.propertyId, roleKey: 'reception' })

    const r = await sicht(folioRef, { cookie: `hp_session=${u.sessionId}` })
    expect(r.statusCode).toBe(404)
  })
})
