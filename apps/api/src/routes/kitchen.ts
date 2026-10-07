import type { FastifyInstance } from 'fastify'
import { addDays } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { can, type Principal } from '../platform/context.js'
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
 *
 * **Gemeinsame Kueche** (0116): arbeitet der Betrieb mit gemeinsamem
 * Personal, kocht eine Kueche fuer alle Haeuser. Die Zahl ist dann die
 * Summe aller Haeuser, in denen die Kueche das Recht hat, und `houses`
 * zeigt die Aufteilung -- wer aufs Gaestehaus-Tablett zaehlt, braucht sie.
 * Die Tage sind die des Hauses aus dem Pfad; die Haeuser eines Betriebs
 * liegen am selben Ort und schliessen ihren Tag in derselben Nacht.
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
        const bis = addDays(heute, TAGE - 1)
        const p = req.principal as Principal
        const { rows } = await client.query<{ id: number; name: string }>(
          `SELECT q.id::int, q.name
             FROM unnest(staff_houses($1)) WITH ORDINALITY AS h(id, n)
             JOIN property q ON q.id = h.id
            ORDER BY h.n`, [propertyId])
        const haeuser = rows.filter(h => h.id === propertyId || can(p, 'kitchen:breakfast', h.id))
        if (haeuser.length <= 1) {
          return { date: heute, days: await fruehstueckeJeTag(client, propertyId, heute, bis),
                   houses: null }
        }
        const jeHaus: Array<{ propertyId: number; name: string
                              days: Awaited<ReturnType<typeof fruehstueckeJeTag>> }> = []
        for (const h of haeuser) {
          jeHaus.push({ propertyId: h.id, name: h.name,
                        days: await fruehstueckeJeTag(client, h.id, heute, bis) })
        }
        const days = jeHaus[0]!.days.map((d, i) => {
          const summe = { ...d }
          for (const h of jeHaus.slice(1)) {
            const x = h.days[i]
            if (x === undefined) continue
            summe.breakfasts += x.breakfasts; summe.adults += x.adults
            summe.children += x.children; summe.unsplit += x.unsplit; summe.assumed += x.assumed
          }
          return summe
        })
        return { date: heute, days, houses: jeHaus }
      })
    }
  })
}
