import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import { applyAction, InvalidTransitionError, eachNight, nightsBetween,
         isIsoDate, type ReservationStatus, type ReservationAction } from '@hotelpms/domain'
import type { Principal } from '../platform/context.js'
import type { PoolClient } from '@hotelpms/db'

interface CreateBooking {
  propertyId: number
  categoryId: number
  arrival: string
  departure: string
  ratePlanId?: number
  guestId?: number
  occupants?: Array<{ guestId?: number; ageAtArrival?: number; isPrimary?: boolean }>
  source?: string
  externalReference?: string
  notes?: string
}

/** Uebersetzt den Fehlercode der Inventarfunktion in eine saubere Antwort. */
function inventoryError(code: string | null): never | void {
  if (code === 'sold_out') throw Errors.soldOut()
  if (code === 'not_materialized') throw Errors.notMaterialized()
  if (code !== null) throw Errors.conflict(`Unbekannter Inventarfehler: ${code}`)
}

async function priceNights(
  client: PoolClient, ratePlanId: number | undefined, nights: string[]
): Promise<number[]> {
  if (!ratePlanId) return nights.map(() => 0)
  const { rows } = await client.query<{ date: string; price_cent: number[] }>(
    `SELECT date::text, price_cent FROM rate_day
      WHERE rate_plan_id = $1 AND date = ANY($2::date[])`, [ratePlanId, nights])
  const byDate = new Map(rows.map(r => [r.date, r.price_cent]))
  return nights.map(n => byDate.get(n)?.[1] ?? byDate.get(n)?.[0] ?? 0)
}

export function reservationRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/bookings',
    permission: 'reservation:write',
    propertyParam: 'propertyId',
    summary: 'Buchung mit einer Reservierung anlegen',
    handler: async (req, reply) => {
      const body = req.body as CreateBooking
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['Kopfzeile erforderlich'] })
      if (!isIsoDate(body.arrival) || !isIsoDate(body.departure)) {
        throw Errors.validation({ arrival: ['Datum im Format YYYY-MM-DD erwartet'] })
      }
      if (nightsBetween(body.arrival, body.departure) <= 0) {
        throw Errors.validation({ departure: ['Muss nach arrival liegen'] })
      }

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key, body)
        if (stored) { reply.status(stored.status); return stored.body }

        // Kontingent zuerst binden. Schlaegt das fehl, wird alles zurueckgerollt.
        const inv = await client.query<{ e: string | null }>(
          `SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
          [body.propertyId, body.categoryId, body.arrival, body.departure])
        inventoryError(inv.rows[0]!.e)

        const booking = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO booking (property_id, booker_guest_id, source, external_reference, created_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING id, public_ref`,
          [body.propertyId, body.guestId ?? null, body.source ?? 'direct',
           body.externalReference ?? null, principal.userId])

        const res = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO reservation
             (property_id, booking_id, category_id, arrival, departure, status,
              rate_plan_id, primary_guest_id, notes, created_by)
           VALUES ($1,$2,$3,$4::date,$5::date,'Confirmed',$6,$7,$8,$9)
           RETURNING id, public_ref`,
          [body.propertyId, booking.rows[0]!.id, body.categoryId, body.arrival, body.departure,
           body.ratePlanId ?? null, body.guestId ?? null, body.notes ?? null, principal.userId])
        const reservationId = res.rows[0]!.id

        const nights = eachNight(body.arrival, body.departure)
        const prices = await priceNights(client, body.ratePlanId, nights)
        for (let i = 0; i < nights.length; i++) {
          await client.query(
            `INSERT INTO reservation_night
               (reservation_id, property_id, date, rate_plan_id, price_cent)
             VALUES ($1,$2,$3::date,$4,$5)`,
            [reservationId, body.propertyId, nights[i], body.ratePlanId ?? null, prices[i]])
        }

        // Personen statt Zaehler: noetig fuer Kurtaxe und Meldeschein.
        const occupants = body.occupants ?? (body.guestId
          ? [{ guestId: body.guestId, isPrimary: true }] : [])
        for (const o of occupants) {
          await client.query(
            `INSERT INTO reservation_occupant
               (property_id, reservation_id, guest_id, age_at_arrival, is_primary)
             VALUES ($1,$2,$3,$4,$5)`,
            [body.propertyId, reservationId, o.guestId ?? null,
             o.ageAtArrival ?? null, o.isPrimary ?? false])
        }

        await client.query(
          `INSERT INTO folio (property_id, reservation_id, guest_id, kind)
           VALUES ($1,$2,$3,'guest')`,
          [body.propertyId, reservationId, body.guestId ?? null])

        const result = {
          bookingRef: booking.rows[0]!.public_ref,
          reservationRef: res.rows[0]!.public_ref,
          arrival: body.arrival,
          departure: body.departure,
          nights: nights.length,
          totalCent: prices.reduce((s, p) => s + p, 0)
        }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  const action = (
    url: string, act: ReservationAction, permission: Parameters<typeof registerRoute>[1]['permission'],
    summary: string
  ) => registerRoute(app, {
    method: 'POST', url, permission, propertyParam: 'propertyId', summary,
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const cur = await client.query<{
          id: number; property_id: number; category_id: number; status: ReservationStatus
          arrival: string; departure: string; resource_id: number | null
        }>(`SELECT id, property_id, category_id, status,
                   arrival::text, departure::text, resource_id
              FROM reservation WHERE public_ref = $1 FOR UPDATE`, [reservationRef])
        if (cur.rowCount === 0) throw Errors.notFound('Reservierung')
        const r = cur.rows[0]!

        let target: ReservationStatus
        try { target = applyAction(r.status, act) }
        catch (e) {
          if (e instanceof InvalidTransitionError) throw Errors.conflict(e.message)
          throw e
        }

        if (act === 'check_in' && r.resource_id === null) {
          throw Errors.unprocessable('Check-in erfordert ein zugewiesenes Zimmer.')
        }

        // Kontingent freigeben, sobald die Reservierung es nicht mehr bindet.
        if (target === 'Canceled' || target === 'NoShow') {
          await client.query(`SELECT inventory_release($1,$2,$3::date,$4::date,1)`,
            [r.property_id, r.category_id, r.arrival, r.departure])
        }
        if (r.status === 'Canceled' && target === 'Confirmed') {
          const inv = await client.query<{ e: string | null }>(
            `SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
            [r.property_id, r.category_id, r.arrival, r.departure])
          inventoryError(inv.rows[0]!.e)
        }

        const stamp = act === 'check_in' ? 'checked_in_at = now(),'
          : act === 'check_out' ? 'checked_out_at = now(),'
          : act === 'cancel' ? 'canceled_at = now(),' : ''
        await client.query(
          `UPDATE reservation SET status = $2, ${stamp} updated_at = now() WHERE id = $1`,
          [r.id, target])

        return { reservationRef, status: target, by: principal.userId }
      })
    }
  })

  action('/v1/reservations/:reservationRef/confirm', 'confirm', 'reservation:write', 'Bestaetigen')
  action('/v1/reservations/:reservationRef/check-in', 'check_in', 'reservation:checkin', 'Check-in')
  action('/v1/reservations/:reservationRef/check-out', 'check_out', 'reservation:checkin', 'Check-out')
  action('/v1/reservations/:reservationRef/cancel', 'cancel', 'reservation:write', 'Stornieren')

  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/assign-unit',
    permission: 'reservation:write',
    summary: 'Zimmer zuweisen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const { resourceId } = req.body as { resourceId: number }
      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number; property_id: number; category_id: number
                                       arrival: string; departure: string }>(
          `SELECT id, property_id, category_id, arrival::text, departure::text
             FROM reservation WHERE public_ref = $1 FOR UPDATE`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('Reservierung')
        const res = r.rows[0]!

        // Out of Order: das Zimmer ist im Zeitraum nicht belegbar.
        const blocked = await client.query(
          `SELECT 1 FROM maintenance_block
            WHERE resource_id = $1 AND kind = 'out_of_order'
              AND from_date < $3::date AND to_date > $2::date LIMIT 1`,
          [resourceId, res.arrival, res.departure])
        if (blocked.rowCount && blocked.rowCount > 0) {
          throw Errors.conflict('Zimmer ist im Zeitraum ausser Betrieb.')
        }

        const taken = await client.query(
          `SELECT 1 FROM reservation
            WHERE resource_id = $1 AND id <> $2
              AND status IN ('Confirmed','InHouse')
              AND arrival < $4::date AND departure > $3::date LIMIT 1`,
          [resourceId, res.id, res.arrival, res.departure])
        if (taken.rowCount && taken.rowCount > 0) {
          throw Errors.conflict('Zimmer ist im Zeitraum bereits belegt.')
        }

        await client.query(
          `UPDATE reservation SET resource_id = $2, updated_at = now() WHERE id = $1`,
          [res.id, resourceId])
        return { reservationRef, resourceId }
      })
    }
  })
}
