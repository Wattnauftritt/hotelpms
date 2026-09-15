import { randomBytes } from 'node:crypto'
import { hash as argonHash } from '@node-rs/argon2'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { withTransaction } from '@hotelpms/db'
import { isIsoDate, nightsBetween, eachNight } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { emitEvent } from '../platform/events.js'
import { authenticateChannel, channelContext } from '../platform/channelAuth.js'
import type { Principal } from '../platform/context.js'
import { inventoryError, priceNights } from './reservations.js'

/** Ein Jahr je Anfrage, wie bei der Verfuegbarkeit fuer die Oberflaeche. */
const MAX_ARI_DAYS = 400

function ariRange(req: FastifyRequest): { from: string; to: string; since: string | null } {
  const q = req.query as { from?: string; to?: string; since?: string }
  if (!q.from || !q.to || !isIsoDate(q.from) || !isIsoDate(q.to)) {
    throw Errors.validation({ from: ['field.isoDate'] })
  }
  const days = nightsBetween(q.from, q.to)
  if (days <= 0) throw Errors.validation({ to: ['field.afterFrom'] })
  if (days > MAX_ARI_DAYS) throw Errors.rangeTooLarge(MAX_ARI_DAYS)
  if (q.since !== undefined && Number.isNaN(Date.parse(q.since))) {
    throw Errors.validation({ since: ['field.isoTimestamp'] })
  }
  return { from: q.from, to: q.to, since: q.since ?? null }
}

interface InboundBooking {
  externalReference: string
  categoryCode: string
  arrival: string
  departure: string
  ratePlanCode?: string
  guestId?: number
  guest?: { firstName?: string; lastName: string; email?: string; phone?: string }
  notes?: string
}

export function channelRoutes(app: FastifyInstance): void {
  // ---------------------------------------------------------------------
  // Verwaltung der Verbindung, durch das Personal, mit Sitzung.
  // ---------------------------------------------------------------------

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/channel-connections',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Zugang fuer einen Channel Manager anlegen',
    handler: async (req, reply) => {
      const { propertyId } = req.params as { propertyId: string }
      const body = req.body as { provider: string; name: string }
      if (body.provider !== 'roomcloud') {
        throw Errors.validation({ provider: ['field.onlyRoomcloud'] })
      }
      if (!body.name) throw Errors.validation({ name: ['field.required'] })
      const principal = req.principal as Principal

      // Das Geheimnis wird nur diesmal ausgegeben. Gespeichert wird der Hash,
      // genau wie beim Kennwort (auth.ts) - aus demselben Grund.
      const secret = randomBytes(24).toString('base64url')
      const tokenHash = await argonHash(secret, { memoryCost: 19_456, timeCost: 2, parallelism: 1 })

      return tx(req.pool, req, async client => {
        const prop = await client.query<{ account_id: number }>(
          `SELECT account_id FROM property WHERE id = $1`, [Number(propertyId)])
        if (prop.rowCount === 0) throw Errors.notFound('res.property')

        const r = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO channel_connection
             (property_id, account_id, provider, name, token_hash, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, public_ref`,
          [Number(propertyId), prop.rows[0]!.account_id, body.provider, body.name, tokenHash,
           principal.userId])
        reply.status(201)
        return { connectionRef: r.rows[0]!.public_ref, token: `${r.rows[0]!.public_ref}.${secret}` }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/channel-connections',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Zugaenge fuer Channel Manager auflisten',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `SELECT public_ref AS "connectionRef", provider, name, status,
                  last_used_at AS "lastUsedAt", created_at AS "createdAt"
             FROM channel_connection WHERE property_id = $1 ORDER BY created_at`,
          [Number(propertyId)])
        return { connections: rows }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/channel-connections/:connectionRef/disable',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Zugang fuer einen Channel Manager sperren',
    handler: async (req) => {
      const { propertyId, connectionRef } = req.params as
        { propertyId: string; connectionRef: string }
      return tx(req.pool, req, async client => {
        // channel_connection hat keine Zeilenrichtlinie (siehe 0022): die
        // Property aus der URL wird hier zusaetzlich geprueft, nicht nur ueber
        // registerRoute's propertyParam gegen den Principal.
        const r = await client.query(
          `UPDATE channel_connection SET status = 'disabled'
            WHERE public_ref = $1 AND property_id = $2 RETURNING id`,
          [connectionRef, Number(propertyId)])
        if (r.rowCount === 0) throw Errors.notFound('res.connection')
        return { ok: true }
      })
    }
  })

  // ---------------------------------------------------------------------
  // ARI selbst, durch den Channel Manager, mit Verbindungstoken statt
  // Sitzung. Deshalb permission: null - die Absicherung ist die
  // Signaturpruefung des Tokens, nicht der Berechtigungskatalog.
  // ---------------------------------------------------------------------

  registerRoute(app, {
    method: 'GET',
    url: '/v1/channel/ari/availability',
    permission: null,
    summary: 'Verfuegbarkeit je Kategorie und Tag, voll oder als Aenderung seit einem Zeitpunkt',
    handler: async (req) => {
      const principal = await authenticateChannel(req.pool, req.headers.authorization)
      const { from, to, since } = ariRange(req)

      const rows = await withTransaction(req.pool, channelContext(principal), client =>
        client.query(
          `SELECT rc.code AS "categoryCode", d.date::text,
                  d.capacity, d.sold, d.blocked, d.overbooking,
                  d.capacity - d.sold - d.blocked + d.overbooking AS available,
                  d.updated_at AS "updatedAt"
             FROM inventory_day d
             JOIN resource_category rc ON rc.id = d.category_id
            WHERE d.property_id = $1 AND d.date >= $2::date AND d.date < $3::date
              AND ($4::timestamptz IS NULL OR d.updated_at >= $4::timestamptz)
            ORDER BY rc.code, d.date`,
          [principal.propertyId, from, to, since]))
      return { from, to, generatedAt: new Date().toISOString(), days: rows.rows }
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/channel/ari/rates',
    permission: null,
    summary: 'Preise und Restriktionen je Ratenplan und Tag, voll oder als Aenderung',
    handler: async (req) => {
      const principal = await authenticateChannel(req.pool, req.headers.authorization)
      const { from, to, since } = ariRange(req)

      const rows = await withTransaction(req.pool, channelContext(principal), client =>
        client.query(
          `SELECT rc.code AS "categoryCode", rp.code AS "ratePlanCode",
                  d.day::date::text AS date,
                  rd.price_cent AS "priceCent",
                  rs.min_los AS "minLos", rs.max_los AS "maxLos",
                  COALESCE(rs.closed, false) AS closed,
                  COALESCE(rs.closed_to_arrival, false) AS "closedToArrival",
                  COALESCE(rs.closed_to_departure, false) AS "closedToDeparture",
                  GREATEST(rd.updated_at, rs.updated_at) AS "updatedAt"
             FROM rate_plan rp
             JOIN resource_category rc ON rc.id = rp.category_id
             CROSS JOIN generate_series($2::date, $3::date - interval '1 day', interval '1 day')
                     AS d(day)
             LEFT JOIN rate_day rd ON rd.rate_plan_id = rp.id AND rd.date = d.day::date
             LEFT JOIN restriction_day rs ON rs.rate_plan_id = rp.id AND rs.date = d.day::date
            WHERE rp.property_id = $1 AND rp.active
              AND ($4::timestamptz IS NULL
                   OR rd.updated_at >= $4::timestamptz OR rs.updated_at >= $4::timestamptz)
            ORDER BY rc.code, rp.code, d.day`,
          [principal.propertyId, from, to, since]))
      return { from, to, generatedAt: new Date().toISOString(), cells: rows.rows }
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/channel/ari/bookings',
    permission: null,
    summary: 'Reservierung eines Channel Managers anlegen',
    handler: async (req, reply) => {
      const principal = await authenticateChannel(req.pool, req.headers.authorization)
      const body = req.body as InboundBooking

      if (!body.externalReference) {
        throw Errors.validation({ externalReference: ['field.required'] })
      }
      if (!body.categoryCode) throw Errors.validation({ categoryCode: ['field.required'] })
      if (!isIsoDate(body.arrival) || !isIsoDate(body.departure)) {
        throw Errors.validation({ arrival: ['field.isoDate'] })
      }
      if (nightsBetween(body.arrival, body.departure) <= 0) {
        throw Errors.validation({ departure: ['field.afterArrival'] })
      }

      const result = await withTransaction(req.pool, channelContext(principal), async client => {
        const cat = await client.query<{ id: number }>(
          `SELECT id FROM resource_category WHERE property_id = $1 AND code = $2 AND active`,
          [principal.propertyId, body.categoryCode])
        if (cat.rowCount === 0) throw Errors.validation({ categoryCode: ['field.unknownCategory'] })
        const categoryId = cat.rows[0]!.id

        let ratePlanId: number | undefined
        if (body.ratePlanCode) {
          const rp = await client.query<{ id: number }>(
            `SELECT id FROM rate_plan WHERE property_id = $1 AND code = $2 AND active`,
            [principal.propertyId, body.ratePlanCode])
          if (rp.rowCount === 0) throw Errors.validation({ ratePlanCode: ['field.unknownRatePlan'] })
          ratePlanId = rp.rows[0]!.id
        }

        // Kontingent zuerst binden, wie bei jeder Buchung (reservations.ts).
        // Bei einer Dublette (unten) wird genau diese Bindung wieder
        // freigegeben - der zweite Eingang bindet nichts dauerhaft doppelt.
        const inv = await client.query<{ e: string | null }>(
          `SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
          [principal.propertyId, categoryId, body.arrival, body.departure])
        inventoryError(inv.rows[0]!.e)

        const inserted = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO booking (property_id, source, channel_code, external_reference)
           VALUES ($1,'channel',$2,$3)
           ON CONFLICT (property_id, external_reference) WHERE external_reference IS NOT NULL
           DO NOTHING
           RETURNING id, public_ref`,
          [principal.propertyId, principal.provider, body.externalReference])

        if (inserted.rowCount === 0) {
          // Zweiter Eingang derselben externen Nummer: die eben gebundene
          // Einheit gehoert nicht dieser Anfrage, sie war schon vergeben.
          await client.query(`SELECT inventory_release($1,$2,$3::date,$4::date,1)`,
            [principal.propertyId, categoryId, body.arrival, body.departure])

          const existing = await client.query<{
            booking_ref: string; reservation_ref: string; arrival: string; departure: string
            total_cent: string
          }>(
            `SELECT b.public_ref AS booking_ref, r.public_ref AS reservation_ref,
                    r.arrival::text, r.departure::text,
                    (SELECT COALESCE(sum(price_cent), 0) FROM reservation_night
                      WHERE reservation_id = r.id) AS total_cent
               FROM booking b JOIN reservation r ON r.booking_id = b.id
              WHERE b.property_id = $1 AND b.external_reference = $2
              LIMIT 1`,
            [principal.propertyId, body.externalReference])
          if (existing.rowCount === 0) {
            // Kann nur passieren, wenn der urspruengliche Aufruf noch nicht
            // fertig ist (Wettlauf) oder sein Fehlschlag den Konflikt nicht
            // geloescht hat; beides ist ein Grund, es dem Anbieter zu sagen,
            // statt eine erfundene Antwort zu liefern.
            throw Errors.conflict(
              'channel.referenceInFlight')
          }
          const e = existing.rows[0]!
          return {
            status: 'already_exists' as const, bookingRef: e.booking_ref,
            reservationRef: e.reservation_ref, arrival: e.arrival, departure: e.departure,
            nights: nightsBetween(e.arrival, e.departure), totalCent: Number(e.total_cent)
          }
        }

        const res = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO reservation
             (property_id, booking_id, category_id, arrival, departure, status,
              rate_plan_id, primary_guest_id, notes)
           VALUES ($1,$2,$3,$4::date,$5::date,'Confirmed',$6,$7,$8)
           RETURNING id, public_ref`,
          [principal.propertyId, inserted.rows[0]!.id, categoryId, body.arrival, body.departure,
           ratePlanId ?? null, body.guestId ?? null, body.notes ?? null])
        const reservationId = res.rows[0]!.id

        const nights = eachNight(body.arrival, body.departure)
        const prices = await priceNights(client, ratePlanId, nights)
        for (let i = 0; i < nights.length; i++) {
          await client.query(
            `INSERT INTO reservation_night
               (reservation_id, property_id, date, rate_plan_id, price_cent)
             VALUES ($1,$2,$3::date,$4,$5)`,
            [reservationId, principal.propertyId, nights[i], ratePlanId ?? null, prices[i]])
        }

        // Der Gast kommt entweder als vorhandene Kennung (bereits ueber die
        // Gaeste-Schnittstelle angelegt und abgeglichen) oder als Rohdaten des
        // Channel Managers. Im zweiten Fall wird er ohne Dublettenpruefung
        // angelegt - die uebernimmt guests.ts fuer den Zusammenfuehrungsfall,
        // das nachzubilden ist nicht Teil dieser Aufgabe.
        let guestId = body.guestId ?? null
        if (body.guestId === undefined && body.guest?.lastName) {
          const g = await client.query<{ id: number }>(
            `INSERT INTO guest (account_id, last_name, first_name, email, phone)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [principal.accountId, body.guest.lastName, body.guest.firstName ?? null,
             body.guest.email ?? null, body.guest.phone ?? null])
          guestId = g.rows[0]!.id
          await client.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
            [reservationId, guestId])
        }
        if (guestId !== null) {
          await client.query(
            `INSERT INTO reservation_occupant (property_id, reservation_id, guest_id, is_primary)
             VALUES ($1,$2,$3,true)`,
            [principal.propertyId, reservationId, guestId])
        }

        await client.query(
          `INSERT INTO folio (property_id, reservation_id, guest_id, kind)
           VALUES ($1,$2,$3,'guest')`,
          [principal.propertyId, reservationId, guestId])

        const totalCent = prices.reduce((s, p) => s + p, 0)
        await emitEvent(client, principal.propertyId, 'reservation.created', {
          reservationRef: res.rows[0]!.public_ref,
          bookingRef: inserted.rows[0]!.public_ref,
          status: 'Confirmed',
          arrival: body.arrival, departure: body.departure,
          categoryId, source: 'channel', externalReference: body.externalReference,
          totalCent
        })

        return {
          status: 'created' as const, bookingRef: inserted.rows[0]!.public_ref,
          reservationRef: res.rows[0]!.public_ref, arrival: body.arrival,
          departure: body.departure, nights: nights.length, totalCent
        }
      })

      reply.status(result.status === 'created' ? 201 : 200)
      return result
    }
  })
}
