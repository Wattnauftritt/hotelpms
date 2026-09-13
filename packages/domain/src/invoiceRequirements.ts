import type { Cent, BasisPoints } from './money.js'
import type { IsoDate } from './dates.js'

/**
 * Pflichtangaben einer Rechnung nach § 14 Abs. 4 UStG, mit den
 * Erleichterungen für Kleinbetragsrechnungen nach § 33 UStDV.
 *
 * **Warum das eine Prüfung und kein Formular ist.** Eine fehlende
 * Pflichtangabe macht die Rechnung nicht ungültig, aber sie kostet dem
 * *Empfänger* den Vorsteuerabzug. Das merkt niemand beim Ausstellen,
 * sondern der Firmenkunde drei Monate später bei seiner Buchhaltung, und
 * dann muss das Haus korrigieren. Eine Rechnung erst gar nicht
 * festschreiben zu lassen, solange eine Angabe fehlt, ist billiger als
 * jede Korrektur.
 *
 * Geprüft wird, was das System wissen kann. Ob eine Anschrift *richtig*
 * ist, kann es nicht wissen; ob sie *da* ist, schon.
 */

export interface Party {
  name?: string | null
  addressLine1?: string | null
  postalCode?: string | null
  city?: string | null
  country?: string | null
  /** Nur beim Aussteller: eines von beiden genügt. */
  taxNumber?: string | null
  vatId?: string | null
}

export interface InvoiceLine {
  description?: string | null
  quantity?: number | null
  netCent: Cent
  rateBp: BasisPoints
}

export interface InvoiceForCheck {
  number?: string | null
  issuedOn?: IsoDate | null
  /** Leistungszeitraum. Bei Beherbergung der Aufenthalt, nicht das Rechnungsdatum. */
  serviceFrom?: IsoDate | null
  serviceTo?: IsoDate | null
  issuer: Party
  recipient: Party
  lines: InvoiceLine[]
  grossCent: Cent
  kind: 'final' | 'interim' | 'deposit' | 'credit_note'
  /** Steuerschuldnerschaft des Leistungsempfängers, § 13b UStG. */
  reverseCharge?: boolean
  /** Hinweis auf eine Steuerbefreiung, falls ein Satz 0 vorkommt. */
  exemptionReason?: string | null
}

/** § 33 UStDV: bis 250 Euro brutto gelten erleichterte Angaben. */
export const KLEINBETRAG_GRENZE: Cent = 25_000

export type RequirementKey =
  | 'issuer_name' | 'issuer_address' | 'issuer_tax_id'
  | 'recipient_name' | 'recipient_address'
  | 'issued_on' | 'number' | 'line_description' | 'line_quantity'
  | 'service_period' | 'tax_breakdown' | 'exemption_reason'
  | 'reverse_charge_note' | 'credit_note_label'

export interface Finding {
  key: RequirementKey
  /** Ohne diese Angabe darf nicht festgeschrieben werden. */
  blocking: boolean
  /** Fundstelle im Gesetz, damit die Meldung nachprüfbar ist. */
  reference: string
  de: string
  en: string
}

function fehlt(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === ''
}

function anschriftFehlt(p: Party): boolean {
  // Postleitzahl und Ort genügen als Anschrift; die Straße kann bei einem
  // Postfach entfallen. Fehlt beides, ist es keine Anschrift.
  return fehlt(p.postalCode) || fehlt(p.city)
}

/**
 * Prüft eine Rechnung vor dem Festschreiben.
 *
 * Gibt **alle** Befunde zurück, nicht nur den ersten. Wer eine Rechnung
 * dreimal hintereinander abgewiesen bekommt, weil jedes Mal ein anderes
 * Feld fehlt, hält das System für kaputt.
 */
export function checkInvoiceRequirements(inv: InvoiceForCheck): Finding[] {
  const f: Finding[] = []
  const klein = inv.grossCent <= KLEINBETRAG_GRENZE && inv.kind !== 'credit_note'

  const add = (
    key: RequirementKey, blocking: boolean, reference: string, de: string, en: string
  ): void => { f.push({ key, blocking, reference, de, en }) }

  // ---- Aussteller. Auch bei Kleinbetragsrechnungen Pflicht.
  if (fehlt(inv.issuer.name)) {
    add('issuer_name', true, '§ 14 Abs. 4 Nr. 1 UStG',
      'Name des ausstellenden Betriebs fehlt.',
      'The issuing business name is missing.')
  }
  if (anschriftFehlt(inv.issuer)) {
    add('issuer_address', true, '§ 14 Abs. 4 Nr. 1 UStG',
      'Anschrift des ausstellenden Betriebs fehlt. Postleitzahl und Ort sind nötig.',
      'The issuing business address is missing. Postal code and city are required.')
  }

  // ---- Steuernummer oder USt-IdNr. Bei Kleinbetrag nicht erforderlich.
  if (!klein && fehlt(inv.issuer.taxNumber) && fehlt(inv.issuer.vatId)) {
    add('issuer_tax_id', true, '§ 14 Abs. 4 Nr. 2 UStG',
      'Steuernummer oder Umsatzsteuer-Identifikationsnummer fehlt. '
      + 'Eine der beiden genügt; sie wird in den Stammdaten des Hauses hinterlegt.',
      'Tax number or VAT identification number is missing. Either one suffices; '
      + 'it is configured in the property settings.')
  }

  // ---- Empfänger. Bei Kleinbetragsrechnungen entbehrlich.
  if (!klein) {
    if (fehlt(inv.recipient.name)) {
      add('recipient_name', true, '§ 14 Abs. 4 Nr. 1 UStG',
        'Name des Rechnungsempfängers fehlt.',
        'The invoice recipient name is missing.')
    }
    if (anschriftFehlt(inv.recipient)) {
      add('recipient_address', true, '§ 14 Abs. 4 Nr. 1 UStG',
        'Anschrift des Rechnungsempfängers fehlt. Bei Firmenrechnungen kostet '
        + 'das dem Kunden den Vorsteuerabzug.',
        'The invoice recipient address is missing. For business invoices this '
        + 'costs the customer the input tax deduction.')
    }
  }

  // ---- Datum und Nummer.
  if (fehlt(inv.issuedOn)) {
    add('issued_on', true, '§ 14 Abs. 4 Nr. 3 UStG',
      'Ausstellungsdatum fehlt.', 'The issue date is missing.')
  }
  if (!klein && fehlt(inv.number)) {
    add('number', true, '§ 14 Abs. 4 Nr. 4 UStG',
      'Fortlaufende Rechnungsnummer fehlt.',
      'The sequential invoice number is missing.')
  }

  // ---- Positionen: Menge und Art der Leistung.
  if (inv.lines.length === 0) {
    add('line_description', true, '§ 14 Abs. 4 Nr. 5 UStG',
      'Die Rechnung enthält keine Position.',
      'The invoice contains no line item.')
  }
  if (inv.lines.some(l => fehlt(l.description))) {
    add('line_description', true, '§ 14 Abs. 4 Nr. 5 UStG',
      'Mindestens eine Position hat keine Leistungsbeschreibung.',
      'At least one line item has no description of the service.')
  }
  if (inv.lines.some(l => l.quantity === null || l.quantity === undefined || l.quantity <= 0)) {
    add('line_quantity', true, '§ 14 Abs. 4 Nr. 5 UStG',
      'Mindestens eine Position hat keine Menge.',
      'At least one line item has no quantity.')
  }

  // ---- Leistungszeitraum. Bei Beherbergung der Aufenthalt.
  if (fehlt(inv.serviceFrom) || fehlt(inv.serviceTo)) {
    add('service_period', true, '§ 14 Abs. 4 Nr. 6 UStG',
      'Leistungszeitraum fehlt. Bei Beherbergung ist das der Aufenthalt, '
      + 'nicht das Rechnungsdatum.',
      'The service period is missing. For accommodation this is the stay, '
      + 'not the invoice date.')
  } else if (inv.serviceTo! < inv.serviceFrom!) {
    add('service_period', true, '§ 14 Abs. 4 Nr. 6 UStG',
      'Der Leistungszeitraum endet vor seinem Beginn.',
      'The service period ends before it begins.')
  }

  // ---- Steuersätze und Beträge.
  const saetze = new Set(inv.lines.map(l => l.rateBp))
  if (saetze.size === 0 && inv.lines.length > 0) {
    add('tax_breakdown', true, '§ 14 Abs. 4 Nr. 8 UStG',
      'Kein Steuersatz angegeben.', 'No tax rate given.')
  }

  // Ein Satz von null verlangt einen Grund. "0 %" ohne Begründung ist der
  // häufigste Mangel bei Rechnungen an ausländische Firmen.
  if (saetze.has(0) && inv.reverseCharge !== true && fehlt(inv.exemptionReason)) {
    add('exemption_reason', true, '§ 14 Abs. 4 Nr. 8 UStG',
      'Eine Position hat den Steuersatz 0 ohne Hinweis auf den Grund der '
      + 'Steuerbefreiung.',
      'A line item has a zero tax rate without stating the reason for the exemption.')
  }

  if (inv.reverseCharge === true) {
    // Der Hinweis ist Pflicht und muss wörtlich erscheinen. Er wird hier
    // nicht geprüft, sondern angefordert: die Darstellung setzt ihn.
    add('reverse_charge_note', false, '§ 14a Abs. 5 UStG',
      'Die Rechnung muss den Hinweis „Steuerschuldnerschaft des '
      + 'Leistungsempfängers" tragen.',
      'The invoice must carry the note "Reverse charge".')
  }

  if (inv.kind === 'credit_note') {
    add('credit_note_label', false, '§ 14 Abs. 4 Nr. 10 UStG',
      'Eine Abrechnung durch den Leistungsempfänger muss „Gutschrift" heißen.',
      'A self-billed invoice must be labelled "Self-billing".')
  }

  return f
}

/** Nur die Befunde, die das Festschreiben verhindern. */
export function blockingFindings(inv: InvoiceForCheck): Finding[] {
  return checkInvoiceRequirements(inv).filter(x => x.blocking)
}

export function isSmallAmountInvoice(grossCent: Cent, kind: string): boolean {
  return grossCent <= KLEINBETRAG_GRENZE && kind !== 'credit_note'
}
