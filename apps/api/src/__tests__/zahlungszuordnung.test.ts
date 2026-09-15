import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, makePaymentMethod,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Welche Zahlung zu welcher Rechnung gehört.
 *
 * `settlement.invoice_id` hatte einen Leser (BT-113 auf dem Beleg) und ein
 * eigenes Schreibrecht aus Migration 0012 — und keinen Schreiber. Folge: auf
 * jedem Beleg stand als Vorauszahlung null, auch wenn der Gast angezahlt
 * hatte, und keine Liste konnte sagen, was offen ist.
 *
 * Geschrieben wird die Zuordnung jetzt an zwei Stellen, und beide sind hier
 * geprüft: beim **Festschreiben** (was vorher schon vermerkt war) und beim
 * **Vermerken** (was danach kommt — der Regelfall beim Auschecken).
 *
 * Der Betrag auf dem Beleg ist davon getrennt: er wird beim Festschreiben in
 * die Momentaufnahme geschrieben. Sonst hinge er davon ab, wann der Worker
 * den Beleg gezeichnet hat, und zwei Ausdrucke derselben Rechnung trügen
 * verschiedene Zahlen.
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
const key = (): string => `zz-${++lauf}-${Date.now()}`

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  await owner.query(`UPDATE property SET tax_number = '21/815/09876' WHERE id = $1`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, new Date().toISOString().slice(0, 10))
  await makePaymentMethod(owner, fx.propertyId, 'BAR')
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  categoryId = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, categoryId, 1)
})

async function folio(): Promise<{ folioRef: string; folioId: number }> {
  const gast = await makeGuest(owner, fx.accountId)
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId,
    arrival: '2027-07-01', departure: '2027-07-04',
    priceCent: 10_000, reserveInventory: false })
  const f = await owner.query<{ public_ref: string }>(
    `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`,
    [res.folioId, gast.id])
  return { folioRef: f.rows[0]!.public_ref, folioId: res.folioId }
}

const buchen = (folioRef: string, netCent: number) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/charges`,
  headers: { ...auth, 'idempotency-key': key() },
  payload: { description: 'Uebernachtung', netCent, taxRateBp: 700 } })

const zahlen = (folioRef: string, amountCent: number) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/settlements`,
  headers: { ...auth, 'idempotency-key': key() },
  payload: { amountCent, paymentMethodCode: 'BAR' } })

const fakturieren = (folioRef: string, payload: unknown = {}) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/invoice`,
  headers: { ...auth, 'idempotency-key': key() }, payload })

const zugeordnet = async (folioId: number): Promise<Array<{
  amount_cent: number; invoice_id: number | null
}>> => (await owner.query(
  `SELECT amount_cent, invoice_id FROM settlement WHERE folio_id = $1 ORDER BY id`,
  [folioId])).rows as Array<{ amount_cent: number; invoice_id: number | null }>

const totals = async (number: string): Promise<{
  payableCent: number; prepaidCent: number; grossCent: number
}> => (await owner.query<{ totals: { payableCent: number; prepaidCent: number
                                     grossCent: number } }>(
  `SELECT totals FROM invoice WHERE number = $1`, [number])).rows[0]!.totals

describe('Zahlung an Rechnung', () => {
  it('ordnet beim Festschreiben zu, was vorher schon vermerkt war', async () => {
    const { folioRef, folioId } = await folio()
    await buchen(folioRef, 30_000)
    await zahlen(folioRef, 10_000)

    // Vorher: die Zahlung hängt am Folio, an keiner Rechnung.
    expect((await zugeordnet(folioId)).every(z => z.invoice_id === null)).toBe(true)

    const r = await fakturieren(folioRef)
    expect(r.statusCode).toBe(201)
    const nummer = (r.json() as { number: string }).number

    const zeilen = await zugeordnet(folioId)
    expect(zeilen).toHaveLength(1)
    expect(zeilen[0]!.invoice_id).not.toBeNull()

    // Und derselbe Betrag steht als vorausgezahlt in der Momentaufnahme —
    // von dort liest ihn der Beleg als BT-113.
    const t = await totals(nummer)
    expect(t.prepaidCent).toBe(10_000)
    expect(t.payableCent).toBe(32_100)
  })

  it('ordnet eine Zahlung nach dem Festschreiben der offenen Rechnung zu', async () => {
    const { folioRef, folioId } = await folio()
    await buchen(folioRef, 30_000)
    const r = await fakturieren(folioRef)
    const nummer = (r.json() as { number: string }).number

    // Der Regelfall: erst die Rechnung, dann zahlt der Gast.
    await zahlen(folioRef, 32_100)

    const zeilen = await zugeordnet(folioId)
    expect(zeilen[0]!.invoice_id).not.toBeNull()

    /*
     * Der Beleg bleibt davon unberührt. Stünde hier jetzt 32 100, hinge der
     * gedruckte Beleg davon ab, wann der Worker gelaufen ist -- vor oder
     * nach der Zahlung.
     */
    expect((await totals(nummer)).prepaidCent).toBe(0)
  })

  it('lässt eine Erstattung unzugeordnet', async () => {
    const { folioRef, folioId } = await folio()
    await buchen(folioRef, 30_000)
    await fakturieren(folioRef)
    await zahlen(folioRef, -5_000)

    // Eine Erstattung ist keine Zahlung auf eine Rechnung. Sie gegen einen
    // Beleg zu rechnen, den sie nicht betrifft, waere schlimmer als sie
    // offen zu lassen: der Saldo des Folios traegt sie ohnehin.
    const erstattung = (await zugeordnet(folioId)).find(z => z.amount_cent < 0)
    expect(erstattung?.invoice_id).toBeNull()
  })

  it('hängt eine Anzahlung nicht zusätzlich als Zahlung an die Schlussrechnung',
    async () => {
      const { folioRef, folioId } = await folio()
      const s = await zahlen(folioRef, 10_000)
      const settlementId = (s.json() as { settlementId: number }).settlementId

      const a = await app.inject({
        method: 'POST', url: `/v1/folios/${folioRef}/deposit-invoice`,
        headers: { ...auth, 'idempotency-key': key() },
        payload: { settlementId, taxRateBp: 700 } })
      expect(a.statusCode).toBe(201)

      await buchen(folioRef, 30_000)
      const r = await fakturieren(folioRef)
      expect(r.statusCode).toBe(201)
      const nummer = (r.json() as { number: string }).number

      /*
       * Der Kern: die Anzahlung steht auf der Schlussrechnung schon als
       * verrechnete Position. Sie zusätzlich als vorausgezahlt auszuweisen
       * zöge denselben Betrag zweimal ab.
       */
      expect((await totals(nummer)).prepaidCent).toBe(0)
      const vermerk = (await zugeordnet(folioId)).find(z => z.amount_cent === 10_000)
      expect(vermerk?.invoice_id).toBeNull()
    })

  it('verweigert eine Anzahlungsrechnung zu einer schon verrechneten Zahlung', async () => {
    const { folioRef } = await folio()
    await buchen(folioRef, 30_000)
    const s = await zahlen(folioRef, 10_000)
    const settlementId = (s.json() as { settlementId: number }).settlementId
    await fakturieren(folioRef)   // zieht die 10 000 als vorausgezahlt

    const a = await app.inject({
      method: 'POST', url: `/v1/folios/${folioRef}/deposit-invoice`,
      headers: { ...auth, 'idempotency-key': key() },
      payload: { settlementId, taxRateBp: 700 } })
    // Sonst stünde derselbe Betrag zweimal: einmal als BT-113 auf der
    // Schlussrechnung und einmal als Anzahlung.
    expect(a.statusCode).toBe(409)
  })

  it('ordnet höchstens bis zum Zahlbetrag zu', async () => {
    const { folioRef, folioId } = await folio()
    await buchen(folioRef, 10_000)         // 10 700 brutto
    await zahlen(folioRef, 50_000)         // deutlich mehr als die Rechnung

    const r = await fakturieren(folioRef)
    const nummer = (r.json() as { number: string }).number
    const t = await totals(nummer)

    // Ein Vermerk ist nicht teilbar: er bleibt ganz offen, statt einen
    // negativen Zahlbetrag (BT-115) zu erzeugen.
    expect(t.prepaidCent).toBe(0)
    expect((await zugeordnet(folioId))[0]!.invoice_id).toBeNull()
  })

  it('lässt eine einmal gesetzte Zuordnung nicht mehr ändern', async () => {
    const { folioRef, folioId } = await folio()
    await buchen(folioRef, 30_000)
    await zahlen(folioRef, 10_000)
    await fakturieren(folioRef)

    const zeile = (await zugeordnet(folioId))[0]!
    expect(zeile.invoice_id).not.toBeNull()

    // Haertegrad 1: NULL -> Wert ist der einzige erlaubte Uebergang
    // (Migration 0012). Auch der Eigentuemer kommt an dem Trigger nicht
    // vorbei.
    await expect(owner.query(
      `UPDATE settlement SET invoice_id = NULL WHERE folio_id = $1`, [folioId]))
      .rejects.toThrow()
  })
})
