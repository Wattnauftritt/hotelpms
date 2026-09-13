import type { PoolClient } from '@hotelpms/db'
import type { WebhookEventType } from '@hotelpms/domain'

/**
 * Ereignis einreihen (Aufgabe 4, Dokument 16).
 *
 * Nimmt bewusst den **Client der laufenden Transaktion** entgegen und keinen
 * Pool: nur so entsteht die Zustellung in derselben Transaktion wie die
 * Fachbuchung. Scheitert die Buchung danach noch, verschwindet mit ihr auch
 * das Ereignis, und kein Empfaenger erfaehrt von einer Reservierung, die es
 * nie gab.
 *
 * Ergibt die Zahl der angelegten Zustellungen, also die der passenden
 * Abonnements. Null ist der Normalfall in einem Haus ohne Fremdsystem und
 * kein Fehler.
 */
export async function emitEvent(
  client: PoolClient,
  propertyId: number,
  type: WebhookEventType,
  data: Record<string, unknown>
): Promise<number> {
  const { rows } = await client.query<{ webhook_enqueue: number }>(
    `SELECT webhook_enqueue($1, $2, $3::jsonb)`,
    [propertyId, type, JSON.stringify(data)])
  return rows[0]!.webhook_enqueue
}
