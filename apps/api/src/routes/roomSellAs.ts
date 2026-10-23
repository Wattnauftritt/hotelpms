import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'
import { geschaeftstag, rechtImHaus } from './depositRequests.js'
import { nightsBetween } from '@hotelpms/domain'

/**
 * Ein Zimmer an einzelnen Tagen als andere Kategorie verkaufen (Migration 0197).
 *
 * Sven, 23.10.2026: Ist morgen kein Doppelzimmer mehr frei, aber noch ein
 * Vierbettzimmer, verkauft das Haus das Vierbettzimmer als Doppelzimmer --
 * zum Preis des Doppelzimmers buchte es sonst niemand, und es stuende leer.
 * Bisher wusste StayGrid davon nichts und meldete weiter ein freies
 * Vierbettzimmer und kein Doppelzimmer.
 *
 * Ein Eintrag je Zimmer und Tag. An diesen Tagen zaehlt das Zimmer im
 * Bestand der anderen Kategorie, und damit stimmt die Zahl, die an den Kanal
 * geht, ohne dass das Adminpanel etwas davon wissen muss.
 *
 * **Recht `reservation:write`, nicht `inventory:write`.** Dasselbe erreichte
 * die Rezeption bisher, indem sie ein Doppelzimmer in das Vierbettzimmer
 * schob -- mit genau diesem Recht. Ein eigenes, hoeheres Recht fuer den
 * ordentlichen Weg triebe sie zurueck zum Umweg.
 */

/** So weit im Voraus, in einem Zug. Wie der Zimmerplan (Dokument 12, P6). */
const MAX_TAGE = 92

/** Wie `depositRequests.ts`: der 30. Februar ist kein Tag, auch wenn er so aussieht. */
function istKalendertag(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** "2026-10-24" als "24.10.2026" fuer den Platzhalter einer Meldung. */
function deutsch(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
}

export function roomSellAsRoutes(app: FastifyInstance): void {
  /**
   * Setzt oder hebt auf, fuer `from` bis vor `to`.
   *
   * `categoryId` ist die Kategorie, als die das Zimmer an diesen Tagen
   * verkauft wird; `null` oder die eigene Gruppe des Zimmers hebt auf. Ein
   * Aufruf ersetzt, was an diesen Tagen stand -- der Zeitraum ist die
   * Auswahl am Plan, und was der Mensch dort sieht, soll danach gelten.
   *
   * **Belegte Tage.** Liegt an einem Tag schon jemand im Zimmer, zaehlt er
   * danach in der neuen Kategorie (Trigger in 0197). Das ist nur richtig,
   * wenn er in genau dieser Kategorie gebucht ist: das Doppelzimmer, das
   * bisher von Hand ins Vierbettzimmer geschoben wurde, darf nachtraeglich
   * als Doppelzimmer markiert werden. Ein Gast, der das Vierbettzimmer
   * gebucht hat, macht es an seinem Tag nicht zum Doppelzimmer -- sonst
   * fehlte das Vierbettzimmer im Bestand, und das Doppelzimmer zaehlte einen
   * Gast, den es nicht hat.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/room-sell-as',
    permission: 'reservation:write',
    propertyParam: 'propertyId',
    summary: 'Zimmer an einzelnen Tagen als andere Kategorie verkaufen',
    handler: async (req) => {
      const pid = Number((req.params as { propertyId: string }).propertyId)
      const body = (req.body ?? {}) as {
        roomId?: unknown; from?: unknown; to?: unknown; categoryId?: unknown }
      if (!Number.isInteger(body.roomId)) {
        throw Errors.validation({ roomId: ['field.required'] })
      }
      if (!istKalendertag(body.from)) throw Errors.validation({ from: ['field.isoDate'] })
      if (!istKalendertag(body.to)) throw Errors.validation({ to: ['field.isoDate'] })
      if (body.categoryId !== null && !Number.isInteger(body.categoryId)) {
        throw Errors.validation({ categoryId: ['field.required'] })
      }
      const from = body.from
      const to = body.to
      const tage = nightsBetween(from, to)
      if (tage <= 0) throw Errors.validation({ to: ['field.afterFrom'] })
      if (tage > MAX_TAGE) throw Errors.rangeTooLarge(MAX_TAGE)
      const roomId = body.roomId as number
      const principal = req.principal as Principal

      return tx(req.pool, req, async client => {
        // Gesperrt: zwei Rechner, die dasselbe Zimmer gleichzeitig markieren,
        // sollen nacheinander pruefen, nicht beide gegen den alten Stand.
        const z = await client.query<{ property_id: number; category_id: number; code: string }>(
          `SELECT property_id, category_id, code FROM resource
            WHERE id = $1 AND active FOR UPDATE`, [roomId])
        const zimmer = z.rows[0]
        // Ein Zimmer des Nachbarhauses ist hier keines (CLAUDE.md,
        // Mandantentrennung: die Zeilenrichtlinie filtert nach Mandant).
        if (zimmer === undefined || Number(zimmer.property_id) !== pid) {
          throw Errors.notFound('res.room')
        }
        rechtImHaus(principal, 'reservation:write', pid)

        const ziel = body.categoryId === null || body.categoryId === zimmer.category_id
          ? null : body.categoryId as number
        if (ziel !== null) {
          const k = await client.query(
            `SELECT 1 FROM resource_category WHERE id = $1 AND property_id = $2 AND active`,
            [ziel, pid])
          if (k.rowCount === 0) throw Errors.notFound('res.category')
        }

        // Vergangene Tage sind gezaehlt; was dort verkauft wurde, steht in
        // `business_day_stat` und aendert sich nicht mehr.
        const heute = await geschaeftstag(client, pid)
        if (from < heute) {
          throw Errors.unprocessable('sellAs.datePast', { date: deutsch(heute) })
        }

        /*
         * Wer an einem Tag im Zimmer liegt, muss in der Kategorie gebucht
         * sein, in der das Zimmer danach zaehlt (siehe oben). Tage, an denen
         * sich nichts aendert, fragen nicht.
         */
        const danach = ziel ?? zimmer.category_id
        const belegt = await client.query<{ ref: string; date: string; category: string }>(
          `SELECT s.public_ref AS ref, d::date::text AS date, k.name AS category
             FROM reservation_room_stay s
             JOIN resource_category k ON k.id = s.category_id
            CROSS JOIN LATERAL generate_series(greatest(s.arrival, $2::date),
                                               least(s.departure, $3::date) - 1,
                                               interval '1 day') d
             LEFT JOIN room_sell_as a ON a.resource_id = s.resource_id AND a.date = d::date
            WHERE s.resource_id = $1
              AND s.stay_status IN ('Optional','Confirmed','InHouse')
              AND s.arrival < $3::date AND s.departure > $2::date
              AND coalesce(a.category_id, $5::bigint) <> $4::bigint
              AND s.category_id <> $4::bigint
            ORDER BY d LIMIT 1`, [roomId, from, to, danach, zimmer.category_id])
        const b = belegt.rows[0]
        if (b !== undefined) {
          throw Errors.conflict('sellAs.occupied',
            { room: zimmer.code, date: deutsch(b.date), ref: b.ref, category: b.category })
        }

        // Erst weg, dann neu: die Trigger rechnen Einfuegen und Loeschen,
        // ein Aendern gibt es nicht (0197).
        await client.query(
          `DELETE FROM room_sell_as
            WHERE resource_id = $1 AND date >= $2::date AND date < $3::date`,
          [roomId, from, to])
        if (ziel !== null) {
          await client.query(
            `INSERT INTO room_sell_as (resource_id, date, property_id, category_id, created_by)
             SELECT $1, d::date, $4, $5, $6
               FROM generate_series($2::date, $3::date - 1, interval '1 day') d`,
            [roomId, from, to, pid, ziel, principal.userId ?? null])
        }
        return { roomId, from, to, categoryId: ziel }
      })
    }
  })
}
