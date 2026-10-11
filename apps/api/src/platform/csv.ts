import type { MessageKey, MessageParams } from '@hotelpms/contracts'

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
  /** Hoechstzahl Spalten je Zeile, Vorgabe `MAX_SPALTEN`. */
  maxColumns?: number
}

/**
 * Hoechstens so viele Spalten je Zeile.
 *
 * Ohne Grenze waren 200 000 leere Spalten in 199 KiB neun Sekunden Rechenzeit
 * im einzigen API-Prozess, weil `toRecords` jede Zeile gegen die ganze
 * Kopfzeile abbildet (Befund M9, Audit 11.10.2026). Der eigene Import
 * braucht ein Dutzend Spalten, ein voller Export aus hotline, HS/3 oder
 * protel einige Dutzend; 200 laesst dafuer reichlich Luft und haelt den
 * schlimmsten Fall bei Zeilen mal 200.
 */
export const MAX_SPALTEN = 200

export class CsvError extends Error {
  /**
   * `key` ist gesetzt, wo die Meldung schon im Katalog steht. Dann ist
   * `message` der Schluessel, wie bei `DumpFormatError`, und die Route
   * reicht ihn mit den Werten an `Errors.unprocessable` weiter; sonst ist
   * es noch der deutsche Satz.
   */
  constructor(readonly line: number, message: string,
              readonly key?: MessageKey, readonly params?: MessageParams) {
    super(key ?? `Zeile ${line}: ${message}`)
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
  const maxColumns = opts.maxColumns ?? MAX_SPALTEN

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
      // Schon beim Lesen abbrechen, nicht erst nach der Zeile: sonst haelt
      // eine einzige Zeile aus Trennzeichen den Speicher voll, bevor die
      // Pruefung sie sieht.
      if (zeile.length >= maxColumns) {
        throw new CsvError(zeilenNummer, '', 'import.csv.tooManyColumns',
                           { line: zeilenNummer, max: maxColumns })
      }
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

// ------------------------------------------------------------- Schreiben

/** Eine reine Zahl, auch mit Vorzeichen und Dezimalkomma: `-12,50`, `+3`, `0.5`. */
const REINE_ZAHL = /^[+-]?\d+(?:[.,]\d+)?$/

/**
 * Ein Feld, das eine Tabellenkalkulation nicht als Formel startet.
 *
 * Unsere CSV-Dateien gehen an Menschen mit Excel oder LibreOffice: das
 * Gaesteverzeichnis an die Gemeinde, der DATEV-Stapel zuerst an den
 * Steuerberater, die Arbeitszeit an die Lohnbuchhaltung. Ein Gast, der im
 * Online-Check-in `=HYPERLINK(...)` als Nachnamen eintraegt, braechte sonst
 * eine Formel auf deren Rechner (Befund M10, Audit 11.10.2026). Entschaerft
 * wird, was mit `= + - @`, Tabulator oder Wagenruecklauf beginnt -- die
 * Zeichen, mit denen Excel und LibreOffice eine Zelle als Formel lesen --,
 * durch ein vorangestelltes Hochkomma (das uebliche Vorgehen nach OWASP).
 * Das Hochkomma bleibt im Text sichtbar; vor einem Namen, der mit einem
 * Gleichheitszeichen beginnt, ist das der kleinere Schaden.
 *
 * **Eine reine Zahl ist keine Formel** und bleibt, wie sie ist. Sonst stuende
 * im Kassenbuch-Export vor jedem `-12,50` ein Hochkomma, und eine negative
 * Korrektur in der Arbeitszeit waere Text statt Zahl -- DATEV laese den
 * Betrag nicht mehr, die Lohnbuchhaltung koennte nicht mehr summieren.
 *
 * Idempotent: ein schon entschaerftes Feld beginnt mit dem Hochkomma und
 * bekommt kein zweites. Darauf verlassen sich die DATEV-Exporte, die einen
 * Buchungstext vor dem Kuerzen auf 60 Zeichen entschaerfen.
 */
export function formelsicher(s: string): string {
  if (!/^[=+\-@\t\r]/.test(s) || REINE_ZAHL.test(s)) return s
  return `'${s}`
}

/**
 * CSV nach RFC 4180 zum Herunterladen. Semikolon, weil deutsche
 * Tabellenkalkulationen das erwarten. Jedes Textfeld geht durch
 * `formelsicher`, hier und nicht an jeder Route: ein Export, der die
 * Pruefung selbst tragen muss, vergisst sie -- so stand es im
 * Gaesteverzeichnis, waehrend die Arbeitszeit sie hatte.
 */
export function writeCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  const feld = (v: string | number | null): string => {
    if (v === null) return ''
    const s = typeof v === 'number' ? String(v) : formelsicher(v)
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return rows.map(r => r.map(feld).join(';')).join('\r\n') + '\r\n'
}
