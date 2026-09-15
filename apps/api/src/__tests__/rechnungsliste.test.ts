import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makePaymentMethod, openBusinessDay, type Fixture }
  from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Die Rechnungsliste (B5 aus Dokument 20).
 *
 * Bisher liess sich eine Rechnung nur ueber ihr Folio finden. Geprueft wird
 * hier das, was die Ansicht braucht und was still falsch sein kann: der
 * Zeitraum mit seiner Obergrenze, der Stand des Belegs, und vor allem, dass
 * die Liste **nicht** behauptet, eine Rechnung sei offen, nur weil die
 * Zahlung am Folio und nicht an der Rechnung haengt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>

interface Zeile {
  invoiceRef: string; number: string; issuedOn: string; kind: string
  grossCent: number; payableCent: number; settledCent: number
  recipient: string; folioRef: string
  documentReady: boolean; hasXml: boolean; mailStatus: string | null
}

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

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  await openBusinessDay(owner, fx.propertyId, new Date().toISOString().slice(0, 10))
  await makePaymentMethod(owner, fx.propertyId, 'BAR')
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

/** Ein Folio mit einer Position, fakturiert. */
async function rechnung(netCent = 46_729): Promise<{ invoiceRef: string; folioRef: string }> {
  const gast = await makeGuest(owner, fx.accountId)
  const f = await owner.query<{ public_ref: string; id: number }>(
    `INSERT INTO folio (property_id, kind, guest_id) VALUES ($1,'guest',$2)
     RETURNING public_ref, id`, [fx.propertyId, gast.id])
  const folioRef = f.rows[0]!.public_ref
  await app.inject({
    method: 'POST', url: `/v1/folios/${folioRef}/charges`,
    headers: { ...auth, 'idempotency-key': `c-${++lauf}` },
    payload: { description: 'Uebernachtung', netCent, taxRateBp: 700 } })
  const r = await app.inject({
    method: 'POST', url: `/v1/folios/${folioRef}/invoice`,
    headers: { ...auth, 'idempotency-key': `i-${++lauf}` }, payload: {} })
  expect(r.statusCode, r.body).toBe(201)
  return { invoiceRef: (JSON.parse(r.body) as { invoiceRef: string }).invoiceRef, folioRef }
}

const liste = (von: string, bis: string, extra = '') => app.inject({
  method: 'GET',
  url: `/v1/properties/${fx.propertyId}/invoices?from=${von}&to=${bis}${extra}`,
  headers: auth })

const zeilen = (body: string): Zeile[] => (JSON.parse(body) as { invoices: Zeile[] }).invoices
const heute = (): string => new Date().toISOString().slice(0, 10)

describe('Rechnungsliste', () => {
  it('nennt Nummer, Empfaenger, Betrag und das Folio dahinter', async () => {
    const { invoiceRef, folioRef } = await rechnung()
    const r = await liste(heute(), heute())
    expect(r.statusCode, r.body).toBe(200)

    const z = zeilen(r.body).find(x => x.invoiceRef === invoiceRef)
    expect(z).toBeDefined()
    expect(z!.number).toMatch(/^\d{4}-\d{5}$/)
    expect(z!.grossCent).toBe(50_000)
    expect(z!.kind).toBe('final')
    expect(z!.recipient).toContain('Petersen')
    // Der Verweis aufs Folio, damit die Ansicht von der Zeile dorthin
    // kommt, ohne zu suchen.
    expect(z!.folioRef).toBe(folioRef)
    expect(typeof z!.grossCent).toBe('number')
  })

  /**
   * Der Punkt, an dem eine Liste leicht lügt: beim Check-out zahlt der Gast
   * aufs Folio, nicht auf die Rechnung. Lange schrieb niemand
   * `settlement.invoice_id`, und eine Spalte „offen" hätte bei **jeder**
   * Rechnung den vollen Betrag gezeigt, auch bei der längst bezahlten.
   *
   * Seit das Vermerken einer Zahlung sie der ältesten offenen Rechnung des
   * Folios zuordnet, sagt die Spalte etwas — und das wird hier geprüft,
   * inklusive der Zuordnung in der Datenbank selbst.
   */
  it('führt eine nach dem Festschreiben vermerkte Zahlung an der Rechnung', async () => {
    const { invoiceRef, folioRef } = await rechnung()

    const vorher = zeilen((await liste(heute(), heute())).body)
      .find(x => x.invoiceRef === invoiceRef)!
    expect(vorher.settledCent).toBe(0)
    expect(vorher.payableCent).toBeGreaterThan(0)

    await app.inject({
      method: 'POST', url: `/v1/folios/${folioRef}/settlements`,
      headers: { ...auth, 'idempotency-key': `s-${++lauf}` },
      payload: { amountCent: vorher.payableCent, paymentMethodCode: 'BAR' } })

    const nachher = zeilen((await liste(heute(), heute())).body)
      .find(x => x.invoiceRef === invoiceRef)!
    expect(nachher.settledCent).toBe(vorher.payableCent)
    expect(nachher.folioRef).toBe(folioRef)

    const verknuepft = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM settlement
        WHERE property_id = $1 AND invoice_id IS NOT NULL`, [fx.propertyId])
    expect(Number(verknuepft.rows[0]!.n)).toBe(1)
  })

  /**
   * Die Obergrenze ist der Zahlbetrag. Mehr zuzuordnen hiesse, auf dem
   * Beleg einen vorausgezahlten Betrag auszuweisen, der groesser ist als
   * die Summe — der Zahlbetrag (BT-115) waere negativ.
   */
  it('ordnet eine Zahlung nicht zu, die über den Zahlbetrag hinausgeht', async () => {
    const { invoiceRef, folioRef } = await rechnung()
    const z = zeilen((await liste(heute(), heute())).body)
      .find(x => x.invoiceRef === invoiceRef)!

    await app.inject({
      method: 'POST', url: `/v1/folios/${folioRef}/settlements`,
      headers: { ...auth, 'idempotency-key': `s-${++lauf}` },
      payload: { amountCent: z.payableCent + 1, paymentMethodCode: 'BAR' } })

    const nachher = zeilen((await liste(heute(), heute())).body)
      .find(x => x.invoiceRef === invoiceRef)!
    // Der Vermerk bleibt ganz offen: er ist nicht teilbar.
    expect(nachher.settledCent).toBe(0)
  })

  /**
   * Der Beleg entsteht nach dem Festschreiben im Worker. Die Ansicht muss
   * das unterscheiden können, sonst zeigt sie einen Fehler, wo nur noch
   * niemand gezeichnet hat.
   */
  it('sagt, ob der Beleg schon erzeugt ist', async () => {
    const { invoiceRef } = await rechnung()
    const vorher = zeilen((await liste(heute(), heute())).body)
      .find(x => x.invoiceRef === invoiceRef)!
    expect(vorher.documentReady).toBe(false)
    expect(vorher.hasXml).toBe(false)

    const inv = await owner.query<{ id: number; property_id: number }>(
      `SELECT id, property_id FROM invoice WHERE public_ref = $1`, [invoiceRef])
    await owner.query(
      `INSERT INTO invoice_document (invoice_id, property_id, pdf, xml, xml_findings,
                                     byte_count, sha256)
       VALUES ($1,$2,$3::bytea,'<xml/>','[]'::jsonb,4,'x')`,
      [inv.rows[0]!.id, inv.rows[0]!.property_id, Buffer.from('%PDF')])

    const nachher = zeilen((await liste(heute(), heute())).body)
      .find(x => x.invoiceRef === invoiceRef)!
    expect(nachher.documentReady).toBe(true)
    expect(nachher.hasXml).toBe(true)
  })

  it('filtert auf die Art und sortiert die neueste zuerst', async () => {
    const a = await rechnung()
    const b = await rechnung(1_000)
    const alle = zeilen((await liste(heute(), heute())).body)
    expect(alle[0]!.invoiceRef).toBe(b.invoiceRef)
    expect(alle.map(z => z.invoiceRef)).toContain(a.invoiceRef)

    const nurAnzahlungen = zeilen((await liste(heute(), heute(), '&kind=deposit')).body)
    expect(nurAnzahlungen).toHaveLength(0)
  })

  it('begrenzt Zeitraum und Zeilenzahl', async () => {
    await rechnung()
    expect((await liste('2026-01-01', '2027-02-04')).statusCode).toBe(200)   // 400 Tage
    expect((await liste('2026-01-01', '2027-02-05')).statusCode).toBe(422)   // 401
    expect((await liste(heute(), heute(), '&limit=1')).statusCode).toBe(200)
    expect(zeilen((await liste(heute(), heute(), '&limit=1')).body)).toHaveLength(1)
    // Eine verdrehte Spanne ist ein Fehler, keine leere Liste.
    expect((await liste('2026-10-10', '2026-10-01')).statusCode).toBe(422)
  })

  it('zeigt die Rechnungen eines fremden Hauses nicht', async () => {
    await rechnung()
    const fremd = await makeProperty(owner, { name: 'Fremdhotel', code: 'FREMD' })
    const u = await makeUser(owner,
      { email: 'fremd@test.de', propertyId: fremd.propertyId, roleKey: 'reception' })
    const r = await app.inject({
      method: 'GET',
      url: `/v1/properties/${fx.propertyId}/invoices?from=${heute()}&to=${heute()}`,
      headers: { cookie: `hp_session=${u.sessionId}` } })
    expect(r.statusCode).toBe(403)
  })
})
