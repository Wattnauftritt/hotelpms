import type { PoolClient } from '@hotelpms/db'

/**
 * Freie Texte des Personals zur Uebersetzung einreihen (Baustein 7, 0112).
 *
 * Die Route reiht ein, der Worker uebersetzt. Keine Uebersetzung im
 * Anfragepfad: die Kraft soll nach dem Speichern nicht auf DeepL warten,
 * und faellt DeepL aus, speichert sie trotzdem.
 *
 * Ein zweites Einreihen derselben Quelle -- der Text wurde geaendert --
 * setzt den Auftrag zurueck, statt einen zweiten anzulegen. Der Worker liest
 * den Text erst beim Uebersetzen, also immer den neuesten.
 */
export type StaffTextKind = 'work_entry' | 'problem' | 'inspection_note'

export async function reiheUebersetzungEin(
  client: PoolClient, propertyId: number, kind: StaffTextKind, sourceId: number,
  targets: readonly string[]
): Promise<void> {
  if (targets.length === 0) return
  await client.query(
    `INSERT INTO staff_text_job (property_id, source_kind, source_id, targets)
     VALUES ($1, $2, $3, $4::text[])
     ON CONFLICT (source_kind, source_id) DO UPDATE
       SET targets = EXCLUDED.targets, status = 'pending', attempts = 0,
           next_at = now(), last_error = NULL`,
    [propertyId, kind, sourceId, targets])
}

/**
 * Was die Kraft schreibt, soll die Leitung deutsch lesen. Wer Deutsch als
 * eigene Sprache gewaehlt hat, schreibt deutsch -- das geht nicht erst an
 * einen fremden Dienst, um das festzustellen. Ohne Wahl entscheidet die
 * Erkennung im Worker.
 */
export async function zielDeutsch(client: PoolClient, userId: number): Promise<string[]> {
  const { rows } = await client.query<{ locale: string | null }>(
    'SELECT locale FROM app_user WHERE id = $1', [userId])
  return rows[0]?.locale === 'de' ? [] : ['de']
}
