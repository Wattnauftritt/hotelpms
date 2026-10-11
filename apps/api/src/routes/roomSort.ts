import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Meldung } from '../platform/texte.js'
import type { PoolClient } from '@hotelpms/db'
import {
  ROOM_SORT_MODES, checkRoomSortWeights, resolveRoomSortWeights, isIsoDate, nightsBetween,
  MAX_SORT_DAYS, RoomSortRoomTakenError, roomSortCompute, roomSortLoad, roomSortLock,
  roomSortMovable, roomSortRun, roomSortSetting, roomSortWrite,
  type RoomSortMode, type RoomSortSituation, type RoomSortWeights
} from '@hotelpms/domain'
import { emitEvents } from '../platform/events.js'
import { zimmerNachNummer } from '../platform/zimmerReihenfolge.js'
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

interface Zeile { mode: RoomSortMode; weights: Partial<RoomSortWeights> }

function antwort(z: Zeile | undefined): Record<string, unknown> {
  const s = z ?? { mode: 'manual' as const, weights: {} }
  return {
    configured: z !== undefined,
    mode: s.mode,
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
          `SELECT mode, weights FROM room_sort_setting WHERE property_id = $1`,
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
      const geprueft = checkRoomSortWeights(b.weights === undefined ? {} : b.weights)
      if (!geprueft.ok) Object.assign(f, geprueft.errors)
      if (Object.keys(f).length > 0 || !geprueft.ok) throw Errors.validation(f)

      return tx(req.pool, req, async client => {
        const { rows } = await client.query<Zeile>(
          `INSERT INTO room_sort_setting (property_id, mode, weights)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (property_id) DO UPDATE
              SET mode = EXCLUDED.mode, weights = EXCLUDED.weights, updated_at = now()
           RETURNING mode, weights`,
          [Number(propertyId), mode, JSON.stringify(geprueft.value)])
        return antwort(rows[0])
      })
    }
  })
}

// ------------------------------------------------------------------ Sortieren

/**
 * Vorschau, Uebernehmen, Rueckgaengig (Migration 0122).
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
 * **Wer liegen bleibt**, wie gelesen und geschrieben wird, steht in
 * `@hotelpms/domain` (`roomSortRun.ts`): der Worker sortiert im Modus
 * `auto` dasselbe, und Apps duerfen einander nicht importieren.
 */

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

/** Die Lage fuer die Route: "Nie" ist hier eine Antwort an den Benutzer. */
async function lage(
  client: PoolClient, propertyId: number, from: string, to: string, sperren: boolean
): Promise<RoomSortSituation> {
  const l = await roomSortLoad(client, propertyId, from, to, sperren)
  if (l === null) throw Errors.conflict('roomSort.off')
  return l
}

/** Ein belegtes Zimmer nach dem Schreiben ist ein Konflikt fuer die Rezeption. */
export async function sortierKonflikt<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f()
  } catch (e) {
    if (e instanceof RoomSortRoomTakenError) {
      throw Errors.conflict('roomSort.roomTaken', { room: e.room, reservation: e.reservation })
    }
    throw e
  }
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
        const r = roomSortCompute(l, from, to)
        const nachId = new Map(l.stays.map(x => [Number(x.id), x]))
        const zimmer = new Map(l.rooms.map(z => [z.id, z.code]))
        const nachZug = new Map(r.moves.map(m => [m.stayId, m]))
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
          fixed: l.stays.filter(x => !roomSortMovable(x, l, from, to)).length,
          costBefore: Math.round(r.costBefore), costAfter: Math.round(r.costAfter),
          /*
           * Alles fuer den Kalender in der Vorschau (Sven, 11.10.2026: "so hat
           * man ja absolut keinen Ueberblick"). Eine Liste von 34 Zuegen zeigt
           * nicht, ob das Ergebnis besser aussieht -- ein Plan vorher und
           * nachher schon. Zimmer in der Reihenfolge des Zimmerplans, damit
           * man dort wiederfindet, was man hier sieht.
           */
          rooms: (await client.query<{ id: number; code: string; name: string | null
                                       category_id: number; category_name: string }>(
            `SELECT r.id, r.code, r.name, r.category_id, c.name AS category_name
               FROM resource r JOIN resource_category c ON c.id = r.category_id
              WHERE r.property_id = $1 AND r.active
              ORDER BY c.sort_order, c.id, ${zimmerNachNummer('r')}`, [Number(propertyId)]))
            .rows.map(z => ({ id: Number(z.id), code: z.code, name: z.name,
                              categoryId: Number(z.category_id), categoryName: z.category_name })),
          stays: l.stays.filter(x => x.status !== 'CheckedOut' || x.resource_id !== null)
            .map(x => {
              const zug = nachZug.get(Number(x.id))
              const vorher = x.resource_id === null ? null : Number(x.resource_id)
              return { reservationRef: x.public_ref, guestName: x.last_name,
                       arrival: x.arrival, departure: x.departure,
                       fromRoomId: vorher, toRoomId: zug === undefined ? vorher : zug.toRoomId,
                       moved: zug !== undefined, fixed: !roomSortMovable(x, l, from, to) }
            })
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
        await roomSortLock(client, pid)
        const l = await lage(client, pid, from, to, true)
        if (l.basis !== b.basis) throw Errors.conflict('roomSort.changed')

        /*
         * Gleicher Stand heisst gleiche Rechnung: die Zuege werden hier noch
         * einmal gerechnet und muessen genau die der Vorschau sein. So
         * schreibt Uebernehmen nie etwas, das der Sortierer nicht
         * vorgeschlagen hat, auch wenn jemand den Rumpf von Hand baut.
         */
        const r = roomSortCompute(l, from, to)
        const nachId = new Map(l.stays.map(x => [Number(x.id), x]))
        const soll = new Map(r.moves.map(m => [nachId.get(m.stayId)!.public_ref, m]))
        for (const w of wunsch) {
          if (soll.get(w.ref)?.toRoomId !== w.toRoomId) {
            throw Errors.conflict('roomSort.invalidMove', { reservation: w.ref })
          }
        }
        if (wunsch.length !== soll.size) throw Errors.conflict('roomSort.changed')

        const zuege = [...soll.values()]
        const runRef = await sortierKonflikt(() => roomSortRun(client, pid, from, to, 'manual',
          zuege, nachId, principal.userId ?? null))
        return { runRef, moved: zuege.length }
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
        await sortierKonflikt(() => roomSortWrite(client, lauf.moves.map(m => ({
          id: m.reservationId, resourceId: m.fromResourceId }))))
        await client.query(
          `UPDATE room_sort_run SET undone_at = now(), undone_by = $2 WHERE id = $1`,
          [lauf.id, principal.userId ?? null])
        // Eine Anweisung fuer alle Ereignisse, nicht eine je Zug (Befund 6).
        await emitEvents(client, pid, 'reservation.changed', lauf.moves.map(m => ({
          reservationRef: nach.get(m.reservationId)!.public_ref, resourceId: m.fromResourceId })))
        return { runRef, undone: lauf.moves.length }
      })
    }
  })
}

/** Vergibt StayGrid in diesem Haus die Zimmer selbst (Modus `auto`, E1)? */
export async function vergibtSelbst(client: PoolClient, propertyId: number): Promise<boolean> {
  return (await roomSortSetting(client, propertyId)).mode === 'auto'
}

export { roomSortLock as sortierSperre }
