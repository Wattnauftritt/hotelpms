import { parseCsv, toRecords } from '../csv.js'

/**
 * HS/3 exportiert pipe-getrennt, mit kompakten JJJJMMTT-Daten und dem
 * Gesamtbetrag als ganze Cent (aeltere Systeme rechnen intern oft in Cent
 * und geben das beim Export unveraendert aus). Wie bei hotline gibt es
 * keine veroeffentlichte Formatbeschreibung (Dokument 05, Abschnitt 6);
 * das ist eine begruendete Annahme, kein bestaetigtes Format.
 *
 * Erwartete Spalten: RES_ID|RM_TYPE|ARR|DEP|GUEST_NAME|AMOUNT_CENT|SRC
 * GUEST_NAME ist "Nachname, Vorname" in einem Feld.
 */
const REQUIRED = ['RES_ID', 'RM_TYPE', 'ARR', 'DEP'] as const

/** JJJJMMTT -> ISO. Unlesbares bleibt unveraendert (siehe hotline.ts). */
function isoFromKompakt(v: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  return m === null ? v : `${m[1]}-${m[2]}-${m[3]}`
}

/** Ganze Cent als Zeichenkette in die Dezimalform, die parseCent erwartet.
 *  Unlesbares bleibt unveraendert, aus demselben Grund wie beim Datum. */
function priceFromCent(v: string): string {
  if (!/^\d+$/.test(v)) return v
  const cent = Number(v)
  return (cent / 100).toFixed(2)
}

function splitName(v: string): { lastName: string; firstName: string } {
  const [nachname, vorname] = v.split(',', 2).map(s => s.trim())
  return { lastName: nachname ?? '', firstName: vorname ?? '' }
}

export function parseHs3Reservations(raw: string): Array<Record<string, string>> {
  const { header, rows } = parseCsv(raw, { delimiter: '|' })
  const records = toRecords(header, rows, REQUIRED)
  return records.map(r => {
    const { lastName, firstName } = splitName(r.GUEST_NAME ?? '')
    return {
      external_reference: `hs3:${r.RES_ID}`,
      category_code: r.RM_TYPE ?? '',
      arrival: isoFromKompakt(r.ARR ?? ''),
      departure: isoFromKompakt(r.DEP ?? ''),
      total_price: priceFromCent(r.AMOUNT_CENT ?? ''),
      guest_last_name: lastName,
      guest_first_name: firstName,
      channel: r.SRC ?? '',
      notes: ''
    }
  })
}
