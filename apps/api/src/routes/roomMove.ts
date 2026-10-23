import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { emitEvent } from '../platform/events.js'
import type { Principal } from '../platform/context.js'
import { geschaeftstag, rechtImHaus } from './depositRequests.js'
import { assertUnitAssignable, zimmerFehler } from './reservations.js'
import type { ReservationStatus } from '@hotelpms/domain'
import type { PoolClient } from '@hotelpms/db'

/**
 * Zimmerwechsel waehrend des Aufenthalts (Migration 0195).
 *
 * Sven, 23.10.2026: Gaeste wechseln mitten im Aufenthalt das Zimmer, weil
 * sie ein Upgrade buchen oder das Zimmer nicht gefaellt -- und der einzige
 * Weg war, sie frueher auszuchecken und neu zu buchen, mit neuem Folio.
 *
 * Der Wechsel hat ein **Datum**. Ab dort liegt der Gast im neuen Zimmer,
 * davor im alten; Folio, Meldeschein und Kanalbuchung bleiben eins. Am
 * Geschaeftstag ist er sofort (altes Zimmer schmutzig, neues belegt), an
 * einem spaeteren Tag zieht ihn der Nachtlauf nach. Vor der Anreise teilt er
 * eine Buchung auf zwei Zimmer, wenn im vollen Haus keines ueber alle
 * Naechte frei ist.
 *
 * Der Preis bleibt, wenn nichts mitkommt. Ein bezahltes Upgrade ist ein
 * hoeherer Nachtpreis ab dem Wechseltag (Svens Entscheidung), keine eigene
 * Position; gebuchte Naechte bleiben, wie sie sind.
 */

/** In diesen Zustaenden liegt oder liegt bald jemand im Zimmer. */
const WECHSELBAR: ReadonlySet<ReservationStatus> = new Set(['Optional', 'Confirmed', 'InHouse'])

/** Wie `depositRequests.ts`: der 30. Februar ist kein Tag, auch wenn er so aussieht. */
function istKalendertag(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

interface Zeile {
  id: number; property_id: number; public_ref: string; status: ReservationStatus
  arrival: string; departure: string; resource_id: number | null; category_id: number
  room_moved: boolean
}

async function lade(
  client: PoolClient, reservationRef: string, principal: Principal, sperren = true
): Promise<Zeile> {
  const r = await client.query<Zeile>(
    `SELECT id, property_id, public_ref, status, arrival::text, departure::text,
            resource_id, category_id, room_moved
       FROM reservation WHERE public_ref = $1 ${sperren ? 'FOR UPDATE' : ''}`, [reservationRef])
  const z = r.rows[0]
  if (z === undefined) throw Errors.notFound('res.reservation')
  // Der Pfad traegt kein Haus; das Recht gilt im Haus des Datensatzes (H4).
  rechtImHaus(principal, 'reservation:write', z.property_id)
  return z
}

/** Die Abschnitte, wie Seitenfenster und Antwort sie zeigen. */
export async function zimmerAbschnitte(
  client: PoolClient, reservationId: number
): Promise<Array<{ resourceId: number; roomCode: string; from: string; to: string
                   movedOut: boolean }>> {
  const { rows } = await client.query<{ resourceId: number; roomCode: string; from: string
                                        to: string; movedOut: boolean }>(
    `SELECT s.resource_id::int AS "resourceId", u.code AS "roomCode",
            s.arrival::text AS "from", s.departure::text AS "to",
            (s.status = 'CheckedOut' AND s.stay_status = 'InHouse') AS "movedOut"
       FROM reservation_room_stay s
       JOIN resource u ON u.id = s.resource_id
      WHERE s.id = $1 AND s.room_moved
      ORDER BY s.arrival`, [reservationId])
  return rows
}

/** Wo der Aufenthalt an einem Tag liegt. */
async function zimmerAm(client: PoolClient, r: Zeile, tag: string): Promise<number | null> {
  if (!r.room_moved) return r.resource_id
  const { rows } = await client.query<{ id: number | null }>(
    `SELECT reservation_room_on($1, $2::date)::int AS id`, [r.id, tag])
  return rows[0]?.id ?? null
}

export function roomMoveRoutes(app: FastifyInstance): void {
  /**
   * Was der Dialog braucht: ab wann gewechselt werden kann und welche Zimmer
   * ab dort bis zur Abreise frei sind. Eine Anweisung fuer alle Zimmer des
   * Hauses, nicht eine je Zimmer.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/reservations/:reservationRef/room-move',
    permission: 'reservation:write',
    summary: 'Zimmerwechsel vorbereiten: freie Zimmer ab einem Tag',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const { from } = req.query as { from?: string }
      if (from !== undefined && !istKalendertag(from)) {
        throw Errors.validation({ from: ['field.isoDate'] })
      }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const r = await lade(client, reservationRef, principal, false)
        const heute = await geschaeftstag(client, r.property_id)
        const fruehestens = r.status === 'InHouse' && heute > r.arrival ? heute : r.arrival
        const ab = from ?? fruehestens
        const aktuell = ab >= r.arrival && ab < r.departure ? await zimmerAm(client, r, ab) : null

        const zimmer = await client.query<{ id: number; code: string; category_id: number
                                            category_name: string; max_occupancy: number }>(
          `SELECT u.id::int, u.code, u.category_id::int, c.name AS category_name,
                  c.max_occupancy
             FROM resource u JOIN resource_category c ON c.id = u.category_id
            WHERE u.property_id = $1 AND u.active
            ORDER BY c.sort_order, c.id,
                     NULLIF(substring(u.code from '^[0-9]+'), '')::numeric NULLS LAST, u.code`,
          [r.property_id])
        const offen = ab < r.departure
          ? await zimmerFehler(client, zimmer.rows.map((u, i) => ({
              ord: i, resourceId: u.id, propertyId: r.property_id,
              arrival: ab, departure: r.departure, exceptReservationId: r.id })))
          : zimmer.rows.map(() => null)
        // Vorbelegung fuer "neuer Preis": was die Nacht am Wechseltag heute kostet.
        const preis = await client.query<{ p: string | null }>(
          `SELECT price_cent AS p FROM reservation_night
            WHERE reservation_id = $1 AND date = $2::date`, [r.id, ab])
        const teile = await zimmerAbschnitte(client, r.id)
        return {
          reservationRef, status: r.status, arrival: r.arrival, departure: r.departure,
          businessDate: heute, earliestFrom: fruehestens, from: ab,
          categoryId: r.category_id, currentResourceId: aktuell,
          nightPriceCent: preis.rows[0]?.p === undefined || preis.rows[0].p === null
            ? null : Number(preis.rows[0].p),
          parts: teile,
          rooms: zimmer.rows.map((u, i) => ({
            resourceId: u.id, code: u.code, categoryId: u.category_id,
            categoryName: u.category_name, maxOccupancy: u.max_occupancy,
            free: offen[i] === null && u.id !== aktuell
          }))
        }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/room-move',
    permission: 'reservation:write',
    summary: 'Zimmer wechseln ab einem Tag, bis zur Abreise',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const body = (req.body ?? {}) as { from?: unknown; resourceId?: unknown; priceCent?: unknown }
      if (!Number.isInteger(body.resourceId)) {
        throw Errors.validation({ resourceId: ['field.required'] })
      }
      if (body.from !== undefined && !istKalendertag(body.from)) {
        throw Errors.validation({ from: ['field.isoDate'] })
      }
      if (body.priceCent !== undefined
          && (!Number.isInteger(body.priceCent) || (body.priceCent as number) < 0
              || (body.priceCent as number) > 100_000_000)) {
        throw Errors.validation({ priceCent: ['field.nonNegativeInteger'] })
      }
      const resourceId = body.resourceId as number
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const r = await lade(client, reservationRef, principal)
        if (!WECHSELBAR.has(r.status)) {
          throw Errors.conflict('roomMove.status', { status: r.status })
        }
        const heute = await geschaeftstag(client, r.property_id)
        const ab = (body.from as string | undefined)
          ?? (r.status === 'InHouse' && heute > r.arrival ? heute : r.arrival)

        // Ab der Anreise ist es das Zimmer des ganzen Aufenthalts -- das geht,
        // solange er nicht schon geteilt ist.
        if (ab >= r.departure || ab < r.arrival || (r.room_moved && ab === r.arrival)) {
          throw Errors.unprocessable('roomMove.dateOutside')
        }
        // Die Naechte vor heute hat der Gast geschlafen, und zwar dort, wo er lag.
        if (r.status === 'InHouse' && ab < heute) {
          throw Errors.unprocessable('roomMove.datePast', { date: deutsch(heute) })
        }
        if (r.resource_id === null && ab > r.arrival) {
          throw Errors.unprocessable('roomMove.needsRoom')
        }
        if (await zimmerAm(client, r, ab) === resourceId) {
          throw Errors.unprocessable('roomMove.sameRoom')
        }
        await assertUnitAssignable(client, {
          resourceId, propertyId: r.property_id,
          arrival: ab, departure: r.departure, exceptReservationId: r.id })

        await client.query(`SELECT reservation_room_move($1, $2::date, $3, $4::date)`,
                           [r.id, ab, resourceId, heute])

        // Ein bezahltes Upgrade: der neue Preis ab dem Wechseltag, nur fuer
        // Naechte, die noch nicht auf dem Folio stehen.
        let repriced = 0
        if (body.priceCent !== undefined) {
          const p = await client.query(
            `UPDATE reservation_night SET price_cent = $3
              WHERE reservation_id = $1 AND date >= $2::date AND NOT posted`,
            [r.id, ab, body.priceCent])
          repriced = p.rowCount ?? 0
        }

        const nachher = await client.query<{ resource_id: number | null }>(
          `SELECT resource_id::int FROM reservation WHERE id = $1`, [r.id])
        const parts = await zimmerAbschnitte(client, r.id)
        await emitEvent(client, r.property_id, 'reservation.changed', {
          reservationRef, status: r.status, arrival: r.arrival, departure: r.departure,
          categoryId: r.category_id,
          // Das Zimmer von heute, wie bisher; die Abschnitte dazu, damit ein
          // Empfaenger einen geplanten Wechsel sieht.
          resourceId: nachher.rows[0]?.resource_id ?? null,
          roomMove: { from: ab, resourceId },
          roomParts: parts.map(p => ({ resourceId: p.resourceId, from: p.from, to: p.to }))
        })
        return { reservationRef, from: ab, resourceId,
                 currentResourceId: nachher.rows[0]?.resource_id ?? null,
                 repricedNights: repriced, parts }
      })
    }
  })

  /**
   * Den letzten Wechsel zuruecknehmen: am Wechseltag oder vorher. Danach hat
   * der Gast eine Nacht im neuen Zimmer geschlafen, und ein Zuruecknehmen
   * schriebe diese Nacht in das alte. Ein neuer Preis bleibt -- er steht in
   * den Naechten, und wer ihn nicht will, aendert ihn dort.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/reservations/:reservationRef/room-move/undo',
    permission: 'reservation:write',
    summary: 'Den letzten Zimmerwechsel zuruecknehmen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const r = await lade(client, reservationRef, principal)
        if (!WECHSELBAR.has(r.status) || !r.room_moved) {
          throw Errors.conflict('roomMove.nothingToUndo')
        }
        const heute = await geschaeftstag(client, r.property_id)
        const teile = await client.query<{ from_date: string; resource_id: number }>(
          `SELECT from_date::text, resource_id::int FROM reservation_room_part
            WHERE reservation_id = $1 AND from_date < $2::date
            ORDER BY from_date DESC LIMIT 2`, [r.id, r.departure])
        const [letzter, davor] = teile.rows
        if (letzter === undefined || davor === undefined || letzter.from_date < heute) {
          throw Errors.conflict('roomMove.nothingToUndo')
        }
        // Das alte Zimmer muss ab dem Wechseltag noch frei sein.
        await assertUnitAssignable(client, {
          resourceId: davor.resource_id, propertyId: r.property_id,
          arrival: letzter.from_date, departure: r.departure, exceptReservationId: r.id })
        await client.query(`SELECT reservation_room_move_undo($1, $2::date)`, [r.id, heute])

        const nachher = await client.query<{ resource_id: number | null }>(
          `SELECT resource_id::int FROM reservation WHERE id = $1`, [r.id])
        const parts = await zimmerAbschnitte(client, r.id)
        await emitEvent(client, r.property_id, 'reservation.changed', {
          reservationRef, status: r.status, arrival: r.arrival, departure: r.departure,
          categoryId: r.category_id, resourceId: nachher.rows[0]?.resource_id ?? null,
          roomParts: parts.map(p => ({ resourceId: p.resourceId, from: p.from, to: p.to }))
        })
        return { reservationRef, currentResourceId: nachher.rows[0]?.resource_id ?? null, parts }
      })
    }
  })
}

/** "2026-10-24" als "24.10.2026" fuer den Platzhalter einer Meldung. */
function deutsch(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
}
