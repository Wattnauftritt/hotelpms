import type { FastifyInstance } from 'fastify'
import type { CleaningWaiverSettings, CleaningWaiverView } from '@hotelpms/contracts'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'
import { pruefeHaus } from '../platform/terminal.js'
import { setzeVerzicht, verzichtEinstellung, verzichtStand }
  from '../platform/reinigungsverzicht.js'
import { verzichtAusRumpf } from './checkin.js'
import { tagOderOffen } from './cleaningPlan.js'

/**
 * Reinigungsverzicht: die Seite der Rezeption und die Einstellung je Haus
 * (Aufgabe 18, Baustein 10; Migration 0115). Die Gastseite steht in
 * `checkin.ts`, die Regel fuer beide in `platform/reinigungsverzicht.ts`.
 */
export function cleaningWaiverRoutes(app: FastifyInstance): void {
  /**
   * Fuer den Gast, der am Tresen oder am Telefon fragt. Unter
   * `reservation:checkin` wie der Check-in-Link: wer dem Gast den Weg zum
   * Selbermachen geben darf, darf es auch fuer ihn tun. Der Stand selbst
   * kommt mit der Reservierung (`cleaningWaiver`).
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/reservations/:reservationRef/cleaning-waiver',
    permission: 'reservation:checkin',
    summary: 'Zwischenreinigung eines Tages fuer den Gast abbestellen oder wieder bestellen',
    handler: async (req) => {
      const { reservationRef } = req.params as { reservationRef: string }
      const { date, waived } = verzichtAusRumpf(req.body)
      const principal = req.principal as Principal
      return tx(req.pool, req, async (client): Promise<CleaningWaiverView | null> => {
        const { rows } = await client.query<{ id: number; property_id: number }>(
          `SELECT id::int, property_id::int FROM reservation WHERE public_ref = $1`,
          [reservationRef])
        if (rows.length === 0) throw Errors.notFound('res.reservation')
        const r = rows[0]!
        pruefeHaus(req, r.property_id)
        const tag = await tagOderOffen(client, r.property_id, undefined)
        await setzeVerzicht(client, {
          reservationId: r.id, propertyId: r.property_id, businessDate: tag,
          date, waived, source: 'reception', userId: principal.userId })
        return verzichtStand(client, r.id, r.property_id, tag, true)
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/cleaning-waiver-settings',
    permission: 'housekeeping:plan',
    propertyParam: 'propertyId',
    summary: 'Einstellung zum Reinigungsverzicht',
    handler: async (req): Promise<CleaningWaiverSettings> => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, client => verzichtEinstellung(client, propertyId))
    }
  })

  /**
   * Bei der Hausdame und nicht in den Einstellungen des Hauses: sie
   * entscheidet, ob ihre Kraefte Wasser verteilen, und sie sieht im Plan,
   * was der Schalter bewirkt.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/cleaning-waiver-settings',
    permission: 'housekeeping:plan',
    propertyParam: 'propertyId',
    summary: 'Reinigungsverzicht ein- oder ausschalten',
    handler: async (req): Promise<CleaningWaiverSettings> => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const b = (req.body ?? {}) as { enabled?: unknown; waterGift?: unknown }
      if (typeof b.enabled !== 'boolean') throw Errors.validation({ enabled: ['field.invalid'] })
      if (typeof b.waterGift !== 'boolean') throw Errors.validation({ waterGift: ['field.invalid'] })
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        await client.query(
          `INSERT INTO property_cleaning_waiver_setting (property_id, enabled, water_gift, updated_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (property_id) DO UPDATE SET
             enabled = $2, water_gift = $3, updated_by = $4, updated_at = now()`,
          [propertyId, b.enabled, b.waterGift, principal.userId])
        return verzichtEinstellung(client, propertyId)
      })
    }
  })
}
