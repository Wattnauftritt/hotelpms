import type { PoolClient } from '@hotelpms/db'
import { enqueueEvents, type WebhookEventType } from '@hotelpms/domain'

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
  return emitEvents(client, propertyId, type, [data])
}

/**
 * Viele Ereignisse einer Art in einer Anweisung (Performance-Audit
 * 11.10.2026, Befund 6).
 *
 * Wer je Zeile `emitEvent` ruft, zahlt je Zeile eine Runde: ein Sortierlauf
 * mit vierzig Zuegen waren vierzig. `webhook_enqueue_bulk` (Migration 0141)
 * legt je Element einen eigenen Umschlag mit eigener Referenz an, in der
 * Reihenfolge des Feldes -- fuer den Empfaenger dasselbe wie vierzig
 * Einzelaufrufe.
 *
 * Ereignisse zu einer Reservierung tragen ausserdem die Buchung und den
 * Cursorstand (Migration 0075). Das Ereignis heisst "jetzt nachfragen": der
 * Empfaenger holt die Zeile ueber `changedSince`, und am Cursor sieht er, ob
 * er sie schon hat -- ein gespeicherter Cursor, der **groesser** ist als
 * dieser, enthaelt die Aenderung. Gleich genuegt nicht: der Horizont einer
 * Liste steht auf `<xid>.0`, solange die Transaktion dieses Ereignisses
 * noch laeuft. Ergaenzt wird in der SQL-Funktion, nur ergaenzend: was die
 * Route selbst mitgibt, gewinnt. Dort, weil auch der Worker einreiht.
 */
export async function emitEvents(
  client: PoolClient,
  propertyId: number,
  type: WebhookEventType,
  rows: Array<Record<string, unknown>>
): Promise<number> {
  return enqueueEvents(client, propertyId, type, rows)
}
