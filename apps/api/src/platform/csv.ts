/**
 * CSV-Leser nach RFC 4180, mit den Zugestaendnissen, die deutsche
 * Tabellenkalkulationen erzwingen: Semikolon als Trennzeichen und eine
 * moegliche Byte-Reihenfolge-Markierung am Anfang.
 *
 * Bewusst selbst geschrieben und nicht als Abhaengigkeit: das Format hat
 * genau drei Regeln, und jede Bibliothek dafuer bringt eine Angriffsflaeche
 * mit, die groesser ist als diese Datei.
 */
export interface CsvOptions {
  delimiter?: string
  /** Hoechstzahl Datenzeilen. Schuetzt vor einer Datei, die den Speicher fuellt. */
  maxRows?: number
}

export class CsvError extends Error {
  constructor(readonly line: number, message: string) {
    super(`Zeile ${line}: ${message}`)
    this.name = 'CsvError'
  }
}

/** Erkennt das Trennzeichen an der Kopfzeile. Semikolon oder Komma. */
export function detectDelimiter(text: string): string {
  const kopf = text.slice(0, text.search(/\r?\n/) === -1 ? text.length
    : text.search(/\r?\n/))
  const semikolon = (kopf.match(/;/g) ?? []).length
  const komma = (kopf.match(/,/g) ?? []).length
  return semikolon >= komma ? ';' : ','
}

export function parseCsv(
  input: string, opts: CsvOptions = {}
): { header: string[]; rows: string[][] } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const delimiter = opts.delimiter ?? detectDelimiter(text)
  const maxRows = opts.maxRows ?? 50_000

  const rows: string[][] = []
  let feld = ''
  let zeile: string[] = []
  let inQuotes = false
  let zeilenNummer = 1

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { feld += '"'; i++ }
        else inQuotes = false
      } else {
        if (c === '\n') zeilenNummer++
        feld += c
      }
      continue
    }
    if (c === '"') {
      if (feld !== '') throw new CsvError(zeilenNummer, 'Anfuehrungszeichen mitten im Feld')
      inQuotes = true
    } else if (c === delimiter) {
      zeile.push(feld); feld = ''
    } else if (c === '\r') {
      // Wird vom folgenden \n behandelt.
    } else if (c === '\n') {
      zeile.push(feld); feld = ''
      if (zeile.length > 1 || zeile[0] !== '') rows.push(zeile)
      zeile = []
      zeilenNummer++
      if (rows.length > maxRows + 1) throw new CsvError(zeilenNummer, 'Datei zu gross')
    } else {
      feld += c
    }
  }
  if (inQuotes) throw new CsvError(zeilenNummer, 'Anfuehrungszeichen nicht geschlossen')
  zeile.push(feld)
  if (zeile.length > 1 || zeile[0] !== '') rows.push(zeile)

  const header = rows.shift()
  if (header === undefined) throw new CsvError(1, 'Datei ist leer')
  return { header: header.map(h => h.trim()), rows }
}

/** Bildet Zeilen auf Objekte ab und meldet fehlende Pflichtspalten. */
export function toRecords(
  header: string[], rows: string[][], required: readonly string[]
): Array<Record<string, string>> {
  const fehlend = required.filter(r => !header.includes(r))
  if (fehlend.length > 0) {
    throw new CsvError(1, `Fehlende Spalten: ${fehlend.join(', ')}`)
  }
  return rows.map(r => {
    const o: Record<string, string> = {}
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim() })
    return o
  })
}
