import type { FastifyInstance } from 'fastify'
import {
  kanalRefPruefen, kanalRumpfPruefen, kanalZeitpunktPruefen,
  kanalBuchungSetzen, kanalBuchungStornieren
} from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { txIm } from '../platform/db.js'
import { alsApiFehler, alsApiFehlerAsync } from '../platform/domainError.js'
import { authenticateChannel, channelContext } from '../platform/channelAuth.js'
import { sortierKonflikt } from './roomSort.js'
import { abgabenZurNummer } from './meldescheinPortal.js'

/*
 * Kanalbuchungen aus einem fuehrenden Umsystem (Migration 0092).
 *
 * Die Fachlogik steht seit der Kanalanbindung (Migration 0198) in
 * `@hotelpms/domain` (`channelBooking.ts`), mit allen Begruendungen: dieselbe
 * Buchung kommt jetzt auch ueber den Worker, wenn StayGrid sie bei einem
 * Channel Manager selbst abholt, und zwei Fassungen desselben Abgleichs
 * liefen auseinander. Hier bleibt nur, was HTTP ist: Token pruefen, Rumpf
 * lesen, Fehler uebersetzen.
 */

export function channelPushRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/channel/ari/bookings/:externalReference',
    // Wie die uebrigen Kanalrouten: abgesichert durch das Verbindungstoken.
    permission: null,
    summary: 'Kanalbuchung anlegen oder auf den Stand der Quelle bringen',
    handler: async (req, reply) => {
      const principal = await authenticateChannel(req.pool, req.headers.authorization)
      const ref = alsApiFehler(() => kanalRefPruefen(
        (req.params as { externalReference: string }).externalReference))
      const body = alsApiFehler(() => kanalRumpfPruefen(req.body))

      const ergebnis = await txIm(req.pool, req, channelContext(principal), async client => {
        const e = await alsApiFehlerAsync(() => sortierKonflikt(() =>
          kanalBuchungSetzen(client, principal, ref, body)))
        // Ein Meldeschein, der ueber den festen Link vor der Nummer kam,
        // findet jetzt seine Reservierung (0216). Bei jedem Push, nicht nur
        // wenn die Nummer neu ist: kam der Schein nach der Nummer, aber vor
        // dem Hauptgast, wartet er sonst bis zur Rezeption.
        if (body.channelBookingNumber !== undefined) {
          await abgabenZurNummer(client, principal.propertyId, body.channelBookingNumber)
        }
        return e
      })

      reply.status(ergebnis.status === 'created' ? 201 : 200)
      return ergebnis
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/channel/ari/bookings/:externalReference/cancel',
    permission: null,
    summary: 'Kanalbuchung stornieren',
    handler: async (req) => {
      const principal = await authenticateChannel(req.pool, req.headers.authorization)
      const ref = alsApiFehler(() => kanalRefPruefen(
        (req.params as { externalReference: string }).externalReference))
      const quelle = alsApiFehler(() => kanalZeitpunktPruefen(
        (req.body as { sourceUpdatedAt?: unknown } | undefined)?.sourceUpdatedAt,
        'sourceUpdatedAt'))

      return txIm(req.pool, req, channelContext(principal), client =>
        alsApiFehlerAsync(() => kanalBuchungStornieren(client, principal, ref, quelle)))
    }
  })
}
