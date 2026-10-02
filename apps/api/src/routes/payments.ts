import type { FastifyInstance } from 'fastify'
import { withTransaction, SYSTEM_CONTEXT } from '@hotelpms/db'
import { paymentSucceeded } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { loadConfig } from '../platform/config.js'
import { createStripeAdapter, verifyStripeSignature, parseStripeEvent,
         type StripeAdapter } from '../platform/payments/stripe.js'
import { paymentLinkRoutes } from './paymentLinks.js'

export interface PaymentRouteOverrides {
  /** Fuer Tests: ein Adapter ohne echten Netzwerkzugriff auf Stripe. */
  stripe?: StripeAdapter
}

export function paymentsRoutes(app: FastifyInstance, overrides: PaymentRouteOverrides = {}): void {
  const config = loadConfig()
  const stripe = overrides.stripe
    ?? (config.stripeSecretKey ? createStripeAdapter(config.stripeSecretKey) : null)

  // Zahlungslinks: anlegen, widerrufen, und die Seite, die der Gast oeffnet
  // (Migration 0059). Eigene Datei, derselbe Adapter.
  paymentLinkRoutes(app, stripe, config)

  registerRoute(app, {
    method: 'POST',
    url: '/v1/payments/stripe/webhook',
    permission: null,
    summary: 'Stripe-Benachrichtigung ueber eine Pay-by-Link-Zahlung entgegennehmen',
    handler: async (req, reply) => {
      if (!config.stripeWebhookSecret) throw Errors.notConfigured('payments.stripeWebhookSecretMissing')
      const raw = req.rawBody
      if (!raw || raw.length === 0) throw Errors.validation({ body: ['field.bodyMissing'] })

      try {
        verifyStripeSignature(
          raw, req.headers['stripe-signature'] as string | undefined, config.stripeWebhookSecret)
      } catch (err) {
        throw Errors.invalidSignature((err as Error).message)
      }

      const event = parseStripeEvent(raw)

      // Eine einzige Transaktion: der Mandantenkontext ist zu Beginn leer
      // (SYSTEM_CONTEXT), denn payment_intent traegt keine Zeilenrichtlinie
      // und ist so vor Herstellung des Kontexts nachschlagbar. Erst nach dem
      // Nachschlagen ist die Property bekannt; ab da wird der Kontext
      // innerhalb derselben Transaktion gesetzt, damit das Schreiben auf
      // folio und settlement durch die Zeilenrichtlinie geht. Zwei getrennte
      // Transaktionen waeren hier ein stiller Fehler: stuerbe der Prozess
      // zwischen ihnen, bliebe die Zahlung ohne Zahlungsvermerk, und eine
      // Wiederholung der Zustellung wuerde durch das Zustellungsprotokoll
      // faelschlich als schon erledigt gelten.
      await withTransaction(req.pool, SYSTEM_CONTEXT, async client => {
        const intent = await client.query<{
          id: number; property_id: number; folio_id: number
          amount_cent: number; status: string; deposit_request_id: number | null
        }>(
          `SELECT id, property_id, folio_id, amount_cent, status, deposit_request_id
             FROM payment_intent
            WHERE provider = 'stripe' AND provider_reference = $1 FOR UPDATE`,
          [event.providerReference])
        if (intent.rowCount === 0) {
          req.log.warn({ providerReference: event.providerReference },
            'Stripe-Ereignis ohne bekannte Zahlungsanfrage')
          return
        }
        const row = intent.rows[0]!

        await client.query(`SELECT set_config('app.property_ids', $1, true)`,
          [String(row.property_id)])

        await client.query(
          `INSERT INTO payment_event (provider, provider_event_id, payment_intent_id)
           VALUES ('stripe', $1, $2) ON CONFLICT DO NOTHING`,
          [event.eventId, row.id])

        if (event.kind === 'failed') {
          await client.query(
            `UPDATE payment_intent SET status = 'failed' WHERE id = $1 AND status = 'pending'`,
            [row.id])
          return
        }
        if (!paymentSucceeded(row.amount_cent, event)) return

        // Der Statusuebergang, nicht das Zustellungsprotokoll, ist die
        // eigentliche Sperre gegen einen doppelten Zahlungsvermerk: ein
        // zweites, andersartiges Ereignis fuer dieselbe Zahlung (Stripe
        // sendet oft mehrere) hat eine andere Ereignis-ID und kaeme am
        // Protokoll vorbei, nicht aber an diesem Uebergang nach 'succeeded'.
        //
        // **Aus jedem Zustand ausser 'succeeded'** (seit 0059), nicht nur
        // aus 'pending'. Ein Checkout, den wir fuer abgelaufen halten und
        // durch einen neuen ersetzt haben, kann beim Anbieter im letzten
        // Augenblick noch bezahlt worden sein; seine Meldung kommt dann
        // nach unserer Markierung. Meldet der Anbieter Geld, ist das Geld
        // da -- es zu verwerfen, hiesse einen Zahlungseingang zu
        // verschweigen, den der Kontoauszug zeigt. Doppelzahlungen
        // verhindert die Route, die Checkouts anlegt (ein offener je Link,
        // ein neuer erst, wenn der Anbieter den alten fuer erledigt
        // erklaert), nicht dieser Empfang.
        const cas = await client.query(
          `UPDATE payment_intent SET status = 'succeeded', settled_at = now()
            WHERE id = $1 AND status <> 'succeeded' RETURNING id`,
          [row.id])
        if (cas.rowCount === 0) return
        if (row.status !== 'pending') {
          req.log.warn({ paymentIntentId: row.id, vorher: row.status },
            'Zahlung auf einen nicht mehr offenen Checkout eingegangen')
        }

        const pm = await client.query<{ id: number }>(
          `INSERT INTO payment_method (property_id, code, name)
           VALUES ($1, 'STRIPE', 'Stripe (Pay-by-Link)')
           ON CONFLICT (property_id, code) DO UPDATE SET code = EXCLUDED.code
           RETURNING id`,
          [row.property_id])

        const bd = await client.query<{ date: string }>(
          `SELECT date::text FROM business_day
            WHERE property_id = $1 AND status = 'open' ORDER BY date DESC LIMIT 1`,
          [row.property_id])

        const settlement = await client.query<{ id: number }>(
          `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                                    payment_method_id, external_reference)
           VALUES ($1,$2,$3::date,$4,$5,$6) RETURNING id`,
          [row.property_id, row.folio_id,
           bd.rows[0]?.date ?? new Date().toISOString().slice(0, 10),
           row.amount_cent, pm.rows[0]!.id, `stripe:${event.providerReference}`])

        await client.query(`UPDATE payment_intent SET settlement_id = $2 WHERE id = $1`,
          [row.id, settlement.rows[0]!.id])

        /*
         * Zahlt der Link auf eine Anzahlungsanforderung, gehoert der Eingang
         * zu ihr -- in derselben Transaktion, aus demselben Grund wie oben:
         * dazwischen sterben darf der Prozess nicht, sonst stuende das Geld
         * auf dem Folio und die Anforderung als ueberfaellig da.
         *
         * Genau einmal, weil der Statusuebergang davor genau einmal gelingt;
         * der eindeutige Index auf settlement_id waere die zweite Sperre.
         * Eine Anzahlungsrechnung entsteht hier **nicht**: sie traegt eine
         * Nummer aus der lueckenlosen Folge und Pflichtangaben, die ein
         * Mensch pruefen soll (Dokument 16, Aufgabe 3). Die Maske zeigt den
         * Eingang ohne Rechnung an, bis jemand sie ausstellt.
         */
        if (row.deposit_request_id !== null) {
          await client.query(
            `INSERT INTO deposit_request_settlement
               (property_id, folio_id, deposit_request_id, settlement_id)
             VALUES ($1,$2,$3,$4) ON CONFLICT (settlement_id) DO NOTHING`,
            [row.property_id, row.folio_id, row.deposit_request_id, settlement.rows[0]!.id])
        }
      })

      reply.status(200)
      return { received: true }
    }
  })
}
