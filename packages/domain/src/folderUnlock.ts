/**
 * Freischalten der Gaestemappe mit Nachname oder PLZ (Migration 0147).
 *
 * **Nachsichtig mit Absicht.** Wer am Telefon seinen Namen eintippt, schreibt
 * "Muller" fuer "Müller", "mueller" fuer "Müller", "garcia" fuer "García",
 * oder nur einen Teil von "Schmidt-Hansen". Abgewiesen zu werden, weil der
 * Meldeschein einen Akzent traegt, den die Tastatur nicht hat, ist die
 * Erfahrung, die eine Mappe unbenutzbar macht. Die Sicherheit kommt nicht
 * aus der Strenge des Vergleichs, sondern aus der Begrenzung der Versuche
 * und daraus, dass nur der Aufenthalt in **diesem** Zimmer zaehlt.
 *
 * Die Pruefung laeuft hier und nicht in SQL: dort fehlt `unaccent`, und eine
 * zweite Fassung derselben Regel liefe auseinander.
 */

/** Kuerzer ist kein Name, sondern ein Rateversuch ("a", "s"). */
const MIN_TEIL = 2
/** Eine PLZ hat mindestens drei Zeichen (Island, Faeroeer); kuerzer ist geraten. */
const MIN_PLZ = 3

/**
 * Kleinbuchstaben ohne Akzente, ß als ss, und die deutsche Umschrift der
 * Umlaute zurueckgefuehrt: "Müller", "Mueller" und "Muller" werden gleich.
 * Beide Seiten gehen durch dieselbe Funktion; dass "ue" in "Manuel" dabei
 * zu "u" wird, schadet nicht, weil der Meldeschein es genauso verliert.
 */
export function folderNameKey(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
    .replace(/æ/g, 'a').replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** Die Teile eines Namens: "Schmidt-Hansen" ist auch "Schmidt" und "Hansen". */
function teile(name: string): string[] {
  const k = folderNameKey(name)
  if (k === '') return []
  const einzeln = k.split(' ').filter(t => t.length >= MIN_TEIL)
  return [k.replace(/ /g, ''), ...einzeln]
}

/**
 * Passt die Eingabe zu einem der Nachnamen? Ganz oder als Teil, nie als
 * Anfang eines Teils: "Sch" soll nicht "Schmidt" oeffnen.
 */
export function folderNameMatches(eingabe: string, nachnamen: readonly string[]): boolean {
  const e = folderNameKey(eingabe).replace(/ /g, '')
  if (e.length < MIN_TEIL) return false
  return nachnamen.some(n => teile(n).includes(e))
}

/** PLZ ohne Leerzeichen und Bindestrich, gross: "nw1 6xe" ist "NW16XE". */
export function folderPostalKey(s: string): string {
  return s.normalize('NFKC').toUpperCase().replace(/[\s-]+/g, '')
}

export function folderPostalMatches(eingabe: string, plz: readonly string[]): boolean {
  const e = folderPostalKey(eingabe)
  if (e.length < MIN_PLZ) return false
  return plz.some(p => folderPostalKey(p) === e)
}

/**
 * Fehlversuche je Zimmer: zehn in einer Viertelstunde, dann wartet das
 * Zimmer, bis die Viertelstunde um ist. Eine PLZ hat fuenf Ziffern; mit
 * zehn Versuchen je Viertelstunde braucht das Durchprobieren im Mittel
 * Wochen, ein Aufenthalt dauert Tage. Ein Gast, der sich vertippt, kommt
 * nie in die Naehe.
 */
export const FOLDER_UNLOCK_MAX_FAILURES = 10
export const FOLDER_UNLOCK_WINDOW_SECONDS = 15 * 60
