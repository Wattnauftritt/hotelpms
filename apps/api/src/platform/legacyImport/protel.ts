import { parseCsv, toRecords } from '../csv.js'

/**
 * protel exportiert Komma-CSV mit englischen Spaltennamen und - in der
 * international ausgerichteten Praxis dieses Anbieters ueblich -
 * amerikanischer Datumsform MM/TT/JJJJ. Das ist die gefaehrlichste der drei
 * Formen: 01/07/2026 ist der 7. Januar, nicht der 1. Juli, und genau deshalb
 * uebernimmt dieser Adapter die Umrechnung, statt sich auf die ohnehin
 * grosszuegige Datumserkennung des generischen Imports zu verlassen, die TT
 * zuerst annimmt. Wie bei hotline und HS/3 ist das eine begruendete Annahme
 * ueber die uebliche Exportform, keine veroeffentlichte Spezifikation
 * (Dokument 05, Abschnitt 6).
 *
 * Erwartete Spalten: ReservationNo,RoomType,CheckIn,CheckOut,GuestName,
 * TotalAmount,Channel. GuestName ist "Nachname, Vorname" in einem Feld,
 * bei Bedarf in Anfuehrungszeichen wegen des Kommas darin.
 */
const REQUIRED = ['ReservationNo', 'RoomType', 'CheckIn', 'CheckOut'] as const

/** MM/TT/JJJJ -> ISO. Unlesbares bleibt unveraendert (siehe hotline.ts). */
function isoFromUs(v: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v)
  if (m === null) return v
  return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
}

function splitName(v: string): { lastName: string; firstName: string } {
  const [nachname, vorname] = v.split(',', 2).map(s => s.trim())
  return { lastName: nachname ?? '', firstName: vorname ?? '' }
}

export function parseProtelReservations(raw: string): Array<Record<string, string>> {
  const { header, rows } = parseCsv(raw, { delimiter: ',' })
  const records = toRecords(header, rows, REQUIRED)
  return records.map(r => {
    const { lastName, firstName } = splitName(r.GuestName ?? '')
    return {
      external_reference: `protel:${r.ReservationNo}`,
      category_code: r.RoomType ?? '',
      arrival: isoFromUs(r.CheckIn ?? ''),
      departure: isoFromUs(r.CheckOut ?? ''),
      // Bereits "980.00"-foermig, genau das Format, das parseCent versteht.
      total_price: r.TotalAmount ?? '',
      guest_last_name: lastName,
      guest_first_name: firstName,
      channel: r.Channel ?? '',
      notes: ''
    }
  })
}
