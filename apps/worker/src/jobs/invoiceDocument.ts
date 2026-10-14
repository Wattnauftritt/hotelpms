import { createHash } from 'node:crypto'
import { withTransaction, type DbContext, type Pool, type PoolClient } from '@hotelpms/db'
import { buildInvoiceCii, ciiFindings, ciiTotals,
         type CiiFinding, type CiiInvoice, type CiiLine, type CiiParty, type CiiPayee }
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
  totals: { grossCent: number; roundingCent?: number; prepaidCent?: number
            lineAdjustCent?: Record<string, number>
            taxAdjustCent?: Record<string, number> }
  due_on: string | null
  preceding_number: string | null
  preceding_issued_on: string | null
  partial_reversal: boolean
}

interface ChargeRow {
  id: number
  reverses_id: number | null
  description: string
  quantity: number
  net_cent: string | number
  tax_rate_bp: number
  revenue_account: string
  business_date: string
  package_part: string | null
}

interface DepositLedgerRow {
  kind: 'received' | 'applied' | 'unapplied' | 'refunded'
  net_cent: string | number
  tax_rate_bp: number
  deposit_number: string
  deposit_issued_on: string
}

/** 2026-10-13 als 13.10.2026. */
function datumDe(iso: string): string {
  const [j, m, t] = iso.split('-')
  return `${t}.${m}.${j}`
}

function party(snapshot: Partial<CiiParty>): CiiParty {
  return {
    name: snapshot.name ?? '',
    addressLine1: snapshot.addressLine1 ?? null,
    postalCode: snapshot.postalCode ?? null,
    city: snapshot.city ?? null,
    country: snapshot.country ?? null,
    taxNumber: snapshot.taxNumber ?? null,
    vatId: snapshot.vatId ?? null,
    registrationId: snapshot.registrationId ?? null,
    electronicAddress: snapshot.electronicAddress ?? null,
    contactName: snapshot.contactName ?? null,
    phone: snapshot.phone ?? null,
    email: snapshot.email ?? null
  }
}

/** Bankverbindung aus der Momentaufnahme des Ausstellers (0164). */
function payee(snapshot: { name?: string; iban?: string | null; bic?: string | null
                           bankName?: string | null }): CiiPayee | null {
  if (!snapshot.iban) return null
  return { iban: snapshot.iban, bic: snapshot.bic ?? null,
           accountName: snapshot.name ?? null, bankName: snapshot.bankName ?? null }
}

function line(c: ChargeRow, ausgleich: number): CiiLine {
  return {
    name: c.description,
    quantity: c.quantity,
    // Das Fruehstueck im Zimmerpreis liegt auf demselben Konto, ist aber
    // kein Tag Beherbergung (Migration 0158).
    unitCode: c.revenue_account === KONTO_LOGIS && c.package_part === null ? 'DAY' : 'C62',
    netCent: Number(c.net_cent) + ausgleich,
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
  // Auf der Rechnungskorrektur zur Anzahlungsrechnung (0162): der
  // zurueckgezahlte Teil, zum Satz, zu dem er versteuert wurde.
  if (d.kind === 'refunded') {
    return {
      name: `Rueckzahlung der Anzahlung (Rechnung ${d.deposit_number} `
        + `vom ${d.deposit_issued_on})`,
      quantity: 1, netCent: -Number(d.net_cent), rateBp: d.tax_rate_bp
    }
  }
  // Auf der Stornorechnung: die Verrechnung wird mit dem Original
  // aufgehoben, die Anzahlung ist wieder offen.
  if (d.kind === 'unapplied') {
    return {
      name: `Verrechnung der Anzahlung aufgehoben (Rechnung ${d.deposit_number} `
        + `vom ${d.deposit_issued_on})`,
      quantity: 1, netCent: Number(d.net_cent), rateBp: d.tax_rate_bp
    }
  }
  return {
    name: `Anzahlung verrechnet (Rechnung ${d.deposit_number} vom ${d.deposit_issued_on})`,
    quantity: -1, netCent: -Number(d.net_cent), rateBp: d.tax_rate_bp
  }
}

/**
 * Nummern der Rechnungen ohne Beleg, aelteste zuerst -- aber die, an denen
 * es schon einmal gescheitert ist, erst nach ihrem Abstand und hinter allen
 * anderen (Befund 14). Bisher kamen 50 dauerhaft scheiternde Rechnungen bei
 * jedem Lauf zuerst an die Reihe und hielten jede neuere auf, und mit ihr
 * die Rechnungsmail, die auf den Anhang wartet.
 */
async function pending(
  client: PoolClient, propertyId: number, limit: number
): Promise<number[]> {
  const r = await client.query<{ id: number }>(
    `SELECT i.id FROM invoice i
       LEFT JOIN invoice_document d ON d.invoice_id = i.id
       LEFT JOIN invoice_document_failure f ON f.invoice_id = i.id
      WHERE i.property_id = $1 AND d.invoice_id IS NULL
        AND (f.invoice_id IS NULL OR f.next_attempt_at <= now())
      ORDER BY f.invoice_id IS NOT NULL, i.id LIMIT $2`, [propertyId, limit])
  return r.rows.map(x => x.id)
}

/**
 * Fehlschlag vermerken. Der Abstand verdoppelt sich ab fuenf Minuten und
 * endet bei einem Tag: aufgegeben wird nie, denn ohne Beleg ist die
 * Rechnung nicht ausgebbar, und behoben wird der Grund meist von Hand --
 * dann soll sie spaetestens am naechsten Tag von selbst nachkommen.
 */
async function vermerkeFehler(
  client: PoolClient, propertyId: number, invoiceId: number, grund: string
): Promise<void> {
  await client.query(
    `INSERT INTO invoice_document_failure
       (invoice_id, property_id, next_attempt_at, last_error)
     VALUES ($1, $2, now() + interval '5 minutes', left($3, 1000))
     ON CONFLICT (invoice_id) DO UPDATE
       SET attempts = invoice_document_failure.attempts + 1,
           next_attempt_at = now() + least(
             interval '5 minutes' * power(2, least(invoice_document_failure.attempts, 20)),
             interval '1 day'),
           last_error = EXCLUDED.last_error,
           last_failed_at = now()`,
    [invoiceId, propertyId, grund])
}

/**
 * Liest eine Rechnung so, wie sie im Beleg erscheint: aus der
 * Momentaufnahme und den zugeordneten Positionen, nicht aus den heutigen
 * Stammdaten. Zieht das Haus um, aendert das keine alte Rechnung (B6).
 */
async function load(
  client: PoolClient, invoiceId: number
): Promise<{ invoice: CiiInvoice; row: InvoiceRow
             logo: { mime: string; bytes: Uint8Array } | null } | null> {
  const i = await client.query<InvoiceRow>(
    `SELECT i.id, i.public_ref, i.number, i.issued_on::text, i.kind, i.currency,
            i.service_from::text, i.service_to::text,
            i.issuer_snapshot, i.recipient_snapshot, i.totals, i.due_on::text,
            o.number AS preceding_number, o.issued_on::text AS preceding_issued_on,
            i.partial_reversal
       FROM invoice i
       LEFT JOIN invoice o ON o.id = i.reverses_id
      WHERE i.id = $1`, [invoiceId])
  if (i.rowCount === 0) return null
  const row = i.rows[0]!

  const c = await client.query<ChargeRow>(
    `SELECT id, reverses_id, description, quantity, net_cent, tax_rate_bp, revenue_account,
            business_date::text, package_part
       FROM charge WHERE invoice_id = $1 ORDER BY id`, [invoiceId])

  // Ausgleich der Positionen (alignLineNets), aus der Momentaufnahme. Die
  // Stornorechnung fuehrt ihn unter der Buchung des Originals, auf die ihre
  // Gegenbuchung verweist. Aeltere Rechnungen haben keinen.
  const ausgleich = row.totals.lineAdjustCent ?? {}
  const ausgleichFuer = (x: ChargeRow): number => Number(
    ausgleich[String(row.kind === 'credit_note' ? x.reverses_id ?? x.id : x.id)] ?? 0)

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
    buyerReference: (row.recipient_snapshot as { buyerReference?: string | null })
      .buyerReference ?? null,
    payee: payee(row.issuer_snapshot as Parameters<typeof payee>[0]),
    lines: [...c.rows.map(x => line(x, ausgleichFuer(x))), ...d.rows.map(depositLine)],
    // Der Leistungszeitraum steht seit 0017 an der Rechnung. Aeltere
    // Rechnungen haben ihn nicht; fuer sie gilt, was die Positionen sagen.
    serviceFrom: row.service_from ?? daten[0] ?? row.issued_on,
    serviceTo: row.service_to ?? daten[daten.length - 1] ?? row.issued_on,
    // Eine Anzahlungsrechnung belegt einen Zahlungseingang und ist bezahlt.
    // Aeltere tragen das nicht in der Momentaufnahme (Befund 5 der
    // Pruefung vom 13.10.2026); fuer sie gilt ihre Summe als vereinnahmt.
    prepaidCent: Number(row.totals.prepaidCent
      ?? (row.kind === 'deposit' ? row.totals.grossCent : s.rows[0]!.prepaid)),
    // BT-114. Der Ausgleich steht in der festgeschriebenen Momentaufnahme und
    // wird nicht neu gerechnet: waere er ableitbar, waere er nicht noetig.
    // Rechnungen vor Aufgabe 12 haben ihn nicht; dort ist er null.
    roundingCent: Number(row.totals.roundingCent ?? 0),
    // Der Cent je Satz, den die Steuer traegt (taxAdjustToGross). Wie der
    // Ausgleich aus der Momentaufnahme, nicht neu gerechnet.
    ...(row.totals.taxAdjustCent === undefined ? {}
      : { taxAdjustCent: row.totals.taxAdjustCent }),
    dueOn: row.due_on,
    precedingInvoice: row.preceding_number === null ? null
      : { number: row.preceding_number, issuedOn: row.preceding_issued_on! },
    // Auf dem Blatt steht der Bezug als Satz, im XML zusaetzlich als
    // BT-25: ein Mensch liest das eine, der Validator das andere.
    notes: row.preceding_number === null ? []
      : row.partial_reversal ? [
        `Diese Rechnungskorrektur berichtigt die Anzahlungsrechnung ${row.preceding_number} `
          + `vom ${datumDe(row.preceding_issued_on!)} um die zurueckgezahlte Anzahlung.`]
      : [`Diese Stornorechnung hebt die Rechnung ${row.preceding_number} vom `
          + `${datumDe(row.preceding_issued_on!)} vollstaendig auf.`]
  }
  // Das Logo von heute, nicht aus der Momentaufnahme: es ist Gestaltung,
  // keine Angabe der Rechnung. Ein einmal gezeichneter Beleg behaelt das
  // Logo, mit dem er gezeichnet wurde (0170).
  const logo = await client.query<{ mime: string; bytes: Buffer }>(
    `SELECT l.mime, l.bytes FROM property_invoice_logo l
      JOIN invoice i ON i.property_id = l.property_id WHERE i.id = $1`, [invoiceId])
  return { invoice, row, logo: logo.rows[0] ?? null }
}

interface Gezeichnet {
  pdf: Uint8Array
  xml: string | null
  findings: CiiFinding[]
}

/**
 * Zeichnet einen einzelnen Beleg, ohne Datenbank.
 *
 * Gibt mit dem Beleg die Befunde zurueck. Fehlt das XML, steht der Grund in
 * der Zeile und als Hinweis auf dem Blatt: eine Kleinbetragsrechnung ohne
 * Empfaenger ist nach § 33 UStDV gueltig und nach EN 16931 kein Beleg.
 */
async function zeichne(
  geladen: { invoice: CiiInvoice; row: InvoiceRow
             logo?: { mime: string; bytes: Uint8Array } | null }, now: Date
): Promise<Gezeichnet> {
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
    logo: geladen.logo ?? null,
    ...(row.partial_reversal ? { title: 'Rechnungskorrektur' } : {}),
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
  return { pdf, xml, findings }
}

/** Legt den gezeichneten Beleg ab und vergisst einen frueheren Fehlschlag. */
async function ablegen(
  client: PoolClient, propertyId: number, invoiceId: number, g: Gezeichnet
): Promise<void> {
  await client.query(
    `INSERT INTO invoice_document
       (invoice_id, property_id, pdf, xml, xml_findings, byte_count, sha256)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
     ON CONFLICT (invoice_id) DO NOTHING`,
    [invoiceId, propertyId, Buffer.from(g.pdf), g.xml, JSON.stringify(g.findings),
     g.pdf.length, createHash('sha256').update(g.pdf).digest('hex')])
  await client.query(
    `DELETE FROM invoice_document_failure WHERE invoice_id = $1`, [invoiceId])
}

/**
 * Arbeitet die Rechnungen einer Property ab, die noch keinen Beleg haben.
 *
 * **Je Rechnung eigene, kurze Transaktionen.** Lesen in einer, Ablegen in
 * einer zweiten; das Zeichnen dazwischen liegt in keiner (Befund 14). Es
 * ist Rechenarbeit von einigen hundert Millisekunden und hielt bisher
 * Verbindung und Transaktion so lange offen -- bei einem Pool von vier
 * Verbindungen fuer den ganzen Worker ist das ein Viertel davon. Zwischen
 * Lesen und Ablegen kann sich nichts aendern, was der Beleg zeigt: Rechnung
 * und Positionen sind Haertegrad 1. Hundert Belege in einer Transaktion
 * wuerden ausserdem bei einem Fehler in Beleg 99 die ersten 98 verwerfen.
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
    let g: Gezeichnet
    try {
      const geladen = await withTransaction(pool, ctx, c => load(c, id))
      if (geladen === null) continue
      g = await zeichne(geladen, now)
      await withTransaction(pool, ctx, c => ablegen(c, propertyId, id, g))
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      ergebnis.failed.push({ invoiceId: id, reason })
      // Gemerkt, damit dieselbe Rechnung nicht jeden Tick wieder vorne
      // steht. Scheitert schon das, bleibt es beim Alarm im Protokoll.
      await withTransaction(pool, ctx, c => vermerkeFehler(c, propertyId, id, reason))
        .catch(() => undefined)
      continue
    }
    ergebnis.created += 1
    if (g.findings.length > 0) ergebnis.withoutXml += 1
    for (const f of g.findings) {
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
