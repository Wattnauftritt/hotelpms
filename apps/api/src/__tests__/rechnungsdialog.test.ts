import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, openBusinessDay, heuteImHaus, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildInvoiceCii } from '@hotelpms/domain'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Rechnungsdialog (Sven, 13.10.2026): vorbefuellt aus der Buchung, aber
 * anpassbar bei Anschrift, Positionen, Zahlungsziel und "bezahlt".
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
  await owner.query(
    `INSERT INTO payment_method (property_id, code, name) VALUES ($1,'CASH','Bar')`,
    [fx.propertyId])
})

interface Folio { ref: string; id: number; nacht: number; extra: number }

/** Folio eines Gastes mit einer Nacht (107 Euro) und einem Getraenk (11,90 Euro). */
async function folio(firma?: { terms: number | null }): Promise<Folio> {
  const gast = await makeGuest(owner, fx.accountId)
  let companyId: number | null = null
  if (firma !== undefined) {
    const c = await owner.query<{ id: number }>(
      `INSERT INTO company (account_id, name, address_line1, postal_code, city, country,
                            payment_terms_days)
       VALUES ($1,'Muster GmbH','Hauptstr. 1','27472','Cuxhaven','DE',$2) RETURNING id`,
      [fx.accountId, firma.terms])
    companyId = c.rows[0]!.id
  }
  const f = await owner.query<{ public_ref: string; id: number }>(
    `INSERT INTO folio (property_id, kind, guest_id, company_id) VALUES ($1,'guest',$2,$3)
     RETURNING public_ref, id`, [fx.propertyId, gast.id, companyId])
  const pos = async (text: string, net: number, tax: number, satz: number,
                     konto: string): Promise<number> => (await owner.query<{ id: number }>(
    `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                         net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account)
     VALUES ($1,$2,current_date,$3,1,$4,$5,$4::bigint + $5::bigint,$6,$7) RETURNING id`,
    [fx.propertyId, f.rows[0]!.id, text, net, tax, satz, konto])).rows[0]!.id
  return { ref: f.rows[0]!.public_ref, id: f.rows[0]!.id,
           nacht: await pos('Uebernachtung', 10_000, 700, 700, '8300'),
           extra: await pos('Minibar', 1_000, 190, 1900, '8400') }
}

const post = (url: string, payload: unknown) => app.inject({
  method: 'POST', url, headers: { ...auth, 'idempotency-key': `k-${++lauf}` }, payload })

// Der Tag im Haus, nicht der der Datenbank: daran rechnet das Zahlungsziel.
const heutePlus = async (tage: number): Promise<string> => Promise.resolve(heuteImHaus(tage))

describe('Vorschau', () => {
  it('rechnet wie das Festschreiben, ohne eine Nummer zu verbrauchen', async () => {
    const f = await folio({ terms: 30 })
    const v = await post(`/v1/folios/${f.ref}/invoice-preview`, { chargeIds: [f.nacht] })
    expect(v.statusCode, v.body).toBe(200)
    const vorschau = JSON.parse(v.body) as {
      totals: { grossCent: number }; recipient: { name: string }; dueOn: string
      openCent: number; findings: unknown[]; lines: Array<{ chargeId: number }> }
    expect(vorschau.lines.map(l => l.chargeId)).toEqual([f.nacht])
    expect(vorschau.totals.grossCent).toBe(10_700)
    expect(vorschau.recipient.name).toBe('Muster GmbH')
    // Zahlungsziel der Firma, nicht des Hauses.
    expect(vorschau.dueOn).toBe(await heutePlus(30))
    expect(vorschau.findings).toEqual([])

    const zaehler = await owner.query(`SELECT 1 FROM invoice_counter`)
    expect(zaehler.rowCount).toBe(0)
  })
})

/**
 * Sven, 16.10.2026: "es waere gut wenn es kuenftig eine rechnungsvorschau
 * gaebe bevor ich diese festschreibe und diese unveraenderbar ist".
 */
describe('PDF-Entwurf', () => {
  it('zeichnet das Blatt, ohne Nummer, Zahlung oder Zuordnung zu schreiben', async () => {
    const f = await folio({ terms: 30 })
    const r = await post(`/v1/folios/${f.ref}/invoice-preview/pdf`,
      { paid: { paymentMethodCode: 'CASH' } })
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200)
    expect(r.headers['content-type']).toBe('application/pdf')
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-')

    for (const tabelle of ['invoice', 'invoice_counter', 'settlement']) {
      expect((await owner.query(`SELECT 1 FROM ${tabelle}`)).rowCount, tabelle).toBe(0)
    }
    const offen = await owner.query(`SELECT 1 FROM charge WHERE invoice_id IS NULL`)
    expect(offen.rowCount).toBe(2)
  })

  it('weist ein fremdes Folio ab wie die Vorschau', async () => {
    const r = await post('/v1/folios/GIBTESNICHT/invoice-preview/pdf', {})
    expect(r.statusCode).toBe(404)
  })
})

describe('Festschreiben mit Angaben aus dem Dialog', () => {
  it('nimmt eine abweichende Anschrift nur fuer diese Rechnung', async () => {
    const f = await folio({ terms: 14 })
    const r = await post(`/v1/folios/${f.ref}/invoice`, {
      recipient: { name: 'Muster GmbH Buchhaltung', addressLine1: 'Postfach 12',
                   postalCode: '20095', city: 'Hamburg', vatId: 'DE123456789' } })
    expect(r.statusCode, r.body).toBe(201)

    const i = await owner.query<{ recipient_snapshot: Record<string, string> }>(
      `SELECT recipient_snapshot FROM invoice`)
    expect(i.rows[0]!.recipient_snapshot).toMatchObject({
      name: 'Muster GmbH Buchhaltung', city: 'Hamburg', country: 'DE', vatId: 'DE123456789' })
    // Die Firma selbst bleibt, wie sie war.
    const c = await owner.query<{ city: string }>(`SELECT city FROM company`)
    expect(c.rows[0]!.city).toBe('Cuxhaven')
  })

  it('traegt den Ansprechpartner der Firma unter den Namen, abweichend nur fuer diese Rechnung', async () => {
    const f = await folio({ terms: 14 })
    await owner.query(`UPDATE company SET contact_name = 'Herr Max Mustermann'`)
    const v = await post(`/v1/folios/${f.ref}/invoice-preview`, { chargeIds: [f.nacht] })
    expect((JSON.parse(v.body) as { recipient: { contactName: string } }).recipient.contactName)
      .toBe('Herr Max Mustermann')

    const r = await post(`/v1/folios/${f.ref}/invoice`, {
      chargeIds: [f.nacht], recipient: { contactName: 'Frau Erika Musterfrau' } })
    expect(r.statusCode, r.body).toBe(201)
    const i = await owner.query<{ recipient_snapshot: Record<string, string> }>(
      `SELECT recipient_snapshot FROM invoice`)
    expect(i.rows[0]!.recipient_snapshot).toMatchObject({
      name: 'Muster GmbH', contactName: 'Frau Erika Musterfrau' })
    const c = await owner.query<{ contact_name: string }>(`SELECT contact_name FROM company`)
    expect(c.rows[0]!.contact_name).toBe('Herr Max Mustermann')

    // Leer nimmt ihn nur von dieser Rechnung.
    const ohne = await post(`/v1/folios/${f.ref}/invoice`, {
      chargeIds: [f.extra], recipient: { contactName: '' } })
    expect(ohne.statusCode, ohne.body).toBe(201)
    const j = await owner.query<{ recipient_snapshot: Record<string, string> }>(
      `SELECT recipient_snapshot FROM invoice ORDER BY id DESC LIMIT 1`)
    expect(j.rows[0]!.recipient_snapshot.contactName).toBeUndefined()
  })

  it('schreibt das Zahlungsziel an die Rechnung und ins XML', async () => {
    const f = await folio()
    const ziel = await heutePlus(10)
    const r = await post(`/v1/folios/${f.ref}/invoice`, { dueOn: ziel })
    expect(r.statusCode, r.body).toBe(201)
    expect(JSON.parse(r.body).dueOn).toBe(ziel)

    const i = await owner.query<{ due_on: string }>(`SELECT due_on::text FROM invoice`)
    expect(i.rows[0]!.due_on).toBe(ziel)

    const xml = buildInvoiceCii({
      number: 'X', issuedOn: '2026-10-13', kind: 'final', currency: 'EUR',
      seller: {}, buyer: {}, serviceFrom: '2026-10-13', serviceTo: '2026-10-13',
      lines: [{ name: 'N', quantity: 1, netCent: 100, rateBp: 700 }], dueOn: ziel } as never)
    expect(xml).toContain('<ram:SpecifiedTradePaymentTerms>')
    expect(xml).toContain('Zahlbar ohne Abzug bis')
  })

  it('weist ein Zahlungsziel in der Vergangenheit ab', async () => {
    const f = await folio()
    const r = await post(`/v1/folios/${f.ref}/invoice`, { dueOn: await heutePlus(-1) })
    expect(r.statusCode).toBe(422)
  })

  it('bucht "gleich bezahlt" als Zahlungsvermerk dieser Rechnung', async () => {
    const f = await folio({ terms: 14 })
    const r = await post(`/v1/folios/${f.ref}/invoice`,
      { paid: { paymentMethodCode: 'CASH' } })
    expect(r.statusCode, r.body).toBe(201)
    const inv = JSON.parse(r.body) as { totals: { prepaidCent: number; payableCent: number }
                                        dueOn: string | null }
    expect(inv.totals.prepaidCent).toBe(inv.totals.payableCent)
    expect(inv.dueOn).toBeNull()

    const s = await owner.query<{ amount_cent: string; zugeordnet: boolean }>(
      `SELECT amount_cent, invoice_id IS NOT NULL AS zugeordnet FROM settlement`)
    expect(s.rows.map(x => [Number(x.amount_cent), x.zugeordnet])).toEqual([[11_890, true]])
    const g = await app.inject({ method: 'GET', url: `/v1/folios/${f.ref}`, headers: auth })
    expect((JSON.parse(g.body) as { balanceCent: number }).balanceCent).toBe(0)
  })

  it('weist eine unbekannte Zahlart ab und schreibt nichts', async () => {
    const f = await folio()
    const r = await post(`/v1/folios/${f.ref}/invoice`,
      { paid: { paymentMethodCode: 'NOPE' } })
    expect(r.statusCode).toBe(422)
    expect((await owner.query(`SELECT 1 FROM invoice`)).rowCount).toBe(0)
  })
})

describe('Korrektur einer Position', () => {
  it('bucht eine offene Position gegen, aber nur einmal', async () => {
    const f = await folio()
    const r = await post(`/v1/folios/${f.ref}/charges/${f.extra}/reverse`, {})
    expect(r.statusCode, r.body).toBe(201)
    expect(JSON.parse(r.body).grossCent).toBe(-1_190)

    const noch = await post(`/v1/folios/${f.ref}/charges/${f.extra}/reverse`, {})
    expect(noch.statusCode).toBe(409)

    // Richtig neu gebucht, brutto eingegeben wie auf dem Papier.
    const neu = await post(`/v1/folios/${f.ref}/charges`,
      { description: 'Minibar', grossCent: 595, taxRateBp: 1900 })
    expect(neu.statusCode, neu.body).toBe(201)
    expect(JSON.parse(neu.body)).toMatchObject({ netCent: 500, taxCent: 95, grossCent: 595 })
  })

  it('bucht keine schon berechnete Position gegen', async () => {
    const f = await folio()
    expect((await post(`/v1/folios/${f.ref}/invoice`, {})).statusCode).toBe(201)
    const r = await post(`/v1/folios/${f.ref}/charges/${f.nacht}/reverse`, {})
    expect(r.statusCode).toBe(409)
  })
})

describe('Zahlung eingegangen', () => {
  it('ordnet die Zahlung der genannten Rechnung zu', async () => {
    const f = await folio({ terms: 14 })
    const a = JSON.parse((await post(`/v1/folios/${f.ref}/invoice`,
      { kind: 'interim', chargeIds: [f.extra] })).body) as { invoiceRef: string }
    const b = JSON.parse((await post(`/v1/folios/${f.ref}/invoice`, {})).body) as {
      invoiceRef: string }

    // Die zweite Rechnung, obwohl die erste aelter und auch offen ist.
    const z = await post(`/v1/folios/${f.ref}/settlements`,
      { amountCent: 10_700, paymentMethodCode: 'CASH', invoiceRef: b.invoiceRef })
    expect(z.statusCode, z.body).toBe(201)
    const s = await owner.query<{ number_ref: string }>(
      `SELECT i.public_ref AS number_ref FROM settlement s JOIN invoice i ON i.id = s.invoice_id`)
    expect(s.rows.map(x => x.number_ref)).toEqual([b.invoiceRef])
    expect(a.invoiceRef).not.toBe(b.invoiceRef)
  })
})

describe('Vorgabe des Hauses', () => {
  it('setzt das Zahlungsziel ohne das Kuerzel', async () => {
    const r = await app.inject({
      method: 'PUT', url: `/v1/properties/${fx.propertyId}/invoice-settings`,
      headers: auth, payload: { paymentTermsDays: 21 } })
    expect(r.statusCode, r.body).toBe(200)
    expect(JSON.parse(r.body).paymentTermsDays).toBe(21)

    const f = await folio()
    const v = JSON.parse((await post(`/v1/folios/${f.ref}/invoice-preview`, {})).body) as {
      dueOn: string }
    expect(v.dueOn).toBe(await heutePlus(21))
  })

  it('gilt auch fuer eine Firma ohne eigenes Zahlungsziel (0189)', async () => {
    // Sven, 19.10.2026: die Voreinstellung kommt aus den Einstellungen,
    // nicht aus einer 14 an der Firma.
    await app.inject({
      method: 'PUT', url: `/v1/properties/${fx.propertyId}/invoice-settings`,
      headers: auth, payload: { paymentTermsDays: 10 } })
    const f = await folio({ terms: null })
    const v = JSON.parse((await post(`/v1/folios/${f.ref}/invoice-preview`, {})).body) as {
      dueOn: string; recipient: { name: string } }
    expect(v.recipient.name).toBe('Muster GmbH')
    expect(v.dueOn).toBe(await heutePlus(10))
  })
})

describe('Kontakt, Bank und Leitweg-ID (0164)', () => {
  const kontakt = {
    contactName: 'Rezeption', phone: '+49 4721 1234', email: 'rechnung@seerobbe.test',
    iban: 'de02 1203 0000 0000 2020 51', bic: 'byladem1001', bankName: 'DKB',
    commercialRegister: 'HRB 1234 Amtsgericht Tostedt',
    accountHolder: 'Hanna Seerobbe', website: 'www.seerobbe.test'
  }
  const setzen = (contact: unknown) => app.inject({
    method: 'PUT', url: `/v1/properties/${fx.propertyId}/invoice-settings`,
    headers: auth, payload: { contact } })

  it('speichert die Angaben vereinheitlicht und meldet, was der XRechnung fehlt', async () => {
    const vorher = JSON.parse((await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/invoice-settings`,
      headers: auth })).body) as { eInvoiceMissing: { xrechnung: string[] } }
    expect(vorher.eInvoiceMissing.xrechnung).toEqual(expect.arrayContaining(['contact', 'iban']))

    const r = await setzen(kontakt)
    expect(r.statusCode, r.body).toBe(200)
    const b = JSON.parse(r.body) as { contact: Record<string, string | null>
                                      eInvoiceMissing: { xml: string[]; xrechnung: string[] } }
    // Leerzeichen und Kleinbuchstaben landen nicht in der Momentaufnahme.
    expect(b.contact).toMatchObject({ iban: 'DE02120300000000202051', bic: 'BYLADEM1001',
                                      commercialRegister: kontakt.commercialRegister })
    expect(b.eInvoiceMissing.xrechnung).not.toContain('contact')
    expect(b.eInvoiceMissing.xrechnung).not.toContain('iban')
    expect(b.eInvoiceMissing.xml).not.toContain('identifier')

    // Ein leerer Text loescht, die uebrigen Felder bleiben.
    const leer = JSON.parse((await setzen({ phone: '' })).body) as {
      contact: Record<string, string | null> }
    expect(leer.contact.phone).toBeNull()
    expect(leer.contact.iban).toBe('DE02120300000000202051')
  })

  it('weist eine IBAN mit falscher Pruefziffer ab', async () => {
    const r = await setzen({ iban: 'DE03120300000000202051' })
    expect(r.statusCode, r.body).toBe(422)
    expect(r.body).toContain('contact.iban')
  })

  it('traegt Bank und Leitweg-ID in die Momentaufnahme der Rechnung', async () => {
    expect((await setzen(kontakt)).statusCode).toBe(200)
    const f = await folio({ terms: 14 })
    await owner.query(`UPDATE company SET buyer_reference = '04011000-12345-34'`)
    expect((await post(`/v1/folios/${f.ref}/invoice`, {})).statusCode).toBe(201)

    const i = await owner.query<{ issuer_snapshot: Record<string, unknown>
                                  recipient_snapshot: Record<string, unknown> }>(
      `SELECT issuer_snapshot, recipient_snapshot FROM invoice`)
    expect(i.rows[0]!.issuer_snapshot).toMatchObject({
      iban: 'DE02120300000000202051', bic: 'BYLADEM1001', contactName: 'Rezeption',
      registrationId: kontakt.commercialRegister,
      // Fuss der Rechnung und BT-85 (0177).
      accountHolder: 'Hanna Seerobbe', website: 'www.seerobbe.test' })
    expect(i.rows[0]!.recipient_snapshot).toMatchObject({ buyerReference: '04011000-12345-34' })

    // Die Bank des Hauses aendert die ausgestellte Rechnung nicht mehr.
    expect((await setzen({ iban: 'DE89370400440532013000' })).statusCode).toBe(200)
    const nachher = await owner.query<{ iban: string }>(
      `SELECT issuer_snapshot->>'iban' AS iban FROM invoice`)
    expect(nachher.rows[0]!.iban).toBe('DE02120300000000202051')
  })
})
