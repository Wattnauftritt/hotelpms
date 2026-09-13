import { parseCsv, toRecords } from '../csv.js'

/**
 * hotline (SoftTec GmbH) exportiert Reservierungslisten als
 * Semikolon-CSV mit deutschen Spaltennamen, Datum TT.MM.JJJJ und
 * Betraegen mit Komma. Es gibt dafuer keine veroeffentlichte
 * Formatbeschreibung (Dokument 05, Abschnitt 6: Schnittstellen sind
 * einzeln verhandelte Partnerschaften, keine dokumentierte API) - diese
 * Spalten sind eine begruendete Annahme fuer die uebliche Form eines
 * hotline-Exports, kein bestaetigtes Format. Vor dem ersten echten
 * Kunden gegen eine tatsaechliche Exportdatei pruefen.
 *
 * Erwartete Spalten: Belegnummer;Zimmerkategorie;Anreise;Abreise;
 * Nachname;Vorname;Gesamtpreis;Herkunft
 */
const REQUIRED = ['Belegnummer', 'Zimmerkategorie', 'Anreise', 'Abreise'] as const

/** TT.MM.JJJJ -> ISO. Bei Unlesbarkeit unveraendert zurueck, damit der
 *  generische Import die Zeile mit korrekter Zeilennummer als Fehler meldet,
 *  statt dass der Adapter selbst eine zweite Fehlermeldung erfindet. */
function isoFromDeutsch(v: string): string {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v)
  if (m === null) return v
  return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
}

export function parseHotlineReservations(raw: string): Array<Record<string, string>> {
  const { header, rows } = parseCsv(raw, { delimiter: ';' })
  const records = toRecords(header, rows, REQUIRED)
  return records.map(r => ({
    external_reference: `hotline:${r.Belegnummer}`,
    category_code: r.Zimmerkategorie ?? '',
    arrival: isoFromDeutsch(r.Anreise ?? ''),
    departure: isoFromDeutsch(r.Abreise ?? ''),
    // Bereits "1.234,50"-foermig, genau das Format, das parseCent im
    // generischen Import versteht - keine weitere Umrechnung noetig.
    total_price: r.Gesamtpreis ?? '',
    guest_last_name: r.Nachname ?? '',
    guest_first_name: r.Vorname ?? '',
    channel: r.Herkunft ?? '',
    notes: ''
  }))
}
