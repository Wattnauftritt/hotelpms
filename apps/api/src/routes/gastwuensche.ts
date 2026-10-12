import type { FastifyInstance } from 'fastify'
import type { FolderRequests, GuestRequestCatalog, GuestRequestRow } from '@hotelpms/contracts'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'
import { mappeTx, aufenthaltDerSitzung } from '../platform/gaestemappe.js'
import { mappeWuensche, wunschAusRumpf, wunschAnlegen, nachrichtAusRumpf, nachrichtAnlegen,
         wunschErledigen, wunschAblehnen, ablehnGrund, wunschZeile, katalogAnsicht, eintragAusRumpf,
         eintragSpeichern } from '../platform/gastwuensche.js'

/**
 * Wuensche und Extras aus der Gaestemappe (Migration 0149, Dokument 35).
 *
 * Der Gast waehlt in der freigeschalteten Mappe aus dem Katalog des
 * Hauses; die Rezeption nimmt unter "Heute" oder im Seitenfenster an oder
 * lehnt mit einem festen Grund ab. Ein Extra mit Preis kommt beim
 * Annehmen aufs Folio. Die Regeln stehen in `platform/gastwuensche.ts`,
 * damit Mail-Link und Terminal sie spaeter mit einer eigenen Route, aber
 * ohne eigene Fassung nutzen.
 */
export function gastwuenscheRoutes(app: FastifyInstance): void {
  /**
   * Einen Wunsch absenden. Nur mit Freischaltung (0147): die Karte allein
   * hat jeder, der je im Zimmer war, und ein Extra mit Preis landet auf
   * dem Folio des Aufenthalts.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/mappe/requests',
    // Oeffentlich: Zimmer-Referenz und Freischaltung im Cookie sind der
    // Ausweis; ohne Freischaltung 403 (0147, 0149).
    permission: null,
    summary: 'Gaestemappe: einen Wunsch oder ein Extra bestellen',
    handler: async (req, reply): Promise<FolderRequests | null> => {
      reply.header('cache-control', 'no-store')
      const w = wunschAusRumpf(req.body)
      return mappeTx(req, async (client, k) => {
        const a = await aufenthaltDerSitzung(client, req, k)
        if (a === null) throw Errors.forbidden('folder.unlockRequired')
        await wunschAnlegen(client, { propertyId: k.propertyId, reservationId: a.reservationId,
          businessDate: k.businessDate, source: 'folder', ...w })
        return mappeWuensche(client, k.propertyId, a.reservationId, k.businessDate)
      })
    }
  })

  /**
   * Eine Nachricht an die Rezeption (0153). Wie ein Wunsch nur mit
   * Freischaltung, und nur, wenn das Haus sie eingeschaltet hat.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/mappe/messages',
    // Oeffentlich: Zimmer-Referenz und Freischaltung im Cookie sind der
    // Ausweis; ohne Freischaltung 403 (0147, 0153).
    permission: null,
    summary: 'Gaestemappe: eine Nachricht an die Rezeption schicken',
    handler: async (req, reply): Promise<FolderRequests | null> => {
      reply.header('cache-control', 'no-store')
      const text = nachrichtAusRumpf(req.body)
      return mappeTx(req, async (client, k) => {
        const a = await aufenthaltDerSitzung(client, req, k)
        if (a === null) throw Errors.forbidden('folder.unlockRequired')
        await nachrichtAnlegen(client, { propertyId: k.propertyId,
          reservationId: a.reservationId, text })
        return mappeWuensche(client, k.propertyId, a.reservationId, k.businessDate)
      })
    }
  })

  // ------------------------------------------------------------ Rezeption

  registerRoute(app, {
    method: 'POST',
    url: '/v1/guest-requests/:requestRef/done',
    permission: 'reservation:checkin',
    summary: 'Gaestewunsch erledigen; ein Extra mit Preis wird dabei gebucht',
    handler: async (req): Promise<GuestRequestRow> => {
      const { requestRef } = req.params as { requestRef: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        await wunschErledigen(client, principal, requestRef)
        return wunschZeile(client, requestRef)
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/guest-requests/:requestRef/decline',
    permission: 'reservation:checkin',
    summary: 'Gaestewunsch ablehnen, mit einem Grund aus der festen Liste',
    handler: async (req): Promise<GuestRequestRow> => {
      const { requestRef } = req.params as { requestRef: string }
      const grund = ablehnGrund(req.body)
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        await wunschAblehnen(client, principal, requestRef, grund)
        return wunschZeile(client, requestRef)
      })
    }
  })

  // -------------------------------------------------------------- Katalog

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/guest-folder/request-items',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe: Wunschkatalog des Hauses mit Preisen',
    handler: async (req): Promise<GuestRequestCatalog> => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, client => katalogAnsicht(client, propertyId))
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/guest-folder/request-items',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe: Eintrag im Wunschkatalog anlegen',
    handler: async (req, reply): Promise<GuestRequestCatalog> => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const e = eintragAusRumpf(req.body)
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        await eintragSpeichern(client, propertyId, null, e, principal.userId)
        reply.status(201)
        return katalogAnsicht(client, propertyId)
      })
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/guest-folder/request-items/:itemRef',
    permission: 'settings:property',
    propertyParam: 'propertyId',
    summary: 'Gaestemappe: Eintrag im Wunschkatalog aendern',
    handler: async (req): Promise<GuestRequestCatalog> => {
      const { propertyId, itemRef } = req.params as { propertyId: string; itemRef: string }
      const e = eintragAusRumpf(req.body)
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        await eintragSpeichern(client, Number(propertyId), itemRef, e, principal.userId)
        return katalogAnsicht(client, Number(propertyId))
      })
    }
  })
}
