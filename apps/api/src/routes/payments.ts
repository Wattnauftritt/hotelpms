import type { FastifyInstance } from 'fastify'
import { withTransaction, SYSTEM_CONTEXT } from '@hotelpms/db'
import { paymentSucceeded } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import { loadConfig } from '../platform/config.js'
import type { Principal } from '../platform/context.js'
import { createStripeAdapter, verifyStripeSignature, parseStripeEvent,
         type StripeAdapter } from '../platform/payments/stripe.js'

export interface PaymentRouteOverrides {
  /** Fuer Tests: ein Adapter ohne echten Netzwerkzugriff auf Stripe. */
  stripe?: StripeAdapter
}

export function paymentsRoutes(app: FastifyInstance, overrides: PaymentRouteOverrides = {}): void {
  const config = loadConfig()
  const stripe = overrides.stripe
    ?? (config.stripeSecretKey ? createStripeAdapter(config.stripeSecretKey) : null)

  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/payment-links',
    permission: 'folio:post',
    summary: 'Pay-by-Link ueber Stripe anfordern',
    handler: async (req, reply) => {
      if (!stripe) throw Errors.notConfigured('STRIPE_SECRET_KEY ist nicht gesetzt.')

      const { folioRef } = req.params as { folioRef: string }
      const body = req.body as { amountCent: number }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['Kopfzeile erforderlich'] })
      if (!Number.isInteger(body.amountCent) || body.amountCent <= 0) {
        throw Errors.validation({ amountCent: ['Muss eine positive Centzahl sein'] })
      }

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(client, principal.clientKey, key, body)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; status: string }>(
          `SELECT id, property_id, status FROM folio WHERE public_ref = $1`, [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('Folio')
        const folio = f.rows[0]!
        if (folio.status === 'closed') throw Errors.conflict('Folio ist geschlossen.')

        const session = await stripe.createCheckoutSession({
          amountCent: body.amountCent,
          reference: folioRef,
          successUrl: `${config.publicAppUrl}/folios/${folioRef}?zahlung=erfolgreich`,
          cancelUrl: `${config.publicAppUrl}/folios/${folioRef}?zahlung=abgebrochen`
        })

        await client.query(
          `INSERT INTO payment_intent (property_id, folio_id, provider, provider_reference,
                                        amount_cent, created_by)
           VALUES ($1,$2,'stripe',$3,$4,$5)`,
          [folio.property_id, folio.id, session.providerReference, body.amountCent,
           principal.userId])

        const result = { url: session.url }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/payments/stripe/webhook',
    permission: null,
    summary: 'Stripe-Benachrichtigung ueber eine Pay-by-Link-Zahlung entgegennehmen',
    handler: async (req, reply) => {
      if (!config.stripeWebhookSecret) throw Errors.notConfigured('STRIPE_WEBHOOK_SECRET ist nicht gesetzt.')
      const raw = req.rawBody
      if (!raw || raw.length === 0) throw Errors.validation({ body: ['Rumpf fehlt'] })

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
          amount_cent: number; status: string
        }>(
          `SELECT id, property_id, folio_id, amount_cent, status FROM payment_intent
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
        // Protokoll vorbei, nicht aber an diesem WHERE status = 'pending'.
        const cas = await client.query(
          `UPDATE payment_intent SET status = 'succeeded', settled_at = now()
            WHERE id = $1 AND status = 'pending' RETURNING id`,
          [row.id])
        if (cas.rowCount === 0) return

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
      })

      reply.status(200)
      return { received: true }
    }
  })
}
