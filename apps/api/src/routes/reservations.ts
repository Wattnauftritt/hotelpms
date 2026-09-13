import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import { emitEvent } from '../platform/events.js'
import { loadBlock } from './blocks.js'
import { applyAction, InvalidTransitionError, eachNight, nightsBetween,
         isIsoDate, occupiesInventory,
         type ReservationStatus, type ReservationAction,
         type WebhookEventType } from '@hotelpms/domain'
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
  /** Abruf aus einem Kontingent statt aus dem freien Verkauf. */
  blockRef?: string
}

/** Uebersetzt den Fehlercode der Inventarfunktion in eine saubere Antwort. */
export function inventoryError(code: string | null): never | void {
  if (code === 'sold_out') throw Errors.soldOut()
  if (code === 'not_materialized') throw Errors.notMaterialized()
  if (code !== null) throw Errors.conflict(`Unbekannter Inventarfehler: ${code}`)
}

export async function priceNights(
  client: PoolClient, ratePlanId: number | undefined, nights: string[]
): Promise<number[]> {
  if (!ratePlanId) return nights.map(() => 0)
  const { rows } = await client.query<{ date: string; price_cent: number[] }>(
    `SELECT date::text, price_cent FROM rate_day
      WHERE rate_plan_id = $1 AND date = ANY($2::date[])`, [ratePlanId, nights])
  const byDate = new Map(rows.map(r => [r.date, r.price_cent]))
  return nights.map(n => byDate.get(n)?.[1] ?? byDate.get(n)?.[0] ?? 0)
}

/**
 * Jede Zustandsaktion hat genau eine Ereignisart. Vollstaendig ueber alle
 * Aktionen des Automaten, nicht nur ueber die heute als Route angebotenen:
 * so entscheidet der Typ die Frage mit, sobald eine weitere hinzukommt,
 * statt sie stillschweigend offen zu lassen.
 */
const EVENT_FOR_ACTION: Record<ReservationAction, WebhookEventType> = {
  confirm:   'reservation.changed',
  hold:      'reservation.changed',
  check_in:  'reservation.checked_in',
  check_out: 'reservation.checked_out',
  cancel:    'reservation.canceled',
  no_show:   'reservation.changed',
  reinstate: 'reservation.changed'
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

        /*
         * Abruf aus einem Kontingent. Der Platz ist dann schon gehalten und
         * wandert nur von `blocked` nach `sold`.
         *
         * Der Zeitraum muss dem des Kontingents genau entsprechen. Das ist
         * eine echte Einschraenkung und hat einen Grund: bei einem Teilabruf
         * saenke `blocked` nur an den belegten Naechten, die Freigabe des
         * Rests am Freigabedatum rechnet aber ueber den ganzen Zeitraum. An
         * den uebrigen Naechten bliebe dann dauerhaft Kontingent gebunden,
         * das niemandem mehr gehoert. Wer abweichend bucht, bucht frei.
         */
        const block = body.blockRef === undefined
          ? null
          : await loadBlock(client, body.blockRef)
        if (block !== null) {
          if (block.property_id !== body.propertyId) throw Errors.notFound('Kontingent')
          if (block.status !== 'active') {
            throw Errors.conflict(`Kontingent ist ${block.status} und nicht mehr abrufbar.`)
          }
          if (block.picked_up >= block.quantity) {
            throw Errors.conflict('Kontingent ist vollstaendig abgerufen.')
          }
          if (block.category_id !== body.categoryId) {
            throw Errors.validation({
              categoryId: ['Muss der Zimmergruppe des Kontingents entsprechen'] })
          }
          if (body.arrival !== block.from_date || body.departure !== block.to_date) {
            throw Errors.unprocessable(
              `Ein Abruf laeuft ueber den ganzen Zeitraum des Kontingents `
              + `(${block.from_date} bis ${block.to_date}). Fuer abweichende Naechte `
              + 'eine eigene Reservierung anlegen.')
          }
          /*
           * Erst freigeben, dann binden -- umgekehrt als `inventory_move`,
           * und aus dem umgekehrten Grund: dort haelt noch niemand den Platz,
           * hier haelt ihn das Kontingent bereits. Im vollen Haus schluege
           * ein Binden vor dem Freigeben an der eigenen Reservierung fehl.
           * Ein Fenster entsteht nicht, beides liegt in einer Transaktion.
           */
          await client.query(`SELECT inventory_unblock($1,$2,$3::date,$4::date,1)`,
            [body.propertyId, block.category_id, block.from_date, block.to_date])
        }

        // Kontingent zuerst binden. Schlaegt das fehl, wird alles zurueckgerollt.
        const inv = await client.query<{ e: string | null }>(
          `SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
          [body.propertyId, body.categoryId, body.arrival, body.departure])
        inventoryError(inv.rows[0]!.e)

        if (block !== null) {
          await client.query(
            `UPDATE availability_block SET picked_up = picked_up + 1 WHERE id = $1`,
            [block.id])
        }

        const booking = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO booking (property_id, booker_guest_id, source, external_reference, created_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING id, public_ref`,
          [body.propertyId, body.guestId ?? null, body.source ?? 'direct',
           body.externalReference ?? null, principal.userId])

        // Der Ratenplan des Kontingents gilt, wenn keiner genannt ist: eine
        // Gruppe hat ihren Preis vereinbart, und ihn je Abruf erneut
        // eintippen zu lassen, waere die Stelle, an der er abweicht.
        const ratePlanId = body.ratePlanId ?? block?.rate_plan_id ?? undefined

        const res = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO reservation
             (property_id, booking_id, category_id, arrival, departure, status,
              rate_plan_id, primary_guest_id, notes, block_id, created_by)
           VALUES ($1,$2,$3,$4::date,$5::date,'Confirmed',$6,$7,$8,$9,$10)
           RETURNING id, public_ref`,
          [body.propertyId, booking.rows[0]!.id, body.categoryId, body.arrival, body.departure,
           ratePlanId ?? null, body.guestId ?? null, body.notes ?? null,
           block?.id ?? null, principal.userId])
        const reservationId = res.rows[0]!.id

        const nights = eachNight(body.arrival, body.departure)
        const prices = await priceNights(client, ratePlanId, nights)
        for (let i = 0; i < nights.length; i++) {
          await client.query(
            `INSERT INTO reservation_night
               (reservation_id, property_id, date, rate_plan_id, price_cent)
             VALUES ($1,$2,$3::date,$4,$5)`,
            [reservationId, body.propertyId, nights[i], ratePlanId ?? null, prices[i]])
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

        await emitEvent(client, body.propertyId, 'reservation.created', {
          reservationRef: result.reservationRef,
          bookingRef: result.bookingRef,
          status: 'Confirmed',
          arrival: body.arrival,
          departure: body.departure,
          categoryId: body.categoryId,
          source: body.source ?? 'direct',
          externalReference: body.externalReference ?? null,
          blockRef: body.blockRef ?? null,
          totalCent: result.totalCent
        })

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
          block_id: number | null
        }>(`SELECT id, property_id, category_id, status,
                   arrival::text, departure::text, resource_id, block_id
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

        /*
         * Ein abgerufener Platz faellt an die Gruppe zurueck, nicht in den
         * freien Verkauf.
         *
         * Sonst verloere eine Gruppe bei jedem Storno ein Zimmer an
         * Laufkundschaft und stuende am Anreisetag mit zu wenigen da, obwohl
         * sie dieselbe Menge vereinbart hatte. Ist das Kontingent bereits
         * freigegeben, gibt es nichts mehr, wohin der Platz zurueckkoennte;
         * dann ist der freie Verkauf richtig.
         */
        const block = r.block_id === null
          ? null
          : (await client.query<{ id: number; status: string; category_id: number
                                  from_date: string; to_date: string }>(
              `SELECT id, status, category_id, from_date::text, to_date::text
                 FROM availability_block WHERE id = $1 FOR UPDATE`, [r.block_id])).rows[0] ?? null

        // Kontingent freigeben, sobald die Reservierung es nicht mehr bindet.
        if (target === 'Canceled' || target === 'NoShow') {
          await client.query(`SELECT inventory_release($1,$2,$3::date,$4::date,1)`,
            [r.property_id, r.category_id, r.arrival, r.departure])
          if (block !== null && block.status === 'active') {
            await client.query(`SELECT inventory_block($1,$2,$3::date,$4::date,1)`,
              [r.property_id, block.category_id, block.from_date, block.to_date])
            await client.query(
              `UPDATE availability_block SET picked_up = picked_up - 1 WHERE id = $1`,
              [block.id])
          }
        }
        if (r.status === 'Canceled' && target === 'Confirmed') {
          // Wiederherstellung: derselbe Weg wie beim Abruf, erst freigeben,
          // dann binden.
          if (block !== null && block.status === 'active') {
            await client.query(`SELECT inventory_unblock($1,$2,$3::date,$4::date,1)`,
              [r.property_id, block.category_id, block.from_date, block.to_date])
          }
          const inv = await client.query<{ e: string | null }>(
            `SELECT inventory_reserve($1,$2,$3::date,$4::date,1) AS e`,
            [r.property_id, r.category_id, r.arrival, r.departure])
          inventoryError(inv.rows[0]!.e)
          if (block !== null && block.status === 'active') {
            await client.query(
              `UPDATE availability_block SET picked_up = picked_up + 1 WHERE id = $1`,
              [block.id])
          }
        }

        const stamp = act === 'check_in' ? 'checked_in_at = now(),'
          : act === 'check_out' ? 'checked_out_at = now(),'
          : act === 'cancel' ? 'canceled_at = now(),' : ''
        await client.query(
          `UPDATE reservation SET status = $2, ${stamp} updated_at = now() WHERE id = $1`,
          [r.id, target])

        await emitEvent(client, r.property_id, EVENT_FOR_ACTION[act], {
          reservationRef, status: target,
          arrival: r.arrival, departure: r.departure,
          categoryId: r.category_id, resourceId: r.resource_id
        })

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

        await emitEvent(client, res.property_id, 'reservation.changed', {
          reservationRef, resourceId,
          arrival: res.arrival, departure: res.departure,
          categoryId: res.category_id
        })

        return { reservationRef, resourceId }
      })
    }
  })

  /**
   * Aufenthalt ändern: Verlängerung, Verkürzung, Kategoriewechsel, einzeln
   * oder zusammen (E11, Dokument 13).
   *
   * Der Fall, der diese Route nötig macht: der Gast bleibt länger, seine
   * Kategorie ist aber ausgebucht, eine andere frei. Das ist eine
   * Verlängerung **plus** einen Umzug, und beides muss zusammen gelingen
   * oder zusammen scheitern.
   *
   * Zwei Aufrufe hintereinander wären falsch, nicht nur unbequem: zwischen
   * Freigeben und Neubelegen ist das Kontingent frei, und genau dann kauft
   * es das Portal. Der Gast verlöre sein Zimmer, obwohl er es schon hatte.
   * `inventory_move` bindet deshalb zuerst und gibt erst danach frei.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/change-stay',
    permission: 'reservation:write',
    summary: 'Aufenthalt verlaengern, verkuerzen oder umbuchen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const body = req.body as {
        arrival?: string; departure?: string; categoryId?: number; ratePlanId?: number }

      return tx(req.pool, req, async client => {
        const cur = await client.query<{
          id: number; property_id: number; category_id: number; status: ReservationStatus
          arrival: string; departure: string; resource_id: number | null
          rate_plan_id: number | null; block_id: number | null }>(
          `SELECT id, property_id, category_id, status, arrival::text, departure::text,
                  resource_id, rate_plan_id, block_id
             FROM reservation WHERE public_ref = $1 FOR UPDATE`, [reservationRef])
        if (cur.rowCount === 0) throw Errors.notFound('Reservierung')
        const r = cur.rows[0]!

        /*
         * Ein Abruf laeuft ueber den Zeitraum seines Kontingents. Waere er
         * verschiebbar, stimmte die Rechnung beim Freigeben des Rests nicht
         * mehr: sie geht ueber den Zeitraum des Kontingents, nicht den der
         * einzelnen Reservierung. Wer anders buchen will, storniert den Abruf
         * und legt eine freie Reservierung an.
         */
        if (r.block_id !== null) {
          throw Errors.conflict(
            'Ein Abruf aus einem Kontingent laesst sich nicht verschieben. '
            + 'Abruf stornieren und frei neu buchen.')
        }

        if (!occupiesInventory(r.status)) {
          throw Errors.conflict(
            `Eine Reservierung im Zustand ${r.status} bindet kein Kontingent und `
            + 'laesst sich nicht aendern.')
        }

        const neuAnkunft = body.arrival ?? r.arrival
        const neuAbreise = body.departure ?? r.departure
        const neuKategorie = body.categoryId ?? r.category_id
        if (!isIsoDate(neuAnkunft) || !isIsoDate(neuAbreise)) {
          throw Errors.validation({ arrival: ['Datum im Format YYYY-MM-DD erwartet'] })
        }
        if (nightsBetween(neuAnkunft, neuAbreise) <= 0) {
          throw Errors.validation({ departure: ['Muss nach arrival liegen'] })
        }
        // Bei InHouse ist die Anreise geschehen und nicht mehr verschiebbar.
        if (r.status === 'InHouse' && neuAnkunft !== r.arrival) {
          throw Errors.conflict('Die Anreise eines Gastes im Haus laesst sich nicht verlegen.')
        }
        if (neuKategorie !== r.category_id) {
          const k = await client.query(
            `SELECT 1 FROM resource_category WHERE id = $1 AND property_id = $2`,
            [neuKategorie, r.property_id])
          if (k.rowCount === 0) throw Errors.notFound('Zimmergruppe')
        }

        const inv = await client.query<{ e: string | null }>(
          `SELECT inventory_move($1,$2,$3::date,$4::date,$5,$6::date,$7::date) AS e`,
          [r.property_id, r.category_id, r.arrival, r.departure,
           neuKategorie, neuAnkunft, neuAbreise])
        inventoryError(inv.rows[0]!.e)

        // Bei Kategoriewechsel passt das zugewiesene Zimmer nicht mehr. Es
        // stehen zu lassen waere schlimmer als es zu entfernen: die
        // Hausliste zeigte dann ein Zimmer der falschen Gruppe.
        const zimmerBleibt = neuKategorie === r.category_id
        await client.query(
          `UPDATE reservation
              SET arrival = $2::date, departure = $3::date, category_id = $4,
                  rate_plan_id = COALESCE($5, rate_plan_id),
                  resource_id = CASE WHEN $6 THEN resource_id ELSE NULL END,
                  updated_at = now()
            WHERE id = $1`,
          [r.id, neuAnkunft, neuAbreise, neuKategorie, body.ratePlanId ?? null, zimmerBleibt])

        /*
         * Naechte fortschreiben. Bereits gebuchte Naechte bleiben unberuehrt:
         * an ihnen haengen Belege, und `posted` sagt, dass die Logis schon
         * auf dem Folio steht. Entfernt werden nur ungebuchte Naechte
         * ausserhalb des neuen Zeitraums.
         */
        const entfernt = await client.query(
          `DELETE FROM reservation_night
            WHERE reservation_id = $1 AND NOT posted
              AND (date < $2::date OR date >= $3::date)`,
          [r.id, neuAnkunft, neuAbreise])

        const nights = eachNight(neuAnkunft, neuAbreise)
        const planId = body.ratePlanId ?? r.rate_plan_id ?? undefined
        const prices = await priceNights(client, planId, nights)
        for (let i = 0; i < nights.length; i++) {
          await client.query(
            `INSERT INTO reservation_night
               (reservation_id, property_id, date, rate_plan_id, price_cent)
             VALUES ($1,$2,$3::date,$4,$5)
             ON CONFLICT (reservation_id, date) DO NOTHING`,
            [r.id, r.property_id, nights[i], planId ?? null, prices[i]])
        }

        const summe = await client.query<{ n: number; total: number }>(
          `SELECT count(*)::int AS n, COALESCE(sum(price_cent),0)::bigint AS total
             FROM reservation_night WHERE reservation_id = $1`, [r.id])

        await emitEvent(client, r.property_id, 'reservation.changed', {
          reservationRef, status: r.status,
          arrival: neuAnkunft, departure: neuAbreise,
          categoryId: neuKategorie,
          previousArrival: r.arrival, previousDeparture: r.departure,
          previousCategoryId: r.category_id,
          nights: summe.rows[0]!.n,
          totalCent: Number(summe.rows[0]!.total)
        })

        return {
          reservationRef,
          arrival: neuAnkunft,
          departure: neuAbreise,
          categoryId: neuKategorie,
          // Beim Kategoriewechsel faellt die Zimmerzuweisung weg und muss
          // neu erfolgen. Das gehoert in die Antwort, nicht in eine Fussnote.
          roomAssignmentCleared: !zimmerBleibt && r.resource_id !== null,
          nights: summe.rows[0]!.n,
          removedNights: entfernt.rowCount ?? 0,
          totalCent: Number(summe.rows[0]!.total)
        }
      })
    }
  })
}