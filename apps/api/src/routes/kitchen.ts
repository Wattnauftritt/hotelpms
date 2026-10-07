import type { FastifyInstance } from 'fastify'
import { addDays } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { tagOderOffen } from './cleaningPlan.js'
import { fruehstueckeJeTag } from './occupancyStats.js'

/**
 * Kueche (Aufgabe 18, Baustein 5; Migration 0110).
 *
 * Die Fruehstueckszahl ab dem offenen Geschaeftstag fuer eine Woche: heute
 * fuer den Morgen, morgen fuer den Einkauf, der Rest fuer die Bestellung.
 * Dieselbe Rechnung wie `GET /breakfast` (`fruehstueckeJeTag`), damit Kueche,
 * Hausdame und Leitung dieselbe Zahl sehen.
 *
 * **Ab dem Geschaeftstag, nicht dem Datum des Telefons.** Um zwei Uhr
 * nachts ist der Kalender schon weiter, der Hoteltag noch nicht; die
 * Fruehstueckskraft, die um sechs kommt, braucht die Zahl des Hoteltags.
 */

const TAGE = 7

export function kitchenRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/kitchen',
    permission: 'kitchen:breakfast',
    propertyParam: 'propertyId',
    summary: 'Fruehstueckszahl heute und in den naechsten sechs Tagen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        const heute = await tagOderOffen(client, propertyId, undefined)
        const days = await fruehstueckeJeTag(client, propertyId, heute,
          addDays(heute, TAGE - 1))
        return { date: heute, days }
      })
    }
  })
}
