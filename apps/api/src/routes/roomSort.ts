import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Meldung } from '../platform/texte.js'
import {
  ROOM_SORT_MODES, checkRoomSortWeights, resolveRoomSortWeights,
  type RoomSortMode, type RoomSortWeights
} from '@hotelpms/domain'

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
