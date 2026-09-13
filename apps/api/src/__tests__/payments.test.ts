import { createHmac } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeGuest,
         makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import type { StripeAdapter } from '../platform/payments/stripe.js'

/**
 * Der Webhook laeuft ohne Sitzung. Ein Test dagegen kann Stripe nicht
 * erreichen (kein echter Schluessel, kein Netzwerk in CI) - er baut daher
 * selbst eine gueltig signierte Zustellung, mit demselben Verfahren, das
 * Stripe fuer echte Zustellungen benutzt (t=<Zeit>,v1=<HMAC-SHA256 hex>).
 * Fuer den Zahlungslink selbst tritt ein Fake an die Stelle des Netzwerks,
 * das ist der Zweck der Adapter-Schnittstelle.
 */
const WEBHOOK_SECRET = 'whsec_test_nur_fuer_diese_datei'

function signStripe(rawBody: string, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  return `t=${timestamp},v1=${signature}`
}

function checkoutCompletedEvent(
  eventId: string, sessionId: string, amountTotal: number, paid = true
): string {
  return JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    data: { object: { id: sessionId, amount_total: amountTotal,
                       payment_status: paid ? 'paid' : 'unpaid' } }
  })
}

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let sessionCounter = 0
let lastCheckoutParams: { amountCent: number; reference: string } | null = null

const fakeStripe: StripeAdapter = {
  async createCheckoutSession(params) {
    lastCheckoutParams = { amountCent: params.amountCent, reference: params.reference }
    const providerReference = `cs_test_${++sessionCounter}`
    return { providerReference, url: `https://checkout.stripe.test/${providerReference}` }
  }
}

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  const built = await buildServer({ pool: appPool(10) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app, { payments: { stripe: fakeStripe } })
  await app.ready()
})
afterAll(async () => {
  await app.close(); await owner.end(); await pool.end()
  delete process.env.STRIPE_WEBHOOK_SECRET
})

let lauf = 0
beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

async function makeFolio(): Promise<{ id: number; ref: string }> {
  const gast = await makeGuest(owner, fx.accountId)
  const r = await owner.query<{ id: number; public_ref: string }>(
    `INSERT INTO folio (property_id, kind, guest_id) VALUES ($1,'guest',$2)
     RETURNING id, public_ref`, [fx.propertyId, gast.id])
  return { id: r.rows[0]!.id, ref: r.rows[0]!.public_ref }
}

const requestLink = (folioRef: string, amountCent: number) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/payment-links`,
  headers: { ...auth, 'idempotency-key': `pl-${++lauf}` },
  payload: { amountCent }
})

const webhook = (rawBody: string, signature: string) => app.inject({
  method: 'POST', url: '/v1/payments/stripe/webhook',
  headers: { 'content-type': 'application/json', 'stripe-signature': signature },
  payload: rawBody
})

async function settlementsOf(folioId: number) {
  const r = await owner.query(
    `SELECT amount_cent, external_reference FROM settlement WHERE folio_id = $1`, [folioId])
  return r.rows
}

describe('Pay-by-Link ueber Stripe', () => {
  it('fordert einen Zahlungslink an und legt eine Zahlungsanfrage an', async () => {
    const folio = await makeFolio()
    const res = await requestLink(folio.ref, 20_000)
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { url: string }
    expect(body.url).toMatch(/^https:\/\/checkout\.stripe\.test\//)
    expect(lastCheckoutParams).toEqual({ amountCent: 20_000, reference: folio.ref })

    const intent = await owner.query(
      `SELECT status, amount_cent, folio_id FROM payment_intent WHERE folio_id = $1`,
      [folio.id])
    expect(intent.rows).toHaveLength(1)
    expect(intent.rows[0]).toMatchObject({ status: 'pending', amount_cent: 20_000 })
  })

  it('lehnt einen Zahlungslink ohne Anmeldung ab', async () => {
    const folio = await makeFolio()
    const res = await app.inject({
      method: 'POST', url: `/v1/folios/${folio.ref}/payment-links`,
      headers: { 'idempotency-key': 'x' }, payload: { amountCent: 1000 }
    })
    expect(res.statusCode).toBe(401)
  })

  it('erfasst genau einen Zahlungsvermerk, auch bei doppelter Zustellung desselben Ereignisses', async () => {
    const folio = await makeFolio()
    const link = await requestLink(folio.ref, 15_000)
    const { url } = JSON.parse(link.body) as { url: string }
    const providerReference = url.split('/').pop()!

    const rawBody = checkoutCompletedEvent('evt_1', providerReference, 15_000)
    const first = await webhook(rawBody, signStripe(rawBody))
    expect(first.statusCode).toBe(200)

    let rows = await settlementsOf(folio.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      amount_cent: 15_000, external_reference: `stripe:${providerReference}` })

    // Dieselbe Zustellung nochmal, wie es Anbieter bis zur Quittierung tun.
    const second = await webhook(rawBody, signStripe(rawBody))
    expect(second.statusCode).toBe(200)
    rows = await settlementsOf(folio.id)
    expect(rows).toHaveLength(1)

    const events = await owner.query(
      `SELECT count(*)::int AS n FROM payment_event WHERE provider_event_id = 'evt_1'`)
    expect(events.rows[0].n).toBe(1)
  })

  it('erfasst keinen zweiten Zahlungsvermerk, wenn ein zweites, andersartiges Ereignis dieselbe Zahlung meldet', async () => {
    // Anbieter senden fuer eine Zahlung oft mehrere Ereignisse mit je eigener
    // ID; das Zustellungsprotokoll allein wuerde ein zweites nicht abfangen.
    // Die eigentliche Sperre ist der Statusuebergang von payment_intent.
    const folio = await makeFolio()
    const link = await requestLink(folio.ref, 8_000)
    const { url } = JSON.parse(link.body) as { url: string }
    const providerReference = url.split('/').pop()!

    const first = checkoutCompletedEvent('evt_a', providerReference, 8_000)
    await webhook(first, signStripe(first))

    const second = checkoutCompletedEvent('evt_b', providerReference, 8_000)
    const res = await webhook(second, signStripe(second))
    expect(res.statusCode).toBe(200)

    const rows = await settlementsOf(folio.id)
    expect(rows).toHaveLength(1)
  })

  it('lehnt eine Zustellung mit falscher Signatur ab und bucht nichts', async () => {
    const folio = await makeFolio()
    const link = await requestLink(folio.ref, 5_000)
    const { url } = JSON.parse(link.body) as { url: string }
    const providerReference = url.split('/').pop()!

    const rawBody = checkoutCompletedEvent('evt_x', providerReference, 5_000)
    const res = await webhook(rawBody, signStripe(rawBody, 'falscher-schluessel'))
    expect(res.statusCode).toBe(400)
    expect(await settlementsOf(folio.id)).toHaveLength(0)
  })

  it('bucht nichts, wenn der gemeldete Betrag von der Anfrage abweicht', async () => {
    const folio = await makeFolio()
    const link = await requestLink(folio.ref, 12_000)
    const { url } = JSON.parse(link.body) as { url: string }
    const providerReference = url.split('/').pop()!

    // Falscher Betrag: die Signatur allein sichert die Herkunft, nicht den
    // Inhalt gegen die eigene Erwartung.
    const rawBody = checkoutCompletedEvent('evt_y', providerReference, 1)
    const res = await webhook(rawBody, signStripe(rawBody))
    expect(res.statusCode).toBe(200)
    expect(await settlementsOf(folio.id)).toHaveLength(0)

    const intent = await owner.query(
      `SELECT status FROM payment_intent WHERE folio_id = $1`, [folio.id])
    expect(intent.rows[0]!.status).toBe('pending')
  })

  it('quittiert ein Ereignis zu einer unbekannten Referenz, ohne etwas zu buchen', async () => {
    const rawBody = checkoutCompletedEvent('evt_unbekannt', 'cs_test_nie_erzeugt', 1_000)
    const res = await webhook(rawBody, signStripe(rawBody))
    expect(res.statusCode).toBe(200)
  })
})
