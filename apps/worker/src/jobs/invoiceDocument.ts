import { createHash } from 'node:crypto'
import { withTransaction, type DbContext, type Pool, type PoolClient } from '@hotelpms/db'
import { buildInvoiceCii, ciiFindings, ciiTotals,
         type CiiFinding, type CiiInvoice, type CiiLine, type CiiParty }
  from '@hotelpms/domain'
import { renderInvoicePdf } from '../pdf/invoiceLayout.js'
import { finalizePdfA3 } from '../pdf/pdfa3.js'

/**
 * Erzeugt zu jeder festgeschriebenen Rechnung den Beleg: ein PDF/A-3 mit
 * eingebettetem CII-XML nach EN 16931 (E3, Dokument 13).
 *
 * **Warum im Worker und nicht beim Festschreiben.** Das Festschreiben haelt
 * die Zaehlerzeile der Rechnungsnummer gesperrt und serialisiert damit alle
 * Rechnungen einer Property. Eine PDF-Erzeugung von einigen hundert
 * Millisekunden in dieser Transaktion wuerde bei zwanzig gleichzeitigen
 * Check-outs zwanzig Kassen anhalten. Der Beleg entsteht deshalb danach,
 * aus Daten, die sich nicht mehr aendern koennen.
 *
 * **Warum das gefahrlos nachtraeglich geht.** Die Rechnung ist Haertegrad 1
 * und ihre Positionen sind ihr fest zugeordnet. Der Beleg von morgen sieht
 * deshalb genauso aus wie der von heute; es gibt kein Zeitfenster, in dem
 * sich der Inhalt noch verschiebt.
 */

/**
 * Erloeskonto der Beherbergung. Positionen darauf werden in Naechten
 * abgerechnet, alles andere in Stueck -- das ist der Unterschied zwischen
 * BT-130 `DAY` und `C62`, und er faellt einem Pruefer auf.
 */
const KONTO_LOGIS = '8300'

export interface InvoiceDocumentResult {
  /** Erzeugte Belege. */
  created: number
  /** Davon ohne eingebettetes XML, weil die Norm nicht erfuellt war. */
  withoutXml: number
  /**
   * Befunde, die nicht an der einzelnen Rechnung liegen, sondern an den
   * Stammdaten des Hauses. Sie treffen jede kuenftige Rechnung und
   * gehoeren deshalb in den Alarm, nicht in die Statistik.
   */
  masterDataGaps: CiiFinding[]
  /** Rechnungen, zu denen kein Beleg entstehen konnte. */
  failed: Array<{ invoiceId: number; reason: string }>
}

interface InvoiceRow {
  id: number
  public_ref: string
  number: string
  issued_on: string
  kind: CiiInvoice['kind']
  currency: string
  service_from: string | null
  service_to: string | null
  issuer_snapshot: Partial<CiiParty>
  recipient_snapshot: Partial<CiiParty>
  totals: { grossCent: number; roundingCent?: number; prepaidCent?: number }
}

interface ChargeRow {
  description: string
  quantity: number
  net_cent: string | number
  tax_rate_bp: number
  revenue_account: string
  business_date: string
}

interface DepositLedgerRow {
  kind: 'received' | 'applied'
  net_cent: string | number
  tax_rate_bp: number
  deposit_number: string
  deposit_issued_on: string
}

function party(snapshot: Partial<CiiParty>): CiiParty {
  return {
    name: snapshot.name ?? '',
    addressLine1: snapshot.addressLine1 ?? null,
    postalCode: snapshot.postalCode ?? null,
    city: snapshot.city ?? null,
    country: snapshot.country ?? null,
    taxNumber: snapshot.taxNumber ?? null,
    vatId: snapshot.vatId ?? null
  }
}

function line(c: ChargeRow): CiiLine {
  return {
    name: c.description,
    quantity: c.quantity,
    unitCode: c.revenue_account === KONTO_LOGIS ? 'DAY' : 'C62',
    netCent: Number(c.net_cent),
    rateBp: c.tax_rate_bp
  }
}

/**
 * Anzahlung als Position (Aufgabe 3). Auf der Anzahlungsrechnung selbst die
 * Vereinnahmung, auf der Schlussrechnung die Verrechnung mit negativem
 * Betrag und Verweis auf die Anzahlungsrechnung -- als Text in der
 * Position, denn eine eigene Position ist es, keine Kopfangabe.
 */
function depositLine(d: DepositLedgerRow): CiiLine {
  if (d.kind === 'received') {
    return { name: 'Anzahlung auf den Aufenthalt', quantity: 1,
              netCent: Number(d.net_cent), rateBp: d.tax_rate_bp }
  }
  return {
    name: `Anzahlung verrechnet (Rechnung ${d.deposit_number} vom ${d.deposit_issued_on})`,
    quantity: -1, netCent: -Number(d.net_cent), rateBp: d.tax_rate_bp
  }
}

/** Nummern der Rechnungen ohne Beleg, aelteste zuerst. */
async function pending(
  client: PoolClient, propertyId: number, limit: number
): Promise<number[]> {
  const r = await client.query<{ id: number }>(
    `SELECT i.id FROM invoice i
       LEFT JOIN invoice_document d ON d.invoice_id = i.id
      WHERE i.property_id = $1 AND d.invoice_id IS NULL
      ORDER BY i.id LIMIT $2`, [propertyId, limit])
  return r.rows.map(x => x.id)
}

/**
 * Liest eine Rechnung so, wie sie im Beleg erscheint: aus der
 * Momentaufnahme und den zugeordneten Positionen, nicht aus den heutigen
 * Stammdaten. Zieht das Haus um, aendert das keine alte Rechnung (B6).
 */
async function load(
  client: PoolClient, invoiceId: number
): Promise<{ invoice: CiiInvoice; row: InvoiceRow } | null> {
  const i = await client.query<InvoiceRow>(
    `SELECT id, public_ref, number, issued_on::text, kind, currency,
            service_from::text, service_to::text,
            issuer_snapshot, recipient_snapshot, totals
       FROM invoice WHERE id = $1`, [invoiceId])
  if (i.rowCount === 0) return null
  const row = i.rows[0]!

  const c = await client.query<ChargeRow>(
    `SELECT description, quantity, net_cent, tax_rate_bp, revenue_account,
            business_date::text
       FROM charge WHERE invoice_id = $1 ORDER BY id`, [invoiceId])

  /*
   * Bereits vereinnahmt und dieser Rechnung zugeordnet (BT-113).
   *
   * Der Betrag kommt aus der **Momentaufnahme** und wird nicht aus den
   * Zahlungsvermerken gerechnet: die Zuordnung laeuft weiter, auch nachdem
   * die Rechnung geschrieben ist (der Gast zahlt beim Auschecken), und ein
   * live gerechneter Betrag machte den Beleg davon abhaengig, wann dieser
   * Lauf ihn gezeichnet hat. Zwei Ausdrucke derselben Rechnung truegen dann
   * verschiedene Zahlen.
   *
   * Rechnungen von vor dieser Aenderung haben das Feld nicht. Fuer sie gilt
   * die Summe der zugeordneten Vermerke -- die damals niemand gesetzt hat,
   * also null, und genau das stand auch bisher auf ihnen.
   */
  const s = await client.query<{ prepaid: string }>(
    `SELECT coalesce(sum(amount_cent), 0)::text AS prepaid
       FROM settlement WHERE invoice_id = $1`, [invoiceId])

  // Anzahlung (Aufgabe 3): auf der Anzahlungsrechnung selbst die
  // Vereinnahmung als einzige Position, auf einer Schlussrechnung die
  // Verrechnung als zusaetzliche Position mit negativem Betrag.
  const d = await client.query<DepositLedgerRow>(
    `SELECT dl.kind, dl.net_cent, dl.tax_rate_bp,
            di.number AS deposit_number, di.issued_on::text AS deposit_issued_on
       FROM deposit_ledger dl
       JOIN invoice di ON di.id = dl.deposit_invoice_id
      WHERE (dl.deposit_invoice_id = $1 AND dl.kind = 'received')
         OR dl.applied_invoice_id = $1`, [invoiceId])

  const daten = c.rows.map(x => x.business_date).sort()
  const invoice: CiiInvoice = {
    number: row.number,
    issuedOn: row.issued_on,
    kind: row.kind,
    currency: row.currency,
    seller: party(row.issuer_snapshot),
    buyer: party(row.recipient_snapshot),
    lines: [...c.rows.map(line), ...d.rows.map(depositLine)],
    // Der Leistungszeitraum steht seit 0017 an der Rechnung. Aeltere
    // Rechnungen haben ihn nicht; fuer sie gilt, was die Positionen sagen.
    serviceFrom: row.service_from ?? daten[0] ?? row.issued_on,
    serviceTo: row.service_to ?? daten[daten.length - 1] ?? row.issued_on,
    prepaidCent: Number(row.totals.prepaidCent ?? s.rows[0]!.prepaid),
    // BT-114. Der Ausgleich steht in der festgeschriebenen Momentaufnahme und
    // wird nicht neu gerechnet: waere er ableitbar, waere er nicht noetig.
    // Rechnungen vor Aufgabe 12 haben ihn nicht; dort ist er null.
    roundingCent: Number(row.totals.roundingCent ?? 0)
  }
  return { invoice, row }
}

/**
 * Erzeugt einen einzelnen Beleg und legt ihn ab.
 *
 * Gibt zurueck, ob ein XML eingebettet wurde. Fehlt es, steht der Grund in
 * der Zeile und als Hinweis auf dem Blatt: eine Kleinbetragsrechnung ohne
 * Empfaenger ist nach § 33 UStDV gueltig und nach EN 16931 kein Beleg.
 */
export async function renderInvoiceDocument(
  client: PoolClient, propertyId: number, invoiceId: number, now: Date
): Promise<{ findings: CiiFinding[] } | null> {
  const geladen = await load(client, invoiceId)
  if (geladen === null) return null
  const { invoice, row } = geladen

  // Der Beleg darf nicht behaupten, was die Rechnung nicht sagt. Weichen
  // die aus den Positionen gerechneten Summen von der festgeschriebenen
  // Momentaufnahme ab, ist etwas grundlegend falsch, und ein gedruckter
  // Beleg wuerde es zementieren.
  const gerechnet = ciiTotals(invoice).grossCent
  const festgeschrieben = Number(row.totals.grossCent)
  if (gerechnet !== festgeschrieben) {
    throw new Error(
      `Rechnung ${row.number}: Positionen ergeben ${gerechnet} Cent, `
      + `festgeschrieben sind ${festgeschrieben} Cent`)
  }

  const findings = ciiFindings(invoice)
  const xml = findings.length === 0 ? buildInvoiceCii(invoice) : null

  const doc = await renderInvoicePdf({
    invoice,
    publicRef: row.public_ref,
    missingXmlNote: xml === null
      ? 'Dieser Beleg traegt keine elektronische Rechnung nach EN 16931: '
        + findings.map(f => `${f.de} (${f.rule})`).join(' ')
      : null
  })
  const pdf = await finalizePdfA3(doc, xml, {
    title: `Rechnung ${invoice.number}`,
    author: invoice.seller.name,
    subject: `Rechnung ${invoice.number} vom ${invoice.issuedOn}`,
    createdAt: now
  })

  await client.query(
    `INSERT INTO invoice_document
       (invoice_id, property_id, pdf, xml, xml_findings, byte_count, sha256)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
     ON CONFLICT (invoice_id) DO NOTHING`,
    [invoiceId, propertyId, Buffer.from(pdf), xml, JSON.stringify(findings),
     pdf.length, createHash('sha256').update(pdf).digest('hex')])

  return { findings }
}

/**
 * Arbeitet die Rechnungen einer Property ab, die noch keinen Beleg haben.
 *
 * **Je Rechnung eine eigene Transaktion.** Die Erzeugung ist Rechenarbeit,
 * kein Datenbankzugriff; hundert Belege in einer Transaktion hielten
 * minutenlang eine Verbindung und wuerden bei einem Fehler in Beleg 99
 * auch die ersten 98 verwerfen.
 */
export async function renderPendingInvoices(
  pool: Pool, ctx: DbContext, propertyId: number,
  opts: { limit?: number; now?: Date } = {}
): Promise<InvoiceDocumentResult> {
  const limit = opts.limit ?? 50
  const now = opts.now ?? new Date()
  const offen = await withTransaction(pool, ctx, c => pending(c, propertyId, limit))

  const ergebnis: InvoiceDocumentResult = {
    created: 0, withoutXml: 0, masterDataGaps: [], failed: []
  }
  const gesehen = new Set<string>()

  for (const id of offen) {
    // Eine Rechnung, an der etwas nicht stimmt, darf die uebrigen nicht
    // aufhalten: sonst bekommt das ganze Haus keine Belege mehr, weil an
    // einer einzigen Rechnung vor Wochen etwas schieflief. Derselbe Grund
    // wie beim Tick ueber die Properties, eine Ebene tiefer.
    let r: { findings: CiiFinding[] } | null
    try {
      r = await withTransaction(pool, ctx, c =>
        renderInvoiceDocument(c, propertyId, id, now))
    } catch (e) {
      ergebnis.failed.push({ invoiceId: id, reason: e instanceof Error ? e.message : String(e) })
      continue
    }
    if (r === null) continue
    ergebnis.created += 1
    if (r.findings.length > 0) ergebnis.withoutXml += 1
    for (const f of r.findings) {
      // Am Haus liegt es, nicht an der Rechnung: das trifft jede weitere
      // und muss deshalb einmal laut gemeldet werden.
      if (f.key.startsWith('seller_') && !gesehen.has(f.key)) {
        gesehen.add(f.key)
        ergebnis.masterDataGaps.push(f)
      }
    }
  }
  return ergebnis
}
