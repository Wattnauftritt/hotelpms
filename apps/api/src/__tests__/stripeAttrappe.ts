import { createHmac } from 'node:crypto'
import type { Pool } from '@hotelpms/db'
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
                           url: string; expiresAt: Date; successUrl: string
                           konto: string | null }>
  angelegt: number
  beendet: string[]
  /** Naechstes Beenden lehnt der Anbieter ab (4xx). */
  verweigern: boolean
  /**
   * Haelt das Anlegen auf, bis das Versprechen erfuellt ist -- ein Anbieter,
   * der gerade langsam ist. Damit laesst sich pruefen, was waehrenddessen
   * in der Datenbank gesperrt ist und was ein zweiter Klick tut.
   */
  anlegenHalten: Promise<void> | null
  /** Die Codes, die Stripe nach dem Verbinden zurueckgibt, und ihr Konto. */
  codes: Map<string, string>
  /** Konten, die Stripe als freigeschaltet meldet. */
  freigeschaltet: Set<string>
  getrennt: string[]
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
    anlegenHalten: null,
    codes: new Map(),
    freigeschaltet: new Set(),
    getrennt: [],
    async createCheckoutSession(konto, p) {
      if (a.anlegenHalten !== null) await a.anlegenHalten
      const ref = `cs_test_${++a.angelegt}`
      const s = { status: 'open' as const, amountCent: p.amountCent,
                  url: `https://checkout.stripe.test/${ref}`,
                  expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
                  successUrl: p.successUrl, konto }
      a.sitzungen.set(ref, s)
      return { providerReference: ref, url: s.url, expiresAt: s.expiresAt }
    },
    async getCheckoutSession(konto, ref) {
      const s = a.sitzungen.get(ref)
      // Wie bei Stripe: auf einem anderen Konto gibt es den Checkout nicht.
      if (s === undefined || s.konto !== konto) throw new Error('unbekannter Checkout')
      return { status: s.status, url: s.status === 'open' ? s.url : null,
               amountCent: s.amountCent, expiresAt: s.expiresAt }
    },
    async expireCheckoutSession(konto, ref) {
      const s = a.sitzungen.get(ref)
      if (a.verweigern || s === undefined || s.konto !== konto || s.status !== 'open') {
        throw new ProviderRefused(400, 'session is not open')
      }
      s.status = 'expired'
      a.beendet.push(ref)
    },
    async connectExchange(code) {
      const konto = a.codes.get(code)
      if (konto === undefined) throw new ProviderRefused(400, 'invalid_grant')
      a.codes.delete(code)
      return { accountId: konto }
    },
    async getAccount(konto) {
      return { chargesEnabled: a.freigeschaltet.has(konto) }
    },
    async deauthorize(konto) {
      a.getrennt.push(konto)
    },
    bezahlen(ref) {
      const s = a.sitzungen.get(ref)
      if (s !== undefined) s.status = 'complete'
    },
    zuruecksetzen() {
      a.sitzungen.clear(); a.angelegt = 0; a.beendet = []; a.verweigern = false
      a.anlegenHalten = null
      a.codes.clear(); a.freigeschaltet.clear(); a.getrennt = []
    }
  }
  return a
}

/** Eine Zustellung, signiert wie von Stripe (t=<Zeit>,v1=<HMAC>). */
export function signiert(raw: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000)
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`
}

/** Das Stripe-Konto, das die Tests einem Haus verbinden. */
export const TESTKONTO = 'acct_test_haus'

/**
 * Ein freigeschaltetes Stripe-Konto am Haus, wie nach dem Verbinden (0167).
 * Ohne es erzeugt die Rezeption keinen Zahlungslink.
 */
export async function kontoVerbinden(
  owner: Pool, propertyId: number, konto: string = TESTKONTO
): Promise<void> {
  await owner.query(
    `INSERT INTO property_payment_account (property_id, provider_account, charges_enabled)
     VALUES ($1, $2, true)
     ON CONFLICT (property_id) DO UPDATE SET provider_account = EXCLUDED.provider_account,
                                             charges_enabled = true`,
    [propertyId, konto])
}

export function bezahltEreignis(
  eventId: string, ref: string, amountCent: number, konto: string | null = TESTKONTO
): string {
  return JSON.stringify({
    id: eventId, type: 'checkout.session.completed',
    ...(konto === null ? {} : { account: konto }),
    data: { object: { id: ref, amount_total: amountCent, payment_status: 'paid' } }
  })
}
