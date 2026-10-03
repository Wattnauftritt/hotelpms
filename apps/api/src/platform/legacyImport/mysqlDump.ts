/**
 * Liest Tabellen aus einem Textabzug von MySQL oder MariaDB (`mysqldump`,
 * `mariadb-dump`), ohne ihn auszufuehren.
 *
 * **Warum nicht einfach einspielen.** Der Abzug ist SQL eines fremden
 * Systems. Ihn gegen eine Datenbank laufen zu lassen hiesse, Anweisungen
 * aus einer hochgeladenen Datei auszufuehren -- und StayGrid hat keine
 * MariaDB, in die er gehoerte. Gelesen werden deshalb nur zwei Formen:
 * `CREATE TABLE` fuer die Spaltennamen und `INSERT INTO ... VALUES` fuer die
 * Werte. Alles andere ueberspringt der Leser, ohne es zu deuten.
 *
 * **Nur die verlangten Tabellen.** Ein KWHotel-Abzug traegt auch Kasse,
 * Protokolle und Rechnungen; was niemand braucht, wird nicht in Werte
 * zerlegt und landet in keinem Speicher.
 *
 * **Zeilenweise.** Ein Dump-Werkzeug schreibt jede Anweisung auf eine Zeile
 * und maskiert Zeilenumbrueche in Zeichenketten als `\n`. Eine Zeile, die
 * mit `INSERT INTO` beginnt, ist deshalb genau eine Anweisung.
 */

export class DumpFormatError extends Error {
  constructor(message: string, readonly params: Record<string, string | number> = {}) {
    super(message)
    this.name = 'DumpFormatError'
  }
}

export interface DumpTable {
  columns: string[]
  /** Werte als Text, wie sie im Abzug stehen; `NULL` wird zu `null`. */
  rows: Array<Array<string | null>>
}

const CREATE = /^CREATE TABLE `([^`]+)` \($/
const SPALTE = /^\s+`([^`]+)`\s/
const INSERT = /^INSERT INTO `([^`]+)`(?: \(([^)]*)\))? VALUES\s*/

export function readDumpTables(
  text: string, wanted: readonly string[]
): Map<string, DumpTable> {
  const gesucht = new Set(wanted)
  const out = new Map<string, DumpTable>()
  let offen: { name: string; columns: string[] } | null = null

  let start = 0
  while (start < text.length) {
    let ende = text.indexOf('\n', start)
    if (ende === -1) ende = text.length
    const zeile = text.slice(start, ende).replace(/\r$/, '')
    start = ende + 1

    if (offen !== null) {
      if (zeile.startsWith(')')) {
        out.set(offen.name, { columns: offen.columns, rows: out.get(offen.name)?.rows ?? [] })
        offen = null
        continue
      }
      const s = SPALTE.exec(zeile)
      if (s !== null) offen.columns.push(s[1]!)
      continue
    }

    const c = CREATE.exec(zeile)
    if (c !== null) {
      if (gesucht.has(c[1]!)) offen = { name: c[1]!, columns: [] }
      continue
    }

    if (!zeile.startsWith('INSERT INTO')) continue
    const i = INSERT.exec(zeile)
    if (i === null || !gesucht.has(i[1]!)) continue
    const name = i[1]!
    let tabelle = out.get(name)
    if (i[2] !== undefined) {
      // `--complete-insert`: die Spalten stehen an der Anweisung selbst.
      const spalten = i[2].split(',').map(s => s.trim().replace(/^`|`$/g, ''))
      if (tabelle === undefined) {
        tabelle = { columns: spalten, rows: [] }
        out.set(name, tabelle)
      } else if (tabelle.columns.join(',') !== spalten.join(',')) {
        throw new DumpFormatError('import.dump.columnsDiffer', { table: name })
      }
    }
    if (tabelle === undefined) {
      throw new DumpFormatError('import.dump.insertBeforeCreate', { table: name })
    }
    leseWerte(zeile, i[0].length, tabelle, name)
  }
  return out
}

const ESCAPES: Record<string, string> = {
  n: '\n', r: '\r', t: '\t', '0': '\0', Z: '\x1a', b: '\b'
}

/** Zerlegt `(...),(...);` in Zeilen. Wirft bei allem, was nicht in diese Form passt. */
function leseWerte(s: string, pos: number, tabelle: DumpTable, name: string): void {
  const n = s.length
  const kaputt = (): never => {
    throw new DumpFormatError('import.dump.unreadableInsert', { table: name })
  }
  let i = pos
  for (;;) {
    while (i < n && (s[i] === ' ' || s[i] === ',')) i++
    if (i >= n) kaputt()
    if (s[i] === ';') return
    if (s[i] !== '(') kaputt()
    i++
    const zeile: Array<string | null> = []
    for (;;) {
      while (s[i] === ' ') i++
      const c = s[i]
      if (c === "'") {
        i++
        let wert = ''
        let von = i
        for (;;) {
          if (i >= n) kaputt()
          const z = s[i]
          if (z === '\\') {
            wert += s.slice(von, i)
            const e = s[i + 1]
            if (e === undefined) kaputt()
            wert += ESCAPES[e!] ?? e
            i += 2
            von = i
          } else if (z === "'") {
            if (s[i + 1] === "'") {
              wert += s.slice(von, i) + "'"
              i += 2
              von = i
            } else {
              wert += s.slice(von, i)
              i++
              break
            }
          } else {
            i++
          }
        }
        zeile.push(wert)
      } else {
        const von = i
        while (i < n && s[i] !== ',' && s[i] !== ')') i++
        if (i >= n) kaputt()
        const roh = s.slice(von, i).trim()
        if (roh === 'NULL') zeile.push(null)
        else {
          // Bitfelder (`b'1'`) als Ziffer, alles andere so, wie es dasteht.
          const bit = /^b'([01]+)'$/.exec(roh)
          zeile.push(bit !== null ? String(parseInt(bit[1]!, 2)) : roh)
        }
      }
      while (s[i] === ' ') i++
      if (s[i] === ',') { i++; continue }
      if (s[i] === ')') { i++; break }
      kaputt()
    }
    if (zeile.length !== tabelle.columns.length) {
      throw new DumpFormatError('import.dump.columnCount', { table: name })
    }
    tabelle.rows.push(zeile)
  }
}

/** Die Zeilen einer Tabelle als Objekte, mit Pruefung der benoetigten Spalten. */
export function tableRecords(
  tables: Map<string, DumpTable>, name: string, required: readonly string[]
): Array<Record<string, string | null>> {
  const t = tables.get(name)
  if (t === undefined) throw new DumpFormatError('import.dump.tableMissing', { table: name })
  const fehlt = required.filter(c => !t.columns.includes(c))
  if (fehlt.length > 0) {
    throw new DumpFormatError('import.dump.columnMissing',
      { table: name, columns: fehlt.join(', ') })
  }
  return t.rows.map(r => {
    const o: Record<string, string | null> = {}
    t.columns.forEach((c, k) => { o[c] = r[k] ?? null })
    return o
  })
}
