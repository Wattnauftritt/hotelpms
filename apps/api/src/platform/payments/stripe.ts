import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PaymentWebhookEvent } from '@hotelpms/domain'

/**
 * Obergrenze je Anfrage an Stripe. Ohne sie wartet fetch bei einem
 * haengenden Stripe minutenlang -- und die Zahlungsseite tut das innerhalb
 * einer Transaktion mit Zeilensperre, auf einem Pool von zehn Verbindungen.
 * Ein paar Gaeste, die neu laden, legten so jede Rezeption lahm (Audit
 * 11.10.2026). Acht Sekunden genuegen Stripe auch an einem schlechten Tag.
 */
const STRIPE_TIMEOUT_MS = 8_000

/**
 * Nur diese Fassade wird von den Routen benutzt, damit ein Test einen
 * Adapter unterschieben kann, ohne eine Netzwerkverbindung zu Stripe zu
 * brauchen. Autorisieren, Belasten, Erstatten und Token folgen laut
 * Dokument 02 spaeter; diese Aufgabe deckt Pay-by-Link.
 */
export interface StripeAdapter {
  /**
   * Alle Checkout-Aufrufe tragen das Konto des Hauses (`account`, Stripe
   * Connect, Migration 0167): angelegt, abgefragt und beendet wird im Namen
   * des Hotels, das Geld geht direkt auf sein Konto. `null` nur fuer einen
   * Checkout von vor 0167, der noch auf dem Konto der Plattform liegt.
   */
  createCheckoutSession(account: string, params: CheckoutSessionParams): Promise<CheckoutSession>
  /**
   * Einen offenen Checkout beim Anbieter beenden. Danach nimmt Stripe keine
   * Zahlung mehr darauf an -- das ist der eigentliche Zweck: ein Link, den
   * nur unsere Datenbank fuer ungueltig haelt, kann der Gast weiterhin
   * bezahlen.
   *
   * Wirft `ProviderRefused`, wenn der Anbieter ablehnt (schon bezahlt, schon
   * abgelaufen), und einen anderen Fehler, wenn er nicht erreichbar ist.
   * Der Aufrufer muss beides unterscheiden: im ersten Fall weiss er, dass
   * sich nichts geaendert hat, im zweiten nicht.
   */
  expireCheckoutSession(account: string | null, providerReference: string): Promise<void>
  /**
   * Wo ein Checkout beim Anbieter steht. Die einzige verlaessliche Auskunft
   * darueber, ob ein alter Checkout noch bezahlt werden kann, bevor ein neuer
   * entsteht (Migration 0068): unsere Zeile sagt nur, was wir zuletzt
   * gehoert haben, und eine Benachrichtigung kann noch unterwegs sein.
   */
  getCheckoutSession(account: string | null, providerReference: string): Promise<CheckoutState>

  /**
   * Den Code aus der Rueckkehr von Stripe einloesen (OAuth fuer
   * Standard-Konten). Liefert die Konto-ID des Hotels. Ein Code gilt einmal;
   * ein abgelaufener oder fremder wirft `ProviderRefused`.
   */
  connectExchange(code: string): Promise<{ accountId: string }>
  /** Darf das verbundene Konto schon Zahlungen annehmen? */
  getAccount(accountId: string): Promise<{ chargesEnabled: boolean }>
  /**
   * Die Verbindung beim Anbieter loesen. Danach darf die Plattform nichts
   * mehr im Namen des Kontos tun; das Konto selbst bleibt dem Hotel.
   */
  deauthorize(accountId: string): Promise<void>
}

export interface CheckoutState {
  /** `complete` heisst bezahlt oder in Bearbeitung -- in beiden Faellen kein zweiter. */
  status: 'open' | 'complete' | 'expired'
  /** Nur bei `open`: die Adresse, unter der der Gast weiterzahlen kann. */
  url: string | null
  amountCent: number | null
  expiresAt?: Date
}

/** Der Anbieter hat die Anfrage verstanden und abgelehnt (4xx). */
export class ProviderRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ProviderRefused'
  }
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
  /**
   * Bis wann der Anbieter den Link annimmt. Ein Stripe-Checkout gilt
   * hoechstens 24 Stunden; ohne diese Angabe stuende ein toter Link als
   * "offen" da, solange die Ablaufmeldung ausbleibt.
   */
  expiresAt?: Date
}

/**
 * `connectClientId` ist die Kennung der Plattform bei Stripe Connect
 * (`ca_...`). Ohne sie laesst sich nichts verbinden und nichts trennen; die
 * Checkouts bereits verbundener Haeuser laufen trotzdem.
 */
export function createStripeAdapter(
  secretKey: string, connectClientId: string | null = null
): StripeAdapter {
  const kopf = (account: string | null): Record<string, string> => ({
    Authorization: `Bearer ${secretKey}`,
    ...(account === null ? {} : { 'Stripe-Account': account })
  })

  return {
    async createCheckoutSession(account, params) {
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
        headers: { ...kopf(account), 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS)
      })
      if (!res.ok) {
        throw new Error(`Stripe-Anfrage fehlgeschlagen (${res.status}): ${await res.text()}`)
      }
      const json = await res.json() as { id: string; url: string; expires_at?: number }
      return {
        providerReference: json.id, url: json.url,
        ...(typeof json.expires_at === 'number'
          ? { expiresAt: new Date(json.expires_at * 1000) } : {})
      }
    },

    async getCheckoutSession(account, providerReference) {
      const res = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(providerReference)}`,
        { headers: kopf(account), signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS) })
      if (!res.ok) {
        throw new Error(`Stripe-Anfrage fehlgeschlagen (${res.status}): ${await res.text()}`)
      }
      const json = await res.json() as { status?: string; url?: string | null
                                         amount_total?: number; expires_at?: number }
      const status = json.status === 'open' || json.status === 'complete'
        ? json.status : 'expired'
      return {
        status, url: status === 'open' ? json.url ?? null : null,
        amountCent: typeof json.amount_total === 'number' ? json.amount_total : null,
        ...(typeof json.expires_at === 'number'
          ? { expiresAt: new Date(json.expires_at * 1000) } : {})
      }
    },

    async expireCheckoutSession(account, providerReference) {
      const res = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(providerReference)}/expire`,
        { method: 'POST', headers: kopf(account),
          signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS) })
      if (res.ok) return
      const text = await res.text()
      if (res.status >= 400 && res.status < 500) throw new ProviderRefused(res.status, text)
      throw new Error(`Stripe-Anfrage fehlgeschlagen (${res.status}): ${text}`)
    },

    async connectExchange(code) {
      const res = await fetch('https://connect.stripe.com/oauth/token', {
        method: 'POST',
        headers: { ...kopf(null), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code }),
        signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS)
      })
      const text = await res.text()
      if (res.status >= 400 && res.status < 500) throw new ProviderRefused(res.status, text)
      if (!res.ok) throw new Error(`Stripe-Anfrage fehlgeschlagen (${res.status}): ${text}`)
      // Die Antwort traegt auch Zugangsschluessel des Kontos. Sie werden
      // nicht gebraucht und nicht gespeichert: die Plattform handelt mit
      // ihrem eigenen Schluessel und der Kopfzeile Stripe-Account.
      const json = JSON.parse(text) as { stripe_user_id?: string }
      if (typeof json.stripe_user_id !== 'string') throw new Error('Stripe: keine Konto-ID')
      return { accountId: json.stripe_user_id }
    },

    async getAccount(accountId) {
      const res = await fetch(
        `https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`,
        { headers: kopf(null), signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS) })
      if (!res.ok) {
        throw new Error(`Stripe-Anfrage fehlgeschlagen (${res.status}): ${await res.text()}`)
      }
      const json = await res.json() as { charges_enabled?: boolean }
      return { chargesEnabled: json.charges_enabled === true }
    },

    async deauthorize(accountId) {
      if (connectClientId === null) throw new Error('STRIPE_CONNECT_CLIENT_ID fehlt')
      const res = await fetch('https://connect.stripe.com/oauth/deauthorize', {
        method: 'POST',
        headers: { ...kopf(null), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: connectClientId, stripe_user_id: accountId }),
        signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS)
      })
      if (res.ok) return
      const text = await res.text()
      if (res.status >= 400 && res.status < 500) throw new ProviderRefused(res.status, text)
      throw new Error(`Stripe-Anfrage fehlgeschlagen (${res.status}): ${text}`)
    }
  }
}

/**
 * Die Adresse, unter der ein Hotel sein Stripe-Konto verbindet oder ein
 * neues anlegt. `state` bindet die Rueckkehr an Haus und Benutzer
 * (`platform/payments/connectState.ts`); ohne ihn koennte ein Fremder einem
 * angemeldeten Benutzer sein eigenes Konto unterschieben, und die Anzahlungen
 * des Hotels gingen dorthin.
 */
export function stripeConnectUrl(clientId: string, state: string, redirectUri: string): string {
  const p = new URLSearchParams({
    response_type: 'code', client_id: clientId, scope: 'read_write',
    state, redirect_uri: redirectUri
  })
  return `https://connect.stripe.com/oauth/authorize?${p.toString()}`
}

// Stripes eigene Empfehlung fuer die Toleranz gegen Wiedereinspielung.
const SIGNATURE_TOLERANCE_SECONDS = 300

/**
 * Signatur nach Stripe-Schema: Kopfzeile "t=<Unixzeit>,v1=<Hex-HMAC>". Die
 * HMAC-SHA256 laeuft ueber "<Zeitstempel>.<roher Rumpf>", mit dem
 * Webhook-Schluessel der Plattform. Wirft bei jeder Abweichung; der
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
  /** Bei Connect: das Konto des Hotels, auf dem das Ereignis geschah. */
  account?: string
  data: { object: { id: string; amount_total?: number; payment_status?: string
                    charges_enabled?: boolean } }
}

/** Was eine Meldung ueber ein verbundenes Konto selbst sagt. */
export type StripeAccountEvent =
  | { kind: 'account.updated'; account: string; chargesEnabled: boolean }
  | { kind: 'account.deauthorized'; account: string }

/**
 * Meldungen ueber das Konto, nicht ueber eine Zahlung: freigeschaltet,
 * gesperrt, vom Hotel bei Stripe getrennt. `null` fuer alles andere.
 */
export function parseStripeAccountEvent(rawBody: Buffer): StripeAccountEvent | null {
  const json = JSON.parse(rawBody.toString('utf8')) as StripeEventPayload
  if (json.type === 'account.updated') {
    const account = json.account ?? json.data.object.id
    return { kind: 'account.updated', account,
             chargesEnabled: json.data.object.charges_enabled === true }
  }
  if (json.type === 'account.application.deauthorized' && typeof json.account === 'string') {
    return { kind: 'account.deauthorized', account: json.account }
  }
  return null
}

/** Das Konto, auf dem ein Ereignis geschah; `null` auf dem der Plattform. */
export function stripeEventAccount(rawBody: Buffer): string | null {
  const json = JSON.parse(rawBody.toString('utf8')) as StripeEventPayload
  return typeof json.account === 'string' ? json.account : null
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
