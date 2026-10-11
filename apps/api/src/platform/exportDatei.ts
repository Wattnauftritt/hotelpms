import { open, unlink, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { FastifyReply } from 'fastify'
import type { PoolClient } from '@hotelpms/db'

/**
 * Zeilen je `FETCH`. Gemessen am Saatlauf (ein Haus, drei Jahre, 151 MB
 * Export): bei 2000 haelt der laengste Stapel die Ereignisschleife unter
 * 50 ms an, bei 5000 waren es gut 100 ms, bei wenig Gewinn an Laufzeit.
 * Der Preis sind rund 280 Anweisungen statt 27; der Mandantenexport steht
 * damit ueber `DB_QUERY_WARN` im Protokoll, und das ist fuer einen Lauf
 * je Vertragsende die richtige Auskunft, kein Fehlalarm.
 */
export const EXPORT_STAPEL = 2000

/**
 * Ein grosser JSON-Export, der nicht im Speicher entsteht (Performance-Audit
 * 11.10.2026, Befund 12).
 *
 * **Warum eine Datei und nicht gleich in die Antwort.** Direkt in die
 * Antwort zu streamen hiesse, die Transaktion so lange offen zu halten, wie
 * der Empfaenger zum Lesen braucht. Ein langsamer Browser haelt dann eine
 * Verbindung des Pools, einen Snapshot, der `VACUUM` aufhaelt, und reisst
 * zwischen zwei `FETCH` die zehn Sekunden von
 * `idle_in_transaction_session_timeout` -- der Export bricht mittendrin ab,
 * mit einer halben Datei beim Empfaenger. Die Datei entkoppelt beides: die
 * Datenbank liest so schnell, wie die Platte schreibt, gibt die Verbindung
 * zurueck, und erst danach bestimmt der Empfaenger das Tempo.
 *
 * **Warum die Datei sofort geloescht wird.** Der Export enthaelt Gastdaten.
 * Der Name verschwindet gleich nach dem Anlegen; geschrieben und gelesen
 * wird ueber den offenen Deskriptor. Stirbt der Prozess mittendrin, bleibt
 * nichts auf der Platte, das jemand finden oder vergessen koennte.
 */
export class JsonExportDatei {
  private cursoren = 0

  private constructor (private readonly fh: FileHandle) {}

  static async anlegen(): Promise<JsonExportDatei> {
    const pfad = join(tmpdir(), `staygrid-export-${randomUUID()}.json`)
    const fh = await open(pfad, 'wx+', 0o600)
    try {
      await unlink(pfad)
    } catch (err) {
      await fh.close()
      throw err
    }
    return new JsonExportDatei(fh)
  }

  /** Haengt Text an. Jeder Aufruf gibt die Ereignisschleife frei. */
  async schreibe(text: string): Promise<void> {
    await this.fh.write(text)
  }

  /** Haengt einen Wert so an, wie `JSON.stringify` ihn im Ganzen schriebe. */
  async wert(v: unknown): Promise<void> {
    await this.schreibe(JSON.stringify(v))
  }

  /**
   * Schreibt das Ergebnis einer Abfrage als JSON-Feld, stapelweise ueber
   * einen Cursor, und gibt die Zeilenzahl zurueck.
   *
   * Ein Cursor statt `LIMIT/OFFSET`: derselbe Snapshot, eine Ausfuehrung,
   * kein erneutes Ueberspringen. Er lebt in der Transaktion des Aufrufers
   * und damit unter dessen Mandantenkontext; die Zeilenrichtlinie greift wie
   * bei jeder anderen Abfrage. Die Zeilen sind dieselben Objekte, die
   * `client.query` lieferte -- dieselben Typumwandler --, und je Zeile
   * `JSON.stringify` ergibt deshalb byteweise dasselbe wie vorher das
   * Ganze.
   */
  async feld(client: PoolClient, sql: string, params: unknown[],
             stapel = EXPORT_STAPEL): Promise<number> {
    // Kein CLOSE: ein Cursor ohne WITH HOLD endet mit der Transaktion, und
    // die Runde je Tabelle sparen wir uns. Deshalb je Feld ein eigener Name.
    const cursor = `staygrid_export_${++this.cursoren}`
    await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${sql}`, params)
    const hole = (): Promise<unknown[]> =>
      client.query(`FETCH ${stapel} FROM ${cursor}`).then(r => r.rows)
    let anzahl = 0
    await this.schreibe('[')
    let rows = await hole()
    while (rows.length > 0) {
      /*
       * Der naechste Stapel ist schon unterwegs, waehrend dieser
       * serialisiert und geschrieben wird: die Datenbank liest, waehrend
       * Node rechnet, statt dass beide abwechselnd warten. Es ist immer nur
       * eine Anfrage auf dem Client offen -- die vorige ist beantwortet.
       * Ein kurzer Stapel ist der letzte; das spart die leere Runde.
       */
      const naechste = rows.length < stapel ? null : hole()
      // Ein abgelehntes Vorausholen darf nicht unbehandelt liegen bleiben,
      // falls das Schreiben zuerst scheitert; geworfen wird es unten.
      naechste?.catch(() => undefined)
      const teil = rows.map(r => JSON.stringify(r)).join(',')
      await this.schreibe(anzahl === 0 ? teil : ',' + teil)
      anzahl += rows.length
      rows = naechste === null ? [] : await naechste
    }
    await this.schreibe(']')
    return anzahl
  }

  /**
   * Gibt die Datei als Lesestrom ab. Der Strom schliesst den Deskriptor am
   * Ende oder beim Abbruch des Empfaengers; danach ist die Datei weg.
   */
  async lesen(): Promise<{ strom: Readable; bytes: number }> {
    const { size } = await this.fh.stat()
    return { strom: this.fh.createReadStream({ start: 0, autoClose: true }), bytes: size }
  }

  /** Fuer den Fehlerfall, bevor `lesen` uebernommen hat. */
  async verwerfen(): Promise<void> {
    try { await this.fh.close() } catch { /* schon zu */ }
  }
}

/**
 * Fuellt eine Exportdatei und sendet sie. `fuellen` laeuft typischerweise in
 * `tx(...)`; erst nach dem Commit wird gesendet, damit die Verbindung nicht
 * auf den Empfaenger wartet.
 */
export async function sendeJsonExport(
  reply: FastifyReply, fuellen: (datei: JsonExportDatei) => Promise<void>
): Promise<FastifyReply> {
  const datei = await JsonExportDatei.anlegen()
  let strom: Readable
  let bytes: number
  try {
    await fuellen(datei)
    ;({ strom, bytes } = await datei.lesen())
  } catch (err) {
    await datei.verwerfen()
    throw err
  }
  reply.header('content-type', 'application/json; charset=utf-8')
  reply.header('content-length', bytes)
  return reply.send(strom)
}
