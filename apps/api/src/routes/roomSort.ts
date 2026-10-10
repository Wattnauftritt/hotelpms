import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Meldung } from '../platform/texte.js'
import { createHash } from 'node:crypto'
import type { PoolClient } from '@hotelpms/db'
import {
  ROOM_SORT_MODES, checkRoomSortWeights, resolveRoomSortWeights, sortRooms, isIsoDate,
  nightsBetween, type RoomSortMode, type RoomSortWeights, type SortRoom, type SortStay
} from '@hotelpms/domain'
import { emitEvent } from '../platform/events.js'
import type { Principal } from '../platform/context.js'

/**
 * Zimmer sortieren: die Einstellung des Hauses (Migration 0104).
 *
 * Die Antwort traegt beides, die Abweichung des Hauses (`weights`) und das,
 * womit gerechnet wird (`effective`): die Maske zeigt neben jedem Feld die
 * Vorgabe, und "zuruecksetzen" heisst, den Schluessel wegzulassen -- nicht,
 * die Vorgabe abzuschreiben, die sich spaeter aendern kann.
 *
 * Lesen am Recht `inventory:read`: der Zimmerplan braucht den Modus, um den
 * Knopf zu zeigen oder nicht, und wer den Plan sieht, hat dieses Recht.
 * Schreiben an `settings:property` wie die Zimmer selbst.
 */

interface Zeile { mode: RoomSortMode; keep_today: boolean; weights: Partial<RoomSortWeights> }

function antwort(z: Zeile | undefined): Record<string, unknown> {
  const s = z ?? { mode: 'manual' as const, keep_today: true, weights: {} }
  return {
    configured: z !== undefined,
    mode: s.mode,
    keepToday: s.keep_today,
    weights: s.weights,
    effective: resolveRoomSortWeights(s.weights)
  }
}

export function roomSortRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/room-sort-settings',
    permission: 'inventory:read',
    propertyParam: 'propertyId',
    summary: 'Zimmer sortieren: Einstellung des Hauses',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        const s = await client.query<Zeile>(
          `SELECT mode, keep_today, weights FROM room_sort_setting WHERE property_id = $1`,
          [Number(propertyId)])
        return antwort(s.rows[0])
      })
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/room-sort-settings',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Zimmer sortieren: Einstellung des Hauses setzen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const b = (req.body ?? {}) as Record<string, unknown>
      const f: Record<string, Meldung[]> = {}
      const mode = b.mode === undefined ? 'manual' : b.mode
      if (typeof mode !== 'string' || !(ROOM_SORT_MODES as readonly string[]).includes(mode)) {
        f.mode = ['field.invalid']
      }
      const keepToday = b.keepToday === undefined ? true : b.keepToday
      if (typeof keepToday !== 'boolean') f.keepToday = ['field.invalid']
      const geprueft = checkRoomSortWeights(b.weights === undefined ? {} : b.weights)
      if (!geprueft.ok) Object.assign(f, geprueft.errors)
      if (Object.keys(f).length > 0 || !geprueft.ok) throw Errors.validation(f)

      return tx(req.pool, req, async client => {
        const { rows } = await client.query<Zeile>(
          `INSERT INTO room_sort_setting (property_id, mode, keep_today, weights)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (property_id) DO UPDATE
              SET mode = EXCLUDED.mode, keep_today = EXCLUDED.keep_today,
                  weights = EXCLUDED.weights, updated_at = now()
           RETURNING mode, keep_today, weights`,
          [Number(propertyId), mode, keepToday, JSON.stringify(geprueft.value)])
        return antwort(rows[0])
      })
    }
  })
}

// ------------------------------------------------------------------ Sortieren

/**
 * Vorschau, Uebernehmen, Rueckgaengig (Migration 0121).
 *
 * **Die Vorschau schreibt nichts**, Uebernehmen schreibt genau die Zuege der
 * Vorschau. Dazwischen kann jemand am Plan gearbeitet haben; deshalb traegt
 * die Vorschau einen Stand (`basis`), eine Pruefsumme ueber alle
 * Aufenthalte im Zeitraum, und Uebernehmen rechnet sie unter Sperre neu. Ist
 * sie anders, wird nichts geschrieben -- die Rezeption soll nicht etwas
 * uebernehmen, das sie so nicht gesehen hat.
 *
 * **Nur das Zimmer aendert sich**, mit derselben Reservierung. Im
 * Adminpanel wurden Zeilen geloescht und neu angelegt, und mit ihnen gingen
 * Meldeschein und Bezuege verloren.
 *
 * **Wer liegen bleibt** (die Regeln aus dem Adminpanel und Svens
 * Grundregeln): angereist oder abgereist, "Zimmer fest", Anreise vor dem
 * Geschaeftstag (gilt als angereist, Sven 05.10.2026), Anreise heute, wenn
 * das Haus es so eingestellt hat, ueber den Zeitraum hinaus, in einem Zimmer
 * einer anderen Gruppe (Upgrade), und eine Kanalbuchung, die in StayGrid von
 * Hand geaendert wurde (`local`, Sven 05.10.2026: geschuetzt).
 */

/** Zwei Monate: so weit plant eine Rezeption Zimmer, und es bleibt eine Runde. */
const MAX_SORT_DAYS = 62

interface StayRow {
  id: number; public_ref: string; booking_id: number; category_id: number
  arrival: string; departure: string; resource_id: number | null; status: string
  room_fixed: boolean; channel_owner: string | null; price_cent: number | null
  text: string; last_name: string | null; updated_at: string
}

interface Lage {
  stays: StayRow[]
  rooms: SortRoom[]
  basis: string
  today: string
  keepToday: boolean
  weights: RoomSortWeights
}

function zeitraum(b: Record<string, unknown>): { from: string; to: string } {
  const from = typeof b.from === 'string' ? b.from : ''
  const to = typeof b.to === 'string' ? b.to : ''
  if (!isIsoDate(from)) throw Errors.validation({ from: ['field.isoDate'] })
  if (!isIsoDate(to)) throw Errors.validation({ to: ['field.isoDate'] })
  const tage = nightsBetween(from, to)
  if (tage <= 0) throw Errors.validation({ to: ['field.afterFrom'] })
  if (tage > MAX_SORT_DAYS) throw Errors.rangeTooLarge(MAX_SORT_DAYS)
  return { from, to }
}

async function lage(
  client: PoolClient, propertyId: number, from: string, to: string, sperren: boolean
): Promise<Lage> {
  const s = await client.query<Zeile>(
    `SELECT mode, keep_today, weights FROM room_sort_setting WHERE property_id = $1`,
    [propertyId])
  const einstellung = s.rows[0] ?? { mode: 'manual' as const, keep_today: true, weights: {} }
  if (einstellung.mode === 'off') throw Errors.conflict('roomSort.off')

  const today = (await client.query<{ d: string }>(
    `SELECT COALESCE((SELECT max(b.date) FROM business_day b WHERE b.property_id = $1),
                     current_date)::text AS d`, [propertyId])).rows[0]!.d

  // Alles, was im Zeitraum ein Zimmer belegt oder eines braucht. Gesperrt,
  // wenn Uebernehmen fragt: der Stand soll bis zum Schreiben gelten.
  const stays = await client.query<StayRow>(
    `SELECT r.id, r.public_ref, r.booking_id, r.category_id,
            r.arrival::text, r.departure::text, r.resource_id, r.status::text,
            r.room_fixed, b.channel_owner,
            (SELECT round(avg(n.price_cent))::int FROM reservation_night n
              WHERE n.reservation_id = r.id) AS price_cent,
            concat_ws(' ', r.short_note, r.notes) AS text,
            g.last_name, r.updated_at::text
       FROM reservation r
       JOIN booking b ON b.id = r.booking_id
       LEFT JOIN guest g ON g.id = r.primary_guest_id
      WHERE r.property_id = $1
        AND r.arrival < $3::date AND r.departure > $2::date
        AND r.status IN ('Optional','Confirmed','InHouse','CheckedOut')
      ORDER BY r.id
      ${sperren ? 'FOR UPDATE OF r' : ''}`, [propertyId, from, to])

  const rooms = await client.query<{ id: number; category_id: number; code: string
                                     quality: number; floor: string | null
                                     building: string | null; attributes: string[]
                                     blocked: Array<{ from: string; to: string }> }>(
    `SELECT r.id, r.category_id, r.code, r.quality, r.floor, r.building, r.attributes,
            COALESCE((SELECT json_agg(json_build_object('from', m.from_date::text,
                                                        'to', m.to_date::text))
                        FROM maintenance_block m
                       WHERE m.resource_id = r.id AND m.kind = 'out_of_order'
                         AND m.from_date < $3::date AND m.to_date > $2::date), '[]') AS blocked
       FROM resource r WHERE r.property_id = $1 AND r.active
      ORDER BY r.id`, [propertyId, from, to])

  const basis = createHash('sha256').update(JSON.stringify([
    stays.rows.map(x => [x.id, x.resource_id, x.arrival, x.departure, x.status, x.room_fixed,
                         x.channel_owner, x.updated_at]),
    rooms.rows.map(x => [x.id, x.category_id, x.blocked])
  ])).digest('base64url')

  return {
    stays: stays.rows,
    rooms: rooms.rows.map(x => ({ id: Number(x.id), categoryId: Number(x.category_id), code: x.code,
                                  quality: x.quality, floor: x.floor, building: x.building,
                                  attributes: x.attributes, blocked: x.blocked })),
    basis, today, keepToday: einstellung.keep_today,
    weights: resolveRoomSortWeights(einstellung.weights)
  }
}

function beweglich(x: StayRow, l: Lage, from: string, to: string): boolean {
  if (x.status !== 'Optional' && x.status !== 'Confirmed') return false
  if (x.room_fixed || x.channel_owner === 'local') return false
  if (x.arrival < from || x.departure > to) return false
  if (x.arrival < l.today) return false
  if (l.keepToday && x.arrival === l.today) return false
  return true
}

function rechnen(l: Lage, from: string, to: string): ReturnType<typeof sortRooms> {
  const stays: SortStay[] = l.stays.map(x => ({
    id: Number(x.id), bookingId: Number(x.booking_id), categoryId: Number(x.category_id),
    arrival: x.arrival, departure: x.departure,
    resourceId: x.resource_id === null ? null : Number(x.resource_id),
    // Abgereiste und Stornierte belegen nichts mehr, Abgereiste aber an
    // ihren Tagen schon: sie stehen nur bis zur Abreise im Zeitraum.
    fixed: !beweglich(x, l, from, to),
    pricePerNightCent: x.price_cent === null ? null : Number(x.price_cent),
    text: x.text ?? ''
  }))
  return sortRooms(l.rooms, stays, l.weights)
}

export function roomSortRunRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/room-sort/preview',
    permission: 'reservation:write',
    propertyParam: 'propertyId',
    summary: 'Zimmer sortieren: Vorschau, schreibt nichts',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const { from, to } = zeitraum((req.body ?? {}) as Record<string, unknown>)
      return tx(req.pool, req, async client => {
        const l = await lage(client, Number(propertyId), from, to, false)
        const r = rechnen(l, from, to)
        const nachId = new Map(l.stays.map(x => [Number(x.id), x]))
        const zimmer = new Map(l.rooms.map(z => [z.id, z.code]))
        return {
          from, to, basis: l.basis,
          moves: r.moves.map(m => {
            const x = nachId.get(m.stayId)!
            return { reservationRef: x.public_ref, guestName: x.last_name,
                     arrival: x.arrival, departure: x.departure,
                     fromRoomId: m.fromRoomId, fromRoomCode: m.fromRoomId === null ? null
                       : zimmer.get(m.fromRoomId) ?? null,
                     toRoomId: m.toRoomId, toRoomCode: zimmer.get(m.toRoomId) ?? null }
          }),
          unplaced: r.unplaced.map(id => {
            const x = nachId.get(id)!
            return { reservationRef: x.public_ref, guestName: x.last_name,
                     arrival: x.arrival, departure: x.departure }
          }),
          fixed: l.stays.filter(x => !beweglich(x, l, from, to)).length,
          costBefore: Math.round(r.costBefore), costAfter: Math.round(r.costAfter)
        }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/room-sort/apply',
    permission: 'reservation:write',
    propertyParam: 'propertyId',
    summary: 'Zimmer sortieren: die Zuege der Vorschau uebernehmen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const b = (req.body ?? {}) as Record<string, unknown>
      const { from, to } = zeitraum(b)
      if (typeof b.basis !== 'string' || b.basis === '') {
        throw Errors.validation({ basis: ['field.required'] })
      }
      const roh = Array.isArray(b.moves) ? b.moves : null
      if (roh === null || roh.length === 0 || roh.length > 2000) {
        throw Errors.validation({ moves: ['field.invalid'] })
      }
      const wunsch = roh.map((m: unknown, i) => {
        const o = (m ?? {}) as Record<string, unknown>
        if (typeof o.reservationRef !== 'string' || !Number.isInteger(o.toRoomId)) {
          throw Errors.validation({ [`moves.${i}`]: ['field.invalid'] })
        }
        return { ref: o.reservationRef, toRoomId: o.toRoomId as number }
      })
      const principal = req.principal as Principal
      const pid = Number(propertyId)

      return tx(req.pool, req, async client => {
        const l = await lage(client, pid, from, to, true)
        if (l.basis !== b.basis) throw Errors.conflict('roomSort.changed')

        /*
         * Gleicher Stand heisst gleiche Rechnung: die Zuege werden hier noch
         * einmal gerechnet und muessen genau die der Vorschau sein. So
         * schreibt Uebernehmen nie etwas, das der Sortierer nicht
         * vorgeschlagen hat, auch wenn jemand den Rumpf von Hand baut.
         */
        const r = rechnen(l, from, to)
        const nachId = new Map(l.stays.map(x => [Number(x.id), x]))
        const soll = new Map(r.moves.map(m => [nachId.get(m.stayId)!.public_ref, m]))
        for (const w of wunsch) {
          if (soll.get(w.ref)?.toRoomId !== w.toRoomId) {
            throw Errors.conflict('roomSort.invalidMove', { reservation: w.ref })
          }
        }
        if (wunsch.length !== soll.size) throw Errors.conflict('roomSort.changed')

        const zuege = [...soll.values()]
        await schreiben(client, zuege.map(m => ({ id: m.stayId, resourceId: m.toRoomId })))

        const run = await client.query<{ public_ref: string }>(
          `INSERT INTO room_sort_run (property_id, from_date, to_date, trigger, moves, created_by)
           VALUES ($1, $2, $3, 'manual', $4::jsonb, $5) RETURNING public_ref`,
          [pid, from, to, JSON.stringify(zuege.map(m => ({
            reservationId: m.stayId, fromResourceId: m.fromRoomId, toResourceId: m.toRoomId }))),
           principal.userId ?? null])

        for (const m of zuege) {
          const x = nachId.get(m.stayId)!
          await emitEvent(client, pid, 'reservation.changed', {
            reservationRef: x.public_ref, resourceId: m.toRoomId,
            arrival: x.arrival, departure: x.departure, categoryId: Number(x.category_id) })
        }
        return { runRef: run.rows[0]!.public_ref, moved: zuege.length }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/room-sort/runs/:runRef/undo',
    permission: 'reservation:write',
    propertyParam: 'propertyId',
    summary: 'Zimmer sortieren: einen Lauf zuruecknehmen',
    handler: async (req) => {
      const { propertyId, runRef } = req.params as { propertyId: string; runRef: string }
      const principal = req.principal as Principal
      const pid = Number(propertyId)
      return tx(req.pool, req, async client => {
        const run = await client.query<{ id: number; undone_at: string | null
                                         moves: Array<{ reservationId: number
                                                        fromResourceId: number | null
                                                        toResourceId: number }> }>(
          `SELECT id, undone_at, moves FROM room_sort_run
            WHERE public_ref = $1 AND property_id = $2 FOR UPDATE`, [runRef, pid])
        if (run.rowCount === 0) throw Errors.notFound('res.resource')
        const lauf = run.rows[0]!
        if (lauf.undone_at !== null) throw Errors.conflict('roomSort.undone')

        /*
         * Nur zuruecknehmen, was seitdem niemand anders angefasst hat. Liegt
         * ein Gast inzwischen in einem dritten Zimmer, hat das jemand
         * bewusst getan; ihn zurueckzulegen hiesse, diese Arbeit still zu
         * verwerfen. Dann lieber gar nicht und sagen, wer.
         */
        const ids = lauf.moves.map(m => m.reservationId)
        const jetzt = await client.query<{ id: number; public_ref: string; resource_id: number | null
                                           status: string }>(
          `SELECT id, public_ref, resource_id, status::text FROM reservation
            WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [ids])
        const nach = new Map(jetzt.rows.map(x => [Number(x.id), x]))
        for (const m of lauf.moves) {
          const x = nach.get(m.reservationId)
          if (x === undefined || Number(x.resource_id) !== m.toResourceId
              || (x.status !== 'Optional' && x.status !== 'Confirmed')) {
            throw Errors.conflict('roomSort.undoStale', { reservation: x?.public_ref ?? '' })
          }
        }
        await schreiben(client, lauf.moves.map(m => ({ id: m.reservationId,
                                                       resourceId: m.fromResourceId })))
        await client.query(
          `UPDATE room_sort_run SET undone_at = now(), undone_by = $2 WHERE id = $1`,
          [lauf.id, principal.userId ?? null])
        for (const m of lauf.moves) {
          await emitEvent(client, pid, 'reservation.changed', {
            reservationRef: nach.get(m.reservationId)!.public_ref, resourceId: m.fromResourceId })
        }
        return { runRef, undone: lauf.moves.length }
      })
    }
  })
}

/**
 * Zimmer setzen, in einer Anweisung, und danach pruefen, dass kein Zimmer
 * doppelt belegt oder gesperrt ist. Erst schreiben, dann pruefen: bei einem
 * Ringtausch (A nach B, B nach C, C nach A) ist jeder Zwischenstand belegt,
 * nur das Ergebnis nicht.
 *
 * `app.room_sort` haelt den Trigger aus 0092 an: ein Zug des Sortierers ist
 * keine Aenderung der Rezeption (Migration 0121).
 */
async function schreiben(
  client: PoolClient, zuege: Array<{ id: number; resourceId: number | null }>
): Promise<void> {
  await client.query(`SELECT set_config('app.room_sort', 'on', true)`)
  await client.query(
    `UPDATE reservation r SET resource_id = x.res, updated_at = now()
       FROM unnest($1::bigint[], $2::bigint[]) AS x(id, res)
      WHERE r.id = x.id`,
    [zuege.map(z => z.id), zuege.map(z => z.resourceId)])
  await client.query(`SELECT set_config('app.room_sort', '', true)`)

  const konflikt = await client.query<{ code: string; ref: string }>(
    `SELECT u.code, r.public_ref AS ref
       FROM reservation r JOIN resource u ON u.id = r.resource_id
      WHERE r.id = ANY($1::bigint[])
        AND (EXISTS (SELECT 1 FROM reservation o
                      WHERE o.resource_id = r.resource_id AND o.id <> r.id
                        AND o.status IN ('Optional','Confirmed','InHouse')
                        AND o.arrival < r.departure AND o.departure > r.arrival)
             OR EXISTS (SELECT 1 FROM maintenance_block m
                         WHERE m.resource_id = r.resource_id AND m.kind = 'out_of_order'
                           AND m.from_date < r.departure AND m.to_date > r.arrival))
      LIMIT 1`, [zuege.map(z => z.id)])
  if (konflikt.rowCount && konflikt.rowCount > 0) {
    throw Errors.conflict('roomSort.roomTaken',
      { room: konflikt.rows[0]!.code, reservation: konflikt.rows[0]!.ref })
  }
}
