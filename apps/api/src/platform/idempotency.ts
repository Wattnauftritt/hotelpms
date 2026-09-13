import { createHash } from 'node:crypto'
import type { PoolClient } from '@hotelpms/db'
import { Errors } from './errors.js'

export interface StoredResponse {
  status: number
  body: unknown
}

export function hashRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex')
}

/**
 * Idempotenz nach S2, Dokument 12.
 *
 *   unbekannt                 -> ausfuehren, Antwort speichern
 *   bekannt, gleicher Rumpf   -> gespeicherte Antwort, nichts erneut ausfuehren
 *   bekannt, anderer Rumpf    -> 422, niemals die alte Antwort
 *   bekannt, laeuft noch      -> 409, Client soll wiederholen
 *
 * Der Schluessel gilt je Client, nicht global, sonst kann ein Client die
 * Idempotenz eines anderen stoeren.
 */
export async function beginIdempotent(
  client: PoolClient, clientKey: string, key: string, body: unknown
): Promise<StoredResponse | null> {
  const hash = hashRequest(body)
  const existing = await client.query<{
    request_hash: string; status: string; response_status: number | null; response_body: unknown
  }>(`SELECT request_hash, status, response_status, response_body
        FROM idempotency_key WHERE client_key = $1 AND key = $2 FOR UPDATE`,
    [clientKey, key])

  if (existing.rowCount && existing.rowCount > 0) {
    const row = existing.rows[0]!
    if (row.request_hash !== hash) throw Errors.idempotencyMismatch()
    if (row.status === 'in_flight') throw Errors.idempotencyInFlight()
    return { status: row.response_status ?? 200, body: row.response_body }
  }

  await client.query(
    `INSERT INTO idempotency_key (client_key, key, request_hash) VALUES ($1, $2, $3)`,
    [clientKey, key, hash])
  return null
}

export async function completeIdempotent(
  client: PoolClient, clientKey: string, key: string, status: number, body: unknown
): Promise<void> {
  await client.query(
    `UPDATE idempotency_key
        SET status = 'completed', response_status = $3, response_body = $4
      WHERE client_key = $1 AND key = $2`,
    [clientKey, key, status, JSON.stringify(body)])
}
