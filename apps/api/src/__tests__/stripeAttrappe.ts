import { createHmac } from 'node:crypto'
import { ProviderRefused, type StripeAdapter, type CheckoutState }
  from '../platform/payments/stripe.js'

/**
 * Ein Zahlungsdienstleister zum Anfassen, ohne Netz.
 *
 * Er fuehrt Buch ueber seine Checkouts wie der echte: offen, abgeschlossen,
 * abgelaufen. Ohne diese Buchfuehrung liesse sich nicht pruefen, worum es
 * beim dauerhaften Link (0068) geht -- dass ein neuer Checkout erst entsteht,
 * wenn der alte beim Anbieter erledigt ist.
 */
export interface Attrappe extends StripeAdapter {
  sitzungen: Map<string, { status: CheckoutState['status']; amountCent: number
                           url: string; expiresAt: Date; successUrl: string }>
  angelegt: number
  beendet: string[]
  /** Naechstes Beenden lehnt der Anbieter ab (4xx). */
  verweigern: boolean
  /** Ein Checkout als bezahlt markieren, wie es der Gast beim Anbieter taete. */
  bezahlen(ref: string): void
  zuruecksetzen(): void
}

export function stripeAttrappe(): Attrappe {
  const a: Attrappe = {
    sitzungen: new Map(),
    angelegt: 0,
    beendet: [],
    verweigern: false,
    async createCheckoutSession(p) {
      const ref = `cs_test_${++a.angelegt}`
      const s = { status: 'open' as const, amountCent: p.amountCent,
                  url: `https://checkout.stripe.test/${ref}`,
                  expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
                  successUrl: p.successUrl }
      a.sitzungen.set(ref, s)
      return { providerReference: ref, url: s.url, expiresAt: s.expiresAt }
    },
    async getCheckoutSession(ref) {
      const s = a.sitzungen.get(ref)
      if (s === undefined) throw new Error('unbekannter Checkout')
      return { status: s.status, url: s.status === 'open' ? s.url : null,
               amountCent: s.amountCent, expiresAt: s.expiresAt }
    },
    async expireCheckoutSession(ref) {
      const s = a.sitzungen.get(ref)
      if (a.verweigern || s === undefined || s.status !== 'open') {
        throw new ProviderRefused(400, 'session is not open')
      }
      s.status = 'expired'
      a.beendet.push(ref)
    },
    bezahlen(ref) {
      const s = a.sitzungen.get(ref)
      if (s !== undefined) s.status = 'complete'
    },
    zuruecksetzen() {
      a.sitzungen.clear(); a.angelegt = 0; a.beendet = []; a.verweigern = false
    }
  }
  return a
}

/** Eine Zustellung, signiert wie von Stripe (t=<Zeit>,v1=<HMAC>). */
export function signiert(raw: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000)
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`
}

export function bezahltEreignis(eventId: string, ref: string, amountCent: number): string {
  return JSON.stringify({
    id: eventId, type: 'checkout.session.completed',
    data: { object: { id: ref, amount_total: amountCent, payment_status: 'paid' } }
  })
}
