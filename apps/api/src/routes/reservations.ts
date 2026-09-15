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

/**
 * Obergrenze der Notiz. Nicht als Schikane, sondern weil ein Freitextfeld
 * ohne Grenze frueher oder spaeter einen Roman enthaelt, den niemand liest
 * und der jede Antwort aufblaeht, in der die Reservierung vorkommt.
 */
const NOTES_MAX_LENGTH = 2000

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
  /**
   * Zimmer gleich mit zuweisen.
   *
   * Fuer den Belegungsplan: wer dort ueber Zimmer 101 aufzieht, will die
   * Buchung **in** 101 haben, nicht in irgendeinem Zimmer der Gruppe. Ohne
   * dieses Feld braeuchte es zwei Aufrufe -- buchen, dann zuweisen -- mit
   * einem Fenster dazwischen, in dem ein zweiter Vorgang dasselbe Zimmer
   * belegt. Der Gast haette dann eine Reservierung ohne das Zimmer, das die
   * Rezeption ihm gerade zugesagt hat.
   */
  resourceId?: number
}

/**
 * Darf diese Reservierung in dieses Zimmer?
 *
 * Drei Fragen, und jede einzelne hat einen Grund:
 *
 * **Gehoert das Zimmer zu diesem Haus?** Die Zeilenrichtlinie filtert nach
 * Mandant, nicht nach Haus -- CLAUDE.md, "Bei mehreren Haeusern im Account
 * reicht die Zeilenrichtlinie nicht".
 *
 * Wichtig ist, wann das zuschlaegt, denn es verfuehrt dazu, die Pruefung fuer
 * ueberfluessig zu halten: bei einem Benutzer mit **einem** Haus faengt die
 * Richtlinie es ab, das fremde Zimmer ist fuer ihn nicht sichtbar. Hat er
 * dagegen Zugriff auf **beide** Haeuser -- in einer Kette der Normalfall --,
 * steht es in seinem Kontext, und `assign-unit` nahm es bis hierher an. Die
 * Reservierung in Haus A trug dann ein Zimmer aus Haus B, und der
 * Belegungsplan von Haus A zeigte sie gar nicht mehr, weil das Zimmer dort
 * nicht vorkommt. Zwei Tests halten genau diese Besetzung fest.
 *
 * **Ist es ausser Betrieb?** Out of Order heisst unbelegbar.
 *
 * **Liegt schon jemand darin?** Der Bestandszaehler rechnet je Gruppe, nicht
 * je Zimmer; zwei Reservierungen im selben Zimmer waeren rechnerisch in
 * Ordnung und im Haus ein Streit an der Rezeption.
 *
 * Bewusst **nicht** geprueft wird, ob das Zimmer zur gebuchten Gruppe
 * gehoert. Ein Upgrade ist Alltag: der Gast hat ein Doppelzimmer gebucht und
 * bekommt die Juniorsuite. Abgerechnet wird, was gebucht wurde; wer wirklich
 * die Gruppe wechseln will, nimmt `change-stay`.
 */
async function assertUnitAssignable(
  client: PoolClient, opts: {
    resourceId: number; propertyId: number; arrival: string; departure: string
    exceptReservationId?: number }
): Promise<void> {
  const unit = await client.query<{ property_id: number; active: boolean }>(
    `SELECT property_id, active FROM resource WHERE id = $1`, [opts.resourceId])
  if (unit.rowCount === 0 || unit.rows[0]!.property_id !== opts.propertyId) {
    throw Errors.notFound('res.room')
  }
  if (!unit.rows[0]!.active) {
    throw Errors.conflict('room.inactive')
  }

  const blocked = await client.query(
    `SELECT 1 FROM maintenance_block
      WHERE resource_id = $1 AND kind = 'out_of_order'
        AND from_date < $3::date AND to_date > $2::date LIMIT 1`,
    [opts.resourceId, opts.arrival, opts.departure])
  if (blocked.rowCount && blocked.rowCount > 0) {
    throw Errors.conflict('room.outOfOrder')
  }

  const taken = await client.query(
    `SELECT 1 FROM reservation
      WHERE resource_id = $1 AND id <> COALESCE($2, -1)
        AND status IN ('Confirmed','InHouse')
        AND arrival < $4::date AND departure > $3::date LIMIT 1`,
    [opts.resourceId, opts.exceptReservationId ?? null, opts.arrival, opts.departure])
  if (taken.rowCount && taken.rowCount > 0) {
    throw Errors.conflict('room.occupied')
  }
}

/** Uebersetzt den Fehlercode der Inventarfunktion in eine saubere Antwort. */
export function inventoryError(code: string | null): never | void {
  if (code === 'sold_out') throw Errors.soldOut()
  if (code === 'not_materialized') throw Errors.notMaterialized()
  if (code !== null) throw Errors.conflict('inventory.unknownError', { code })
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
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })
      if (!isIsoDate(body.arrival) || !isIsoDate(body.departure)) {
        throw Errors.validation({ arrival: ['field.isoDate'] })
      }
      if (nightsBetween(body.arrival, body.departure) <= 0) {
        throw Errors.validation({ departure: ['field.afterArrival'] })
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
          if (block.property_id !== body.propertyId) throw Errors.notFound('res.block')
          if (block.status !== 'active') {
            throw Errors.conflict('block.notPickable', { status: block.status })
          }
          if (block.picked_up >= block.quantity) {
            throw Errors.conflict('block.fullyPickedUp')
          }
          if (block.category_id !== body.categoryId) {
            throw Errors.validation({
              categoryId: ['field.mustMatchBlockCategory'] })
          }
          if (body.arrival !== block.from_date || body.departure !== block.to_date) {
            throw Errors.unprocessable(
              'block.pickupWholePeriod',
              { from: block.from_date, to: block.to_date })
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

        /*
         * Das Zimmer, falls eines mitkommt, wird **vor** dem Anlegen geprueft
         * und in derselben Anweisung gesetzt. Ein zweiter Aufruf danach
         * haette ein Fenster, in dem jemand anders dasselbe Zimmer belegt --
         * und die Reservierung stuende ohne das Zimmer da, das die Rezeption
         * im Belegungsplan gerade zugesagt hat.
         */
        if (body.resourceId !== undefined) {
          await assertUnitAssignable(client, {
            resourceId: body.resourceId, propertyId: body.propertyId,
            arrival: body.arrival, departure: body.departure })
        }

        const res = await client.query<{ id: number; public_ref: string }>(
          `INSERT INTO reservation
             (property_id, booking_id, category_id, arrival, departure, status,
              rate_plan_id, primary_guest_id, notes, block_id, resource_id, created_by)
           VALUES ($1,$2,$3,$4::date,$5::date,'Confirmed',$6,$7,$8,$9,$10,$11)
           RETURNING id, public_ref`,
          [body.propertyId, booking.rows[0]!.id, body.categoryId, body.arrival, body.departure,
           ratePlanId ?? null, body.guestId ?? null, body.notes ?? null,
           block?.id ?? null, body.resourceId ?? null, principal.userId])
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

  /**
   * Eine einzelne Reservierung, vollstaendig.
   *
   * Der Belegungsplan ist das Hauptwerkzeug der Rezeption, und wer dort
   * einen Balken anklickt, will alles sehen, was zu diesem Aufenthalt
   * gehoert -- nicht nur das, was auf den Balken passt. Bisher gab es
   * dafuer gar nichts: `GET /v1/reservations/:ref` existierte nicht, und
   * `notes` liess sich nach dem Anlegen weder lesen noch aendern.
   *
   * Ein Aufruf, nicht sechs. Gast, Zimmer, Ratenplan, Naechte mit Preisen,
   * Mitreisende, Folio und Kontingent kommen zusammen; sonst kostet jeder
   * Klick im Plan eine Handvoll Runden.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/reservations/:reservationRef',
    permission: 'reservation:read',
    summary: 'Eine Reservierung mit allem, was dazugehoert',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number }>(
          `SELECT r.id,
                  r.public_ref            AS "reservationRef",
                  b.public_ref            AS "bookingRef",
                  r.status, r.arrival::text, r.departure::text,
                  r.notes,
                  r.category_id           AS "categoryId",
                  c.code                  AS "categoryCode",
                  c.name                  AS "categoryName",
                  r.resource_id           AS "resourceId",
                  u.code                  AS "roomCode",
                  u.floor,
                  r.rate_plan_id          AS "ratePlanId",
                  rp.code                 AS "ratePlanCode",
                  g.public_ref            AS "guestRef",
                  nullif(trim(concat_ws(' ', g.first_name, g.last_name)), '') AS "guestName",
                  g.email                 AS "guestEmail",
                  g.language              AS "guestLanguage",
                  co.public_ref           AS "companyRef",
                  co.name                 AS "companyName",
                  bl.public_ref           AS "blockRef",
                  bl.name                 AS "blockName",
                  b.source, b.external_reference AS "externalReference",
                  r.checked_in_at         AS "checkedInAt",
                  r.checked_out_at        AS "checkedOutAt",
                  r.canceled_at           AS "canceledAt",
                  f.public_ref            AS "folioRef"
             FROM reservation r
             JOIN booking b            ON b.id = r.booking_id
             JOIN resource_category c  ON c.id = r.category_id
             LEFT JOIN resource u      ON u.id = r.resource_id
             LEFT JOIN rate_plan rp    ON rp.id = r.rate_plan_id
             LEFT JOIN guest g         ON g.id = r.primary_guest_id
             LEFT JOIN company co      ON co.id = b.booker_company_id
             LEFT JOIN availability_block bl ON bl.id = r.block_id
             LEFT JOIN folio f         ON f.reservation_id = r.id
            WHERE r.public_ref = $1`, [reservationRef])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const kopf = r.rows[0]! as Record<string, unknown>

        const naechte = await client.query(
          `SELECT date::text, price_cent AS "priceCent",
                  rate_plan_id AS "ratePlanId"
             FROM reservation_night WHERE reservation_id = $1 ORDER BY date`,
          [kopf.id])

        const mitreisende = await client.query(
          `SELECT o.age_at_arrival AS "ageAtArrival", o.is_primary AS "isPrimary",
                  g.public_ref AS "guestRef",
                  nullif(trim(concat_ws(' ', g.first_name, g.last_name)), '') AS name
             FROM reservation_occupant o
             LEFT JOIN guest g ON g.id = o.guest_id
            WHERE o.reservation_id = $1
            ORDER BY o.is_primary DESC, o.id`, [kopf.id])

        // Die laufende id bleibt drinnen; nach aussen geht die oeffentliche
        // Referenz (C1, Dokument 13).
        delete kopf.id
        return {
          ...kopf,
          nights: naechte.rows,
          occupants: mitreisende.rows,
          totalCent: naechte.rows.reduce(
            (sum, n) => sum + Number((n as { priceCent: number }).priceCent), 0)
        }
      })
    }
  })

  /**
   * Die Notiz an der Reservierung.
   *
   * Eine eigene Route und kein Feld in `change-stay`: eine Notiz beruehrt
   * weder Bestand noch Preis noch Zustand. Sie durch dieselbe Tuer zu
   * schicken wie eine Verlaengerung hiesse, fuer einen Satz Text den ganzen
   * Apparat aus Inventarbewegung und Neubepreisung anzuwerfen -- und ein
   * Tippfehler in der Notiz koennte an einem vollen Haus scheitern.
   *
   * Notizen sind **kein** Ort fuer Gesundheitsdaten oder aehnlich
   * Heikles. Das steht so in der Maske, nicht nur hier: das Feld ist
   * Freitext und wird weder durchsucht noch anonymisiert.
   */
  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/reservations/:reservationRef',
    permission: 'reservation:write',
    summary: 'Notiz an der Reservierung aendern',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const body = req.body as { notes?: string | null }
      if (body.notes !== undefined && body.notes !== null
          && body.notes.length > NOTES_MAX_LENGTH) {
        throw Errors.validation({ notes: ['field.maxLength'] },
          { max: NOTES_MAX_LENGTH })
      }

      return tx(req.pool, req, async client => {
        const r = await client.query<{ id: number; property_id: number }>(
          `UPDATE reservation SET notes = NULLIF($2, ''), updated_at = now()
            WHERE public_ref = $1
            RETURNING id, property_id`,
          [reservationRef, body.notes ?? ''])
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        return { reservationRef, notes: body.notes ?? null }
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
        if (cur.rowCount === 0) throw Errors.notFound('res.reservation')
        const r = cur.rows[0]!

        let target: ReservationStatus
        try { target = applyAction(r.status, act) }
        catch (e) {
          if (e instanceof InvalidTransitionError) throw Errors.conflict(e.message)
          throw e
        }

        if (act === 'check_in' && r.resource_id === null) {
          throw Errors.unprocessable('stay.checkinNeedsRoom')
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

        /*
         * Ob Bestand gebunden wird, entscheidet der **Zustand**, nicht die
         * Handlung. Hier stand das Paar Storno/Wiederherstellen
         * ausgeschrieben, und dabei fehlte ein Fall: ein No-Show, der doch
         * noch anreist, geht nicht ueber dieses Paar - er geht ueber
         * `check_in` direkt nach `InHouse`, einen bindenden Zustand, ohne
         * dass je wieder gebunden wurde. Das Zimmer war belegt und der
         * Zaehler sagte frei; auffallen wuerde das als Ueberbuchung, nicht
         * als Fehlermeldung. `occupiesInventory` fuer Vorher und Nachher
         * deckt jeden Weg ab, auch die, die es noch nicht gibt.
         */
        const bandVorher = occupiesInventory(r.status)
        const bindetNachher = occupiesInventory(target)

        // Kontingent freigeben, sobald die Reservierung es nicht mehr bindet.
        if (bandVorher && !bindetNachher) {
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
        if (!bandVorher && bindetNachher) {
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
  // Der Zustandsautomat kennt `reinstate` seit jeher, einen Weg dorthin gab
  // es nicht: ein versehentlicher Storno war damit endgueltig, und ein
  // No-Show, der doch noch anreist, kam nur ueber den Check-in zurueck.
  action('/v1/reservations/:reservationRef/reinstate', 'reinstate', 'reservation:write',
    'Storno oder No-Show zuruecknehmen')

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
        if (r.rowCount === 0) throw Errors.notFound('res.reservation')
        const res = r.rows[0]!

        await assertUnitAssignable(client, {
          resourceId, propertyId: res.property_id,
          arrival: res.arrival, departure: res.departure, exceptReservationId: res.id })

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
        if (cur.rowCount === 0) throw Errors.notFound('res.reservation')
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
            'stay.pickupNotMovable')
        }

        if (!occupiesInventory(r.status)) {
          throw Errors.conflict(
            'stay.statusHoldsNoInventory', { status: r.status })
        }

        const neuAnkunft = body.arrival ?? r.arrival
        const neuAbreise = body.departure ?? r.departure
        const neuKategorie = body.categoryId ?? r.category_id
        if (!isIsoDate(neuAnkunft) || !isIsoDate(neuAbreise)) {
          throw Errors.validation({ arrival: ['field.isoDate'] })
        }
        if (nightsBetween(neuAnkunft, neuAbreise) <= 0) {
          throw Errors.validation({ departure: ['field.afterArrival'] })
        }
        // Bei InHouse ist die Anreise geschehen und nicht mehr verschiebbar.
        if (r.status === 'InHouse' && neuAnkunft !== r.arrival) {
          throw Errors.conflict('stay.inHouseArrivalFixed')
        }
        if (neuKategorie !== r.category_id) {
          const k = await client.query(
            `SELECT 1 FROM resource_category WHERE id = $1 AND property_id = $2`,
            [neuKategorie, r.property_id])
          if (k.rowCount === 0) throw Errors.notFound('res.category')
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