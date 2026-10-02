import type { FastifyInstance } from 'fastify'
import { withTransaction, SYSTEM_CONTEXT } from '@hotelpms/db'
import { paymentSucceeded, isSendableAddress, emailLanguage, depositRequestOpenCent,
         renderPaymentLinkEmail } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { beginIdempotent, completeIdempotent } from '../platform/idempotency.js'
import { loadConfig } from '../platform/config.js'
import type { Principal } from '../platform/context.js'
import { isTrainingProperty } from '../platform/training.js'
import { createStripeAdapter, verifyStripeSignature, parseStripeEvent, ProviderRefused,
         type StripeAdapter } from '../platform/payments/stripe.js'
import { rechtImHaus, anforderungSperren, postBereitschaft } from './depositRequests.js'

export interface PaymentRouteOverrides {
  /** Fuer Tests: ein Adapter ohne echten Netzwerkzugriff auf Stripe. */
  stripe?: StripeAdapter
}

export function paymentsRoutes(app: FastifyInstance, overrides: PaymentRouteOverrides = {}): void {
  const config = loadConfig()
  const stripe = overrides.stripe
    ?? (config.stripeSecretKey ? createStripeAdapter(config.stripeSecretKey) : null)

  /**
   * Pay-by-Link: einen Zahlungslink beim Anbieter anfordern, auf Wunsch einer
   * Anzahlungsanforderung zugeordnet und in derselben Anfrage per Gastpost
   * an den Gast geschickt.
   *
   * **Senden geht nur hier, nicht spaeter.** Die Adresse des Links wird
   * nicht gespeichert (Vertrag `PaymentLink`); eine Route "diesen Link
   * schicken" muesste sie sich vom Aufrufer geben lassen -- und dann
   * bestimmte der Aufrufer den Inhalt der Gastpost, nicht nur den
   * Empfaenger. Genau diese Grenze haelt `routes/email.ts`.
   *
   * **Ein Uebungshaus bekommt keinen Link.** Er fuehrte zu einem echten
   * Anbieter, und ein Gast, dessen echte Adresse im Schulungshaus steht,
   * koennte echtes Geld auf eine Uebungsbuchung zahlen.
   *
   * **Die Post wird vor dem Anbieter geprueft.** Was `email_enqueue` spaeter
   * abweisen wuerde -- Versand aus, Absender nicht freigeschaltet, keine
   * Adresse --, faellt vorher auf. Sonst laege beim Anbieter ein Checkout,
   * zu dem es bei uns nichts gibt.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/folios/:folioRef/payment-links',
    permission: 'folio:post',
    summary: 'Pay-by-Link ueber Stripe anfordern, optional per Gastpost schicken',
    handler: async (req, reply) => {
      if (!stripe) throw Errors.notConfigured('payments.stripeKeyMissing')

      const { folioRef } = req.params as { folioRef: string }
      const body = (req.body ?? {}) as {
        amountCent: number
        /** Die Anforderung, auf die der Link zahlt. */
        depositRequestRef?: string
        /** In derselben Anfrage an den Gast der Reservierung schicken. */
        sendEmail?: boolean
        /** Abweichende Adresse. Nur zusammen mit sendEmail. */
        to?: string
      }
      const principal = req.principal as Principal
      const key = req.headers['idempotency-key'] as string | undefined
      if (!key) throw Errors.validation({ 'idempotency-key': ['field.headerRequired'] })
      if (!Number.isInteger(body.amountCent) || body.amountCent <= 0) {
        throw Errors.validation({ amountCent: ['field.positiveCent'] })
      }
      if (body.to !== undefined && !isSendableAddress(body.to)) {
        throw Errors.validation({ to: ['field.email'] })
      }

      return tx(req.pool, req, async client => {
        const stored = await beginIdempotent(
          client, principal.clientKey, key, body, principal.accountIds[0]!)
        if (stored) { reply.status(stored.status); return stored.body }

        const f = await client.query<{ id: number; property_id: number; status: string
                                       reservation_id: number | null }>(
          `SELECT id, property_id, status, reservation_id FROM folio WHERE public_ref = $1`,
          [folioRef])
        if (f.rowCount === 0) throw Errors.notFound('res.folio')
        const folio = f.rows[0]!
        rechtImHaus(principal, 'folio:post', folio.property_id)
        if (folio.status === 'closed') throw Errors.conflict('folio.closed')

        if (await isTrainingProperty(client, folio.property_id)) {
          throw Errors.unprocessable('training.noPaymentLink')
        }

        let anforderung: { id: number; dueDate: string } | null = null
        if (body.depositRequestRef !== undefined) {
          const a = await anforderungSperren(client, body.depositRequestRef)
          if (a.folio_id !== folio.id) throw Errors.notFound('res.depositRequest')
          if (a.canceled) throw Errors.conflict('deposit.requestCanceled')
          const offen = depositRequestOpenCent(a.amount_cent, a.received_cent)
          if (offen <= 0) throw Errors.conflict('deposit.requestFulfilled')
          if (body.amountCent > offen) {
            throw Errors.unprocessable('deposit.linkExceedsOpen',
              { amount: body.amountCent, open: offen })
          }
          anforderung = { id: a.id, dueDate: a.due_date }
        }

        /*
         * Alles, was die Post braucht, **bevor** der Anbieter gefragt wird.
         * Empfaenger ist der Gast der Reservierung, wie bei der
         * Buchungsbestaetigung -- und aus demselben Grund: die Loeschung
         * eines Gastes findet seine Post ueber die Reservierung (0046).
         */
        let post: {
          to: string; name: string | null; language: string | null
          reservationId: number; reservationRef: string; arrival: string
          departure: string; propertyName: string; currency: string
        } | null = null
        if (body.sendEmail === true) {
          rechtImHaus(principal, 'email:send', folio.property_id)
          if (folio.reservation_id === null) {
            throw Errors.unprocessable('deposit.needsReservation')
          }
          const bereit = await postBereitschaft(client, folio.property_id, false)
          if (bereit.reason === 'disabled') throw Errors.unprocessable('mail.sendingDisabled')
          if (bereit.reason === 'sender') throw Errors.unprocessable('mail.senderNotActive')

          const r = await client.query<{
            public_ref: string; arrival: string; departure: string
            property_name: string; currency: string; email: string | null
            name: string | null; language: string | null; anonymized: boolean }>(
            `SELECT r.public_ref, r.arrival::text, r.departure::text,
                    p.name AS property_name, p.currency,
                    g.email, g.language,
                    nullif(trim(concat_ws(' ', g.first_name, g.last_name)), '') AS name,
                    COALESCE(g.status = 'anonymized', false) AS anonymized
               FROM reservation r
               JOIN property p   ON p.id = r.property_id
               LEFT JOIN guest g ON g.id = r.primary_guest_id
              WHERE r.id = $1`, [folio.reservation_id])
          const res = r.rows[0]!
          if (res.anonymized) throw Errors.unprocessable('mail.guestAnonymized')
          const adresse = body.to ?? res.email
          if (!isSendableAddress(adresse)) {
            throw Errors.unprocessable('mail.noReservationAddress')
          }
          post = {
            to: adresse!, name: res.name, language: res.language,
            reservationId: folio.reservation_id, reservationRef: res.public_ref,
            arrival: res.arrival, departure: res.departure,
            propertyName: res.property_name, currency: res.currency
          }
        }

        const session = await stripe.createCheckoutSession({
          amountCent: body.amountCent,
          reference: folioRef,
          successUrl: `${config.publicAppUrl}/folios/${folioRef}?zahlung=erfolgreich`,
          cancelUrl: `${config.publicAppUrl}/folios/${folioRef}?zahlung=abgebrochen`
        })

        const pi = await client.query<{ id: number }>(
          `INSERT INTO payment_intent (property_id, folio_id, provider, provider_reference,
                                        amount_cent, created_by, deposit_request_id, expires_at)
           VALUES ($1,$2,'stripe',$3,$4,$5,$6,$7) RETURNING id`,
          [folio.property_id, folio.id, session.providerReference, body.amountCent,
           principal.userId, anforderung?.id ?? null, session.expiresAt ?? null])
        const linkId = pi.rows[0]!.id

        let messageRef: string | null = null
        if (post !== null) {
          const text = renderPaymentLinkEmail({
            propertyName: post.propertyName,
            guestName: post.name,
            reservationRef: post.reservationRef,
            arrival: post.arrival,
            departure: post.departure,
            amountCent: body.amountCent,
            currency: post.currency,
            dueDate: anforderung?.dueDate ?? null,
            deposit: anforderung !== null,
            url: session.url
          }, emailLanguage(post.language))
          const q = await client.query<{ ref: string }>(
            `SELECT email_enqueue($1,'payment_link',$2,$3,$4,$5,$6,NULL,$7,$8) AS ref`,
            [folio.property_id, post.to, post.name, text.subject, text.text, text.html,
             post.reservationId, principal.userId])
          messageRef = q.rows[0]!.ref
          await client.query(
            `UPDATE payment_intent
                SET email_id = (SELECT id FROM outbound_email WHERE public_ref = $2)
              WHERE id = $1`, [linkId, messageRef])
        }

        /*
         * Die Adresse steht in der Antwort und damit im Idempotenzspeicher,
         * wie schon vor 0060: ein Wiederholungsversuch nach einer
         * Zeitueberschreitung soll denselben Link bekommen und nicht einen
         * zweiten Checkout beim Anbieter erzeugen. Eine Spalte, die jeder
         * mit Lesezugriff auf das Folio abfragen kann, bekommt sie nicht.
         */
        const result = {
          url: session.url, linkId,
          expiresAt: session.expiresAt?.toISOString() ?? null,
          messageRef
        }
        await completeIdempotent(client, principal.clientKey, key, 201, result)
        reply.status(201)
        return result
      })
    }
  })

  /**
   * Einen offenen Link ungueltig machen -- beim Anbieter, nicht nur bei uns.
   *
   * Ein Link, den nur unsere Datenbank fuer ungueltig haelt, kann der Gast
   * weiterhin bezahlen. Deshalb zuerst der Anbieter, dann der Status. Lehnt
   * der Anbieter ab, ist meist gerade bezahlt worden; dann aendert sich hier
   * nichts, und die Zahlung kommt ueber den Webhook herein.
   *
   * `payment_intent` traegt keine Zeilenrichtlinie (0021). Gefunden wird der
   * Link deshalb nur ueber sein Folio, und das steht unter der Richtlinie:
   * eine fremde ID ergibt 404, nicht einen fremden Link.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/payment-links/:linkId/cancel',
    permission: 'folio:post',
    summary: 'Zahlungslink beim Anbieter ungueltig machen',
    handler: async (req) => {
      const { linkId } = req.params as { linkId: string }
      const principal = req.principal as Principal
      const id = Number(linkId)
      if (!Number.isInteger(id) || id <= 0) throw Errors.notFound('res.paymentLink')

      return tx(req.pool, req, async client => {
        const l = await client.query<{ id: number; property_id: number; status: string
                                       provider_reference: string }>(
          `SELECT pi.id, pi.property_id, pi.status, pi.provider_reference
             FROM payment_intent pi
             JOIN folio f ON f.id = pi.folio_id AND f.property_id = pi.property_id
            WHERE pi.id = $1
            FOR UPDATE OF pi`, [id])
        if (l.rowCount === 0) throw Errors.notFound('res.paymentLink')
        const link = l.rows[0]!
        rechtImHaus(principal, 'folio:post', link.property_id)
        if (link.status !== 'pending') throw Errors.conflict('payments.linkNotOpen')
        if (!stripe) throw Errors.notConfigured('payments.stripeKeyMissing')

        try {
          await stripe.expireCheckoutSession(link.provider_reference)
        } catch (err) {
          if (err instanceof ProviderRefused) throw Errors.conflict('payments.linkNotCancelable')
          req.log.warn({ err }, 'Zahlungslink beim Anbieter nicht ungueltig gemacht')
          throw Errors.upstreamFailed('payments.providerUnavailable')
        }

        await client.query(
          `UPDATE payment_intent
              SET status = 'canceled', canceled_at = now(), canceled_by = $2
            WHERE id = $1 AND status = 'pending'`, [link.id, principal.userId])
        return { linkId: link.id, status: 'canceled' }
      })
    }
  })

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
