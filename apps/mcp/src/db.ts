import pg from 'pg'

export type Pool = pg.Pool
export type Client = pg.PoolClient

/** So lange darf eine Anweisung rechnen. Die Rezeption soll davon nichts merken. */
export const ZEITGRENZE_MS = 5_000

export interface Verbindung {
  id: number
  ref: string
  benutzer: number
  laeuftAb: Date
}

export function poolAnlegen(url: string, max = 4): Pool {
  return new pg.Pool({
    connectionString: url, max,
    application_name: 'hotelpms-mcp',
    // Auch ausserhalb einer Abfrage nicht ewig: ein haengender Dienst haelt
    // sonst Verbindungen, die der Rezeption fehlen.
    idle_in_transaction_session_timeout: 10_000,
    statement_timeout: ZEITGRENZE_MS
  })
}

/** Das Token pruefen; `null` heisst 401. */
export async function anmelden(pool: Pool, tokenHash: Buffer): Promise<Verbindung | null> {
  const r = await pool.query<{ verbindung: string; verbindung_ref: string; benutzer: string
                               laeuft_ab: Date }>(
    'SELECT * FROM mcp_dienst.anmelden($1)', [tokenHash])
  const z = r.rows[0]
  return z === undefined ? null
    : { id: Number(z.verbindung), ref: z.verbindung_ref, benutzer: Number(z.benutzer),
        laeuftAb: new Date(z.laeuft_ab) }
}

/**
 * Lesend arbeiten, als diese Verbindung.
 *
 * `READ ONLY` haelt jedes Schreiben auf, auch in einer Funktion mit den
 * Rechten ihres Eigentuemers -- die Rolle selbst hat ohnehin kein
 * Schreibrecht, das hier ist die zweite Sperre. `mcp.verbindung` sagt den
 * Sichten, wessen Freigaben gelten. Der Suchpfad zeigt nur auf die
 * Sichten: `FROM guest` ist dann die geschwaerzte, eine andere gibt es fuer
 * diese Rolle nicht.
 */
export async function lesend<T>(
  pool: Pool, v: Verbindung, arbeit: (c: Client) => Promise<T>
): Promise<{ ergebnis: T; klartext: boolean }> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN READ ONLY')
    await c.query(`SELECT set_config('mcp.verbindung', $1, true),
                          set_config('search_path', 'mcp, pg_catalog', true),
                          set_config('statement_timeout', $2, true)`,
                  [String(v.id), String(ZEITGRENZE_MS)])
    const k = await c.query<{ k: boolean }>('SELECT mcp_dienst.klartext_aktiv() AS k')
    const ergebnis = await arbeit(c)
    await c.query('COMMIT')
    return { ergebnis, klartext: k.rows[0]?.k === true }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined)
    throw e
  } finally {
    c.release()
  }
}

export interface Aufruf {
  werkzeug: string
  haus: number | null
  zeilen: number
  klartext: boolean
  dauerMs: number
  ok: boolean
  detail: string | null
}

/** Jeden Aufruf festhalten, auch den gescheiterten. */
export async function protokollieren(pool: Pool, v: Verbindung, a: Aufruf): Promise<void> {
  await pool.query('SELECT mcp_dienst.protokollieren($1, $2, $3, $4, $5, $6, $7, $8)',
    [v.id, a.werkzeug, a.haus, a.zeilen, a.klartext, Math.round(a.dauerMs), a.ok, a.detail])
}
