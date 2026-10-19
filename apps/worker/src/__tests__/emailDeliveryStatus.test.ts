import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty,
         makeEmailDomain, type Fixture } from '@hotelpms/testing'
import { withTransaction, type DbContext, type Pool } from '@hotelpms/db'
import { deliverEmails } from '../jobs/emailDelivery.js'
import { checkEmailDeliveries, deliveryVerdict, scrubReason,
         DELIVERY_CHECK_DELAYS } from '../jobs/emailDeliveryStatus.js'
import { createBrevoAdapter } from '../email/brevo.js'
import { TickBreaker } from '../jobs/breaker.js'

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext

/**
 * Ein echter HTTP-Server fuer Versand und Ereignisabfrage, und der echte
 * Adapter dagegen: geprueft wird auch, dass die Kennung mit ihren spitzen
 * Klammern kodiert ankommt und der Schluessel in der Kopfzeile steht.
 */
async function anbieter(ereignisse: (messageId: string) => { code: number; body: unknown }): Promise<{
  url: string; eventsUrl: string; abfragen: Array<{ messageId: string | null; key?: string }>
  schliessen: () => Promise<void>
}> {
  const abfragen: Array<{ messageId: string | null; key?: string }> = []
  let gesendet = 0
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' && u.pathname.endsWith('/events')) {
      const id = u.searchParams.get('messageId')
      abfragen.push({ messageId: id, key: req.headers['api-key'] as string | undefined })
      const a = ereignisse(id ?? '')
      res.writeHead(a.code, { 'content-type': 'application/json' }).end(JSON.stringify(a.body))
      return
    }
    req.resume()
    req.on('end', () => {
      gesendet++
      res.writeHead(201, { 'content-type': 'application/json' })
        .end(JSON.stringify({ messageId: `<nachricht-${gesendet}@smtp-relay.brevo>` }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v3/smtp/email`,
    eventsUrl: `http://127.0.0.1:${port}/v3/smtp/statistics/events`,
    abfragen,
    schliessen: () => new Promise<void>(r => { server.close(() => { r() }) })
  }
}

async function absender(): Promise<void> {
  await makeEmailDomain(owner, fx.propertyId, 'seeblick.test')
  await owner.query(
    `INSERT INTO property_email_setting (property_id, from_name, from_email, enabled)
     VALUES ($1,'Hotel Seeblick','post@seeblick.test',true)`, [fx.propertyId])
}

async function einreihen(to: string): Promise<string> {
  // Die Testmail braucht weder Reservierung noch Rechnung; der Weg danach
  // ist fuer jede Art derselbe.
  return withTransaction(app, ctx, async client => {
    const r = await client.query<{ ref: string }>(
      `SELECT email_enqueue($1,'checkin_invitation_test',$2,NULL,'Test','Text',
                            NULL,NULL,NULL,NULL) AS ref`,
      [fx.propertyId, to])
    return r.rows[0]!.ref
  })
}

async function zeile(ref: string): Promise<{
  provider_message_id: string | null; delivery_status: string | null
  delivery_reason: string | null; delivery_checks: number
  delivery_next_check_at: Date | null }> {
  const r = await owner.query(
    `SELECT provider_message_id, delivery_status, delivery_reason, delivery_checks,
            delivery_next_check_at FROM outbound_email WHERE public_ref = $1`, [ref])
  return r.rows[0] as never
}

/** Die naechste Nachfrage sofort faellig machen, statt Minuten zu warten. */
async function faelligMachen(): Promise<void> {
  await owner.query(
    `UPDATE outbound_email SET delivery_next_check_at = now()
      WHERE delivery_next_check_at IS NOT NULL`)
}

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(5)
})
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
})

describe('Urteil aus den Ereignissen', () => {
  it('nimmt die Abweisung vor der Anfrage, die Zustellung vor der Verzoegerung', () => {
    expect(deliveryVerdict([
      { event: 'requests', date: '2026-10-16T04:02:00+02:00', reason: null },
      { event: 'hardBounces', date: '2026-10-16T04:02:05+02:00',
        reason: '550 5.1.1 <m.muster.123@guest.booking.com>: sender not allowed' }
    ])).toEqual({ status: 'hard_bounce', at: '2026-10-16T04:02:05+02:00',
                  reason: '550 5.1.1 <…@…>: sender not allowed' })
    expect(deliveryVerdict([
      { event: 'deferred', date: '2026-10-16T04:03:00Z', reason: 'greylisted' },
      { event: 'delivered', date: '2026-10-16T04:20:00Z', reason: null },
      { event: 'opened', date: '2026-10-16T09:00:00Z', reason: null }
    ])?.status).toBe('delivered')
    expect(deliveryVerdict([{ event: 'unsubscribed', date: null, reason: null }])).toBeNull()
  })

  it('schreibt keine Adresse aus dem Grund mit', () => {
    // Der Grund landet in einer Spalte, die keine Loeschung kennt (0187).
    expect(scrubReason('rejected: anna.beispiel@gast.test (user unknown)'))
      .toBe('rejected: …@… (user unknown)')
    expect(scrubReason('   ')).toBeNull()
  })
})

describe('Nachfrage beim Anbieter', () => {
  it('vermerkt eine Abweisung und fragt danach nicht mehr', async () => {
    await absender()
    const ref = await einreihen('m.muster.123@guest.booking.com')
    const a = await anbieter(() => ({ code: 200, body: { events: [
      { event: 'requests', date: '2026-10-16T04:02:00+02:00' },
      { event: 'blocked', date: '2026-10-16T04:02:01+02:00',
        reason: 'Sender m.muster.123@guest.booking.com blocked' }] } }))
    const brevo = createBrevoAdapter('xkeysib-test', { baseUrl: a.url, eventsUrl: a.eventsUrl })

    await deliverEmails(app, ctx, fx.propertyId, brevo)
    const gesendet = await zeile(ref)
    // Angenommen ist nicht zugestellt: die erste Nachfrage ist geplant.
    expect(gesendet.delivery_status).toBeNull()
    expect(gesendet.delivery_next_check_at).not.toBeNull()

    // Vor der Frist passiert nichts.
    expect((await checkEmailDeliveries(app, ctx, fx.propertyId, brevo)).checked).toBe(0)

    await faelligMachen()
    const r = await checkEmailDeliveries(app, ctx, fx.propertyId, brevo)
    expect(r).toEqual({ checked: 1, undelivered: 1 })
    expect(a.abfragen).toEqual([{ messageId: gesendet.provider_message_id, key: 'xkeysib-test' }])

    const z = await zeile(ref)
    expect(z.delivery_status).toBe('blocked')
    expect(z.delivery_reason).toBe('Sender …@… blocked')
    expect(z.delivery_next_check_at).toBeNull()
    await a.schliessen()
  })

  it('fragt bei angenommener Post in wachsenden Abstaenden weiter, dann nicht mehr', async () => {
    await absender()
    const ref = await einreihen('anna@gast.test')
    const a = await anbieter(() => ({ code: 200, body: { events: [
      { event: 'requests', date: '2026-10-16T04:02:00Z' }] } }))
    const brevo = createBrevoAdapter('k', { baseUrl: a.url, eventsUrl: a.eventsUrl })
    await deliverEmails(app, ctx, fx.propertyId, brevo)

    for (let i = 1; i <= DELIVERY_CHECK_DELAYS.length; i++) {
      await faelligMachen()
      await checkEmailDeliveries(app, ctx, fx.propertyId, brevo)
      const z = await zeile(ref)
      expect(z.delivery_status).toBe('accepted')
      expect(z.delivery_checks).toBe(i)
      expect(z.delivery_next_check_at === null).toBe(i === DELIVERY_CHECK_DELAYS.length)
    }
    await a.schliessen()
  })

  it('verbraucht bei einem Ausfall des Anbieters keine Nachfrage', async () => {
    await absender()
    const ref = await einreihen('anna@gast.test')
    const a = await anbieter(() => ({ code: 503, body: { message: 'down' } }))
    const brevo = createBrevoAdapter('k', { baseUrl: a.url, eventsUrl: a.eventsUrl })
    await deliverEmails(app, ctx, fx.propertyId, brevo)
    await faelligMachen()

    const breaker = new TickBreaker(1)
    const r = await checkEmailDeliveries(app, ctx, fx.propertyId, brevo, { breaker })
    expect(r.checked).toBe(0)
    expect(breaker.tripped()).toBe(true)
    const z = await zeile(ref)
    expect(z.delivery_checks).toBe(0)
    // Die Frist aus dem Beanspruchen holt sie spaeter wieder.
    expect(z.delivery_next_check_at).not.toBeNull()
    await a.schliessen()
  })

  it('sieht keine Post eines anderen Hauses', async () => {
    await absender()
    const ref = await einreihen('anna@gast.test')
    const a = await anbieter(() => ({ code: 200, body: { events: [
      { event: 'delivered', date: '2026-10-16T04:02:00Z' }] } }))
    const brevo = createBrevoAdapter('k', { baseUrl: a.url, eventsUrl: a.eventsUrl })
    await deliverEmails(app, ctx, fx.propertyId, brevo)
    await faelligMachen()

    const fremd = await makeProperty(owner)
    const r = await checkEmailDeliveries(app,
      { accountIds: [fremd.accountId], propertyIds: [fremd.propertyId], userId: null },
      fremd.propertyId, brevo)
    expect(r.checked).toBe(0)
    expect((await zeile(ref)).delivery_status).toBeNull()

    await checkEmailDeliveries(app, ctx, fx.propertyId, brevo)
    expect((await zeile(ref)).delivery_status).toBe('delivered')
    await a.schliessen()
  })
})
