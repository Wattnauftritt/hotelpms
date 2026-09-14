import type { FastifyInstance, FastifyRequest } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { nightsBetween, isIsoDate } from '@hotelpms/domain'

const MAX_AVAILABILITY_DAYS = 731   // P6, Dokument 12
const MAX_TAPE_CHART_DAYS = 92

function range(req: FastifyRequest, max: number): { from: string; to: string } {
  const q = req.query as { from?: string; to?: string }
  if (!q.from || !q.to || !isIsoDate(q.from) || !isIsoDate(q.to)) {
    throw Errors.validation({ from: ['Datum im Format YYYY-MM-DD erwartet'] })
  }
  const days = nightsBetween(q.from, q.to)
  if (days <= 0) throw Errors.validation({ to: ['Muss nach from liegen'] })
  if (days > max) throw Errors.rangeTooLarge(max)
  return { from: q.from, to: q.to }
}

export function availabilityRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/availability',
    permission: 'reservation:read',
    propertyParam: 'propertyId',
    summary: 'Verfuegbarkeit je Kategorie und Tag',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const { from, to } = range(req, MAX_AVAILABILITY_DAYS)
      // Eine Abfrage, unabhaengig von der Zahl der Reservierungen.
      const rows = await tx(req.pool, req, client => client.query(
        `SELECT category_id, date::text,
                capacity, sold, blocked, overbooking,
                capacity - sold - blocked + overbooking AS available
           FROM inventory_day
          WHERE property_id = $1 AND date >= $2::date AND date < $3::date
          ORDER BY category_id, date`,
        [Number(propertyId), from, to]))
      return { days: rows.rows }
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/tape-chart',
    permission: 'reservation:read',
    propertyParam: 'propertyId',
    summary: 'Zimmerplan fuer einen Bildschirm',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const { from, to } = range(req, MAX_TAPE_CHART_DAYS)
      const pid = Number(propertyId)

      // Genau drei Abfragen, unabhaengig von Haus- und Belegungsgroesse.
      // Ein Aggregat-Endpunkt statt 400 Einzelaufrufen durch den Client.
      return tx(req.pool, req, async client => {
        const units = await client.query(
          `SELECT r.id, r.code, r.floor, r.category_id, c.name AS category_name,
                  c.sort_order
             FROM resource r
             JOIN resource_category c ON c.id = r.category_id
            WHERE r.property_id = $1 AND r.active
            ORDER BY c.sort_order, r.code`, [pid])

        const reservations = await client.query(
          `SELECT r.id, r.public_ref, r.resource_id, r.category_id,
                  r.arrival::text, r.departure::text, r.status,
                  g.last_name, g.first_name,
                  -- Die Notiz gehoert auf den Balken, wenigstens als
                  -- Merkmal: die Rezeption haelt hier fest, was beim
                  -- naechsten Blick auf den Plan zaehlt ("Spaetanreise",
                  -- "Hochzeitstag"). Eine Notiz, die man erst nach zwei
                  -- Klicks sieht, wird nicht geschrieben.
                  r.notes,
                  b.source, b.external_reference,
                  rp.code AS rate_code,
                  (SELECT count(*) FROM reservation_occupant o
                    WHERE o.reservation_id = r.id) AS occupants
             FROM reservation r
             JOIN booking b ON b.id = r.booking_id
             LEFT JOIN guest g ON g.id = r.primary_guest_id
             LEFT JOIN rate_plan rp ON rp.id = r.rate_plan_id
            WHERE r.property_id = $1
              AND r.arrival < $3::date AND r.departure > $2::date
              AND r.status IN ('Optional','Confirmed','InHouse')`, [pid, from, to])

        const blocks = await client.query(
          /*
           * `::text` ist hier nicht Geschmackssache. Eine `date`-Spalte kommt
           * ohne den Cast als `Date` zurueck und wird als voller Zeitstempel
           * serialisiert; die Oberflaeche rechnet damit `NaN` und setzt jeden
           * Balken auf `left: NaN`. Der Zimmerplan zeigte dann kein einziges
           * belegtes Zimmer, ohne dass irgendwo ein Fehler auftrat. Und ein
           * Zeitstempel verschiebt das Kalenderdatum je nach Zeitzone um
           * einen Tag (CLAUDE.md, "Geld und Datum").
           */
          `SELECT resource_id, from_date::text, to_date::text, kind, reason
             FROM maintenance_block
            WHERE property_id = $1 AND from_date < $3::date AND to_date > $2::date`,
          [pid, from, to])

        return { from, to, units: units.rows, reservations: reservations.rows, blocks: blocks.rows }
      })
    }
  })
}
