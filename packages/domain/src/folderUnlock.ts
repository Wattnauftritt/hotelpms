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
const MIN_NAME = 2
/**
 * Ein **Teil** eines Namens oeffnet erst ab vier Zeichen (Audit 19.10., M4).
 * Der ganze Nachname darf kuerzer sein -- "Li", "Ng", "Oz" muessen oeffnen --,
 * ein Teil aber ist nur dann ein Ausweis, wenn ihn nicht halb Europa traegt:
 * Mit "de" oder "da" stuende jede Mappe eines Gastes offen, in dessen Namen
 * die Silbe als eigenes Wort vorkommt.
 */
const MIN_TEIL = 4
/** Eine PLZ hat mindestens drei Zeichen (Island, Faeroeer); kuerzer ist geraten. */
const MIN_PLZ = 3

/**
 * Namenszusaetze und Partikel oeffnen nie als Teil, gleich wie lang: "von"
 * oeffnete jede Mappe eines "von Hohenberg" (Nachstellung im Audit
 * 19.10., M4). Sie sagen ueber den Gast nichts, was nicht viele mit ihm
 * teilen. Die Eintraege stehen in der Form von `folderNameKey`, also ohne
 * Akzente und Umlaute ("grafin" fuer "Graefin"). Als ganzer Nachname
 * oeffnen sie weiter: wer "De" heisst, gibt "De" ein.
 */
const PARTIKEL: ReadonlySet<string> = new Set([
  // deutsch und niederlaendisch
  'von', 'vom', 'van', 'der', 'den', 'des', 'dem', 'het', 'zu', 'zum', 'zur', 'ten', 'ter',
  'auf', 'aus', 'im', 'am', 'op', 'in', 't',
  // romanisch
  'de', 'da', 'di', 'do', 'du', 'la', 'le', 'lo', 'les', 'los', 'las', 'el', 'il', 'y', 'e',
  'del', 'dei', 'dos', 'das', 'della', 'delle', 'dello', 'degli', 'dalla', 'dal',
  'saint', 'sainte', 'sankt', 'san', 'santa', 'santo', 'sao',
  // arabisch, hebraeisch, skandinavisch und andere
  'al', 'ul', 'bin', 'bint', 'ibn', 'ben', 'bar', 'abu', 'ab', 'af', 'av', 'mac', 'mc',
  // Adelspraedikate und Zusaetze
  'freiherr', 'freifrau', 'freiin', 'graf', 'grafin', 'prinz', 'prinzessin', 'baron',
  'baronin', 'ritter', 'edler', 'edle', 'herzog', 'herzogin', 'furst', 'furstin',
  'junior', 'senior', 'jr', 'sr'
])

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

/**
 * Was zu einem Namen oeffnet: der ganze Name ohne Zwischenraum ab zwei
 * Zeichen, und jeder Teil ab vier, der kein Partikel ist. "Schmidt-Hansen"
 * ist auch "Schmidt" und "Hansen"; "von Hohenberg" ist "vonhohenberg" und
 * "Hohenberg", aber nicht "von".
 */
function teile(name: string): string[] {
  const k = folderNameKey(name)
  if (k === '') return []
  const ganz = k.replace(/ /g, '')
  const einzeln = k.split(' ').filter(t => t.length >= MIN_TEIL && !PARTIKEL.has(t))
  return ganz.length >= MIN_NAME ? [ganz, ...einzeln] : einzeln
}

/**
 * Passt die Eingabe zu einem der Nachnamen? Ganz oder als Teil, nie als
 * Anfang eines Teils: "Sch" soll nicht "Schmidt" oeffnen.
 */
export function folderNameMatches(eingabe: string, nachnamen: readonly string[]): boolean {
  const e = folderNameKey(eingabe).replace(/ /g, '')
  if (e.length < MIN_NAME) return false
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
 * Fehlversuche: zehn je Herkunft und Zimmer in einer Viertelstunde, dazu
 * zwanzig je Zimmer ueber alle Herkuenfte (Audit 19.10., N2). Danach wartet
 * die Herkunft beziehungsweise das Zimmer, bis die Viertelstunde um ist.
 *
 * Was das gegen das Durchprobieren der PLZ bringt, steht hier ohne
 * Beschoenigung: Es gibt rund 8 200 vergebene Postleitzahlen. Mit zehn
 * Versuchen je Viertelstunde sind das 960 am Tag, das ganze Feld ist von
 * einer Herkunft aus in gut acht Tagen durch, von mehreren entsprechend
 * schneller bis zur Grenze des Zimmers; nach Einwohnern geordnet trifft
 * man die meisten Gaeste frueher. Voraussetzung ist die Karte aus dem
 * Zimmer, und der Schaden nach einem Treffer ist begrenzt (Abreisetag,
 * Wuensche, Reinigungsverzicht). Sven haelt das Risiko deshalb fuer
 * vertretbar und hat am 19.10. entschieden, die PLZ als Schluessel zu
 * behalten (Audit 19.10., M4). Ein Gast, der sich vertippt, kommt nie in
 * die Naehe der Grenze.
 */
export const FOLDER_UNLOCK_MAX_FAILURES = 10
export const FOLDER_UNLOCK_MAX_FAILURES_ROOM = 20
export const FOLDER_UNLOCK_WINDOW_SECONDS = 15 * 60
