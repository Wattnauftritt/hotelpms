import type { PoolClient } from '@hotelpms/db'
import type { CleaningWaiverView } from '@hotelpms/contracts'
import { Errors } from './errors.js'

/**
 * Reinigungsverzicht des Gastes (Aufgabe 18, Baustein 10; Migration 0115).
 *
 * An einer Stelle fuer beide Tueren -- die Gastseite hinter dem
 * Check-in-Link und das Seitenfenster der Rezeption. Zwei Fassungen der
 * Regel "welcher Tag darf noch" liefen auseinander, und dann setzt der Gast
 * einen Tag, den die Rezeption nicht mehr setzen duerfte, oder umgekehrt.
 *
 * **Welche Tage.** Die Bleibetage (Anreise < Tag < Abreise) ab dem offenen
 * Geschaeftstag. Der Anreisetag hat keine Zwischenreinigung, der
 * Abreisetag eine Abreisereinigung, auf die niemand verzichten kann -- der
 * naechste Gast kommt.
 *
 * **Bis wann.** Bis die Kraft das Zimmer an dem Tag gemeldet hat. Die
 * Uhrzeit spielt keine Rolle: ein Wunsch um 7 Uhr, bevor jemand im Haus
 * ist, erreicht die Kraft genauso wie einer am Vorabend. Danach ist der Tag
 * gesperrt; ein Verzicht, nachdem gereinigt wurde, waere ein Eintrag ueber
 * etwas, das nicht geschehen ist.
 */

/** Zustaende, in denen ein Aufenthalt noch Bleibetage hat. */
const LAUFEND = ['Confirmed', 'InHouse']

interface Tag { date: string; waived: boolean; locked: boolean }

/** Die Einstellung des Hauses; ohne Zeile ist der Verzicht aus. */
export async function verzichtEinstellung(
  client: PoolClient, propertyId: number
): Promise<{ enabled: boolean; waterGift: boolean }> {
  const { rows } = await client.query<{ enabled: boolean; water_gift: boolean }>(
    `SELECT enabled, water_gift FROM property_cleaning_waiver_setting WHERE property_id = $1`,
    [propertyId])
  return { enabled: rows[0]?.enabled ?? false, waterGift: rows[0]?.water_gift ?? false }
}

/**
 * Die Bleibetage ab dem Geschaeftstag, in einer Anweisung. Leer, wenn der
 * Aufenthalt nicht laeuft oder kein Zimmer hat -- ohne Zimmer weiss
 * niemand, welche Aufgabe den Tag sperrt.
 */
async function tage(
  client: PoolClient, reservationId: number, businessDate: string
): Promise<Tag[]> {
  const { rows } = await client.query<Tag>(
    `SELECT d::date::text AS date,
            EXISTS (SELECT 1 FROM cleaning_waiver w
                     WHERE w.reservation_id = r.id AND w.business_date = d::date
                       AND w.withdrawn_at IS NULL) AS waived,
            EXISTS (SELECT 1 FROM housekeeping_task t
                     WHERE t.resource_id = r.resource_id AND t.business_date = d::date
                       AND t.kind = 'stayover' AND t.outcome IS NOT NULL) AS locked
       FROM reservation r
       CROSS JOIN LATERAL generate_series(
              GREATEST(r.arrival + 1, $2::date), r.departure - 1, interval '1 day') d
      WHERE r.id = $1 AND r.status::text = ANY ($3::text[]) AND r.resource_id IS NOT NULL
      ORDER BY d`, [reservationId, businessDate, LAUFEND])
  return rows
}

/**
 * Was Gastseite und Seitenfenster zeigen. `null`, wenn das Haus den
 * Verzicht nicht anbietet oder kein Bleibetag mehr kommt -- dann zeigt
 * keine der beiden Seiten etwas dazu.
 */
export async function verzichtStand(
  client: PoolClient, reservationId: number, propertyId: number, businessDate: string,
  mayEdit: boolean
): Promise<CleaningWaiverView | null> {
  const e = await verzichtEinstellung(client, propertyId)
  if (!e.enabled) return null
  const days = await tage(client, reservationId, businessDate)
  if (days.length === 0) return null
  return { waterGift: e.waterGift, days, mayEdit }
}

/**
 * Einen Tag setzen oder zuruecknehmen. Zuruecknehmen loescht nicht, es
 * stempelt `withdrawn_at` -- die Hausdame soll sehen, warum ein Zimmer
 * gestern nicht gereinigt wurde.
 */
export async function setzeVerzicht(
  client: PoolClient,
  a: { reservationId: number; propertyId: number; businessDate: string
       date: string; waived: boolean; source: 'guest' | 'reception'; userId: number | null }
): Promise<void> {
  const e = await verzichtEinstellung(client, a.propertyId)
  if (!e.enabled) throw Errors.unprocessable('cleaningWaiver.disabled')
  // Die Reservierung sperren: zwei gleichzeitige Klicks auf denselben Tag
  // sollen nicht am eindeutigen Index scheitern, sondern nacheinander laufen.
  await client.query(`SELECT 1 FROM reservation WHERE id = $1 FOR UPDATE`, [a.reservationId])
  const tag = (await tage(client, a.reservationId, a.businessDate)).find(t => t.date === a.date)
  if (tag === undefined) throw Errors.unprocessable('cleaningWaiver.notAStayDay')
  if (tag.waived === a.waived) return
  if (tag.locked) throw Errors.conflict('cleaningWaiver.locked')
  if (a.waived) {
    await client.query(
      `INSERT INTO cleaning_waiver (property_id, reservation_id, business_date, source, created_by)
       VALUES ($1, $2, $3::date, $4, $5)`,
      [a.propertyId, a.reservationId, a.date, a.source, a.userId])
  } else {
    await client.query(
      `UPDATE cleaning_waiver SET withdrawn_at = now(), withdrawn_by = $3
        WHERE reservation_id = $1 AND business_date = $2::date AND withdrawn_at IS NULL`,
      [a.reservationId, a.date, a.userId])
  }
}
