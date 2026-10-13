import type { PoolClient } from '@hotelpms/db'
import type { ZipDatei } from './zipDatei.js'
import { Errors } from './errors.js'

/**
 * GoBD-Archiv: Tabellen, Beschreibung nach GDPdU und Belege eines
 * Zeitraums in einem ZIP (Pruefung des Rechnungssystems vom 13.10.2026).
 *
 * Der bisherige Export war ein JSON ohne `index.xml`, ohne Belege, ohne
 * Protokoll und ohne Anzahlungsjournal. Eine Betriebspruefung liest den
 * Datentraeger mit IDEA oder einem vergleichbaren Werkzeug, und das
 * erwartet die Beschreibungsdatei nach dem Beschreibungsstandard der
 * Finanzverwaltung (GDPdU, DTD vom 01.08.2002). Ohne sie ist jede Tabelle
 * ein Ratespiel ueber Trennzeichen, Dezimalzeichen und Spaltenbedeutung.
 *
 * **Werte unveraendert.** Anders als die CSV fuer die Tabellenkalkulation
 * setzt dieser Export kein Hochkomma vor Text, der mit `=` beginnt: das
 * Archiv ist ein Nachweis, und ein Nachweis gibt die Daten so wieder, wie
 * sie gespeichert sind. Jeder Text steht in Anfuehrungszeichen, damit
 * Semikolon und Zeilenumbruch darin nichts verschieben.
 *
 * **Abgrenzung nach Geschaeftstag** wie der DATEV-Stapel, das Protokoll
 * nach dem Zeitpunkt in der Zeitzone des Hauses.
 */

type Typ = 'text' | 'zahl' | 'betrag' | 'datum' | 'prozent'

interface Spalte { name: string; typ: Typ; beschreibung?: string }

interface Tabelle {
  datei: string
  name: string
  beschreibung: string
  schluessel: Spalte
  spalten: Spalte[]
  /** $1 Haus, $2 von, $3 bis. Spalten in der Reihenfolge oben, Schluessel zuerst. */
  sql: string
}

const TABELLEN: Tabelle[] = [
  {
    datei: 'rechnungen.csv',
    name: 'Rechnungen',
    beschreibung: 'Ausgestellte Rechnungen, Anzahlungsrechnungen und Rechnungskorrekturen. '
      + 'Empfaenger ist die Momentaufnahme bei Ausstellung. Der Beleg liegt unter belege/.',
    schluessel: { name: 'Rechnungsnummer', typ: 'text' },
    spalten: [
      { name: 'Art', typ: 'text',
        beschreibung: 'final Schlussrechnung, interim Zwischenrechnung, deposit '
          + 'Anzahlungsrechnung, credit_note Storno oder Rechnungskorrektur' },
      { name: 'Ausstellungsdatum', typ: 'datum' },
      { name: 'Geschaeftstag', typ: 'datum' },
      { name: 'Empfaenger', typ: 'text' },
      { name: 'Netto', typ: 'betrag' },
      { name: 'Steuer', typ: 'betrag' },
      { name: 'Brutto', typ: 'betrag' },
      { name: 'Rundung', typ: 'betrag', beschreibung: 'Rundungsbetrag auf Belegebene (BT-114)' },
      { name: 'Zahlbetrag', typ: 'betrag' },
      { name: 'Bezug', typ: 'text', beschreibung: 'Bei Storno und Korrektur: die berichtigte Rechnung' },
      { name: 'Faellig', typ: 'datum' },
      { name: 'Waehrung', typ: 'text' },
      { name: 'Erfasst', typ: 'text', beschreibung: 'Zeitpunkt der Festschreibung, UTC' },
      { name: 'Beleg', typ: 'text', beschreibung: 'Dateiname des PDF unter belege/' },
      { name: 'SHA256', typ: 'text', beschreibung: 'Fingerabdruck des PDF' }
    ],
    sql: `SELECT i.number, i.kind, i.issued_on::text, i.business_date::text,
                 COALESCE(i.recipient_snapshot->>'name', ''),
                 (i.totals->>'netCent')::bigint, (i.totals->>'taxCent')::bigint,
                 (i.totals->>'grossCent')::bigint,
                 COALESCE((i.totals->>'roundingCent')::bigint, 0),
                 COALESCE((i.totals->>'payableCent')::bigint, (i.totals->>'grossCent')::bigint),
                 o.number, i.due_on::text, i.currency,
                 to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                 CASE WHEN d.invoice_id IS NOT NULL
                      THEN regexp_replace(i.number, '[^A-Za-z0-9._-]', '_', 'g') || '.pdf' END,
                 d.sha256
            FROM invoice i
            LEFT JOIN invoice o ON o.id = i.reverses_id
            LEFT JOIN invoice_document d ON d.invoice_id = i.id
           WHERE i.property_id = $1 AND i.business_date BETWEEN $2::date AND $3::date
           ORDER BY i.business_date, i.id`
  },
  {
    datei: 'positionen.csv',
    name: 'Positionen',
    beschreibung: 'Einzelne Leistungen auf einem Folio. Unveraenderlich; eine Korrektur ist '
      + 'eine zweite Zeile mit negativem Betrag und Verweis auf das Original.',
    schluessel: { name: 'PositionID', typ: 'zahl' },
    spalten: [
      { name: 'Rechnungsnummer', typ: 'text', beschreibung: 'Leer, solange nicht fakturiert' },
      { name: 'Geschaeftstag', typ: 'datum' },
      { name: 'Text', typ: 'text' },
      { name: 'Menge', typ: 'zahl' },
      { name: 'Netto', typ: 'betrag' },
      { name: 'Steuer', typ: 'betrag' },
      { name: 'Brutto', typ: 'betrag' },
      { name: 'Steuersatz', typ: 'prozent' },
      { name: 'Erloeskonto', typ: 'text' },
      { name: 'KorrekturVon', typ: 'zahl', beschreibung: 'PositionID des Originals' },
      { name: 'Erfasst', typ: 'text' }
    ],
    sql: `SELECT c.id, i.number, c.business_date::text, c.description, c.quantity,
                 c.net_cent, c.tax_cent, c.gross_cent, c.tax_rate_bp, c.revenue_account,
                 c.reverses_id,
                 to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            FROM charge c LEFT JOIN invoice i ON i.id = c.invoice_id
           WHERE c.property_id = $1 AND c.business_date BETWEEN $2::date AND $3::date
           ORDER BY c.id`
  },
  {
    datei: 'zahlungen.csv',
    name: 'Zahlungsvermerke',
    beschreibung: 'Vermerke ueber Zahlungen. Die Zahlung selbst laeuft ausserhalb dieses '
      + 'Systems (Kasse, Bank, Zahlungsdienstleister); Referenz verweist darauf.',
    schluessel: { name: 'ZahlungID', typ: 'zahl' },
    spalten: [
      { name: 'Rechnungsnummer', typ: 'text' },
      { name: 'Geschaeftstag', typ: 'datum' },
      { name: 'Betrag', typ: 'betrag' },
      { name: 'Zahlart', typ: 'text' },
      { name: 'Referenz', typ: 'text' },
      { name: 'KorrekturVon', typ: 'zahl' },
      { name: 'Erfasst', typ: 'text' }
    ],
    sql: `SELECT s.id, i.number, s.business_date::text, s.amount_cent, pm.code,
                 s.external_reference, s.reverses_id,
                 to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            FROM settlement s
            JOIN payment_method pm ON pm.id = s.payment_method_id
            LEFT JOIN invoice i ON i.id = s.invoice_id
           WHERE s.property_id = $1 AND s.business_date BETWEEN $2::date AND $3::date
           ORDER BY s.id`
  },
  {
    datei: 'anzahlungsjournal.csv',
    name: 'Anzahlungsjournal',
    beschreibung: 'Versteuerte Anzahlungen: Vereinnahmung (received), Verrechnung mit der '
      + 'Schlussrechnung (applied), Aufhebung durch Storno (unapplied), Rueckzahlung '
      + 'mit Rechnungskorrektur (refunded). Betraege sind immer positiv; die Art gibt '
      + 'die Richtung.',
    schluessel: { name: 'JournalID', typ: 'zahl' },
    spalten: [
      { name: 'Art', typ: 'text' },
      { name: 'Geschaeftstag', typ: 'datum' },
      { name: 'Anzahlungsrechnung', typ: 'text' },
      { name: 'Gegenbeleg', typ: 'text',
        beschreibung: 'Schlussrechnung, Stornorechnung oder Rechnungskorrektur' },
      { name: 'ZahlungID', typ: 'zahl' },
      { name: 'Steuersatz', typ: 'prozent' },
      { name: 'Netto', typ: 'betrag' },
      { name: 'Steuer', typ: 'betrag' },
      { name: 'Brutto', typ: 'betrag' }
    ],
    sql: `SELECT d.id, d.kind, d.business_date::text, di.number, ai.number, d.settlement_id,
                 d.tax_rate_bp, d.net_cent, d.tax_cent, d.amount_gross_cent
            FROM deposit_ledger d
            JOIN invoice di ON di.id = d.deposit_invoice_id
            LEFT JOIN invoice ai ON ai.id = d.applied_invoice_id
           WHERE d.property_id = $1 AND d.business_date BETWEEN $2::date AND $3::date
           ORDER BY d.id`
  },
  {
    datei: 'protokoll.csv',
    name: 'Aenderungsprotokoll',
    beschreibung: 'Jede Schreibhandlung an Rechnungen, Belegen, Positionen, Zahlungsvermerken, '
      + 'Anzahlungsjournal und Mahnungen, mit Zeitpunkt und Benutzer. Personenbezogene '
      + 'Werte sind im Protokoll durch einen Platzhalter ersetzt (Datenschutz).',
    schluessel: { name: 'ProtokollID', typ: 'zahl' },
    spalten: [
      { name: 'Zeitpunkt', typ: 'text', beschreibung: 'UTC' },
      { name: 'Tabelle', typ: 'text' },
      { name: 'DatensatzID', typ: 'zahl' },
      { name: 'Aktion', typ: 'text' },
      { name: 'BenutzerID', typ: 'zahl' },
      { name: 'Aenderung', typ: 'text', beschreibung: 'Geaenderte Felder als JSON' }
    ],
    sql: `SELECT a.id,
                 to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                 a.table_name, a.row_id, a.action, a.user_id, a.changed::text
            FROM audit_log a, property p
           WHERE p.id = $1 AND a.property_id = $1
             AND a.table_name IN ('invoice','invoice_document','charge','settlement',
                                  'deposit_ledger','invoice_reminder')
             AND a.occurred_at >= ($2::date::timestamp AT TIME ZONE p.timezone)
             AND a.occurred_at <  (($3::date + 1)::timestamp AT TIME ZONE p.timezone)
           ORDER BY a.occurred_at, a.id`
  }
]

const STAPEL = 2000
const BELEGE_JE_RUNDE = 50
/**
 * ZIP ohne ZIP64 fasst 65 535 Eintraege; je Rechnung bis zu zwei. Darueber
 * wird der Zeitraum abgewiesen, mit einem, der passt -- ein grosses Haus
 * exportiert dann ein Jahr in zwei Teilen statt gar nicht.
 */
const MAX_BELEGE = 32_000

function iso2de(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
}

/** Cent als Euro mit Komma, ohne Tausenderpunkt; Ganzzahlarithmetik, kein Fliesskomma. */
function euro(cent: number | string | bigint): string {
  const n = BigInt(cent)
  const neg = n < 0n
  const a = neg ? -n : n
  return `${neg ? '-' : ''}${a / 100n},${String(a % 100n).padStart(2, '0')}`
}

function feld(v: unknown, typ: Typ): string {
  if (v === null || v === undefined) return ''
  switch (typ) {
    case 'betrag': return euro(v as string)
    case 'prozent': return euro(v as string)
    case 'datum': return iso2de(String(v))
    case 'zahl': return String(v)
    case 'text': return `"${String(v).replace(/"/g, '""')}"`
  }
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function spalteXml(s: Spalte, primaer: boolean): string {
  const art = s.typ === 'text' ? '<AlphaNumeric/>'
    : s.typ === 'zahl' ? '<Numeric/>'
    : s.typ === 'datum' ? '<Date><Format>DD.MM.YYYY</Format></Date>'
    : '<Numeric><Accuracy>2</Accuracy></Numeric>'
  const tag = primaer ? 'VariablePrimaryKey' : 'VariableColumn'
  const besch = s.beschreibung ? `<Description>${xml(s.beschreibung)}</Description>` : ''
  return `        <${tag}><Name>${xml(s.name)}</Name>${besch}${art}</${tag}>`
}

/** Beschreibungsdatei nach GDPdU (DTD gdpdu-01-08-2002). */
export function indexXml(haus: { name: string; city: string | null },
                         von: string, bis: string): string {
  const tabellen = TABELLEN.map(t => `    <Table>
      <URL>${t.datei}</URL>
      <Name>${xml(t.name)}</Name>
      <Description>${xml(t.beschreibung)}</Description>
      <Validity>
        <Range><From>${iso2de(von)}</From><To>${iso2de(bis)}</To></Range>
        <Format>DD.MM.YYYY</Format>
      </Validity>
      <UTF8/>
      <DecimalSymbol>,</DecimalSymbol>
      <DigitGroupingSymbol>.</DigitGroupingSymbol>
      <Range><From>2</From></Range>
      <VariableLength>
        <ColumnDelimiter>;</ColumnDelimiter>
        <RecordDelimiter>&#13;&#10;</RecordDelimiter>
        <TextEncapsulator>"</TextEncapsulator>
${[spalteXml(t.schluessel, true), ...t.spalten.map(s => spalteXml(s, false))].join('\n')}
      </VariableLength>
    </Table>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE DataSet SYSTEM "gdpdu-01-08-2002.dtd">
<DataSet>
  <Version>1.0</Version>
  <DataSupplier>
    <Name>${xml(haus.name)}</Name>
    <Location>${xml(haus.city ?? '')}</Location>
    <Comment>StayGrid, GoBD-Export ${iso2de(von)} bis ${iso2de(bis)}</Comment>
  </DataSupplier>
  <Media>
    <Name>StayGrid GoBD-Export</Name>
${tabellen}
  </Media>
</DataSet>
`
}

/** Eine Tabelle als CSV, stapelweise ueber einen Cursor in derselben Transaktion. */
async function* csvZeilen(client: PoolClient, t: Tabelle, nr: number,
                          params: unknown[]): AsyncGenerator<string> {
  const alle = [t.schluessel, ...t.spalten]
  yield alle.map(s => `"${s.name}"`).join(';') + '\r\n'
  const cursor = `staygrid_gobd_${nr}`
  await client.query({ text: `DECLARE ${cursor} NO SCROLL CURSOR FOR ${t.sql}`, values: params })
  for (;;) {
    const r = await client.query({ text: `FETCH ${STAPEL} FROM ${cursor}`, rowMode: 'array' })
    const rows = r.rows as unknown[][]
    if (rows.length === 0) break
    yield rows.map(z => z.map((v, i) => feld(v, alle[i]!.typ)).join(';')).join('\r\n') + '\r\n'
    if (rows.length < STAPEL) break
  }
}

/** Fuellt das Archiv: Beschreibung, Tabellen, Belege. */
export async function gobdArchiv(client: PoolClient, zip: ZipDatei, propertyId: number,
                                 von: string, bis: string): Promise<void> {
  const haus = (await client.query<{ name: string; city: string | null; tage: number
                                     belege: string }>(
    `SELECT name, city, ($3::date - $2::date + 1) AS tage,
            (SELECT count(*) FROM invoice i JOIN invoice_document d ON d.invoice_id = i.id
              WHERE i.property_id = $1
                AND i.business_date BETWEEN $2::date AND $3::date)::text AS belege
       FROM property WHERE id = $1`, [propertyId, von, bis])).rows[0]!
  const belege = Number(haus.belege)
  if (belege > MAX_BELEGE) {
    throw Errors.rangeTooLarge(Math.max(1, Math.floor(haus.tage * MAX_BELEGE / belege)))
  }
  await zip.eintrag('index.xml', [indexXml(haus, von, bis)])
  const params = [propertyId, von, bis]
  let nr = 0
  for (const t of TABELLEN) await zip.eintrag(t.datei, csvZeilen(client, t, ++nr, params))

  /*
   * Belege: das PDF/A-3 und, wo eines entstanden ist, das CII-XML im
   * Klartext. In Runden statt mit einem Cursor, weil je Runde fuenfzig
   * PDF im Speicher genug sind und jede Runde ihren Eintrag fertig
   * schreibt, bevor die naechste holt.
   */
  let nach = 0
  for (;;) {
    const { rows } = await client.query<{ id: string; datei: string; pdf: Buffer
                                          xml: string | null }>(
      `SELECT i.id::text AS id,
              regexp_replace(i.number, '[^A-Za-z0-9._-]', '_', 'g') AS datei, d.pdf, d.xml
         FROM invoice i JOIN invoice_document d ON d.invoice_id = i.id
        WHERE i.property_id = $1 AND i.business_date BETWEEN $2::date AND $3::date
          AND i.id > $4
        ORDER BY i.id LIMIT ${BELEGE_JE_RUNDE}`, [propertyId, von, bis, nach])
    for (const r of rows) {
      await zip.eintrag(`belege/${r.datei}.pdf`, [r.pdf])
      if (r.xml !== null) await zip.eintrag(`belege/${r.datei}.xml`, [r.xml])
    }
    if (rows.length < BELEGE_JE_RUNDE) break
    nach = Number(rows[rows.length - 1]!.id)
  }
}
