import type { PoolClient } from '@hotelpms/db'
import { AM_TERMINAL } from './gastwuensche.js'

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
 * Die Haeuser des Geraets, die die Selbstbedienung anbieten. Es muss auch
 * etwas zu bedienen geben: der Reinigungsverzicht oder ein kostenloser
 * Eintrag im Wunschkatalog mit Haekchen "am Terminal" -- sonst stuende nach
 * "Ja" ein leerer Bildschirm da. Liefert je Haus den Geschaeftstag als
 * `d`; `$1` sind die Haeuser des Geraets.
 */
export const HAEUSER_SQL = `
  SELECT p.id, p.name, ${GESCHAEFTSTAG_SQL} AS d
    FROM property p
    JOIN property_terminal_self_setting ts ON ts.property_id = p.id AND ts.enabled
   WHERE p.id = ANY ($1::bigint[])
     AND (EXISTS (SELECT 1 FROM property_cleaning_waiver_setting ws
                   WHERE ws.property_id = ts.property_id AND ws.enabled)
          -- Hier heisst der Artikel \`p\` wie in AM_TERMINAL; das Haus
          -- kommt deshalb ueber \`ts\`.
          OR EXISTS (SELECT 1 FROM guest_request_item i
                       LEFT JOIN product p ON p.id = i.product_id
                      WHERE i.property_id = ts.property_id AND i.active
                        AND ${AM_TERMINAL}))`

/**
 * Was die Selbstbedienung am Geraet anbietet, fuer den Knopf im
 * Ruhezustand: Reinigung abbestellen, Wuensche -- oder `null`, dann steht
 * kein Knopf da.
 */
export async function selbstbedienungAngeboten(
  client: PoolClient, propertyIds: number[]
): Promise<{ cleaning: boolean; requests: boolean } | null> {
  const { rows } = await client.query<{ cleaning: boolean; requests: boolean; an: boolean }>(
    `WITH h AS (${HAEUSER_SQL})
     SELECT EXISTS (SELECT 1 FROM h) AS an,
            EXISTS (SELECT 1 FROM h JOIN property_cleaning_waiver_setting ws
                                      ON ws.property_id = h.id AND ws.enabled) AS cleaning,
            EXISTS (SELECT 1 FROM h JOIN guest_request_item i ON i.property_id = h.id
                      LEFT JOIN product p ON p.id = i.product_id
                     WHERE i.active AND ${AM_TERMINAL}) AS requests`, [propertyIds])
  const r = rows[0]!
  return r.an ? { cleaning: r.cleaning, requests: r.requests } : null
}

/** Was Einstellungen → Gaesteterminals zur Selbstbedienung zeigt. */
export interface SelbstEinstellung {
  enabled: boolean
  cleaningWaiverEnabled: boolean
  /** Kostenlose Eintraege im Wunschkatalog mit Haekchen "am Terminal". */
  terminalItems: number
}

export async function einstellungAnsicht(
  client: PoolClient, propertyId: number
): Promise<SelbstEinstellung> {
  const { rows } = await client.query<SelbstEinstellung>(
    `SELECT coalesce((SELECT enabled FROM property_terminal_self_setting
                       WHERE property_id = $1), false) AS enabled,
            coalesce((SELECT enabled FROM property_cleaning_waiver_setting
                       WHERE property_id = $1), false) AS "cleaningWaiverEnabled",
            (SELECT count(*)::int FROM guest_request_item i
               LEFT JOIN product p ON p.id = i.product_id
              WHERE i.property_id = $1 AND i.active AND ${AM_TERMINAL}) AS "terminalItems"`,
    [propertyId])
  return rows[0]!
}

/**
 * Der Startbestand am Terminal (Plan terminal-selfservice, Abschnitt 9):
 * zwei Kopfkissen, beide an Housekeeping, hoechstens zwei. Nur fuers
 * Terminal angehakt; ob sie auch in die Mappe gehoeren, entscheidet das
 * Haus im Katalog. Ein Eintrag, den es unter diesem Namen schon gibt,
 * bleibt, wie er ist.
 */
const KISSEN: ReadonlyArray<Record<string, string>> = [
  { de: 'Zusätzliches Kopfkissen', en: 'Extra pillow', nl: 'Extra hoofdkussen',
    da: 'Ekstra hovedpude', sv: 'Extra kudde', nb: 'Ekstra hodepute',
    pl: 'Dodatkowa poduszka', cs: 'Polštář navíc', fr: 'Oreiller supplémentaire',
    it: 'Cuscino aggiuntivo', es: 'Almohada adicional', tr: 'Ekstra yastık',
    ru: 'Дополнительная подушка', uk: 'Додаткова подушка' },
  { de: 'Kopfkissen ohne Federn', en: 'Feather-free pillow', nl: 'Hoofdkussen zonder veren',
    da: 'Hovedpude uden fjer', sv: 'Kudde utan fjäder', nb: 'Hodepute uten fjær',
    pl: 'Poduszka bez pierza', cs: 'Polštář bez peří', fr: 'Oreiller sans plumes',
    it: 'Cuscino senza piume', es: 'Almohada sin plumas', tr: 'Tüysüz yastık',
    ru: 'Подушка без пера', uk: 'Подушка без пір’я' }
]

export async function kissenVorbelegen(
  client: PoolClient, propertyId: number, userId: number | null
): Promise<void> {
  await client.query(
    `INSERT INTO guest_request_item (property_id, name, handler, max_qty, on_folder,
                                     on_terminal, position, updated_by)
     SELECT $1, n.name, 'housekeeping', 2, false, true,
            (SELECT coalesce(max(position), 0) FROM guest_request_item
              WHERE property_id = $1) + n.nr, $3
       FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS n(name, nr)
      WHERE NOT EXISTS (SELECT 1 FROM guest_request_item i
                         WHERE i.property_id = $1 AND i.name ->> 'de' = n.name ->> 'de')`,
    [propertyId, JSON.stringify(KISSEN), userId])
}
