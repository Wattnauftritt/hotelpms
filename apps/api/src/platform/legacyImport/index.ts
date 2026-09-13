import { parseHotlineReservations } from './hotline.js'
import { parseHs3Reservations } from './hs3.js'
import { parseProtelReservations } from './protel.js'

export type LegacySystem = 'hotline' | 'hs3' | 'protel'

/**
 * Jeder Adapter uebersetzt nur die Spalten und Formen seines Altsystems in
 * die Zeilenform, die routes/import.ts fuer Reservierungen ohnehin schon
 * versteht (external_reference, category_code, arrival, departure, ...).
 * Die eigentliche Fachpruefung - Kategorie vorhanden, Datum gueltig, Kontingent
 * frei, externe Nummer schon gesehen - bleibt dort und laeuft fuer alle drei
 * Systeme gleich; ein Adapter erfindet keine eigene zweite Fehlermeldung.
 */
export const LEGACY_ADAPTERS: Record<LegacySystem, (raw: string) => Array<Record<string, string>>> = {
  hotline: parseHotlineReservations,
  hs3: parseHs3Reservations,
  protel: parseProtelReservations
}

export { CsvError as LegacyFormatError } from '../csv.js'
