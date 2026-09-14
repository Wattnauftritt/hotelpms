import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeGuest,
         makePaymentMethod, type Fixture } from '@hotelpms/testing'
import { withTransaction, type DbContext, type Pool } from '@hotelpms/db'
import { renderPendingInvoices } from '../jobs/invoiceDocument.js'

/**
 * Der Beleg entsteht aus der festgeschriebenen Rechnung, nicht aus den
 * heutigen Stammdaten. Geprüft wird gegen echtes PostgreSQL, weil hier
 * genau das zählt, was eine gemockte Datenbank nicht hat: die
 * Zeilenrichtlinie, die Unveränderlichkeit und die Momentaufnahme.
 */

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext

const HEUTE = new Date('2026-10-04T08:00:00.000Z')

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(5)
})
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
  // Ein Haus mit USt-IdNr: ohne sie gibt es nach BR-CO-26 kein EN 16931.
  await owner.query(`UPDATE property SET vat_id = 'DE123456789' WHERE id = $1`,
    [fx.propertyId])
})

interface RechnungOpts {
  positionen?: Array<{ description?: string; netCent: number; rateBp?: number
                       quantity?: number; account?: string }>
  mitEmpfaenger?: boolean
  kind?: 'final' | 'interim' | 'deposit' | 'credit_note'
  propertyId?: number
  accountId?: number
  // Fuer Aufgabe 3: eine Verrechnung ist keine charge, geht aber in die
  // festgeschriebene Summe ein, genau wie im echten Festschreiben.
  zusaetzlicheSummen?: Array<{ netCent: number; rateBp: number }>
}

/**
 * Legt eine festgeschriebene Rechnung an. Bewusst ueber SQL und nicht ueber
 * die API: hier wird der Beleg geprueft, nicht der Weg zur Rechnung.
 */
async function rechnung(
  opts: RechnungOpts = {}
): Promise<{ id: number; ref: string; folioId: number }> {
  const propertyId = opts.propertyId ?? fx.propertyId
  const accountId = opts.accountId ?? fx.accountId
  const positionen = opts.positionen ?? [{ netCent: 30_000 }]

  const gast = opts.mitEmpfaenger === false
    ? null : (await makeGuest(owner, accountId)).id
  const f = await owner.query<{ id: number }>(
    `INSERT INTO folio (property_id, kind, guest_id) VALUES ($1,'guest',$2) RETURNING id`,
    [propertyId, gast])
  const folioId = f.rows[0]!.id

  const gruppen = new Map<number, number>()
  const chargeIds: number[] = []
  for (const [i, p] of positionen.entries()) {
    const rateBp = p.rateBp ?? 700
    const netto = p.netCent
    const steuer = Math.round(netto * rateBp / 10_000)
    gruppen.set(rateBp, (gruppen.get(rateBp) ?? 0) + netto)
    const c = await owner.query<{ id: number }>(
      `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account)
       VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [propertyId, folioId, `2026-10-0${i + 1}`, p.description ?? 'Uebernachtung',
       p.quantity ?? 1, netto, steuer, netto + steuer, rateBp, p.account ?? '8300'])
    chargeIds.push(c.rows[0]!.id)
  }
  for (const zs of opts.zusaetzlicheSummen ?? []) {
    gruppen.set(zs.rateBp, (gruppen.get(zs.rateBp) ?? 0) + zs.netCent)
  }

  const groups = [...gruppen.entries()].sort((a, b) => a[0] - b[0]).map(([rateBp, netCent]) => {
    const taxCent = Math.round(netCent * rateBp / 10_000)
    return { rateBp, netCent, taxCent, grossCent: netCent + taxCent }
  })
  const totals = {
    groups,
    netCent: groups.reduce((s, g) => s + g.netCent, 0),
    taxCent: groups.reduce((s, g) => s + g.taxCent, 0),
    grossCent: groups.reduce((s, g) => s + g.grossCent, 0)
  }

  const aussteller = await owner.query(
    `SELECT name, address_line1 AS "addressLine1", postal_code AS "postalCode",
            city, country, tax_number AS "taxNumber", vat_id AS "vatId"
       FROM property WHERE id = $1`, [propertyId])
  const empfaenger = gast === null ? {} : (await owner.query(
    `SELECT trim(both ', ' from coalesce(last_name,'') || ', ' || coalesce(first_name,''))
              AS name,
            address_line1 AS "addressLine1", postal_code AS "postalCode",
            city, country FROM guest WHERE id = $1`, [gast])).rows[0]

  const inv = await owner.query<{ id: number; public_ref: string }>(
    `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date, kind,
                          service_from, service_to,
                          issuer_snapshot, recipient_snapshot, totals)
     VALUES ($1,$2,$3,'2026-10-04'::date,'2026-10-04'::date,$4,
             '2026-10-01'::date,'2026-10-03'::date,$5,$6,$7)
     RETURNING id, public_ref`,
    [propertyId, folioId, `2026-${String(Date.now() % 100000).padStart(5, '0')}`,
     opts.kind ?? 'final', JSON.stringify(aussteller.rows[0]),
     JSON.stringify(empfaenger), JSON.stringify(totals)])

  await owner.query(`UPDATE charge SET invoice_id = $2 WHERE id = ANY($1)`,
    [chargeIds, inv.rows[0]!.id])
  return { id: inv.rows[0]!.id, ref: inv.rows[0]!.public_ref, folioId }
}

interface Beleg {
  invoice_id: number
  xml: string | null
  xml_findings: Array<{ key: string; rule: string }>
  byte_count: number
  sha256: string
  pdf: Buffer
}

async function beleg(invoiceId: number): Promise<Beleg | null> {
  const r = await owner.query<Beleg>(
    `SELECT invoice_id, xml, xml_findings, byte_count, sha256, pdf
       FROM invoice_document WHERE invoice_id = $1`, [invoiceId])
  return r.rows[0] ?? null
}

describe('Rechnungsbeleg aus der festgeschriebenen Rechnung', () => {
  it('erzeugt PDF und XML zu einer vollstaendigen Rechnung', async () => {
    const r = await rechnung({
      positionen: [
        { description: 'Uebernachtung', netCent: 30_000, quantity: 3 },
        { description: 'Fruehstueck', netCent: 4_200, rateBp: 1900, account: '8400' }
      ]
    })
    const ergebnis = await renderPendingInvoices(app, ctx, fx.propertyId, { now: HEUTE })
    expect(ergebnis).toMatchObject({ created: 1, withoutXml: 0, masterDataGaps: [] })

    const d = (await beleg(r.id))!
    expect(d.pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(d.byte_count).toBe(d.pdf.length)
    expect(d.xml_findings).toEqual([])

    // Die Summen des Belegs kommen aus den Positionen der Rechnung.
    // 300,00 zu 7 Prozent und 42,00 zu 19 Prozent: 342,00 netto, 28,98 Steuer.
    expect(d.xml).toContain('<ram:GrandTotalAmount>370.98</ram:GrandTotalAmount>')
    expect(d.xml).toContain('<ram:BasisAmount>300.00</ram:BasisAmount>')
    expect(d.xml).toContain('<ram:BasisAmount>42.00</ram:BasisAmount>')
    // Der Leistungszeitraum steht an der Rechnung und nicht im Kalender.
    expect(d.xml).toContain('<udt:DateTimeString format="102">20261001</udt:DateTimeString>')
    // Logis wird in Naechten abgerechnet, alles andere in Stueck.
    expect(d.xml).toContain('<ram:BilledQuantity unitCode="DAY">3</ram:BilledQuantity>')
    expect(d.xml).toContain('<ram:BilledQuantity unitCode="C62">1</ram:BilledQuantity>')
  })

  it('bettet das XML in das PDF ein, nicht nur daneben', async () => {
    const r = await rechnung()
    await renderPendingInvoices(app, ctx, fx.propertyId, { now: HEUTE })
    const d = (await beleg(r.id))!
    const roh = d.pdf.toString('latin1')
    expect(roh).toContain('factur-x.xml')
    expect(roh).toContain('<pdfaid:part>3</pdfaid:part>')
  })

  /**
   * Der Worker tickt alle paar Minuten. Er darf einen Beleg nicht bei jedem
   * Durchlauf neu erzeugen: die Rechnung ist unveränderlich, der Beleg
   * damit auch.
   */
  it('erzeugt keinen zweiten Beleg zur selben Rechnung', async () => {
    const r = await rechnung()
    await renderPendingInvoices(app, ctx, fx.propertyId, { now: HEUTE })
    const erst = (await beleg(r.id))!

    const zweiter = await renderPendingInvoices(app, ctx, fx.propertyId, {
      now: new Date('2026-11-01T00:00:00.000Z')
    })
    expect(zweiter.created).toBe(0)
    expect((await beleg(r.id))!.sha256).toBe(erst.sha256)
  })

  /**
   * § 33 UStDV erlaubt die Rechnung ohne Empfänger, EN 16931 kennt sie
   * nicht (BR-07, BR-10). Der Beleg entsteht trotzdem — ohne XML und mit
   * dem Grund im Klartext.
   */
  it('erzeugt fuer eine Kleinbetragsrechnung ein PDF ohne XML', async () => {
    const r = await rechnung({ positionen: [{ netCent: 2_000 }], mitEmpfaenger: false })
    const ergebnis = await renderPendingInvoices(app, ctx, fx.propertyId, { now: HEUTE })
    expect(ergebnis).toMatchObject({ created: 1, withoutXml: 1, masterDataGaps: [] })

    const d = (await beleg(r.id))!
    expect(d.xml).toBeNull()
    expect(d.pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(d.xml_findings.map(f => f.key)).toEqual(['buyer_name', 'buyer_address'])
    expect(d.pdf.toString('latin1')).not.toContain('factur-x.xml')
  })

  /**
   * Die Steuernummer genügt § 14 UStG, aber nicht der Norm. Das liegt am
   * Haus und trifft jede Rechnung, deshalb wird es gesondert gemeldet und
   * nicht in der Statistik versteckt.
   */
  it('meldet die fehlende USt-IdNr des Hauses als Stammdatenluecke', async () => {
    await owner.query(`UPDATE property SET vat_id = NULL WHERE id = $1`, [fx.propertyId])
    const r = await rechnung()
    const ergebnis = await renderPendingInvoices(app, ctx, fx.propertyId, { now: HEUTE })

    expect(ergebnis.withoutXml).toBe(1)
    expect(ergebnis.masterDataGaps.map(f => f.rule)).toEqual(['BR-CO-26'])
    expect((await beleg(r.id))!.xml).toBeNull()
  })

  it('meldet die Stammdatenluecke einmal, nicht je Rechnung', async () => {
    await owner.query(`UPDATE property SET vat_id = NULL WHERE id = $1`, [fx.propertyId])
    await rechnung()
    await rechnung()
    const ergebnis = await renderPendingInvoices(app, ctx, fx.propertyId, { now: HEUTE })
    expect(ergebnis.created).toBe(2)
    expect(ergebnis.masterDataGaps).toHaveLength(1)
  })

  /**
   * Der Beleg ist Härtegrad 1 wie die Rechnung: eine spätere
   * Layoutänderung darf nicht stillschweigend das Dokument ersetzen, das
   * der Gast bereits in der Hand hält.
   */
  it('laesst sich nicht aendern und nicht loeschen', async () => {
    const r = await rechnung()
    await renderPendingInvoices(app, ctx, fx.propertyId, { now: HEUTE })

    await expect(withTransaction(app, ctx, c =>
      c.query(`UPDATE invoice_document SET xml = 'x' WHERE invoice_id = $1`, [r.id])
    )).rejects.toThrow(/unveraenderlich|permission denied/i)

    await expect(withTransaction(app, ctx, c =>
      c.query(`DELETE FROM invoice_document WHERE invoice_id = $1`, [r.id])
    )).rejects.toThrow(/unveraenderlich|permission denied/i)
  })

  /**
   * Ein Beleg enthält Namen und Anschrift des Gastes. Die Zeilenrichtlinie
   * muss ihn genauso schützen wie die Rechnung selbst.
   */
  it('bleibt hinter der Zeilenrichtlinie des Mandanten', async () => {
    const fremd = await makeProperty(owner, { name: 'Fremdhotel', code: 'FREMD' })
    await owner.query(`UPDATE property SET vat_id = 'DE999999999' WHERE id = $1`,
      [fremd.propertyId])
    const fremdeRechnung = await rechnung({
      propertyId: fremd.propertyId, accountId: fremd.accountId
    })

    // Der Worker im Kontext des eigenen Hauses sieht die fremde nicht.
    const ergebnis = await renderPendingInvoices(app, ctx, fremd.propertyId, { now: HEUTE })
    expect(ergebnis.created).toBe(0)
    expect(await beleg(fremdeRechnung.id)).toBeNull()

    const fremdCtx: DbContext = {
      accountIds: [fremd.accountId], propertyIds: [fremd.propertyId], userId: null
    }
    expect((await renderPendingInvoices(app, fremdCtx, fremd.propertyId, { now: HEUTE }))
      .created).toBe(1)

    const sichtbar = await withTransaction(app, ctx, c =>
      c.query(`SELECT count(*)::int AS n FROM invoice_document`))
    expect(sichtbar.rows[0]!.n).toBe(0)
  })

  /**
   * Ein bereits zugeordneter Zahlungsvermerk ist eine Anzahlung im Sinne
   * von BT-113 und mindert den offenen Betrag.
   */
  it('weist einen zugeordneten Zahlungsvermerk als Anzahlung aus', async () => {
    const r = await rechnung({ positionen: [{ netCent: 30_000 }] })
    const pm = await makePaymentMethod(owner, fx.propertyId)
    const f = await owner.query<{ folio_id: number }>(
      `SELECT folio_id FROM invoice WHERE id = $1`, [r.id])
    await owner.query(
      `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                               payment_method_id, invoice_id)
       VALUES ($1,$2,'2026-10-02'::date,10000,$3,$4)`,
      [fx.propertyId, f.rows[0]!.folio_id, pm, r.id])

    await renderPendingInvoices(app, ctx, fx.propertyId, { now: HEUTE })
    const d = (await beleg(r.id))!
    expect(d.xml).toContain('<ram:TotalPrepaidAmount>100.00</ram:TotalPrepaidAmount>')
    expect(d.xml).toContain('<ram:DuePayableAmount>221.00</ram:DuePayableAmount>')
  })

  /**
   * Aufgabe 3: eine Anzahlung wird auf der Anzahlungsrechnung selbst als
   * Vereinnahmung ausgewiesen, und in der Schlussrechnung als eigene
   * Position mit negativem Betrag und Verweis auf die Anzahlungsrechnung
   * verrechnet.
   */
  describe('Anzahlung', () => {
    async function anzahlung(
      depositGrossCent: number, rateBp = 700
    ): Promise<{ id: number; ref: string; number: string; folioId: number }> {
      const netCent = Math.round(depositGrossCent - depositGrossCent * rateBp / (10_000 + rateBp))
      const taxCent = depositGrossCent - netCent
      const gast = (await makeGuest(owner, fx.accountId)).id
      const f = await owner.query<{ id: number }>(
        `INSERT INTO folio (property_id, kind, guest_id) VALUES ($1,'guest',$2) RETURNING id`,
        [fx.propertyId, gast])
      const folioId = f.rows[0]!.id
      const pm = await makePaymentMethod(owner, fx.propertyId)
      const s = await owner.query<{ id: number }>(
        `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent, payment_method_id)
         VALUES ($1,$2,'2026-09-15'::date,$3,$4) RETURNING id`,
        [fx.propertyId, folioId, depositGrossCent, pm])

      const aussteller = await owner.query(
        `SELECT name, address_line1 AS "addressLine1", postal_code AS "postalCode",
                city, country, tax_number AS "taxNumber", vat_id AS "vatId"
           FROM property WHERE id = $1`, [fx.propertyId])
      const empfaenger = (await owner.query(
        `SELECT trim(both ', ' from coalesce(last_name,'') || ', ' || coalesce(first_name,''))
                  AS name,
                address_line1 AS "addressLine1", postal_code AS "postalCode",
                city, country FROM guest WHERE id = $1`, [gast])).rows[0]
      const totals = { groups: [{ rateBp, netCent, taxCent, grossCent: depositGrossCent }],
                        netCent, taxCent, grossCent: depositGrossCent }

      const inv = await owner.query<{ id: number; public_ref: string; number: string }>(
        `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date, kind,
                              service_from, service_to,
                              issuer_snapshot, recipient_snapshot, totals)
         VALUES ($1,$2,$3,'2026-09-15'::date,'2026-09-15'::date,'deposit',
                 '2026-10-01'::date,'2026-10-03'::date,$4,$5,$6)
         RETURNING id, public_ref, number`,
        [fx.propertyId, folioId, `2026-${String(Date.now() % 100000).padStart(5, '0')}`,
         JSON.stringify(aussteller.rows[0]), JSON.stringify(empfaenger), JSON.stringify(totals)])

      await owner.query(
        `INSERT INTO deposit_ledger (property_id, folio_id, deposit_invoice_id, kind,
                                     amount_gross_cent, net_cent, tax_cent, tax_rate_bp,
                                     business_date, settlement_id)
         VALUES ($1,$2,$3,'received',$4,$5,$6,$7,'2026-09-15'::date,$8)`,
        [fx.propertyId, folioId, inv.rows[0]!.id, depositGrossCent, netCent, taxCent, rateBp,
         s.rows[0]!.id])

      return { id: inv.rows[0]!.id, ref: inv.rows[0]!.public_ref, number: inv.rows[0]!.number,
               folioId }
    }

    it('weist die Anzahlungsrechnung mit ihrer einen Position aus', async () => {
      const dep = await anzahlung(20_000)
      const ergebnis = await renderPendingInvoices(app, ctx, fx.propertyId, { now: HEUTE })
      expect(ergebnis).toMatchObject({ created: 1, withoutXml: 0 })

      const d = (await beleg(dep.id))!
      expect(d.xml).toContain('<ram:TypeCode>386</ram:TypeCode>')
      expect(d.xml).toContain('<ram:GrandTotalAmount>200.00</ram:GrandTotalAmount>')
      expect(d.xml).toContain('Anzahlung auf den Aufenthalt')
    })

    it('verrechnet die Anzahlung in der Schlussrechnung mit negativer Position', async () => {
      const dep = await anzahlung(20_000)
      const dl = await owner.query<{ net_cent: number; tax_cent: number; tax_rate_bp: number
                                     amount_gross_cent: number }>(
        `SELECT net_cent, tax_cent, tax_rate_bp, amount_gross_cent
           FROM deposit_ledger WHERE deposit_invoice_id = $1`, [dep.id])
      const row = dl.rows[0]!

      // Die festgeschriebene Summe muss die Verrechnung schon enthalten, so
      // wie es das echte Festschreiben tut: die Rechnung ist Haertegrad 1
      // und kann nicht nachtraeglich angepasst werden.
      const schluss = await rechnung({
        positionen: [{ netCent: 46_729 }],
        zusaetzlicheSummen: [{ netCent: -row.net_cent, rateBp: row.tax_rate_bp }]
      })

      // Die Verrechnung so eintragen, wie es das Festschreiben taete: eine
      // 'applied'-Zeile, die auf dieselbe Anzahlungsrechnung verweist.
      await owner.query(
        `INSERT INTO deposit_ledger (property_id, folio_id, deposit_invoice_id, kind,
                                     amount_gross_cent, net_cent, tax_cent, tax_rate_bp,
                                     business_date, applied_invoice_id)
         VALUES ($1,$2,$3,'applied',$4,$5,$6,$7,'2026-10-04'::date,$8)`,
        [fx.propertyId, schluss.folioId, dep.id, row.amount_gross_cent, row.net_cent,
         row.tax_cent, row.tax_rate_bp, schluss.id])

      const ergebnis = await renderPendingInvoices(app, ctx, fx.propertyId, { now: HEUTE })
      expect(ergebnis.failed).toEqual([])

      const d = (await beleg(schluss.id))!
      expect(d.xml).toContain(`Anzahlung verrechnet (Rechnung ${dep.number}`)
      expect(d.xml).toContain('<ram:BilledQuantity unitCode="C62">-1</ram:BilledQuantity>')
      expect(d.xml).toContain('<ram:GrandTotalAmount>300.00</ram:GrandTotalAmount>')
    })
  })

  it('verweigert den Beleg, wenn Positionen und Summe auseinandergehen', async () => {
    const kaputt = await rechnung()
    // Eine zusaetzliche Position derselben Rechnung zuordnen, ohne die
    // Momentaufnahme zu aendern. Von aussen unmoeglich, hier absichtlich.
    const f = await owner.query<{ folio_id: number }>(
      `SELECT folio_id FROM invoice WHERE id = $1`, [kaputt.id])
    await owner.query(
      `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account,
                           invoice_id)
       VALUES ($1,$2,'2026-10-02'::date,'Unterschlagene Position',1,
               10000,700,10700,700,'8300',$3)`,
      [fx.propertyId, f.rows[0]!.folio_id, kaputt.id])

    // Eine zweite, gesunde Rechnung: sie muss ihren Beleg trotzdem
    // bekommen. Sonst bliebe ein ganzes Haus ohne Belege, weil an einer
    // einzigen Rechnung vor Wochen etwas schieflief.
    const gesund = await rechnung()

    const ergebnis = await renderPendingInvoices(app, ctx, fx.propertyId, { now: HEUTE })
    expect(ergebnis.created).toBe(1)
    expect(ergebnis.failed).toHaveLength(1)
    expect(ergebnis.failed[0]!.invoiceId).toBe(kaputt.id)
    expect(ergebnis.failed[0]!.reason).toMatch(/festgeschrieben/)

    expect(await beleg(kaputt.id)).toBeNull()
    expect(await beleg(gesund.id)).not.toBeNull()
  })
})
