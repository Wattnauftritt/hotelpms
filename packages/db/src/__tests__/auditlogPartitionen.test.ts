import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'

/**
 * Die Partitionen des Audit-Protokolls sind kein Nebenweg zum Protokoll
 * (Befund H1, Dokument 25; Migration 0048).
 *
 * Warum das einen eigenen Test braucht, obwohl Dokument 26 die
 * Zeilenrichtlinie schon prueft: die Richtlinie sitzt an der Elterntabelle
 * und wirkt fuer Abfragen ueber sie. Eine Partition fuehrt eigene Rechte und
 * erbt **keine** Richtlinie. Gemessen an der laufenden Datenbank zeigte
 * dieselbe Rolle in derselben Transaktion ueber `audit_log` eine Zeile und
 * ueber `audit_log_2026_09` alle -- der Monatsname ist in einer Sekunde
 * geraten.
 *
 * Geprueft wird deshalb nicht die Richtlinie, sondern das Recht: an der
 * Partition hat die Anwendungsrolle nur INSERT. Und weil sich das jeden
 * Monat neu entscheidet, wird die Funktion mitgeprueft, die Partitionen
 * anlegt.
 */

let owner: Pool
let app: Pool
let fx: Fixture
let partition: string

const monat = (d: Date) =>
  `audit_log_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`

beforeAll(async () => { await ensureSchema(); owner = ownerPool(); app = appPool(5) })
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  partition = monat(new Date())
  // Eine Protokollzeile eines fremden Hauses: die ist es, die nicht
  // sichtbar werden darf.
  await owner.query(
    `INSERT INTO audit_log (property_id, account_id, table_name, row_key, action)
     VALUES ($1, $2, 'guest', '{"id":1}'::jsonb, 'UPDATE')`,
    [fx.propertyId + 100000, fx.accountId + 100000])
})

/** Kontext setzen und in derselben Transaktion arbeiten. */
async function alsMandant<T>(fn: (q: (sql: string) => Promise<unknown>) => Promise<T>)
: Promise<T> {
  const client = await app.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `SELECT set_config('app.account_ids',$1,true),
              set_config('app.property_ids',$2,true),
              set_config('app.user_id','',true)`,
      [String(fx.accountId), String(fx.propertyId)])
    const r = await fn((sql: string) => client.query(sql))
    await client.query('COMMIT')
    return r
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

describe('Partitionen des Audit-Protokolls', () => {
  it('laesst die Anwendungsrolle nicht unmittelbar auf einer Partition lesen', async () => {
    await expect(alsMandant(q => q(`SELECT count(*) FROM ${partition}`)))
      .rejects.toThrow(/permission denied/i)
  })

  it('laesst sie dort auch nichts aendern oder loeschen', async () => {
    /*
     * Haertegrad 1 an zwei Stellen, nicht an einer. Vor 0048 scheiterte das
     * hier am Trigger, nicht am Recht -- eine einzige Sicherung fuer eine
     * Regel, die CLAUDE.md als unverhandelbar fuehrt.
     */
    await expect(alsMandant(q => q(`DELETE FROM ${partition}`)))
      .rejects.toThrow(/permission denied/i)
    await expect(alsMandant(q => q(`UPDATE ${partition} SET action = 'INSERT'`)))
      .rejects.toThrow(/permission denied/i)
  })

  it('haelt das Lesen ueber die Elterntabelle offen und mandantengetrennt', async () => {
    /*
     * Der Gegenbeweis zum ersten Fall: entzogen ist der Nebenweg, nicht das
     * Lesen. Sonst waere die erste Route, die ein Pruefprotokoll anzeigt,
     * ohne Not verbaut.
     *
     * Geprueft wird an der fremden Zeile, nicht an einer Gesamtzahl: das
     * Anlegen des Hauses protokolliert selbst, und die eigenen Zeilen sind
     * hier genau die, die sichtbar sein sollen.
     */
    const r = await alsMandant(q => q(
      `SELECT count(*) FILTER (WHERE property_id = ${fx.propertyId + 100000})::int AS fremd,
              count(*)::int AS alle
         FROM audit_log`) as Promise<{ rows: Array<{ fremd: number; alle: number }> }>)
    expect(r.rows[0]!.fremd).toBe(0)
    expect(r.rows[0]!.alle).toBeGreaterThan(0)
  })

  it('entzieht die Rechte auch an einer neu angelegten Partition', async () => {
    /*
     * Der eigentliche Fallstrick: jede neue Monatspartition holt sich die
     * Standardrechte aus `ALTER DEFAULT PRIVILEGES` (0001) zurueck. Ein
     * einmaliger Entzug waere in einem Monat wieder wirkungslos, und
     * auffallen wuerde das erst an der Partition, in die dann geschrieben
     * wird.
     */
    await owner.query(`SELECT audit_log_ensure_partitions(13)`)
    const kuenftig = new Date()
    kuenftig.setUTCMonth(kuenftig.getUTCMonth() + 13)
    const name = monat(kuenftig)

    const da = await owner.query(
      `SELECT 1 FROM pg_class WHERE relname = $1`, [name])
    expect(da.rowCount, `${name} wurde nicht angelegt`).toBe(1)

    const rechte = await owner.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE grantee = 'hotelpms_app' AND table_name = $1
        ORDER BY privilege_type`, [name])
    expect(rechte.rows.map(r => r.privilege_type)).toEqual(['INSERT'])
  })
})
