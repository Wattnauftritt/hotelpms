import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>

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
})

let lauf = 0
async function folioMit(
  positionen: Array<{ netCent: number; taxRateBp?: number; description?: string
                      businessDate?: string }>,
  opts: { mitGast?: boolean } = {}
): Promise<string> {
  const gast = opts.mitGast === false ? null : (await makeGuest(owner, fx.accountId)).id
  const f = await owner.query<{ public_ref: string; id: number }>(
    `INSERT INTO folio (property_id, kind, guest_id) VALUES ($1,'guest',$2)
     RETURNING public_ref, id`, [fx.propertyId, gast])

  for (const [i, pos] of positionen.entries()) {
    if (pos.businessDate !== undefined) {
      // Direkt einfuegen, wenn ein bestimmtes Geschaeftsdatum gebraucht wird.
      const netto = pos.netCent
      const steuer = Math.round(netto * (pos.taxRateBp ?? 700) / 10_000)
      await owner.query(
        `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                             net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account)
         VALUES ($1,$2,$3::date,$4,1,$5,$6,$7,$8,'8300')`,
        [fx.propertyId, f.rows[0]!.id, pos.businessDate,
         pos.description ?? 'Uebernachtung', netto, steuer, netto + steuer,
         pos.taxRateBp ?? 700])
    } else {
      await app.inject({
        method: 'POST', url: `/v1/folios/${f.rows[0]!.public_ref}/charges`,
        headers: { ...auth, 'idempotency-key': `c-${++lauf}-${i}` },
        payload: { description: pos.description ?? 'Uebernachtung',
                   netCent: pos.netCent, taxRateBp: pos.taxRateBp ?? 700 }
      })
    }
  }
  return f.rows[0]!.public_ref
}

const fakturieren = (folioRef: string) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/invoice`,
  headers: { ...auth, 'idempotency-key': `i-${++lauf}` }, payload: {} })

describe('Rechnung und Pflichtangaben', () => {
  it('schreibt eine vollstaendige Rechnung fest', async () => {
    const r = await fakturieren(await folioMit([{ netCent: 30_000 }]))
    expect(r.statusCode, r.body).toBe(201)
    const inv = JSON.parse(r.body) as { number: string; serviceFrom: string }
    expect(inv.number).toMatch(/^\d{4}-\d{5}$/)
  })

  /**
   * Das Haus ohne Anschrift ist kein erfundener Fall: bei der Einrichtung
   * wird sie regelmäßig vergessen, und ohne diese Prüfung fiele es erst
   * dem Firmenkunden bei seiner Buchhaltung auf.
   */
  it('verweigert die Rechnung ohne Anschrift des Hauses', async () => {
    await owner.query(`UPDATE property SET postal_code = NULL WHERE id = $1`,
      [fx.propertyId])
    const r = await fakturieren(await folioMit([{ netCent: 30_000 }]))
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).detail).toContain('§ 14 Abs. 4 Nr. 1')
  })

  it('verweigert die Rechnung ohne Steuernummer und ohne USt-IdNr', async () => {
    await owner.query(`UPDATE property SET tax_number = NULL, vat_id = NULL WHERE id = $1`,
      [fx.propertyId])
    const r = await fakturieren(await folioMit([{ netCent: 30_000 }]))
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).detail).toContain('§ 14 Abs. 4 Nr. 2')
  })

  it('laesst die USt-IdNr allein genuegen', async () => {
    await owner.query(
      `UPDATE property SET tax_number = NULL, vat_id = 'DE123456789' WHERE id = $1`,
      [fx.propertyId])
    expect((await fakturieren(await folioMit([{ netCent: 30_000 }]))).statusCode).toBe(201)
  })

  it('verweigert eine Rechnung ueber 250 Euro ohne Empfaenger', async () => {
    const r = await fakturieren(await folioMit([{ netCent: 30_000 }], { mitGast: false }))
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).detail).toContain('Rechnungsempf')
  })

  /**
   * § 33 UStDV: bis 250 Euro brutto braucht die Rechnung keinen Empfänger.
   * Genau der Fall der Laufkundschaft an der Bar.
   */
  it('laesst eine Kleinbetragsrechnung ohne Empfaenger zu', async () => {
    const r = await fakturieren(
      await folioMit([{ netCent: 20_000 }], { mitGast: false }))
    expect(r.statusCode).toBe(201)
  })

  it('zieht die Grenze bei genau 250 Euro brutto', async () => {
    // 233,64 netto bei 7 Prozent sind 250,00 brutto.
    const genau = await fakturieren(
      await folioMit([{ netCent: 23_364 }], { mitGast: false }))
    expect(genau.statusCode).toBe(201)

    const einCentDarueber = await fakturieren(
      await folioMit([{ netCent: 23_365 }], { mitGast: false }))
    expect(einCentDarueber.statusCode).toBe(422)
  })

  /**
   * Der Leistungszeitraum ist bei Beherbergung der Aufenthalt, nicht das
   * Rechnungsdatum. Er wird aus den Positionen abgeleitet, nicht vom
   * Aufrufer entgegengenommen: die Positionen wissen es, der Aufrufer
   * könnte sich irren.
   */
  it('leitet den Leistungszeitraum aus den Positionen ab', async () => {
    const folio = await folioMit([
      { netCent: 10_000, businessDate: '2026-10-01' },
      { netCent: 10_000, businessDate: '2026-10-03' },
      { netCent: 10_000, businessDate: '2026-10-02' }
    ])
    const r = await fakturieren(folio)
    expect(r.statusCode).toBe(201)
    const inv = JSON.parse(r.body) as { serviceFrom: string; serviceTo: string }
    expect(inv.serviceFrom).toBe('2026-10-01')
    expect(inv.serviceTo).toBe('2026-10-03')

    const g = await owner.query<{ service_from: string; service_to: string }>(
      `SELECT service_from::text, service_to::text FROM invoice WHERE property_id = $1`,
      [fx.propertyId])
    expect(g.rows[0]!.service_from).toBe('2026-10-01')
    expect(g.rows[0]!.service_to).toBe('2026-10-03')
  })

  /**
   * Der Beleg selbst entsteht im Worker, nicht hier. Geprüft wird deshalb
   * die Auslieferung: was in der Datenbank liegt, geht unverändert hinaus,
   * und was nicht da ist, wird als „kommt gleich" beantwortet und nicht
   * als „gibt es nicht".
   */
  describe('Auslieferung des Belegs', () => {
    async function mitBeleg(pdf = Buffer.from('%PDF-1.7 Testbeleg')): Promise<string> {
      const r = await fakturieren(await folioMit([{ netCent: 30_000 }]))
      const inv = JSON.parse(r.body) as { invoiceRef: string }
      await owner.query(
        // Beide Male ausdruecklich als bytea: derselbe Parameter in zwei
        // Rollen laesst PostgreSQL sonst raten und scheitern.
        `INSERT INTO invoice_document (invoice_id, property_id, pdf, xml, byte_count, sha256)
         SELECT id, property_id, $2::bytea, '<xml/>', length($2::bytea), 'x'
           FROM invoice WHERE public_ref = $1`, [inv.invoiceRef, pdf])
      return inv.invoiceRef
    }

    it('liefert das PDF mit Typ und Dateinamen', async () => {
      const ref = await mitBeleg()
      const r = await app.inject({
        method: 'GET', url: `/v1/invoices/${ref}/pdf`, headers: auth })
      expect(r.statusCode).toBe(200)
      expect(r.headers['content-type']).toBe('application/pdf')
      expect(r.headers['content-disposition']).toMatch(/^attachment; filename="Rechnung-\d{4}-\d{5}\.pdf"$/)
      expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    })

    it('liefert die Bytes unveraendert', async () => {
      // Ein Beleg mit Nullbytes und hohen Zeichen: wer ihn durch eine
      // Zeichenkette schickt, macht ihn unbrauchbar, und zwar erst beim
      // Empfaenger.
      const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe, 0x0a])
      const ref = await mitBeleg(pdf)
      const r = await app.inject({
        method: 'GET', url: `/v1/invoices/${ref}/pdf`, headers: auth })
      expect(r.rawPayload.equals(pdf)).toBe(true)
    })

    it('unterscheidet den noch nicht erzeugten Beleg von der fehlenden Rechnung', async () => {
      const r = await fakturieren(await folioMit([{ netCent: 30_000 }]))
      const { invoiceRef } = JSON.parse(r.body) as { invoiceRef: string }

      const offen = await app.inject({
        method: 'GET', url: `/v1/invoices/${invoiceRef}/pdf`, headers: auth })
      expect(offen.statusCode).toBe(409)
      expect(JSON.parse(offen.body).type).toBe('urn:hotelpms:document_pending')

      const unbekannt = await app.inject({
        method: 'GET', url: '/v1/invoices/inv_gibtesnicht/pdf', headers: auth })
      expect(unbekannt.statusCode).toBe(404)
    })

    /**
     * Ein Beleg trägt Namen und Anschrift des Gastes. Die öffentliche
     * Referenz ist keine Berechtigung: das fremde Haus darf ihn auch dann
     * nicht bekommen, wenn es sie kennt.
     */
    it('gibt den Beleg nicht an ein fremdes Haus', async () => {
      const ref = await mitBeleg()
      const fremd = await makeProperty(owner, { name: 'Fremdhotel', code: 'FREMD' })
      const fremderNutzer = await makeUser(owner,
        { email: 'fremd@test.de', propertyId: fremd.propertyId, roleKey: 'reception' })

      const r = await app.inject({
        method: 'GET', url: `/v1/invoices/${ref}/pdf`,
        headers: { cookie: `hp_session=${fremderNutzer.sessionId}` } })
      expect(r.statusCode).toBe(404)
    })
  })

  it('nennt alle Maengel auf einmal', async () => {
    await owner.query(
      `UPDATE property SET postal_code = NULL, tax_number = NULL, vat_id = NULL
        WHERE id = $1`, [fx.propertyId])
    const r = await fakturieren(await folioMit([{ netCent: 30_000 }], { mitGast: false }))
    const detail = JSON.parse(r.body).detail as string
    // Aussteller-Anschrift, Steuernummer, Empfaenger: drei Fundstellen.
    expect(detail).toContain('Nr. 1')
    expect(detail).toContain('Nr. 2')
    expect(detail.match(/§ 14/g)!.length).toBeGreaterThanOrEqual(3)
  })
})
