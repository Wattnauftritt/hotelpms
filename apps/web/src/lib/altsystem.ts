/**
 * Was vom KWHotel-Abzug an die Schnittstelle geht.
 *
 * Die `.bak` traegt die ganze Datenbank des Hauses: Kasse, Rechnungen,
 * Protokolle, Mitarbeiter. Gebraucht werden sechs Tabellen. Der Rest bleibt
 * im Browser -- was nicht verschickt wird, kann unterwegs und in keinem
 * Protokoll liegen bleiben, und die Anfrage wird ein Bruchteil so gross.
 *
 * Gelesen wird zeilenweise wie auf der Schnittstelle
 * (`platform/legacyImport/mysqlDump.ts`): ein Dump-Werkzeug schreibt jede
 * Anweisung auf eine Zeile, `CREATE TABLE` endet mit einer Zeile, die mit
 * `)` beginnt.
 */
export const KWHOTEL_TABELLEN = [
  'Rezerwacje', 'Klienci', 'RezerwKlient', 'Pokoje', 'rooms', 'hotels'] as const

export function auszugAusAbzug(text: string, tabellen: readonly string[]): string {
  const gesucht = new Set(tabellen)
  const out: string[] = []
  let inTabelle = false
  for (const zeile of text.split('\n')) {
    if (inTabelle) {
      out.push(zeile)
      if (zeile.startsWith(')')) inTabelle = false
      continue
    }
    const c = /^CREATE TABLE `([^`]+)`/.exec(zeile)
    if (c !== null) {
      if (gesucht.has(c[1]!)) { inTabelle = true; out.push(zeile) }
      continue
    }
    const i = /^INSERT INTO `([^`]+)`/.exec(zeile)
    if (i !== null && gesucht.has(i[1]!)) out.push(zeile)
  }
  return out.join('\n')
}

/** "0, 1, 2" -> [0, 1, 2]. Unlesbares faellt heraus, die Vorschau zeigt es. */
export function zahlenAus(text: string): number[] {
  return text.split(/[\s,;]+/).filter(s => /^\d+$/.test(s)).map(Number)
}

/** "ungereinigt, nicht gereinigt" -> zwei Namen. */
export function namenAus(text: string): string[] {
  return text.split(/[,;\n]+/).map(s => s.trim()).filter(s => s !== '')
}
