import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ensureSchema, appPool } from '@hotelpms/testing'
import { withTransaction, SYSTEM_CONTEXT, type Pool } from '@hotelpms/db'
import { JsonExportDatei } from '../platform/exportDatei.js'

/**
 * Die Exportdatei hinter Mandanten- und GoBD-Export (Performance-Audit
 * 11.10.2026, Befund 12).
 *
 * Was hier festgehalten wird, ist die Zusage an jeden Leser des Exports:
 * stapelweise geschrieben ergibt byteweise dasselbe wie vorher das eine
 * `JSON.stringify` -- auch an den Stapelgrenzen, wo ein Komma fehlen oder
 * doppelt stehen koennte.
 */

let pool: Pool

beforeAll(async () => {
  await ensureSchema()
  pool = appPool(2)
})
afterAll(async () => { await pool.end() })

const ABFRAGE = `SELECT g AS n, 'Zeile;"' || g || E'"\\n' AS text,
                        (DATE '2026-10-01' + g)::text AS datum,
                        jsonb_build_object('g', g) AS nutzlast,
                        now() AS zeitpunkt
                   FROM generate_series(1, $1::int) g ORDER BY g`

async function alsText(datei: JsonExportDatei): Promise<string> {
  const { strom, bytes } = await datei.lesen()
  const teile: Buffer[] = []
  for await (const t of strom) teile.push(t as Buffer)
  const text = Buffer.concat(teile)
  expect(text.length).toBe(bytes)
  return text.toString('utf8')
}

async function eigeneDateien(): Promise<string[]> {
  return (await readdir(tmpdir())).filter(n => n.startsWith('staygrid-export-'))
}

describe('JsonExportDatei', () => {
  it.each([
    ['keine Zeile', 0],
    ['weniger als ein Stapel', 2],
    ['genau zwei Stapel', 6],
    ['ein angebrochener dritter Stapel', 7]
  ])('schreibt %s wie JSON.stringify', async (_name, zeilen) => {
    const datei = await JsonExportDatei.anlegen()
    const erwartet = await withTransaction(pool, SYSTEM_CONTEXT, async client => {
      const ganz = await client.query(ABFRAGE, [zeilen])
      await datei.schreibe('{"a":')
      const anzahl = await datei.feld(client, ABFRAGE, [zeilen], 3)
      await datei.schreibe(',"b":')
      // Zwei Felder in derselben Transaktion: der Cursor des ersten darf
      // dem zweiten nicht im Weg stehen.
      await datei.feld(client, ABFRAGE, [zeilen], 3)
      await datei.schreibe('}')
      expect(anzahl).toBe(zeilen)
      return JSON.stringify({ a: ganz.rows, b: ganz.rows })
    })
    expect(await alsText(datei)).toBe(erwartet)
  })

  /**
   * Der Export enthaelt Gastdaten. Eine Datei, die nach dem Export liegen
   * bleibt -- oder nach einem Absturz mittendrin --, findet irgendwann
   * jemand, der sie nicht sehen sollte.
   */
  it('laesst keinen Dateinamen im Temp-Verzeichnis zurueck', async () => {
    const vorher = await eigeneDateien()
    const datei = await JsonExportDatei.anlegen()
    await datei.schreibe('[1]')
    expect(await eigeneDateien()).toEqual(vorher)
    expect(await alsText(datei)).toBe('[1]')
  })

  it('bricht bei einem Fehler ab und rollt die Transaktion zurueck', async () => {
    const datei = await JsonExportDatei.anlegen()
    await expect(withTransaction(pool, SYSTEM_CONTEXT, client =>
      datei.feld(client, 'SELECT 1 / (g - 3) FROM generate_series(1, 5) g', [], 1)))
      .rejects.toThrow(/division by zero/)
    await datei.verwerfen()
  })
})
