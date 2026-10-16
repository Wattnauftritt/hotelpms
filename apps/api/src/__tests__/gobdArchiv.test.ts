import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { inflateRawSync, crc32 } from 'node:zlib'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, makePaymentMethod,
         openBusinessDay, blockInvoiceDocuments, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * GoBD-Archiv (Pruefung des Rechnungssystems vom 13.10.2026): bisher ein
 * JSON ohne Beschreibung nach GDPdU, ohne Belege, Protokoll und
 * Anzahlungsjournal.
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
  await makePaymentMethod(owner, fx.propertyId, 'BAR')
  const cat = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, cat, 1)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const gast = await makeGuest(owner, fx.accountId)
  await owner.query(
    `UPDATE guest SET address_line1 = 'Strandweg 2', postal_code = '27476',
                      city = 'Cuxhaven', country = 'DE' WHERE id = $1`, [gast.id])
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: cat, arrival: '2026-10-01', departure: '2026-10-03' })
  await owner.query(`UPDATE folio SET guest_id = $2 WHERE id = $1`, [res.folioId, gast.id])
  folioRef = (await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM folio WHERE id = $1`, [res.folioId])).rows[0]!.public_ref
})
let folioRef: string

const post = (url: string, payload: unknown = {}) => app.inject({
  method: 'POST', url, headers: { ...auth, 'idempotency-key': `gb-${++lauf}` }, payload })

/** Liest ein ZIP ueber sein Verzeichnis und prueft je Eintrag die Pruefsumme. */
function entpacken(zip: Buffer): Map<string, Buffer> {
  const ende = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(ende).toBeGreaterThan(0)
  const anzahl = zip.readUInt16LE(ende + 10)
  let p = zip.readUInt32LE(ende + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < anzahl; i++) {
    expect(zip.readUInt32LE(p)).toBe(0x02014b50)
    const crc = zip.readUInt32LE(p + 16)
    const gepackt = zip.readUInt32LE(p + 20)
    const roh = zip.readUInt32LE(p + 24)
    const nl = zip.readUInt16LE(p + 28)
    const versatz = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nl).toString('utf8')
    const lokal = 30 + zip.readUInt16LE(versatz + 26) + zip.readUInt16LE(versatz + 28)
    const daten = inflateRawSync(zip.subarray(versatz + lokal, versatz + lokal + gepackt))
    expect(daten.length).toBe(roh)
    expect(crc32(daten) >>> 0, name).toBe(crc)
    out.set(name, daten)
    p += 46 + nl
  }
  return out
}

describe('GoBD-Archiv', () => {
  it('liefert Beschreibung, Tabellen, Journal, Protokoll und Belege', async () => {
    const z = await post(`/v1/folios/${folioRef}/settlements`,
      { amountCent: 50_000, paymentMethodCode: 'BAR' })
    const a = await post(`/v1/folios/${folioRef}/deposit-invoice`,
      { settlementId: (JSON.parse(z.body) as { settlementId: number }).settlementId,
        taxRateBp: 700 })
    expect(a.statusCode, a.body).toBe(201)
    const anz = JSON.parse(a.body) as { invoiceRef: string; number: string }
    expect((await post(`/v1/folios/${folioRef}/charges`,
      { description: 'Uebernachtung; "Meerblick"', grossCent: 30_000, taxRateBp: 700 }))
      .statusCode).toBe(201)
    expect((await post(`/v1/invoices/${anz.invoiceRef}/refund`,
      { amountCent: 20_000, paymentMethodCode: 'BAR' })).statusCode).toBe(201)
    // Die Schlussrechnung mit einem Beleg samt XML. Die Stammdaten der
    // Fixture reichen fuer keine elektronische Rechnung; das Festschreiben
    // zeichnete deshalb ein PDF ohne XML, und der Weg des XML ins Archiv
    // bliebe ungeprueft. Gesperrt und von Hand abgelegt, wie vom Worker.
    const aufheben = await blockInvoiceDocuments(owner, fx.propertyId)
    let s: Awaited<ReturnType<typeof post>>
    try {
      s = await post(`/v1/folios/${folioRef}/invoice`)
    } finally {
      await aufheben()
    }
    expect(s.statusCode, s.body).toBe(201)
    const schluss = JSON.parse(s.body) as { number: string }
    await owner.query(
      `INSERT INTO invoice_document (invoice_id, property_id, pdf, xml, byte_count, sha256)
       SELECT id, property_id, '\\x255044462d'::bytea, '<rsm/>', 5, 'abc'
         FROM invoice WHERE number = $1`, [schluss.number])

    // Vom Geschaeftstag bis morgen: das Protokoll zaehlt nach der Uhr, und
    // der Geschaeftstag der Fixture ist ein fester Tag.
    const tag = (await owner.query<{ d: string; bis: string }>(
      `SELECT business_date::text AS d, (current_date + 1)::text AS bis
         FROM invoice WHERE number = $1`, [schluss.number])).rows[0]!
    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/exports/gobd?from=${tag.d}&to=${tag.bis}&format=zip` })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['content-type']).toBe('application/zip')
    const dateien = entpacken(r.rawPayload)

    const datei = schluss.number.replace(/[^A-Za-z0-9._-]/g, '_')
    const namen = [...dateien.keys()]
    expect(namen.slice(0, 8)).toEqual([
      'index.xml', 'rechnungen.csv', 'positionen.csv', 'zahlungen.csv',
      'anzahlungsjournal.csv', 'kassenbuch.csv', 'kassenbelege.csv', 'protokoll.csv'])
    // Danach die Belege: je Rechnung das PDF, daneben das XML, wo es eines gibt.
    expect(namen.slice(8).every(n => n.startsWith('belege/'))).toBe(true)
    expect(namen.filter(n => n.endsWith('.pdf'))).toHaveLength(3)
    expect(namen).toContain(`belege/${datei}.pdf`)
    expect(namen).toContain(`belege/${datei}.xml`)

    const index = dateien.get('index.xml')!.toString()
    expect(index).toContain('<!DOCTYPE DataSet SYSTEM "gdpdu-01-08-2002.dtd">')
    for (const t of ['rechnungen', 'positionen', 'zahlungen', 'anzahlungsjournal',
                     'kassenbuch', 'kassenbelege', 'protokoll']) {
      expect(index).toContain(`<URL>${t}.csv</URL>`)
    }

    const zeilen = (n: string): string[] => dateien.get(n)!.toString().trimEnd().split('\r\n')
    // Kopf plus Anzahlungsrechnung, Korrektur und Schlussrechnung.
    const rechnungen = zeilen('rechnungen.csv')
    expect(rechnungen).toHaveLength(4)
    expect(rechnungen.find(z => z.startsWith(`"${schluss.number}"`))).toContain(`"${datei}.pdf"`)
    // Text in Anfuehrungszeichen, Semikolon und Anfuehrungszeichen darin bleiben heil.
    expect(zeilen('positionen.csv')[1]).toContain('"Uebernachtung; ""Meerblick"""')
    expect(zeilen('positionen.csv')[1]).toContain(';300,00;7,00;')
    expect(zeilen('anzahlungsjournal.csv').slice(1).map(z => z.split(';')[1]))
      .toEqual(['"received"', '"refunded"', '"applied"'])
    expect(zeilen('protokoll.csv').some(z => z.includes(';"invoice";'))).toBe(true)
    expect(dateien.get(`belege/${datei}.pdf`)!.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('nimmt das Kassenbuch mit seinen Belegen mit', async () => {
    // Fuer das Jahresarchiv der Sicherung (15.10.2026): ohne Kassenbuch
    // haette es zehn Jahre lang Rechnungen ohne Barkasse aufbewahrt.
    const tag = '2026-10-01'
    const e = (await owner.query<{ id: string; entry_no: string }>(
      `INSERT INTO cashbook_entry (property_id, business_date, kind, amount_cent, tax_rate_bp,
                                   text, external_number)
       VALUES ($1, $2, 'expense', -1234, 1900, 'Putzmittel; "Glanz"', 'KB-77')
       RETURNING id::text, entry_no::text`, [fx.propertyId, tag])).rows[0]!
    const bild = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const pdf = Buffer.from('%PDF-1.7 Quittung')
    const belege = (await owner.query<{ id: string }>(
      `INSERT INTO cashbook_receipt (property_id, entry_id, mime, bytes, byte_count, sha256)
       VALUES ($1, $2, 'image/jpeg', $3, $4, 'aaa'), ($1, $2, 'application/pdf', $5, $6, 'bbb')
       RETURNING id::text`,
      [fx.propertyId, e.id, bild, bild.length, pdf, pdf.length])).rows.map(r => r.id)
    // Bis morgen, weil das Protokoll nach der Uhr zaehlt (wie oben).
    const bis = (await owner.query<{ d: string }>(
      `SELECT (current_date + 1)::text AS d`)).rows[0]!.d
    // Ein Eintrag ausserhalb des Zeitraums bleibt draussen.
    await owner.query(
      `INSERT INTO cashbook_entry (property_id, business_date, kind, amount_cent, tax_rate_bp)
       VALUES ($1, $2::date - 40, 'cash_in', 5000, 0)`, [fx.propertyId, tag])

    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/exports/gobd?from=${tag}&to=${bis}&format=zip` })
    expect(r.statusCode, r.body).toBe(200)
    const dateien = entpacken(r.rawPayload)

    const kasse = dateien.get('kassenbuch.csv')!.toString().trimEnd().split('\r\n')
    expect(kasse).toHaveLength(2)
    expect(kasse[1]!.startsWith(`${e.entry_no};`)).toBe(true)
    expect(kasse[1]).toContain(';"expense";-12,34;19,00;"Putzmittel; ""Glanz""";')
    expect(kasse[1]).toContain(';"KB-77";')

    const jpg = `KB-${e.entry_no}-${belege[0]}.jpg`
    const pdfName = `KB-${e.entry_no}-${belege[1]}.pdf`
    const liste = dateien.get('kassenbelege.csv')!.toString().trimEnd().split('\r\n')
    expect(liste.slice(1).map(z => z.split(';')[2])).toEqual([`"${jpg}"`, `"${pdfName}"`])
    expect(liste[1]).toContain(';"image/jpeg";7;"aaa";')
    expect(dateien.get(`belege/kasse/${jpg}`)).toEqual(bild)
    expect(dateien.get(`belege/kasse/${pdfName}`)).toEqual(pdf)
    expect(dateien.get('protokoll.csv')!.toString()).toContain(';"cashbook_entry";')
  })

  it('weist ein unbekanntes Format ab', async () => {
    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/exports/gobd?from=2026-10-01&to=2026-10-02&format=xls` })
    expect(r.statusCode).toBe(422)
  })
})
