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
  /*
   * Ereignisse zu einer Reservierung tragen ausserdem die Buchung und den
   * Cursorstand (Migration 0075). Das Ereignis heisst "jetzt nachfragen":
   * der Empfaenger holt die Zeile ueber `changedSince`, und am Cursor sieht
   * er, ob er sie schon hat -- ein gespeicherter Cursor, der **groesser**
   * ist als dieser, enthaelt die Aenderung. Gleich genuegt nicht: der
   * Horizont einer Liste steht auf `<xid>.0`, solange die Transaktion
   * dieses Ereignisses noch laeuft.
   *
   * Im selben Aufruf wie das Einreihen, nicht als zweite Abfrage, und nur
   * ergaenzend: was die Route selbst mitgibt, gewinnt.
   */
  const { rows } = await client.query<{ webhook_enqueue: number }>(
    `SELECT webhook_enqueue($1, $2,
       CASE WHEN $2 LIKE 'reservation.%'
            THEN jsonb_strip_nulls(jsonb_build_object(
                   'bookingRef', (SELECT b.public_ref FROM reservation r
                                    JOIN booking b ON b.id = r.booking_id
                                   WHERE r.public_ref = $3::jsonb ->> 'reservationRef'),
                   'cursor', pg_current_xact_id()::text || '.0'))
            ELSE '{}'::jsonb END || $3::jsonb)`,
    [propertyId, type, JSON.stringify(data)])
  return rows[0]!.webhook_enqueue
}
