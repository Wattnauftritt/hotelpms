import type { WebhookEventType } from './webhooks.js'

/**
 * Ereignisse in der laufenden Transaktion einreihen (Aufgabe 4, Dokument 16;
 * eine Anweisung fuer viele: Performance-Audit 11.10.2026, Befund 6).
 *
 * Steht hier und nicht mehr nur in der API, weil der Worker abgeholte
 * Kanalbuchungen anlegt und dabei dieselben Ereignisse ausloest wie die
 * Rezeption (Migration 0198). Die Begruendungen zu Client statt Pool und zum
 * Cursorstand stehen bei `emitEvents` in `apps/api/src/platform/events.ts`.
 */
export async function enqueueEvents(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  propertyId: number,
  type: WebhookEventType,
  rows: Array<Record<string, unknown>>
): Promise<number> {
  if (rows.length === 0) return 0
  const { rows: r } = await client.query(
    `SELECT webhook_enqueue_bulk($1, $2, $3::jsonb[]) AS n`,
    [propertyId, type, rows.map(d => JSON.stringify(d))])
  return (r[0] as { n: number }).n
}
