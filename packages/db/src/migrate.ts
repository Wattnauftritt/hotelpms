import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { dbUrl } from './config.js'

const here = dirname(fileURLToPath(import.meta.url))
// src/ im Quellbaum, dist/ im Build: Migrationen liegen eine Ebene darueber.
const migrationsDir = join(here, '..', 'migrations')

export interface MigrationResult {
  applied: string[]
  skipped: number
}

/** Migrationen laufen unter der Eigentuemerrolle, nie unter der Anwendungsrolle (W2). */
export async function migrate(log: (m: string) => void = () => {}): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: dbUrl('owner') })
  await client.connect()
  const applied: string[] = []
  let skipped = 0
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`)
    const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort()
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migration')).rows.map(r => r.name)
    )
    for (const file of files) {
      if (done.has(file)) { skipped++; continue }
      const sql = await readFile(join(migrationsDir, file), 'utf8')
      log(`  anwenden: ${file}`)
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        applied.push(file)
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${file} fehlgeschlagen: ${(err as Error).message}`)
      }
    }
    /*
     * Die Sichten des Claude-Zugangs nach jedem Lauf neu erzeugen (Migration
     * 0222, Dokument 38), auch ohne neue Migration. Sonst fehlte eine neue
     * Spalte dort bis zur naechsten Aenderung an 0222 -- also fuer immer --,
     * und eine Rolle, die erst nach der Migration angelegt wurde, bekaeme
     * nie ihre Rechte.
     */
    const { rows } = await client.query<{ da: boolean }>(
      `SELECT to_regprocedure('mcp_views_refresh()') IS NOT NULL AS da`)
    if (rows[0]?.da === true) await client.query('SELECT mcp_views_refresh()')
  } finally {
    await client.end()
  }
  return { applied, skipped }
}
