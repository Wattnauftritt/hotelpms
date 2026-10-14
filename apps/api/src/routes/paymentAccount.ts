import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Config } from '../platform/config.js'
import type { Principal } from '../platform/context.js'
import { isTrainingProperty } from '../platform/training.js'
import { ProviderRefused, stripeConnectUrl, type StripeAdapter }
  from '../platform/payments/stripe.js'
import { connectStateErzeugen, connectStatePruefen } from '../platform/payments/connectState.js'
import { rechtImHaus } from './depositRequests.js'

/**
 * Das Stripe-Konto eines Hauses verbinden und trennen (Stripe Connect,
 * Migration 0167).
 *
 * **Das Hotel ist Vertragspartner von Stripe, nicht die Plattform.** Es
 * meldet sich bei Stripe mit seinem eigenen Konto an oder legt dort eines
 * an; StayGrid bekommt nur die Erlaubnis, in seinem Namen Checkouts
 * anzulegen. Auszahlung, Gebuehren, Rueckbuchungen und Erstattungen bleiben
 * beim Hotel. Der Plattform-Schluessel ist dabei nur der Ausweis, mit dem
 * StayGrid fuer das Konto handelt; ueber ihn laeuft kein Geld.
 *
 * **Die Rueckkehr landet in der Oberflaeche, nicht hier.** Stripe leitet
 * nach `/stripe-verbunden` weiter, und die Seite reicht Code und `state` per
 * POST an die API. Ein GET direkt auf die API bekaeme das Sitzungscookie
 * nicht: es ist `SameSite=Strict`, und eine Weiterleitung von stripe.com
 * ist eine fremde Herkunft.
 *
 * Recht `integration:manage`: ein Zahlungskonto ist eine Schnittstelle wie
 * Channel Manager und Webhooks, und wer es verbindet, bestimmt, wohin das
 * Geld der Gaeste geht.
 */
export function paymentAccountRoutes(
  app: FastifyInstance, stripe: StripeAdapter | null, config: Config
): void {
  const redirectUri = `${config.publicAppUrl}/stripe-verbunden`
  const verbindbar = stripe !== null && config.stripeConnectClientId !== null

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/payment-account',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Verbundenes Stripe-Konto des Hauses',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const zeile = await tx(req.pool, req, async client => {
        const r = await client.query<{ provider_account: string; charges_enabled: boolean
                                       connected_at: Date }>(
          `SELECT provider_account, charges_enabled, connected_at
             FROM property_payment_account WHERE property_id = $1`, [propertyId])
        return r.rows[0] ?? null
      })

      /*
       * Ein frisch angelegtes Konto ist erst nach der Pruefung bei Stripe
       * freigeschaltet. Meist meldet das der Webhook (`account.updated`);
       * fehlt er oder ist die Meldung noch unterwegs, fragt die Maske hier
       * nach, ohne Verbindung aus dem Pool.
       */
      let chargesEnabled = zeile?.charges_enabled ?? false
      if (zeile !== null && !chargesEnabled && stripe !== null) {
        try {
          chargesEnabled = (await stripe.getAccount(zeile.provider_account)).chargesEnabled
          if (chargesEnabled) {
            await tx(req.pool, req, client => client.query(
              `UPDATE property_payment_account SET charges_enabled = true, updated_at = now()
                WHERE property_id = $1 AND provider_account = $2`,
              [propertyId, zeile.provider_account]))
          }
        } catch (err) {
          req.log.warn({ err }, 'Stripe-Konto nicht abgefragt')
        }
      }

      return {
        configured: verbindbar,
        account: zeile === null ? null : {
          accountId: zeile.provider_account,
          chargesEnabled,
          connectedAt: zeile.connected_at.toISOString()
        }
      }
    }
  })

  /** Die Adresse bei Stripe, unter der das Hotel verbindet. */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/payment-account/connect',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Stripe-Konto verbinden: Adresse bei Stripe erzeugen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const principal = req.principal as Principal
      if (!verbindbar || config.stripeConnectClientId === null) {
        throw Errors.notConfigured('payments.connectNotConfigured')
      }
      if (principal.userId === null) throw Errors.forbidden('access.missingPermission',
        { permission: 'integration:manage' })
      // Ein Uebungshaus bekommt kein echtes Zahlungskonto, aus demselben
      // Grund, aus dem es keinen Zahlungslink erzeugt.
      await tx(req.pool, req, async client => {
        if (await isTrainingProperty(client, propertyId)) {
          throw Errors.unprocessable('training.noPaymentLink')
        }
      })
      const state = connectStateErzeugen(config.sessionSecret,
        { propertyId, userId: principal.userId })
      return { url: stripeConnectUrl(config.stripeConnectClientId, state, redirectUri) }
    }
  })

  /**
   * Die Rueckkehr von Stripe: Code einloesen, Konto am Haus vermerken.
   *
   * Das Haus kommt aus dem signierten `state`, nicht aus der Adresse, und
   * nur derselbe Benutzer, der den Knopf gedrueckt hat, loest ihn ein.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/payment-account/complete',
    permission: 'integration:manage',
    summary: 'Stripe-Konto verbinden: Rueckkehr von Stripe einloesen',
    handler: async (req) => {
      const body = (req.body ?? {}) as { code?: string; state?: string; error?: string }
      const principal = req.principal as Principal
      if (!stripe) throw Errors.notConfigured('payments.connectNotConfigured')
      const s = typeof body.state === 'string'
        ? connectStatePruefen(config.sessionSecret, body.state) : null
      if (s === null || s.userId !== principal.userId) {
        throw Errors.unprocessable('payments.connectStateInvalid')
      }
      rechtImHaus(principal, 'integration:manage', s.propertyId)
      // Abgebrochen bei Stripe: nichts zu tun, die Maske sagt es.
      if (typeof body.error === 'string' || typeof body.code !== 'string' || body.code === '') {
        throw Errors.unprocessable('payments.connectRefused')
      }

      let accountId: string
      let chargesEnabled: boolean
      try {
        accountId = (await stripe.connectExchange(body.code)).accountId
        chargesEnabled = (await stripe.getAccount(accountId)).chargesEnabled
      } catch (err) {
        if (err instanceof ProviderRefused) throw Errors.unprocessable('payments.connectRefused')
        req.log.warn({ err }, 'Stripe-Konto nicht verbunden')
        throw Errors.upstreamFailed('payments.providerUnavailable')
      }

      await tx(req.pool, req, client => client.query(
        `INSERT INTO property_payment_account
           (property_id, provider, provider_account, charges_enabled, connected_by)
         VALUES ($1, 'stripe', $2, $3, $4)
         ON CONFLICT (property_id) DO UPDATE
            SET provider_account = EXCLUDED.provider_account,
                charges_enabled = EXCLUDED.charges_enabled,
                connected_by = EXCLUDED.connected_by,
                connected_at = now(), updated_at = now()`,
        [s.propertyId, accountId, chargesEnabled, principal.userId]))
      return { propertyId: s.propertyId, accountId, chargesEnabled }
    }
  })

  /**
   * Die Verbindung loesen.
   *
   * **Nicht, solange ein Checkout offen ist.** Nach dem Trennen meldet
   * Stripe nichts mehr von diesem Konto -- ein Gast, der danach noch
   * bezahlt, haette Geld beim Hotel, das hier nie verbucht wird. Wer
   * trennen will, widerruft vorher die offenen Links.
   *
   * Zuerst bei uns, dann beim Anbieter: ist die Zeile weg, entsteht kein
   * neuer Checkout mehr auf dem Konto. Scheitert danach der Aufruf bei
   * Stripe, ist das Haus trotzdem getrennt; die Erlaubnis bei Stripe kann
   * das Hotel dort selbst entziehen. Beim Anbieter getrennt wird nur, wenn
   * kein anderes Haus dasselbe Konto nutzt; sonst verloere das Gaestehaus
   * seine Zahlungen, weil das Hotel aufgeraeumt hat.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/payment-account/disconnect',
    permission: 'integration:manage',
    propertyParam: 'propertyId',
    summary: 'Stripe-Konto des Hauses trennen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const erst = await tx(req.pool, req, async client => {
        const r = await client.query<{ provider_account: string }>(
          `SELECT provider_account FROM property_payment_account
            WHERE property_id = $1 FOR UPDATE`, [propertyId])
        const konto = r.rows[0]?.provider_account
        if (konto === undefined) throw Errors.notFound('res.paymentAccount')
        const offen = await client.query(
          `SELECT 1 FROM payment_intent
            WHERE property_id = $1 AND provider_account = $2 AND status = 'pending'
              AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`, [propertyId, konto])
        if ((offen.rowCount ?? 0) > 0) throw Errors.conflict('payments.accountHasOpenCheckouts')
        await client.query(
          `DELETE FROM property_payment_account WHERE property_id = $1`, [propertyId])
        const andere = await client.query(
          `SELECT 1 FROM property_payment_account
            WHERE provider = 'stripe' AND provider_account = $1 LIMIT 1`, [konto])
        return { konto, geteilt: (andere.rowCount ?? 0) > 0 }
      })

      let beimAnbieter = false
      if (!erst.geteilt && stripe !== null && config.stripeConnectClientId !== null) {
        try {
          await stripe.deauthorize(erst.konto)
          beimAnbieter = true
        } catch (err) {
          // Schon getrennt (vom Hotel selbst bei Stripe) ist kein Fehler.
          if (err instanceof ProviderRefused) beimAnbieter = true
          else req.log.warn({ err }, 'Stripe-Konto beim Anbieter nicht getrennt')
        }
      }
      return { ok: true, providerDisconnected: beimAnbieter }
    }
  })
}
