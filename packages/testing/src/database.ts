import pg from 'pg'
import { createPool, migrate, type Pool } from '@hotelpms/db'

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

/**
 * Leert alle Fachtabellen, behaelt Katalog und Systemrollen.
 *
 * `audit_redaction` steht bei den Ausnahmen, weil sie kein Fachbestand ist,
 * sondern eine Regel: welche Felder nicht ins Protokoll gehoeren. Geleert
 * schriebe der Trigger wieder alles mit, und jeder Test dazu waere gruen --
 * gegen eine Datenbank, in der die Regel gar nicht mehr existiert
 * (Migration 0044).
 */
export async function truncateAll(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER })
  await client.connect()
  const { rows } = await client.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT IN ('schema_migration','inventory_error','audit_redaction')
       AND tablename NOT LIKE 'audit_log%'`)
  /*
   * Berechtigungskatalog und Systemrollen werden vom TRUNCATE mit geleert --
   * `TRUNCATE account CASCADE` raeumt sie ueber `role.account_id` still ab --
   * und danach aus einer Kopie zurueckgeschrieben.
   *
   * Hier stand einmal: die Migration 0003 noch einmal einspielen. Das war
   * eine Falle mit Zeitzuender. Der Katalog waechst, und zwar in spaeteren
   * Migrationen; 0028 hat `email:send` hinzugefuegt. Wer ihn aus 0003 allein
   * wiederherstellt, hat den Stand von damals, und jedes spaeter
   * hinzugekommene Recht fehlt in **jedem** Test. Der Befund sieht dann aus
   * wie ein Fehler in der Route -- 403 statt 202 --, und gesucht wird an der
   * falschen Stelle.
   *
   * Eine Kopie des tatsaechlichen Standes kennt diese Frage nicht: sie
   * stimmt, was immer die Migrationen gesaet haben.
   */
  await client.query(`
    CREATE TEMP TABLE katalog_sicherung AS
      SELECT * FROM permission;
    CREATE TEMP TABLE rolle_sicherung AS
      SELECT * FROM role WHERE account_id IS NULL;
    CREATE TEMP TABLE rollenrecht_sicherung AS
      SELECT rp.* FROM role_permission rp
       JOIN role r ON r.id = rp.role_id AND r.account_id IS NULL;`)

  if (rows.length > 0) {
    await client.query(
      `TRUNCATE ${rows.map(r => `public.${r.tablename}`).join(', ')} RESTART IDENTITY CASCADE`)
  }
  await client.query('TRUNCATE audit_log')

  // Die Systemrollen behalten ihre ids: `role_permission` und die
  // Testfixtures verweisen darauf. RESTART IDENTITY hat den Zaehler
  // zurueckgesetzt, er muss deshalb hinter die groesste id nachgezogen
  // werden, sonst kollidiert die naechste Account-Rolle mit einer Systemrolle.
  await client.query(`
    INSERT INTO permission SELECT * FROM katalog_sicherung;
    INSERT INTO role OVERRIDING SYSTEM VALUE SELECT * FROM rolle_sicherung;
    SELECT setval(pg_get_serial_sequence('role','id'),
                  GREATEST((SELECT max(id) FROM role), 1));
    INSERT INTO role_permission SELECT * FROM rollenrecht_sicherung;`)

  await client.end()
}

export function appPool(max = 20): Pool {
  return createPool({ kind: 'app', max, applicationName: 'hotelpms-test' })
}
export function ownerPool(max = 5): Pool {
  return createPool({ kind: 'owner', max, applicationName: 'hotelpms-test-owner' })
}
