import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createPool, migrate, type Pool } from '@hotelpms/db'

const CATALOG_MIGRATION = fileURLToPath(
  new URL('../../db/migrations/0003_permissions.sql', import.meta.url))

let migrated = false

/** Baut das Testschema einmal je Lauf neu auf. */
export async function resetSchema(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await client.connect()
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  await client.query('GRANT USAGE ON SCHEMA public TO hotelpms_app, hotelpms_readonly')
  await client.end()
  await migrate()
  migrated = true
}

export async function ensureSchema(): Promise<void> {
  if (!migrated) await resetSchema()
}

/** Leert alle Fachtabellen, behaelt Katalog und Systemrollen. */
export async function truncateAll(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await client.connect()
  const { rows } = await client.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT IN ('schema_migration','inventory_error')
       AND tablename NOT LIKE 'audit_log%'`)
  if (rows.length > 0) {
    await client.query(
      `TRUNCATE ${rows.map(r => `public.${r.tablename}`).join(', ')} RESTART IDENTITY CASCADE`)
  }
  await client.query('TRUNCATE audit_log')

  // Berechtigungskatalog und Systemrollen werden mit geleert und aus
  // derselben Quelle wie die Migration neu gesaet. Sonst raeumt
  // TRUNCATE account CASCADE sie ueber role.account_id stillschweigend ab.
  await client.query(await readFile(CATALOG_MIGRATION, 'utf8'))
  await client.end()
}

export function appPool(max = 20): Pool {
  return createPool({ kind: 'app', max, applicationName: 'hotelpms-test' })
}
export function ownerPool(max = 5): Pool {
  return createPool({ kind: 'owner', max, applicationName: 'hotelpms-test-owner' })
}
