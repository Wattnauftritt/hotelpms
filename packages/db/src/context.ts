import type { PoolClient, Pool } from './pool.js'

/**
 * Mandanten- und Benutzerkontext einer Transaktion.
 * Wird transaktionslokal gesetzt (set_config mit true), damit PgBouncer im
 * Transaction Mode die Verbindung nicht verschmutzt (S1, Dokument 12).
 * Der Kontext kommt aus dem Token, nie aus einem Parameter des Clients.
 */
export interface DbContext {
  accountIds: readonly number[]
  propertyIds: readonly number[]
  userId: number | null
  supportSessionId?: number | null
}

export const SYSTEM_CONTEXT: DbContext = {
  accountIds: [],
  propertyIds: [],
  userId: null
}

async function applyContext(client: PoolClient, ctx: DbContext): Promise<void> {
  await client.query(
    `SELECT set_config('app.account_ids',  $1, true),
            set_config('app.property_ids', $2, true),
            set_config('app.user_id',      $3, true),
            set_config('app.support_session_id', $4, true)`,
    [
      ctx.accountIds.join(','),
      ctx.propertyIds.join(','),
      ctx.userId === null ? '' : String(ctx.userId),
      ctx.supportSessionId == null ? '' : String(ctx.supportSessionId)
    ]
  )
}

/**
 * Fuehrt eine Arbeitseinheit in einer Transaktion mit gesetztem Kontext aus.
 * Jede Anfrage laeuft in einer Transaktion; sonst greift die Zeilenrichtlinie
 * nicht, weil der transaktionslokale Kontext fehlt.
 */
export async function withTransaction<T>(
  pool: Pool,
  ctx: DbContext,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await applyContext(client, ctx)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* Verbindung bereits tot */ }
    throw err
  } finally {
    client.release()
  }
}
