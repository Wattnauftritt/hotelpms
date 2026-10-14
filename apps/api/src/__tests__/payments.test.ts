import { createHmac } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeGuest,
         makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { stripeAttrappe, kontoVerbinden, TESTKONTO } from './stripeAttrappe.js'

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
  eventId: string, sessionId: string, amountTotal: number, paid = true,
  account: string = TESTKONTO
): string {
  return JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    account,
    data: { object: { id: sessionId, amount_total: amountTotal,
                       payment_status: paid ? 'paid' : 'unpaid' } }
  })
}

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>

/** Der Anbieter ohne Netz, mit Buchfuehrung ueber seine Checkouts. */
const fakeStripe = stripeAttrappe()

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  process.env.STRIPE_CONNECT_CLIENT_ID = 'ca_test_plattform'
  const built = await buildServer({ pool: appPool(10) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app, { payments: { stripe: fakeStripe } })
  await app.ready()
})
afterAll(async () => {
  await app.close(); await owner.end(); await pool.end()
  delete process.env.STRIPE_WEBHOOK_SECRET
  delete process.env.STRIPE_CONNECT_CLIENT_ID
})

let lauf = 0
beforeEach(async () => {
  await truncateAll()
  fakeStripe.zuruecksetzen()
  fx = await makeProperty(owner)
  await kontoVerbinden(owner, fx.propertyId)
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

/**
 * Seit 0068 bekommt der Gast einen Link von uns; den Checkout beim Anbieter
 * legt erst das Oeffnen an. Fuer den Webhook zaehlt dessen Kennung.
 */
async function checkoutZu(folioRef: string, amountCent: number): Promise<string> {
  const link = await requestLink(folioRef, amountCent)
  expect(link.statusCode).toBe(201)
  const t = new URL((link.json() as { url: string }).url).searchParams.get('t')!
  const r = await app.inject({ method: 'GET', url: `/v1/pay/checkout?t=${t}` })
  expect(r.statusCode).toBe(303)
  return String(r.headers.location).split('/').pop()!
}

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
  it('legt einen Link an und erst beim Oeffnen eine Zahlungsanfrage beim Anbieter', async () => {
    const folio = await makeFolio()
    const res = await requestLink(folio.ref, 20_000)
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { url: string }
    expect(body.url).toMatch(/\/v1\/pay\?t=/)
    expect(fakeStripe.angelegt).toBe(0)

    const ref = await checkoutZu(folio.ref, 20_000)
    expect(fakeStripe.sitzungen.get(ref)!.amountCent).toBe(20_000)
    const intent = await owner.query(
      `SELECT status, amount_cent, folio_id FROM payment_intent WHERE provider_reference = $1`,
      [ref])
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
    const providerReference = await checkoutZu(folio.ref, 15_000)

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
    const providerReference = await checkoutZu(folio.ref, 8_000)

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
    const providerReference = await checkoutZu(folio.ref, 5_000)

    const rawBody = checkoutCompletedEvent('evt_x', providerReference, 5_000)
    const res = await webhook(rawBody, signStripe(rawBody, 'falscher-schluessel'))
    expect(res.statusCode).toBe(400)
    expect(await settlementsOf(folio.id)).toHaveLength(0)
  })

  it('bucht nichts, wenn der gemeldete Betrag von der Anfrage abweicht', async () => {
    const folio = await makeFolio()
    const providerReference = await checkoutZu(folio.ref, 12_000)

    // Falscher Betrag: die Signatur allein sichert die Herkunft, nicht den
    // Inhalt gegen die eigene Erwartung.
    const rawBody = checkoutCompletedEvent('evt_y', providerReference, 1)
    const res = await webhook(rawBody, signStripe(rawBody))
    expect(res.statusCode).toBe(200)
    expect(await settlementsOf(folio.id)).toHaveLength(0)

    const intent = await owner.query(
      `SELECT status FROM payment_intent WHERE provider_reference = $1`, [providerReference])
    expect(intent.rows[0]!.status).toBe('pending')
  })

  it('quittiert ein Ereignis zu einer unbekannten Referenz, ohne etwas zu buchen', async () => {
    const rawBody = checkoutCompletedEvent('evt_unbekannt', 'cs_test_nie_erzeugt', 1_000)
    const res = await webhook(rawBody, signStripe(rawBody))
    expect(res.statusCode).toBe(200)
  })
})

describe('Stripe Connect: jedes Haus sein eigenes Konto (0167)', () => {
  const kontoEreignis = (typ: string, konto: string, extra: object = {}): string =>
    JSON.stringify({ id: `evt_${typ}_${Math.random()}`, type: typ, account: konto,
                     data: { object: { id: konto, ...extra } } })

  async function verwalter(): Promise<Record<string, string>> {
    const u = await makeUser(owner,
      { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'owner' })
    return { cookie: `hp_session=${u.sessionId}` }
  }

  it('legt den Checkout auf dem Konto des Hauses an, nicht auf dem der Plattform', async () => {
    const folio = await makeFolio()
    const ref = await checkoutZu(folio.ref, 4_000)
    expect(fakeStripe.sitzungen.get(ref)!.konto).toBe(TESTKONTO)
    const intent = await owner.query(
      `SELECT provider_account FROM payment_intent WHERE provider_reference = $1`, [ref])
    expect(intent.rows[0]!.provider_account).toBe(TESTKONTO)
  })

  it('erzeugt ohne verbundenes Konto keinen Zahlungslink', async () => {
    await owner.query(`DELETE FROM property_payment_account WHERE property_id = $1`,
      [fx.propertyId])
    const folio = await makeFolio()
    const res = await requestLink(folio.ref, 1_000)
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('payments.accountNotConnected')
  })

  it('erzeugt keinen Zahlungslink, solange Stripe das Konto nicht freigeschaltet hat', async () => {
    await owner.query(
      `UPDATE property_payment_account SET charges_enabled = false WHERE property_id = $1`,
      [fx.propertyId])
    const folio = await makeFolio()
    expect((await requestLink(folio.ref, 1_000)).statusCode).toBe(422)
  })

  it('oeffnet keinen Checkout mehr, wenn das Haus das Konto inzwischen getrennt hat', async () => {
    const folio = await makeFolio()
    const link = await requestLink(folio.ref, 2_000)
    const t = new URL((link.json() as { url: string }).url).searchParams.get('t')!
    await owner.query(`DELETE FROM property_payment_account WHERE property_id = $1`,
      [fx.propertyId])
    const r = await app.inject({ method: 'GET', url: `/v1/pay/checkout?t=${t}` })
    expect(r.statusCode).toBe(200)
    expect(fakeStripe.angelegt).toBe(0)
  })

  it('bucht nichts, wenn die Meldung von einem anderen Konto kommt als der Checkout', async () => {
    const folio = await makeFolio()
    const ref = await checkoutZu(folio.ref, 6_000)
    const fremd = checkoutCompletedEvent('evt_fremd', ref, 6_000, true, 'acct_fremd')
    expect((await webhook(fremd, signStripe(fremd))).statusCode).toBe(200)
    expect(await settlementsOf(folio.id)).toHaveLength(0)
  })

  it('uebernimmt Freischaltung und Trennung aus den Meldungen von Stripe', async () => {
    const gesperrt = kontoEreignis('account.updated', TESTKONTO, { charges_enabled: false })
    expect((await webhook(gesperrt, signStripe(gesperrt))).statusCode).toBe(200)
    let z = await owner.query(
      `SELECT charges_enabled FROM property_payment_account WHERE property_id = $1`,
      [fx.propertyId])
    expect(z.rows[0]!.charges_enabled).toBe(false)

    const frei = kontoEreignis('account.updated', TESTKONTO, { charges_enabled: true })
    await webhook(frei, signStripe(frei))
    z = await owner.query(
      `SELECT charges_enabled FROM property_payment_account WHERE property_id = $1`,
      [fx.propertyId])
    expect(z.rows[0]!.charges_enabled).toBe(true)

    const weg = kontoEreignis('account.application.deauthorized', TESTKONTO)
    await webhook(weg, signStripe(weg))
    z = await owner.query(
      `SELECT 1 FROM property_payment_account WHERE property_id = $1`, [fx.propertyId])
    expect(z.rowCount).toBe(0)
  })

  it('verbindet ein Konto ueber die Rueckkehr von Stripe, gebunden an Haus und Benutzer', async () => {
    await owner.query(`DELETE FROM property_payment_account WHERE property_id = $1`,
      [fx.propertyId])
    const chef = await verwalter()

    const start = await app.inject({ method: 'POST', headers: chef,
      url: `/v1/properties/${fx.propertyId}/payment-account/connect` })
    expect(start.statusCode).toBe(200)
    const ziel = new URL((start.json() as { url: string }).url)
    expect(ziel.host).toBe('connect.stripe.com')
    expect(ziel.searchParams.get('client_id')).toBe('ca_test_plattform')
    expect(ziel.searchParams.get('redirect_uri')).toMatch(/\/stripe-verbunden$/)
    const state = ziel.searchParams.get('state')!

    // Die Rezeption darf nicht verbinden, auch nicht mit einem gueltigen state.
    fakeStripe.codes.set('ac_1', 'acct_neu')
    const fremd = await app.inject({ method: 'POST', headers: auth,
      url: '/v1/payment-account/complete', payload: { code: 'ac_1', state } })
    expect(fremd.statusCode).toBe(403)

    // Ein manipulierter state wird abgewiesen, bevor Stripe gefragt wird.
    const falsch = await app.inject({ method: 'POST', headers: chef,
      url: '/v1/payment-account/complete',
      payload: { code: 'ac_1', state: state.replace(/^\d+/, '999') } })
    expect(falsch.statusCode).toBe(422)
    expect(fakeStripe.codes.has('ac_1')).toBe(true)

    fakeStripe.freigeschaltet.add('acct_neu')
    const ok = await app.inject({ method: 'POST', headers: chef,
      url: '/v1/payment-account/complete', payload: { code: 'ac_1', state } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ propertyId: fx.propertyId, accountId: 'acct_neu',
                                      chargesEnabled: true })

    const sicht = await app.inject({ method: 'GET', headers: chef,
      url: `/v1/properties/${fx.propertyId}/payment-account` })
    expect(sicht.json()).toMatchObject({ configured: true,
      account: { accountId: 'acct_neu', chargesEnabled: true } })
  })

  it('trennt nicht, solange ein Checkout offen ist, und danach auch beim Anbieter', async () => {
    const chef = await verwalter()
    const folio = await makeFolio()
    const ref = await checkoutZu(folio.ref, 3_000)

    const zu = await app.inject({ method: 'POST', headers: chef,
      url: `/v1/properties/${fx.propertyId}/payment-account/disconnect` })
    expect(zu.statusCode).toBe(409)
    expect(zu.json().code).toBe('payments.accountHasOpenCheckouts')

    const bezahlt = checkoutCompletedEvent('evt_vor_trennen', ref, 3_000)
    await webhook(bezahlt, signStripe(bezahlt))

    const ok = await app.inject({ method: 'POST', headers: chef,
      url: `/v1/properties/${fx.propertyId}/payment-account/disconnect` })
    expect(ok.statusCode).toBe(200)
    expect(fakeStripe.getrennt).toEqual([TESTKONTO])
  })

  it('trennt ein Konto, das ein zweites Haus mitnutzt, beim Anbieter nicht', async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name, address_line1, postal_code, city, country)
       VALUES ($1,'GH','Gaestehaus','Hafenstr. 2','25813','Husum','DE') RETURNING id`,
      [fx.accountId])
    await kontoVerbinden(owner, zweites.rows[0]!.id)
    const chef = await verwalter()

    const ok = await app.inject({ method: 'POST', headers: chef,
      url: `/v1/properties/${fx.propertyId}/payment-account/disconnect` })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().providerDisconnected).toBe(false)
    expect(fakeStripe.getrennt).toEqual([])
  })
})
