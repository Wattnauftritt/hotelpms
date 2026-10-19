import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ensureSchema, ownerPool, appPool } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'

/**
 * SECURITY-DEFINER-Funktionen und die Rechte der Anwendungsrolle (Befunde
 * M11 und N12 aus dem Sicherheitsaudit vom 11.10.2026, Migration 0133).
 *
 * **Warum der Suchpfad einen Test verdient.** Steht pg_temp nicht
 * ausdruecklich darin, sucht PostgreSQL dort zuerst. Eine temporaere Tabelle
 * `app_user` der Anwendungsrolle verdeckte dann die echte in jeder Funktion,
 * die mit den Rechten der Eigentuemerin laeuft. Jede neue Migration, die eine
 * Funktion mit `SET search_path = public` anlegt oder neu fasst, setzt das
 * still zurueck -- dieser Test faellt dann mit ihrem Namen.
 */

let owner: Pool
let app: Pool

beforeAll(async () => { await ensureSchema(); owner = ownerPool(); app = appPool(1) })
afterAll(async () => { await owner.end(); await app.end() })

describe('SECURITY DEFINER', () => {
  it('jede Funktion sucht pg_temp zuletzt', async () => {
    const r = await owner.query<{ name: string; config: string[] | null }>(
      `SELECT p.oid::regprocedure::text AS name, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef`)
    expect(r.rows.length).toBeGreaterThan(50)
    const falsch = r.rows
      .filter(f => !(f.config ?? []).includes('search_path=public, pg_temp'))
      .map(f => f.name)
    expect(falsch).toEqual([])
  })

  it('die Anwendung legt keine temporaere Tabelle an', async () => {
    await expect(app.query(`CREATE TEMP TABLE app_user (id bigint)`))
      .rejects.toThrow(/permission denied/)
  })

  it('Hilfsfunktionen ohne Kontextpruefung sind fuer die Anwendung zu', async () => {
    for (const sql of [
      `SELECT payment_link_revoke_for_guest(1)`,
      `SELECT inventory_room_shift_apply('[]'::jsonb)`,
      `SELECT inventory_recalc_capacity(1, current_date, current_date)`
    ]) {
      await expect(app.query(sql)).rejects.toThrow(/permission denied/)
    }
  })
})

/**
 * Die Leserolle (Audit 19.10.2026, M1, Migration 0183). Sie verspricht "nur
 * lesen", konnte ueber SECURITY-DEFINER-Funktionen aber Gaeste anonymisieren
 * und Kunden sperren. Geprueft wird das wirksame Recht, PUBLIC
 * eingeschlossen -- ein REVOKE von der Rolle allein nimmt ihr nichts, solange
 * PUBLIC es noch hat.
 */
describe('Leserolle', () => {
  // Bewusst leer: keine Richtlinie und keine Sicht ruft eine
  // SECURITY-DEFINER-Funktion. Wer hier etwas eintraegt, begruendet es.
  const ERLAUBT: string[] = []

  it('fuehrt keine SECURITY-DEFINER-Funktion aus', async () => {
    const r = await owner.query<{ name: string }>(
      `SELECT p.oid::regprocedure::text AS name
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
          AND has_function_privilege('hotelpms_readonly', p.oid, 'EXECUTE')
        ORDER BY 1`)
    expect(r.rows.map(f => f.name).filter(n => !ERLAUBT.includes(n))).toEqual([])
  })

  it('kann jede Hilfe der Zeilenrichtlinien weiter ausfuehren', async () => {
    const r = await owner.query<{ name: string; darf: boolean }>(
      `SELECT DISTINCT p.oid::regprocedure::text AS name,
              has_function_privilege('hotelpms_readonly', p.oid, 'EXECUTE') AS darf
         FROM pg_policies pol
        CROSS JOIN LATERAL regexp_matches(
               coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, ''),
               '([a-z_][a-z0-9_]*)\\(', 'g') m
         JOIN pg_proc p ON p.proname = m[1]
         JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
        WHERE pol.schemaname = 'public'`)
    expect(r.rows.length).toBeGreaterThan(0)
    expect(r.rows.filter(f => !f.darf).map(f => f.name)).toEqual([])
  })

  it('die Anwendung behaelt ihre Funktionen', async () => {
    const r = await owner.query<{ darf: boolean }>(
      `SELECT has_function_privilege('hotelpms_app', 'guest_erase_one(bigint)', 'EXECUTE')
              AND has_function_privilege('hotelpms_app', 'session_principal(text, text)', 'EXECUTE')
              AND has_function_privilege('hotelpms_app', 'channel_connection_for_auth(text)',
                                         'EXECUTE') AS darf`)
    expect(r.rows[0]!.darf).toBe(true)
  })
})
