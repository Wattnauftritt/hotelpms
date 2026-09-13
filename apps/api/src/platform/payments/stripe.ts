import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PaymentWebhookEvent } from '@hotelpms/domain'

/**
 * Nur diese Fassade wird von den Routen benutzt, damit ein Test einen
 * Adapter unterschieben kann, ohne eine Netzwerkverbindung zu Stripe zu
 * brauchen. Autorisieren, Belasten, Erstatten und Token folgen laut
 * Dokument 02 spaeter; diese Aufgabe deckt Pay-by-Link.
 */
export interface StripeAdapter {
  createCheckoutSession(params: CheckoutSessionParams): Promise<CheckoutSession>
}

export interface CheckoutSessionParams {
  amountCent: number
  /** Verwendungszweck, dem Gast sichtbar. Der Folio-Verweis, nicht die interne ID. */
  reference: string
  successUrl: string
  cancelUrl: string
}

export interface CheckoutSession {
  providerReference: string
  url: string
}

export function createStripeAdapter(secretKey: string): StripeAdapter {
  return {
    async createCheckoutSession(params: CheckoutSessionParams): Promise<CheckoutSession> {
      const body = new URLSearchParams({
        mode: 'payment',
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        client_reference_id: params.reference,
        'line_items[0][price_data][currency]': 'eur',
        'line_items[0][price_data][product_data][name]': `Zahlung ${params.reference}`,
        'line_items[0][price_data][unit_amount]': String(params.amountCent),
        'line_items[0][quantity]': '1'
      })
      const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
      })
      if (!res.ok) {
        throw new Error(`Stripe-Anfrage fehlgeschlagen (${res.status}): ${await res.text()}`)
      }
      const json = await res.json() as { id: string; url: string }
      return { providerReference: json.id, url: json.url }
    }
  }
}

// Stripes eigene Empfehlung fuer die Toleranz gegen Wiedereinspielung.
const SIGNATURE_TOLERANCE_SECONDS = 300

/**
 * Signatur nach Stripe-Schema: Kopfzeile "t=<Unixzeit>,v1=<Hex-HMAC>". Die
 * HMAC-SHA256 laeuft ueber "<Zeitstempel>.<roher Rumpf>", mit dem
 * Webhook-Schluessel der Property. Wirft bei jeder Abweichung; der
 * Aufrufer entscheidet, wie er das meldet.
 */
export function verifyStripeSignature(
  rawBody: Buffer, header: string | undefined, secret: string
): void {
  if (!header) throw new Error('Signatur fehlt')
  const parts = Object.fromEntries(
    header.split(',').map(kv => kv.split('=', 2) as [string, string]))
  const timestamp = parts.t
  const signature = parts.v1
  if (!timestamp || !signature) throw new Error('Signatur unvollstaendig')

  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) {
    throw new Error('Signatur veraltet')
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex')
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(signature, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Signatur ungueltig')
}

interface StripeEventPayload {
  id: string
  type: string
  data: { object: { id: string; amount_total?: number; payment_status?: string } }
}

/**
 * Uebersetzt die Stripe-spezifische Form in die anbieterunabhaengige Sicht
 * aus packages/domain. checkout.session.completed mit payment_status=paid
 * ist das von Stripe empfohlene Erfolgsereignis fuer Checkout Sessions;
 * payment_intent.succeeded kann fuer dieselbe Zahlung zusaetzlich eintreffen,
 * mit eigener Ereignis-ID, deshalb entscheidet ueber den Zahlungsvermerk
 * nicht diese Funktion, sondern der Statusuebergang von payment_intent.
 */
export function parseStripeEvent(rawBody: Buffer): PaymentWebhookEvent {
  const json = JSON.parse(rawBody.toString('utf8')) as StripeEventPayload
  const obj = json.data.object

  if (json.type === 'checkout.session.completed' && obj.payment_status === 'paid') {
    return { eventId: json.id, kind: 'succeeded', providerReference: obj.id,
              amountCent: obj.amount_total }
  }
  if (json.type === 'checkout.session.expired') {
    return { eventId: json.id, kind: 'failed', providerReference: obj.id }
  }
  return { eventId: json.id, kind: 'ignored', providerReference: obj.id }
}
