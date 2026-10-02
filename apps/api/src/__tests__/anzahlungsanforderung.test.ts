import { createHmac } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, makePaymentMethod,
         makeEmailDomain, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { ProviderRefused, type StripeAdapter } from '../platform/payments/stripe.js'

/**
 * Anzahlung anfordern, Zahlungslink, Eingang (Migration 0060).
 *
 * Geprueft wird, was an der Oberflaeche nicht zu sehen ist und trotzdem
 * stimmen muss:
 *
 * 1. **Der Betrag wird abgerundet und ganzzahlig festgeschrieben**, auch in
 *    Prozent. Die Maske zeigt ihn vorher mit derselben Funktion an.
 * 2. **Ueberfaellig wird gegen den Geschaeftstag geprueft**, nicht gegen die
 *    Uhr. Am Faelligkeitstag selbst ist nichts ueberfaellig.
 * 3. **Ein Uebungshaus bekommt keinen Link** -- und der Anbieter wird gar
 *    nicht erst gefragt.
 * 4. **Der Eingang ueber den Webhook wird genau einmal verbucht und genau
 *    einmal zugeordnet**, auch bei doppelter oder andersartiger Zustellung.
 * 5. **Rechte gelten im Haus des Folios**, nicht in irgendeinem.
 */

const WEBHOOK_SECRET = 'whsec_test_anzahlung'

function signStripe(rawBody: string): string {
  const t = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex')
  return `t=${t},v1=${sig}`
}

function bezahlt(eventId: string, sessionId: string, amountTotal: number): string {
  return JSON.stringify({
    id: eventId, type: 'checkout.session.completed',
    data: { object: { id: sessionId, amount_total: amountTotal, payment_status: 'paid' } }
  })
}

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let categoryId: number

/** Der Anbieter als Attrappe: kein Netz, aber jeder Aufruf wird gezaehlt. */
let erzeugt = 0
let beendet: string[] = []
let beendenVerweigern = false
const fakeStripe: StripeAdapter = {
  async createCheckoutSession() {
    const providerReference = `cs_test_anz_${++erzeugt}`
    return { providerReference, url: `https://checkout.stripe.test/${providerReference}`,
             expiresAt: new Date(Date.now() + 24 * 3600 * 1000) }
  },
  async expireCheckoutSession(ref) {
    if (beendenVerweigern) throw new ProviderRefused(400, 'session is not open')
    beendet.push(ref)
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
const key = (): string => `anz-${++lauf}-${Date.now()}`

beforeEach(async () => {
  await truncateAll()
  erzeugt = 0
  beendet = []
  beendenVerweigern = false
  fx = await makeProperty(owner)
  await openBusinessDay(owner, fx.propertyId, '2026-10-01')
  await makePaymentMethod(owner, fx.propertyId, 'TRANSFER')
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  categoryId = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, categoryId, 2)
})

/** Drei Naechte vom 20. bis 23. Oktober, je Nacht `nachtCent`. */
async function aufenthalt(nachtCent = 10_000, propertyId = fx.propertyId,
                          kategorie = categoryId): Promise<{
  folioRef: string; folioId: number; reservationId: number }> {
  const gast = await makeGuest(owner, fx.accountId)
  await owner.query(`UPDATE guest SET email = 'gast@example.org', language = 'en'
                      WHERE id = $1`, [gast.id])
  const res = await makeReservation(owner, {
    propertyId, categoryId: kategorie,
    arrival: '2026-10-20', departure: '2026-10-23',
    priceCent: nachtCent, reserveInventory: false })
  await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
    [res.reservationId, gast.id])
  const f = await owner.query<{ public_ref: string }>(
    `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`,
    [res.folioId, gast.id])
  return { folioRef: f.rows[0]!.public_ref, folioId: res.folioId,
           reservationId: res.reservationId }
}

const anfordern = (folioRef: string, payload: unknown, wer = auth) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/deposit-requests`,
  headers: { ...wer, 'idempotency-key': key() }, payload })

const link = (folioRef: string, payload: unknown, wer = auth) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/payment-links`,
  headers: { ...wer, 'idempotency-key': key() }, payload })

const webhook = (raw: string) => app.inject({
  method: 'POST', url: '/v1/payments/stripe/webhook',
  headers: { 'content-type': 'application/json', 'stripe-signature': signStripe(raw) },
  payload: raw })

interface Anforderung {
  requestRef: string; amountCent: number; percentBp: number | null
  basisCent: number | null; dueDate: string; receivedCent: number; openCent: number
  settlementIds: number[]; state: string; depositInvoiceMissing: boolean
}
interface Sicht {
  propertyId: number; businessDate: string; isTraining: boolean
  canRequestDeposit: boolean; stayCent: number | null
  mail: { ready: boolean; reason: string | null; guestAddress: boolean }
  requests: Anforderung[]
  settlements: Array<{ id: number; amountCent: number; depositRequestRef: string | null }>
  paymentLinks: Array<{ id: number; status: string; expired: boolean
                        depositRequestRef: string | null; mailStatus: string | null
                        expiresAt: string | null }>
}

async function sicht(folioRef: string, wer = auth): Promise<Sicht> {
  const r = await app.inject({
    method: 'GET', url: `/v1/folios/${folioRef}/prepayments`, headers: wer })
  expect(r.statusCode).toBe(200)
  return r.json() as Sicht
}

async function eingang(folioId: number, amountCent: number): Promise<number> {
  const s = await owner.query<{ id: number }>(
    `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                             payment_method_id)
     SELECT $1, $2, '2026-10-01', $3, id FROM payment_method
      WHERE property_id = $1 AND code = 'TRANSFER' RETURNING id`,
    [fx.propertyId, folioId, amountCent])
  return s.rows[0]!.id
}

async function geschaeftstagWechseln(neu: string): Promise<void> {
  await owner.query(`UPDATE business_day SET status = 'closed', closed_at = now()
                      WHERE property_id = $1 AND status = 'open'`, [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, neu)
}

async function postEinschalten(): Promise<void> {
  await makeEmailDomain(owner, fx.propertyId, 'seeblick.test')
  await owner.query(
    `INSERT INTO property_email_setting (property_id, from_name, from_email, enabled)
     VALUES ($1, 'Hotel Seeblick', 'rezeption@seeblick.test', true)`, [fx.propertyId])
}

describe('Anzahlung anfordern', () => {
  it('legt eine Anforderung mit Betrag an und zeigt sie als angefordert', async () => {
    const { folioRef } = await aufenthalt()
    const r = await anfordern(folioRef, { amountCent: 9_000, dueDate: '2026-10-10' })
    expect(r.statusCode).toBe(201)

    const v = await sicht(folioRef)
    expect(v.businessDate).toBe('2026-10-01')
    expect(v.canRequestDeposit).toBe(true)
    expect(v.stayCent).toBe(30_000)
    expect(v.requests).toHaveLength(1)
    expect(v.requests[0]).toMatchObject({
      amountCent: 9_000, percentBp: null, dueDate: '2026-10-10',
      receivedCent: 0, openCent: 9_000, state: 'requested' })
  })

  it('rechnet Prozent ganzzahlig und rundet zugunsten des Gastes ab', async () => {
    // 3 x 111,11 = 333,33 EUR; 30 % davon sind 99,999 -- gefordert 99,99.
    const { folioRef } = await aufenthalt(11_111)
    const r = await anfordern(folioRef, { percentBp: 3_000, dueDate: '2026-10-10' })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ amountCent: 9_999, percentBp: 3_000, basisCent: 33_333 })

    // 100 Prozent ergeben genau den Aufenthalt, nie einen Cent mehr.
    const { folioRef: zweites } = await aufenthalt(11_111)
    const voll = await anfordern(zweites, { percentBp: 10_000, dueDate: '2026-10-10' })
    expect(voll.json()).toMatchObject({ amountCent: 33_333 })
  })

  it('weist unklare, unmoegliche und ueberhoehte Anforderungen ab', async () => {
    const { folioRef } = await aufenthalt()
    expect((await anfordern(folioRef,
      { amountCent: 100, percentBp: 1000, dueDate: '2026-10-10' })).statusCode).toBe(422)
    expect((await anfordern(folioRef, { amountCent: 100 })).statusCode).toBe(422)
    // Der 30. Februar hat die Form eines Datums, ist aber keines.
    expect((await anfordern(folioRef,
      { amountCent: 100, dueDate: '2027-02-30' })).statusCode).toBe(422)

    const vorher = await anfordern(folioRef, { amountCent: 100, dueDate: '2026-09-30' })
    expect(vorher.statusCode).toBe(422)
    expect(vorher.json().code).toBe('deposit.dueBeforeBusinessDay')

    const nachher = await anfordern(folioRef, { amountCent: 100, dueDate: '2026-10-24' })
    expect(nachher.json().code).toBe('deposit.dueAfterDeparture')

    // Zwei Anforderungen zusammen ueber dem Aufenthalt: Tippfehler.
    expect((await anfordern(folioRef,
      { amountCent: 20_000, dueDate: '2026-10-10' })).statusCode).toBe(201)
    const zuviel = await anfordern(folioRef, { amountCent: 10_001, dueDate: '2026-10-15' })
    expect(zuviel.statusCode).toBe(422)
    expect(zuviel.json().code).toBe('deposit.requestExceedsStay')
  })

  it('nimmt keine Anforderung fuer eine stornierte Reservierung an', async () => {
    const { folioRef, reservationId } = await aufenthalt()
    await owner.query(`UPDATE reservation SET status = 'Canceled' WHERE id = $1`,
      [reservationId])
    const r = await anfordern(folioRef, { amountCent: 5_000, dueDate: '2026-10-10' })
    expect(r.json().code).toBe('deposit.reservationNotOpen')
    expect((await sicht(folioRef)).canRequestDeposit).toBe(false)
  })
})

describe('Faelligkeit gegen den Geschaeftstag', () => {
  it('ist am Faelligkeitstag noch offen und erst am Geschaeftstag danach ueberfaellig',
    async () => {
      const { folioRef } = await aufenthalt()
      await anfordern(folioRef, { amountCent: 10_000, dueDate: '2026-10-05' })

      await geschaeftstagWechseln('2026-10-05')
      expect((await sicht(folioRef)).requests[0]!.state).toBe('requested')

      await geschaeftstagWechseln('2026-10-06')
      expect((await sicht(folioRef)).requests[0]!.state).toBe('overdue')
    })

  it('zeigt teilweise bezahlt, solange die Frist laeuft, danach ueberfaellig', async () => {
    const { folioRef, folioId } = await aufenthalt()
    const a = await anfordern(folioRef, { amountCent: 10_000, dueDate: '2026-10-05' })
    const ref = (a.json() as { requestRef: string }).requestRef
    const s = await eingang(folioId, 4_000)
    const z = await app.inject({
      method: 'POST', url: `/v1/deposit-requests/${ref}/settlements`,
      headers: auth, payload: { settlementId: s } })
    expect(z.statusCode).toBe(201)

    let v = await sicht(folioRef)
    expect(v.requests[0]).toMatchObject({ state: 'partial', receivedCent: 4_000,
                                          openCent: 6_000 })
    expect(v.settlements.find(x => x.id === s)?.depositRequestRef).toBe(ref)

    await geschaeftstagWechseln('2026-10-06')
    v = await sicht(folioRef)
    expect(v.requests[0]!.state).toBe('overdue')

    // Der Rest kommt -- auch nach der Frist ist die Anforderung dann erfuellt.
    const rest = await eingang(folioId, 6_000)
    await app.inject({ method: 'POST', url: `/v1/deposit-requests/${ref}/settlements`,
                       headers: auth, payload: { settlementId: rest } })
    expect((await sicht(folioRef)).requests[0]!.state).toBe('received')
  })
})

describe('Zuordnung von Zahlungseingaengen', () => {
  it('ist wiederholbar, aber ein Eingang gehoert nur einer Anforderung', async () => {
    const { folioRef, folioId } = await aufenthalt()
    const a = (await anfordern(folioRef, { amountCent: 5_000, dueDate: '2026-10-10' }))
      .json() as { requestRef: string }
    const b = (await anfordern(folioRef, { amountCent: 5_000, dueDate: '2026-10-12' }))
      .json() as { requestRef: string }
    const s = await eingang(folioId, 5_000)

    const zuordnen = (ref: string, settlementId: number) => app.inject({
      method: 'POST', url: `/v1/deposit-requests/${ref}/settlements`,
      headers: auth, payload: { settlementId } })

    expect((await zuordnen(a.requestRef, s)).statusCode).toBe(201)
    expect((await zuordnen(a.requestRef, s)).statusCode).toBe(200)
    const andere = await zuordnen(b.requestRef, s)
    expect(andere.statusCode).toBe(409)
    expect(andere.json().code).toBe('deposit.settlementAlreadyAssigned')

    // Eine Erstattung ist kein Eingang auf eine Forderung.
    const minus = await eingang(folioId, -1_000)
    expect((await zuordnen(b.requestRef, minus)).statusCode).toBe(422)
  })
})

describe('Zahlungslink zur Anforderung', () => {
  it('erzeugt keinen Link im Uebungshaus und fragt den Anbieter gar nicht erst', async () => {
    const { folioRef } = await aufenthalt()
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])
    const a = (await anfordern(folioRef, { amountCent: 5_000, dueDate: '2026-10-10' }))
      .json() as { requestRef: string }

    const r = await link(folioRef, { amountCent: 5_000, depositRequestRef: a.requestRef })
    expect(r.statusCode).toBe(422)
    expect(r.json().code).toBe('training.noPaymentLink')
    expect(erzeugt).toBe(0)

    const v = await sicht(folioRef)
    expect(v.isTraining).toBe(true)
    expect(v.mail).toMatchObject({ ready: false, reason: 'training' })
    // Die Anforderung selbst ist Uebung genug: sie verlaesst das Haus nicht.
    expect(v.requests[0]!.state).toBe('requested')
  })

  it('verbucht den Eingang genau einmal und ordnet ihn genau einmal zu', async () => {
    const { folioRef, folioId } = await aufenthalt()
    const a = (await anfordern(folioRef, { amountCent: 9_000, dueDate: '2026-10-10' }))
      .json() as { requestRef: string }

    const l = await link(folioRef, { amountCent: 9_000, depositRequestRef: a.requestRef })
    expect(l.statusCode).toBe(201)
    const { url, linkId, expiresAt } = l.json() as { url: string; linkId: number
                                                     expiresAt: string | null }
    expect(expiresAt).not.toBeNull()
    const sessionId = url.split('/').pop()!

    let v = await sicht(folioRef)
    expect(v.requests[0]!.state).toBe('link_sent')
    expect(v.paymentLinks[0]).toMatchObject({ id: linkId, status: 'pending',
      depositRequestRef: a.requestRef, mailStatus: null, expired: false })

    // Dieselbe Zustellung zweimal, dann ein andersartiges Ereignis derselben
    // Zahlung -- Stripe tut beides.
    const erst = bezahlt('evt_anz_1', sessionId, 9_000)
    expect((await webhook(erst)).statusCode).toBe(200)
    expect((await webhook(erst)).statusCode).toBe(200)
    expect((await webhook(bezahlt('evt_anz_2', sessionId, 9_000))).statusCode).toBe(200)

    const vermerke = await owner.query(
      `SELECT id FROM settlement WHERE folio_id = $1`, [folioId])
    expect(vermerke.rows).toHaveLength(1)
    const zuordnungen = await owner.query(
      `SELECT settlement_id FROM deposit_request_settlement WHERE folio_id = $1`, [folioId])
    expect(zuordnungen.rows).toHaveLength(1)

    v = await sicht(folioRef)
    expect(v.requests[0]).toMatchObject({ state: 'received', receivedCent: 9_000,
                                          openCent: 0, depositInvoiceMissing: true })

    // Die Anzahlungsrechnung entsteht nicht im Webhook, sondern ueber den
    // vorhandenen Weg -- und danach fehlt sie nicht mehr.
    const rechnung = await app.inject({
      method: 'POST', url: `/v1/folios/${folioRef}/deposit-invoice`,
      headers: { ...auth, 'idempotency-key': key() },
      payload: { settlementId: vermerke.rows[0]!.id, taxRateBp: 700 } })
    expect(rechnung.statusCode).toBe(201)
    expect((await sicht(folioRef)).requests[0]!.depositInvoiceMissing).toBe(false)
  })

  it('verlangt per Link nicht mehr als den offenen Rest', async () => {
    const { folioRef, folioId } = await aufenthalt()
    const a = (await anfordern(folioRef, { amountCent: 9_000, dueDate: '2026-10-10' }))
      .json() as { requestRef: string }
    const s = await eingang(folioId, 4_000)
    await app.inject({ method: 'POST', url: `/v1/deposit-requests/${a.requestRef}/settlements`,
                       headers: auth, payload: { settlementId: s } })

    const r = await link(folioRef, { amountCent: 9_000, depositRequestRef: a.requestRef })
    expect(r.statusCode).toBe(422)
    expect(r.json().code).toBe('deposit.linkExceedsOpen')
    expect((await link(folioRef,
      { amountCent: 5_000, depositRequestRef: a.requestRef })).statusCode).toBe(201)
  })
})

describe('Zahlungslink per Gastpost', () => {
  it('reiht die Mail in derselben Anfrage ein, mit Bezug auf die Reservierung', async () => {
    await postEinschalten()
    const { folioRef, reservationId } = await aufenthalt()
    const a = (await anfordern(folioRef, { amountCent: 9_000, dueDate: '2026-10-10' }))
      .json() as { requestRef: string }

    const r = await link(folioRef,
      { amountCent: 9_000, depositRequestRef: a.requestRef, sendEmail: true })
    expect(r.statusCode).toBe(201)
    const { url, messageRef } = r.json() as { url: string; messageRef: string | null }
    expect(messageRef).not.toBeNull()

    const mail = await owner.query<{ kind: string; reservation_id: number; to_email: string
                                     subject: string; body_text: string }>(
      `SELECT kind, reservation_id, to_email, subject, body_text FROM outbound_email
        WHERE public_ref = $1`, [messageRef])
    expect(mail.rows[0]).toMatchObject({ kind: 'payment_link', reservation_id: reservationId,
                                         to_email: 'gast@example.org' })
    // In der Sprache des Gastes, mit Link, Betrag und Frist.
    expect(mail.rows[0]!.subject).toContain('Payment for your stay')
    expect(mail.rows[0]!.body_text).toContain(url)
    expect(mail.rows[0]!.body_text).toContain('90,00 EUR')
    expect(mail.rows[0]!.body_text).toContain('2026-10-10')

    const v = await sicht(folioRef)
    expect(v.mail).toMatchObject({ ready: true, reason: null, guestAddress: true })
    expect(v.paymentLinks[0]!.mailStatus).toBe('pending')
  })

  it('prueft die Post, bevor der Anbieter gefragt wird', async () => {
    const { folioRef } = await aufenthalt()
    const r = await link(folioRef, { amountCent: 5_000, sendEmail: true })
    expect(r.statusCode).toBe(422)
    expect(r.json().code).toBe('mail.sendingDisabled')
    // Kein Checkout beim Anbieter, zu dem es bei uns nichts gaebe.
    expect(erzeugt).toBe(0)
    const n = await owner.query(`SELECT count(*)::int AS n FROM payment_intent`)
    expect(n.rows[0].n).toBe(0)

    expect((await sicht(folioRef)).mail).toMatchObject({ ready: false, reason: 'disabled' })
  })

  it('schickt nichts an einen anonymisierten Gast', async () => {
    await postEinschalten()
    const { folioRef, reservationId } = await aufenthalt()
    await owner.query(
      `UPDATE guest SET status = 'anonymized'
        WHERE id = (SELECT primary_guest_id FROM reservation WHERE id = $1)`,
      [reservationId])
    const r = await link(folioRef, { amountCent: 5_000, sendEmail: true })
    expect(r.json().code).toBe('mail.guestAnonymized')
    expect(erzeugt).toBe(0)
  })
})

describe('Link ungueltig machen und Anforderung zurueckziehen', () => {
  it('beendet den Link beim Anbieter, bevor er als ungueltig gilt', async () => {
    const { folioRef } = await aufenthalt()
    const a = (await anfordern(folioRef, { amountCent: 5_000, dueDate: '2026-10-10' }))
      .json() as { requestRef: string }
    const l = (await link(folioRef, { amountCent: 5_000, depositRequestRef: a.requestRef }))
      .json() as { url: string; linkId: number }

    // Mit offenem Link laesst sich die Anforderung nicht zurueckziehen.
    const zu = await app.inject({
      method: 'POST', url: `/v1/deposit-requests/${a.requestRef}/cancel`, headers: auth })
    expect(zu.statusCode).toBe(409)
    expect(zu.json().code).toBe('deposit.requestHasOpenLink')

    // Lehnt der Anbieter ab, bleibt der Link offen.
    beendenVerweigern = true
    const abgelehnt = await app.inject({
      method: 'POST', url: `/v1/payment-links/${l.linkId}/cancel`, headers: auth })
    expect(abgelehnt.statusCode).toBe(409)
    expect((await sicht(folioRef)).paymentLinks[0]!.status).toBe('pending')

    beendenVerweigern = false
    const ok = await app.inject({
      method: 'POST', url: `/v1/payment-links/${l.linkId}/cancel`, headers: auth })
    expect(ok.statusCode).toBe(200)
    expect(beendet).toEqual([l.url.split('/').pop()])
    expect((await sicht(folioRef)).paymentLinks[0]!.status).toBe('canceled')

    const nochmal = await app.inject({
      method: 'POST', url: `/v1/payment-links/${l.linkId}/cancel`, headers: auth })
    expect(nochmal.json().code).toBe('payments.linkNotOpen')

    const jetzt = await app.inject({
      method: 'POST', url: `/v1/deposit-requests/${a.requestRef}/cancel`, headers: auth })
    expect(jetzt.statusCode).toBe(200)
    const v = await sicht(folioRef)
    expect(v.requests[0]).toMatchObject({ state: 'canceled', openCent: 0 })

    // Auf eine zurueckgezogene Forderung gibt es keinen neuen Link.
    const danach = await link(folioRef, { amountCent: 5_000, depositRequestRef: a.requestRef })
    expect(danach.json().code).toBe('deposit.requestCanceled')
  })
})

describe('Rechte', () => {
  it('laesst lesen, aber nicht anfordern, wer nur das Folio lesen darf', async () => {
    const { folioRef } = await aufenthalt()
    const a = (await anfordern(folioRef, { amountCent: 5_000, dueDate: '2026-10-10' }))
      .json() as { requestRef: string }
    const l = (await link(folioRef, { amountCent: 5_000 })).json() as { linkId: number }

    const b = await makeUser(owner,
      { email: 'buchhaltung@test.de', propertyId: fx.propertyId, roleKey: 'accounting' })
    const lesend = { cookie: `hp_session=${b.sessionId}` }

    expect((await sicht(folioRef, lesend)).requests).toHaveLength(1)
    expect((await anfordern(folioRef, { amountCent: 1_000, dueDate: '2026-10-10' }, lesend))
      .statusCode).toBe(403)
    expect((await link(folioRef, { amountCent: 1_000 }, lesend)).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/v1/payment-links/${l.linkId}/cancel`,
                               headers: lesend })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/v1/deposit-requests/${a.requestRef}/cancel`,
                               headers: lesend })).statusCode).toBe(403)
  })

  it('prueft das Recht im Haus des Folios, nicht in irgendeinem', async () => {
    // Zweites Haus im selben Account: dort nur lesen.
    const p = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name, address_line1, postal_code, city,
                             country, tax_number)
       VALUES ($1,'ZWEI','Zweites Haus','Kai 2','25813','Husum','DE','21/815/00999')
       RETURNING id`, [fx.accountId])
    const zweites = p.rows[0]!.id
    await openBusinessDay(owner, zweites, '2026-10-01')
    const kat = await makeCategory(owner, zweites)
    await makeResources(owner, zweites, kat, 1)
    const { folioRef } = await aufenthalt(10_000, zweites, kat)

    const u = await makeUser(owner,
      { email: 'zwei@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'accounting' AND account_id IS NULL`,
      [u.userId, zweites])
    const wer = { cookie: `hp_session=${u.sessionId}` }

    // Lesen geht: die Zeilenrichtlinie laesst das Folio durch.
    expect((await sicht(folioRef, wer)).propertyId).toBe(zweites)
    // Buchen nicht -- obwohl der Benutzer folio:post im ersten Haus hat.
    const r = await anfordern(folioRef, { amountCent: 1_000, dueDate: '2026-10-10' }, wer)
    expect(r.statusCode).toBe(403)
    expect((await link(folioRef, { amountCent: 1_000 }, wer)).statusCode).toBe(403)
    expect(erzeugt).toBe(0)
  })

  it('verlangt fuer das Verschicken zusaetzlich das Recht auf Gastpost', async () => {
    await postEinschalten()
    const { folioRef } = await aufenthalt()
    // Eine Rolle mit folio:post, aber ohne email:send.
    const rolle = await owner.query<{ id: number }>(
      `INSERT INTO role (account_id, level, key, name) VALUES ($1, 'property', 'nur_folio', 'Nur Folio')
       RETURNING id`, [fx.accountId])
    await owner.query(
      `INSERT INTO role_permission (role_id, permission_key) VALUES ($1,'folio:read'),
                                                                    ($1,'folio:post')`,
      [rolle.rows[0]!.id])
    const u = await makeUser(owner, { email: 'folio@test.de' })
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id) VALUES ($1,$2,$3)`,
      [u.userId, fx.propertyId, rolle.rows[0]!.id])
    const wer = { cookie: `hp_session=${u.sessionId}` }

    expect((await link(folioRef, { amountCent: 1_000 }, wer)).statusCode).toBe(201)
    const mitPost = await link(folioRef, { amountCent: 1_000, sendEmail: true }, wer)
    expect(mitPost.statusCode).toBe(403)
  })
})
