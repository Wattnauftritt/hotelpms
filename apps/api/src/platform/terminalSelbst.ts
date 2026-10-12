import type { PoolClient } from '@hotelpms/db'

/**
 * Selbstbedienung am Gaesteterminal (Dokument 31, Abschnitt 14; Migration
 * 0150): was die Routen des Terminals und das Oeffnen eines Auftrags
 * gemeinsam brauchen.
 */

/**
 * Wer als Gast eines Zimmers gilt: jede nicht stornierte Buchung ab dem
 * Anreisetag, auch ohne Check-in (Sven, 05.10.2026) -- dieselben Zustaende
 * wie beim Verzicht (`LAUFEND` in `reinigungsverzicht.ts`). Bis vor den
 * Abreisetag: der Abreisende hat keinen Bleibetag mehr, und am Wechseltag
 * steht sonst der falsche Name auf dem Bildschirm.
 */
export const GAST_IM_ZIMMER_SQL = `v.status::text IN ('Confirmed', 'InHouse')
  AND v.primary_guest_id IS NOT NULL
  AND v.arrival <= tag.d AND v.departure > tag.d`

/** Der offene Geschaeftstag je Haus, sonst der Kalendertag. Fristen laufen gegen ihn. */
export const GESCHAEFTSTAG_SQL = `COALESCE(
  (SELECT max(b.date) FROM business_day b WHERE b.property_id = p.id AND b.status = 'open'),
  current_date)`

export type EndeGrund = 'done' | 'canceled' | 'timeout' | 'declined' | 'job' | 'replaced'

/**
 * Offene Sitzungen eines Geraets beenden und ihre Links zurueckziehen --
 * alle oder genau eine. Ein Link, der die Sitzung ueberlebte, gehoerte dem
 * naechsten Gast am Touchscreen.
 *
 * Gerufen auch beim Oeffnen eines Auftrags: der Auftrag der Rezeption hat
 * immer Vorrang, und was der Gast bis dahin gespeichert hat, bleibt.
 */
export async function beendeSelbstbedienung(
  client: PoolClient, deviceId: number, grund: EndeGrund, sessionId?: number
): Promise<void> {
  await client.query(
    `WITH zu AS (
       UPDATE terminal_self_session
          SET ended_at = now(), ended_reason = $2
        WHERE device_id = $1 AND ended_at IS NULL
          AND ($3::bigint IS NULL OR id = $3)
        RETURNING checkin_token_id)
     UPDATE checkin_token SET revoked_at = now()
      WHERE revoked_at IS NULL
        AND id IN (SELECT checkin_token_id FROM zu WHERE checkin_token_id IS NOT NULL)`,
    [deviceId, grund, sessionId ?? null])
}

/**
 * Die Haeuser des Geraets, die die Selbstbedienung anbieten. Solange der
 * Verzicht ihre einzige Funktion ist, muss auch er eingeschaltet sein --
 * sonst stuende nach "Ja" ein leerer Bildschirm da. Liefert je Haus den
 * Geschaeftstag als `d`; `$1` sind die Haeuser des Geraets.
 */
export const HAEUSER_SQL = `
  SELECT p.id, p.name, ${GESCHAEFTSTAG_SQL} AS d
    FROM property p
    JOIN property_terminal_self_setting ts ON ts.property_id = p.id AND ts.enabled
    JOIN property_cleaning_waiver_setting ws ON ws.property_id = p.id AND ws.enabled
   WHERE p.id = ANY ($1::bigint[])`

/** Bietet eines der Haeuser des Geraets die Selbstbedienung an? */
export async function selbstbedienungAngeboten(
  client: PoolClient, propertyIds: number[]
): Promise<boolean> {
  const { rows } = await client.query<{ an: boolean }>(
    `SELECT EXISTS (${HAEUSER_SQL}) AS an`, [propertyIds])
  return rows[0]?.an === true
}
