import type { PoolClient } from '@hotelpms/db'

/**
 * Eine Push-Meldung an eine Kraft einreihen (Baustein 8, Migration 0113).
 *
 * Gesendet wird im Worker; hier steht nur, wem was zu sagen ist. Eine
 * gleiche Meldung, die noch aussteht, wird nicht verdoppelt -- wer den Plan
 * dreimal speichert, bekommt eine Nachricht. Ob die Kraft ueberhaupt ein
 * Telefon angemeldet hat, entscheidet erst der Worker: eine Meldung ohne
 * Abo kostet eine Zeile, eine Abfrage je Route mehr kostete jede Anfrage.
 */
export async function meldePush(
  client: PoolClient, propertyId: number, userIds: readonly number[],
  kind: 'plan' | 'rework', params: Record<string, string>, dedupeKey: string
): Promise<void> {
  if (userIds.length === 0) return
  await client.query(
    `INSERT INTO staff_push (property_id, user_id, kind, params, dedupe_key)
     SELECT $1, u, $3, $4::jsonb, $5 FROM unnest($2::bigint[]) AS u
     ON CONFLICT DO NOTHING`,
    [propertyId, userIds, kind, JSON.stringify(params), dedupeKey])
}
