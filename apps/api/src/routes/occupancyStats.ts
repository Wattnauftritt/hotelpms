import type { FastifyInstance } from 'fastify'
import { isIsoDate, nightsBetween } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'

/**
 * Belegungsstatistik fuer angebundene Systeme: Reservierungen, Zimmernaechte
 * und Personennaechte je Tag oder je Monat.
 *
 * **Wofuer.** Das Adminpanel (API-Entwurf, Abschnitt 3.4) rechnet daraus sein
 * Fruehstueck und seine Monatsstatistik. Die Fruehstuecksregel steht bewusst
 * nicht hier: sie ist in jedem Haus anders (dort: keins am Anreisetag, eins
 * am Abreisetag, also Fruehstueck an Tag D = Personennaechte der Nacht D-1).
 * StayGrid liefert die Rohgroesse, das Haus rechnet seine Regel selbst.
 *
 * **Personennaechte, getrennt nach dem, was man weiss.** Je Nacht zaehlt
 * die Personenzahl der Reservierung. Wie genau sie bekannt ist, ist
 * verschieden, und das bleibt in der Antwort unterscheidbar, statt in einer
 * Summe zu verschwinden:
 *
 * - `adultNights`, `childNights` -- die Reservierung traegt die Aufteilung
 *   (Migration 0076). Ohne Kinderzahl zaehlen die Erwachsenen allein.
 * - `unsplitPersonNights` -- nur die Gesamtzahl ist bekannt (`guest_count`,
 *   etwa von der Rezeption am Telefon). Aus "drei Personen" laesst sich
 *   nicht ablesen, wie viele Kinder dabei sind; geraten wird nicht.
 * - `assumedPersonNights` -- gar keine Personenzahl. Dann zaehlt die
 *   Hoechstbelegung der Kategorie. Das ist eine Annahme, und wer sie nicht
 *   will, zieht sie ab.
 *
 * `personNights` ist die Summe der vier.
 *
 * **Nur, was belegt.** Gezaehlt werden die Zustaende der Gruppe `active`
 * wie in der Reservierungsliste (Optional, Confirmed, InHouse, CheckedOut).
 * Eine Anfrage belegt nichts, eine Stornierung und ein No-Show nicht mehr.
 *
 * **Jeder Zeitraum kommt, auch der leere.** Ein Tag ohne Gaeste steht mit
 * Nullen in der Reihe. Sonst verschoebe das Adminpanel bei der Rechnung
 * "Nacht D-1" an einer Luecke um die falsche Zeile.
 *
 * **Aus den Naechten, nicht aus `business_day_stat`.** Die Aufzeichnung des
 * Nachtlaufs kennt keine Personen und keine Zukunft; das Fruehstueck von
 * morgen ist aber genau die Zahl, die die Kueche heute braucht.
 */

/** Ein Jahr und ein Tag, damit ein Schaltjahr in einem Aufruf passt. */
const MAX_TAGE = 366
/** Fuenf Jahre. Seit 2023 sind das zwei Aufrufe. */
const MAX_MONATE = 60

const AKTIV = ['Optional', 'Confirmed', 'InHouse', 'CheckedOut']

interface Zeile {
  period: string
  reservations: number
  roomNights: number
  personNights: number
  adultNights: number
  childNights: number
  unsplitPersonNights: number
  assumedPersonNights: number
}

/** Monate von `from` bis `to`, beide eingeschlossen. */
function monate(from: string, to: string): number {
  const [jv, mv] = from.split('-').map(Number) as [number, number]
  const [jb, mb] = to.split('-').map(Number) as [number, number]
  return (jb * 12 + mb) - (jv * 12 + mv) + 1
}

export function occupancyStatsRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/stats/occupancy',
    permission: 'report:operational',
    propertyParam: 'propertyId',
    summary: 'Reservierungen, Zimmer- und Personennaechte je Tag oder Monat',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const q = req.query as { from?: string; to?: string; granularity?: string }

      if (q.from === undefined || !isIsoDate(q.from)) {
        throw Errors.validation({ from: ['field.isoDate'] })
      }
      if (q.to === undefined || !isIsoDate(q.to)) {
        throw Errors.validation({ to: ['field.isoDate'] })
      }
      if (q.to < q.from) throw Errors.validation({ to: ['field.onOrAfterFrom'] })
      const granularity = q.granularity ?? 'day'
      if (granularity !== 'day' && granularity !== 'month') {
        throw Errors.validation({ granularity: ['field.allowedValues'] },
          { values: 'day, month' })
      }
      if (granularity === 'day' && nightsBetween(q.from, q.to) + 1 > MAX_TAGE) {
        throw Errors.rangeTooLarge(MAX_TAGE)
      }
      if (granularity === 'month' && monate(q.from, q.to) > MAX_MONATE) {
        throw Errors.rangeTooLargeMonths(MAX_MONATE)
      }

      return tx(req.pool, req, async client => {
        /*
         * Ein Verbund ueber die Naechte des Zeitraums, gruppiert nach Tag
         * oder Monat. Fuenf Jahre eines grossen Hauses sind so ein Scan ueber
         * den Index (property_id, date), keine Abfrage je Zeitraum.
         */
        const { rows } = await client.query<Zeile>(
          `WITH tage AS (
             SELECT d::date AS tag
               FROM generate_series($2::date, $3::date, interval '1 day') d
           ),
           naechte AS (
             SELECT n.date, n.reservation_id, r.adults, r.children,
                    r.guest_count, c.max_occupancy
               FROM reservation_night n
               JOIN reservation r       ON r.id = n.reservation_id
               JOIN resource_category c ON c.id = r.category_id
              WHERE n.property_id = $1
                AND n.date BETWEEN $2::date AND $3::date
                AND r.status::text = ANY ($5::text[])
           )
           SELECT CASE WHEN $4 = 'month' THEN to_char(t.tag, 'YYYY-MM')
                       ELSE t.tag::text END                         AS period,
                  count(DISTINCT x.reservation_id)::int              AS reservations,
                  count(x.reservation_id)::int                       AS "roomNights",
                  COALESCE(sum(COALESCE(x.guest_count, x.max_occupancy)), 0)::int
                                                                     AS "personNights",
                  COALESCE(sum(x.adults), 0)::int                    AS "adultNights",
                  COALESCE(sum(x.children), 0)::int                  AS "childNights",
                  COALESCE(sum(x.guest_count) FILTER (WHERE x.adults IS NULL), 0)::int
                                                                     AS "unsplitPersonNights",
                  COALESCE(sum(x.max_occupancy) FILTER (WHERE x.guest_count IS NULL), 0)::int
                                                                     AS "assumedPersonNights"
             FROM tage t
             LEFT JOIN naechte x ON x.date = t.tag
            GROUP BY 1
            ORDER BY 1`,
          [propertyId, q.from, q.to, granularity, AKTIV])

        const summe = (f: keyof Omit<Zeile, 'period' | 'reservations'>) =>
          rows.reduce((s, z) => s + z[f], 0)

        return {
          from: q.from,
          to: q.to,
          granularity,
          periods: rows,
          /*
           * Ohne `reservations`: eine Reservierung ueber den Monatswechsel
           * steht in zwei Zeitraeumen, ihre Summe zaehlte sie doppelt.
           */
          totals: {
            roomNights: summe('roomNights'),
            personNights: summe('personNights'),
            adultNights: summe('adultNights'),
            childNights: summe('childNights'),
            unsplitPersonNights: summe('unsplitPersonNights'),
            assumedPersonNights: summe('assumedPersonNights')
          }
        }
      })
    }
  })
}
