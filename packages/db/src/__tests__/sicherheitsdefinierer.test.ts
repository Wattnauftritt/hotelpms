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
