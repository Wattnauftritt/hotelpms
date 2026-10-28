import type { CiiLine, CiiParty, CiiPayee } from './invoiceCii.js'
import type { InvoiceLineSource } from './invoiceLines.js'

/**
 * Vom gespeicherten Stand zur Struktur, aus der Blatt und XML entstehen.
 *
 * Stand bis zum 16.10.2026 im Worker. Seit der Vorschau vor dem
 * Festschreiben baut auch die API daraus einen Entwurf (Sven: "es waere gut
 * wenn es kuenftig eine rechnungsvorschau gaebe bevor ich diese
 * festschreibe"), und zwei Fassungen derselben Abbildung liefen
 * auseinander: der Entwurf zeigte dann andere Zeilen als der Beleg.
 */

/**
 * Erloeskonto der Beherbergung. Positionen darauf werden in Naechten
 * abgerechnet, alles andere in Stueck -- das ist der Unterschied zwischen
 * BT-130 `DAY` und `C62`, und er faellt einem Pruefer auf.
 */
const KONTO_LOGIS = '8300'

/** Die Spalten einer Buchung, die der Beleg braucht. */
export interface InvoiceChargeRow {
  id: number
  reverses_id?: number | null
  description: string
  quantity: number
  net_cent: string | number
  /** Brutto der Buchung; vergleicht die Preise der Naechte (groupInvoiceLines). */
  gross_cent?: string | number
  tax_rate_bp: number
  revenue_account: string
  business_date: string
  package_part: string | null
}

/** Eine Zeile des Anzahlungsjournals mit Nummer und Datum der Anzahlungsrechnung. */
export interface InvoiceDepositRow {
  kind: 'received' | 'applied' | 'unapplied' | 'refunded'
  net_cent: string | number
  tax_rate_bp: number
  deposit_number: string
  deposit_issued_on: string
}

export function partyFromSnapshot(snapshot: Partial<CiiParty>): CiiParty {
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
export function payeeFromSnapshot(snapshot: { name?: string; iban?: string | null; bic?: string | null
                           bankName?: string | null
                           accountHolder?: string | null }): CiiPayee | null {
  if (!snapshot.iban) return null
  // BT-85 ist der Name des Kontos, nicht der des Hotels (0177). Aeltere
  // Momentaufnahmen und Haeuser ohne Angabe behalten den Namen des Hauses.
  return { iban: snapshot.iban, bic: snapshot.bic ?? null,
           accountName: snapshot.accountHolder || snapshot.name || null,
           bankName: snapshot.bankName ?? null }
}

/**
 * Rang einer Buchung auf der Rechnung: Uebernachtung vor Fruehstueck vor
 * allem anderen (Sven, 15.10.2026). Aeltere Fruehstuecksbuchungen tragen
 * kein `package_part`; fuer sie entscheidet der Text.
 */
function rang(c: InvoiceChargeRow): number {
  if (c.package_part === 'breakfast_food') return 1
  if (c.package_part === 'breakfast_drinks') return 2
  if (c.package_part === 'inclusion') return 3
  if (/^Fr(ü|ue)hst(ü|ue)ck Getr/.test(c.description)) return 2
  if (/^Fr(ü|ue)hst(ü|ue)ck/.test(c.description)) return 1
  if (c.revenue_account === KONTO_LOGIS) return 0
  return 4
}

export function chargeLineSource(
  c: InvoiceChargeRow, ausgleich: number, gast: string | undefined
): InvoiceLineSource {
  return {
    description: c.description,
    businessDate: c.business_date,
    guest: gast,
    quantity: c.quantity,
    // Das Fruehstueck im Zimmerpreis liegt auf demselben Konto, ist aber
    // kein Tag Beherbergung (Migration 0158).
    unitCode: c.revenue_account === KONTO_LOGIS && c.package_part === null ? 'DAY' : 'C62',
    netCent: Number(c.net_cent) + ausgleich,
    ...(c.gross_cent === undefined ? {} : { grossCent: Number(c.gross_cent) }),
    rateBp: c.tax_rate_bp,
    rank: rang(c)
  }
}

/**
 * Anzahlung als Position (Aufgabe 3). Auf der Anzahlungsrechnung selbst die
 * Vereinnahmung, auf der Schlussrechnung die Verrechnung mit negativem
 * Betrag und Verweis auf die Anzahlungsrechnung -- als Text in der
 * Position, denn eine eigene Position ist es, keine Kopfangabe.
 */
export function depositLedgerLine(d: InvoiceDepositRow): CiiLine {
  if (d.kind === 'received') {
    return { name: 'Anzahlung auf den Aufenthalt', quantity: 1,
              netCent: Number(d.net_cent), rateBp: d.tax_rate_bp }
  }
  // Auf der Rechnungskorrektur zur Anzahlungsrechnung (0162): der
  // zurueckgezahlte Teil, zum Satz, zu dem er versteuert wurde.
  if (d.kind === 'refunded') {
    return {
      name: `Rückzahlung der Anzahlung (Rechnung ${d.deposit_number} `
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

