import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeGuest, makeReservation, makePaymentMethod,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let rooms: number[]
let auth: Record<string, string>

const TAG = '2026-10-01'
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
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  rooms = await makeResources(owner, fx.propertyId, catId, 3)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, TAG)
  await makePaymentMethod(owner, fx.propertyId, 'CARD')
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

const post = (url: string, payload: unknown) => app.inject({
  method: 'POST', url, headers: { ...auth, 'idempotency-key': `k-${++lauf}` },
  payload })
const get = (url: string) => app.inject({ method: 'GET', url, headers: auth })

async function folioMitGast(): Promise<{ folioRef: string; reservationRef: string }> {
  const gast = await makeGuest(owner, fx.accountId)
  const r = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: catId, arrival: '2026-09-29',
    departure: TAG, status: 'InHouse', resourceId: rooms[0]!, priceCent: 12_000 })
  await owner.query(
    `UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`, [r.reservationId, gast.id])
  await owner.query(`UPDATE folio SET guest_id = $2 WHERE id = $1`, [r.folioId, gast.id])
  const refs = await owner.query<{ f: string; r: string }>(
    `SELECT f.public_ref AS f, r.public_ref AS r
       FROM folio f JOIN reservation r ON r.id = f.reservation_id WHERE f.id = $1`,
    [r.folioId])
  return { folioRef: refs.rows[0]!.f, reservationRef: refs.rows[0]!.r }
}

describe('Folio in der Oberflaeche', () => {
  it('liefert Positionen, Zahlungen und Saldo in einer Anfrage', async () => {
    const { folioRef } = await folioMitGast()
    await post(`/v1/folios/${folioRef}/charges`,
      { description: 'Fruehstueck', netCent: 840, taxRateBp: 1900, quantity: 2 })
    await post(`/v1/folios/${folioRef}/settlements`,
      { amountCent: 1000, paymentMethodCode: 'CARD', externalReference: 'Bon 4711' })

    const r = await get(`/v1/folios/${folioRef}`)
    expect(r.statusCode).toBe(200)
    const f = JSON.parse(r.body) as {
      charges: Array<{ gross_cent: number; quantity: number }>
      settlements: Array<{ external_reference: string }>
      balanceCent: number }
    expect(f.charges).toHaveLength(1)
    expect(f.charges[0]!.quantity).toBe(2)
    // 2 mal 8,40 netto zu 19 Prozent sind 19,99 brutto.
    expect(f.charges[0]!.gross_cent).toBe(1999)
    expect(f.settlements[0]!.external_reference).toBe('Bon 4711')
    expect(f.balanceCent).toBe(999)
  })

  /**
   * Der Beleg beim Abrechnungsort ist der Kern der Entscheidung gegen eine
   * Kassenfunktion: dieses System ordnet zu, es wickelt nicht ab. Der
   * Verweis zeigt, wo die maßgebliche Aufzeichnung liegt.
   */
  it('nennt an den Zahlungsarten, dass der Vermerk nicht abwickelt', async () => {
    const r = await get(`/v1/properties/${fx.propertyId}/payment-methods`)
    expect(r.statusCode).toBe(200)
    const p = JSON.parse(r.body) as { paymentMethods: Array<{ code: string }>
                                      hinweis: string }
    expect(p.paymentMethods.map(m => m.code)).toContain('CARD')
    expect(p.hinweis).toContain('wickelt nicht ab')
  })

  it('gibt den Folio-Verweis im Tagesgeschaeft mit', async () => {
    const { folioRef } = await folioMitGast()
    const r = await get(`/v1/properties/${fx.propertyId}/daily-sheet?date=${TAG}`)
    const d = JSON.parse(r.body) as {
      departures: Array<{ folioRef: string | null; balanceCent: number | null }> }
    // Ohne diesen Verweis muesste die Oberflaeche je Zeile nachladen.
    expect(d.departures[0]!.folioRef).toBe(folioRef)
  })

  it('weist den Saldo der Abreise im Tagesgeschaeft aus', async () => {
    const { folioRef } = await folioMitGast()
    await post(`/v1/folios/${folioRef}/charges`,
      { description: 'Uebernachtung', netCent: 10_000, taxRateBp: 700 })

    const r = await get(`/v1/properties/${fx.propertyId}/daily-sheet?date=${TAG}`)
    const d = JSON.parse(r.body) as { departures: Array<{ balanceCent: number }> }
    expect(d.departures[0]!.balanceCent).toBe(10_700)
  })

  it('bucht dieselbe Position bei wiederholtem Schluessel nur einmal', async () => {
    const { folioRef } = await folioMitGast()
    const rumpf = { description: 'Minibar', netCent: 500, taxRateBp: 1900 }
    const erste = await app.inject({
      method: 'POST', url: `/v1/folios/${folioRef}/charges`,
      headers: { ...auth, 'idempotency-key': 'derselbe' }, payload: rumpf })
    const zweite = await app.inject({
      method: 'POST', url: `/v1/folios/${folioRef}/charges`,
      headers: { ...auth, 'idempotency-key': 'derselbe' }, payload: rumpf })

    expect(erste.statusCode).toBe(201)
    expect(zweite.statusCode).toBe(201)
    // Die Rezeption drueckt zweimal, wenn es einen Moment dauert. Ohne
    // Schluessel stuende die Position dann doppelt auf der Rechnung.
    expect(JSON.parse(zweite.body)).toEqual(JSON.parse(erste.body))
    const n = await owner.query(`SELECT 1 FROM charge WHERE property_id = $1`,
      [fx.propertyId])
    expect(n.rowCount).toBe(1)
  })

  it('markiert fakturierte Positionen als unveraenderlich', async () => {
    const { folioRef } = await folioMitGast()
    await post(`/v1/folios/${folioRef}/charges`,
      { description: 'Uebernachtung', netCent: 30_000, taxRateBp: 700 })
    const rechnung = await post(`/v1/folios/${folioRef}/invoice`, {})
    expect(rechnung.statusCode, rechnung.body).toBe(201)

    const f = JSON.parse((await get(`/v1/folios/${folioRef}`)).body) as {
      charges: Array<{ invoice_id: number | null }> }
    // Die Oberflaeche zeigt das an, statt eine Aenderung erst beim Versuch
    // mit einer Fehlermeldung zu beantworten.
    expect(f.charges[0]!.invoice_id).not.toBeNull()
  })

  it('bucht nicht mehr auf ein geschlossenes Folio', async () => {
    const { folioRef } = await folioMitGast()
    await owner.query(
      `UPDATE folio SET status = 'closed', closed_at = now() WHERE public_ref = $1`,
      [folioRef])
    const r = await post(`/v1/folios/${folioRef}/charges`,
      { description: 'Zu spaet', netCent: 100, taxRateBp: 1900 })
    expect(r.statusCode).toBe(409)
  })

  it('weist eine unbekannte Zahlungsart ab', async () => {
    const { folioRef } = await folioMitGast()
    const r = await post(`/v1/folios/${folioRef}/settlements`,
      { amountCent: 1000, paymentMethodCode: 'BITCOIN' })
    expect(r.statusCode).toBe(422)
  })
})
