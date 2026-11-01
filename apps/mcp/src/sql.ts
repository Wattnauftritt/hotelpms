/**
 * Was `sql_lesen` annimmt und was davon ins Protokoll geht.
 *
 * Die Sicherheit liegt nicht hier, sondern in der Datenbank: die Rolle
 * `hotelpms_mcp` sieht nur die Sichten in `mcp`, und jede Abfrage laeuft in
 * einer Transaktion `READ ONLY` mit Zeitgrenze. Diese Pruefung ist die
 * zweite Linie und fuer verstaendliche Meldungen da -- eine Abfrage, die
 * hier durchkaeme, scheiterte dort.
 */

export const SQL_MAX_ZEICHEN = 8000
export const SQL_MAX_ZEILEN = 500

/**
 * Nur eine Abfrage, die mit SELECT oder WITH beginnt. Abgewiesen wird
 * ausserdem, was die Verbindung der Transaktion umstellen koennte:
 * `set_config` und die Unicode-Schreibweise, mit der sich der Name
 * verkleiden liesse. Die Klartext-Pruefung liest die Verbindung aus
 * `mcp.verbindung` -- wer sie umstellt, liest unter fremder Freigabe.
 */
export function sqlPruefen(sql: unknown): string {
  if (typeof sql !== 'string') throw new SqlAbgewiesen('Die Abfrage fehlt.')
  const s = sql.trim().replace(/;\s*$/, '')
  if (s === '') throw new SqlAbgewiesen('Die Abfrage ist leer.')
  if (s.length > SQL_MAX_ZEICHEN) {
    throw new SqlAbgewiesen(`Die Abfrage ist laenger als ${SQL_MAX_ZEICHEN} Zeichen.`)
  }
  if (!/^(select|with|values|table)\b/i.test(s)) {
    throw new SqlAbgewiesen('Nur lesende Abfragen: SELECT, WITH, VALUES oder TABLE.')
  }
  if (/set_config|\bu&|pg_sleep|\bcopy\b|\blo_|dblink|pg_read/i.test(s)) {
    throw new SqlAbgewiesen('Diese Funktion ist im Claude-Zugang nicht erlaubt.')
  }
  if (s.includes(';')) {
    throw new SqlAbgewiesen('Nur eine Anweisung je Aufruf.')
  }
  return s
}

export class SqlAbgewiesen extends Error {}

/**
 * Fuers Protokoll: Zeichenketten ersetzen, Zahlen und Namen bleiben. Ein
 * `WHERE last_name = 'Petersen'` soll dort als Suche nach einem Nachnamen
 * stehen, nicht als Suche nach Herrn Petersen -- dieselbe Regel wie beim
 * Protokoll der API (Befund B2, Dokument 25).
 */
export function fuersProtokoll(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "'…'")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "'…'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000)
}
