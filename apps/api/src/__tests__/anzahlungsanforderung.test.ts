import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, makePaymentMethod,
         makeEmailDomain, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { stripeAttrappe, signiert, bezahltEreignis } from './stripeAttrappe.js'

/**
 * Anzahlung anfordern, Zahlungslink, Eingang (Migrationen 0060, 0068).
 *
 * Geprueft wird, was an der Oberflaeche nicht zu sehen ist und trotzdem
 * stimmen muss:
 *
 * 1. **Der Betrag wird abgerundet und ganzzahlig festgeschrieben**, auch in
 *    Prozent. Die Maske zeigt ihn vorher mit derselben Funktion an.
 * 2. **Ueberfaellig wird gegen den Geschaeftstag geprueft**, nicht gegen die
 *    Uhr. Am Faelligkeitstag selbst ist nichts ueberfaellig.
 * 3. **Der Link in der Mail haelt bis zur Frist** (0068): er ist von uns, und
 *    erst beim Oeffnen entsteht ein Checkout beim Anbieter -- je Link
 *    hoechstens ein offener, und ein neuer erst, wenn der alte erledigt ist.
 * 4. **Ein Uebungshaus legt nie einen Checkout an.**
 * 5. **Der Eingang ueber den Webhook wird genau einmal verbucht und genau
 *    einmal zugeordnet**, auch bei doppelter oder andersartiger Zustellung.
 * 6. **Das Token steht nirgends im Klartext**: nicht in der Datenbank, nicht
 *    im Idempotenzspeicher, nicht im Protokoll, nach dem Versand nicht in der
 *    Gastpost, und nach einer Loeschung fuehrt es ins Leere.
 * 7. **Rechte gelten im Haus des Folios**, nicht in irgendeinem.
 */

const WEBHOOK_SECRET = 'whsec_test_anzahlung'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let categoryId: number

/** Der Anbieter als Attrappe: kein Netz, aber mit Buchfuehrung ueber Checkouts. */
const stripe = stripeAttrappe()

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  const built = await buildServer({ pool: appPool(10) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app, { payments: { stripe } })
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
  stripe.zuruecksetzen()
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
  headers: { 'content-type': 'application/json',
             'stripe-signature': signiert(raw, WEBHOOK_SECRET) },
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
                        expiresAt: string | null; legacy: boolean
                        validUntil: string | null; openedAt: string | null }>
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

/** Das Token aus der Adresse, die die Rezeption bekommt. */
function tokenAus(url: string): string {
  return new URL(url).searchParams.get('t')!
}

const seite = (token: string, wer: Record<string, string> = {}) => app.inject({
  method: 'GET', url: `/v1/pay?t=${encodeURIComponent(token)}`, headers: wer })

const zurKasse = (token: string) => app.inject({
  method: 'GET', url: `/v1/pay/checkout?t=${encodeURIComponent(token)}` })

/** Oeffnet den Link bis zum Anbieter und liefert die Kennung des Checkouts. */
async function oeffnen(token: string): Promise<string> {
  const r = await zurKasse(token)
  expect(r.statusCode, r.body).toBe(303)
  return String(r.headers.location).split('/').pop()!
}

async function anforderungMitLink(betrag = 9_000, payload: Record<string, unknown> = {}) {
  const auf = await aufenthalt()
  const a = (await anfordern(auf.folioRef, { amountCent: betrag, dueDate: '2026-10-10' }))
    .json() as { requestRef: string }
  const l = await link(auf.folioRef,
    { amountCent: betrag, depositRequestRef: a.requestRef, ...payload })
  expect(l.statusCode, l.body).toBe(201)
  const body = l.json() as { url: string; linkId: number; validUntil: string
                             messageRef: string | null }
  return { ...auf, requestRef: a.requestRef, ...body, token: tokenAus(body.url) }
}

describe('Der dauerhafte Zahlungslink', () => {
  it('ist ein Link von uns, gilt eine Woche ueber die Frist und fragt beim Anlegen niemanden',
    async () => {
      const x = await anforderungMitLink()
      // Nicht die Adresse eines Checkouts, sondern unsere, mit dem Token in
      // der Abfrage und nicht im Pfad.
      expect(x.url).toMatch(/\/v1\/pay\?t=[A-Za-z0-9_-]{43}$/)
      // Faellig am 10., eine Woche Kulanz, vor der Abreise am 23.
      expect(x.validUntil).toBe('2026-10-17')
      expect(stripe.angelegt).toBe(0)

      // In der Datenbank nur der Hash.
      const roh = await owner.query<{ token_hash: string }>(
        `SELECT token_hash FROM payment_link WHERE id = $1`, [x.linkId])
      expect(roh.rows[0]!.token_hash).not.toContain(x.token)
      expect(roh.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/)

      const v = await sicht(x.folioRef)
      expect(v.requests[0]!.state).toBe('link_sent')
      expect(v.paymentLinks[0]).toMatchObject({ id: x.linkId, legacy: false,
        status: 'pending', validUntil: '2026-10-17', expired: false, openedAt: null })
    })

  it('zeigt dem Gast eine Seite und legt erst auf den Knopf einen Checkout an', async () => {
    const x = await anforderungMitLink()
    const s = await seite(x.token)
    expect(s.statusCode).toBe(200)
    expect(s.headers['content-type']).toContain('text/html')
    expect(s.headers['cache-control']).toBe('no-store')
    // Englisch, weil das Gastprofil englisch ist; Betrag und Haus stehen da,
    // der Name des Gastes nicht.
    expect(s.body).toContain('Continue to payment')
    expect(s.body).toContain('90,00 EUR')
    expect(s.body).toContain('Testhotel')
    expect(s.body).not.toContain('Petersen')
    expect(s.body).not.toContain('<style')
    expect(s.body).not.toContain('<script')
    // Ein Vorabaufruf durch ein Mailprogramm legt nichts an.
    expect(stripe.angelegt).toBe(0)

    const ref = await oeffnen(x.token)
    expect(stripe.angelegt).toBe(1)
    // Der Anbieter bekommt das Token nicht, auch nicht in der Rueckkehr.
    expect(stripe.sitzungen.get(ref)!.successUrl).not.toContain(x.token)
    expect((await sicht(x.folioRef)).paymentLinks[0]!.openedAt).not.toBeNull()
  })

  it('verwendet einen offenen Checkout wieder, auch bei gleichzeitigem Oeffnen', async () => {
    const x = await anforderungMitLink()
    const [a, b, c] = await Promise.all([zurKasse(x.token), zurKasse(x.token),
                                         zurKasse(x.token)])
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([303, 303, 303])
    expect(new Set([a.headers.location, b.headers.location, c.headers.location]).size).toBe(1)
    expect(stripe.angelegt).toBe(1)
    expect(await oeffnen(x.token)).toBe('cs_test_1')
    expect(stripe.angelegt).toBe(1)
  })

  it('legt nach Ablauf beim Anbieter einen neuen an, und nur einen', async () => {
    const x = await anforderungMitLink()
    const erst = await oeffnen(x.token)
    stripe.sitzungen.get(erst)!.status = 'expired'

    const zweit = await oeffnen(x.token)
    expect(zweit).not.toBe(erst)
    const offen = await owner.query(
      `SELECT provider_reference, status FROM payment_intent
        WHERE payment_link_id = $1 ORDER BY id`, [x.linkId])
    expect(offen.rows).toEqual([
      { provider_reference: erst, status: 'failed' },
      { provider_reference: zweit, status: 'pending' }])
  })

  it('schliesst den alten Checkout beim Anbieter, wenn sich der offene Betrag aendert',
    async () => {
      const x = await anforderungMitLink()
      const erst = await oeffnen(x.token)
      // Der Gast ueberweist einen Teil; die Rezeption ordnet ihn zu.
      const s = await eingang(x.folioId, 4_000)
      await app.inject({ method: 'POST',
        url: `/v1/deposit-requests/${x.requestRef}/settlements`,
        headers: auth, payload: { settlementId: s } })

      const zweit = await oeffnen(x.token)
      expect(stripe.beendet).toEqual([erst])
      expect(stripe.sitzungen.get(zweit)!.amountCent).toBe(5_000)
      expect((await seite(x.token)).body).toContain('50,00 EUR')
    })

  /*
   * Die Doppelzahlung. Der Webhook nimmt jede echte Zahlung an -- Geld, das
   * der Anbieter meldet, ist da. Die Sperre liegt davor: ein neuer Checkout
   * entsteht nur, wenn der Anbieter den alten fuer erledigt erklaert, und
   * die Datenbank laesst je Link hoechstens einen offenen zu.
   */
  it('legt keinen zweiten Checkout an, solange der erste beim Anbieter bezahlt wird',
    async () => {
      const x = await anforderungMitLink()
      const erst = await oeffnen(x.token)
      stripe.bezahlen(erst)  // bezahlt, die Meldung ist noch unterwegs

      const nochmal = await zurKasse(x.token)
      expect(nochmal.statusCode).toBe(200)
      expect(nochmal.body).toContain('being processed')
      expect(stripe.angelegt).toBe(1)

      // Die Meldung kommt -- zweimal und als zweites Ereignis --, ein Vermerk.
      const raw = bezahltEreignis('evt_1', erst, 9_000)
      await webhook(raw); await webhook(raw)
      await webhook(bezahltEreignis('evt_2', erst, 9_000))
      const vermerke = await owner.query(
        `SELECT id FROM settlement WHERE folio_id = $1`, [x.folioId])
      expect(vermerke.rows).toHaveLength(1)
      const zuordnung = await owner.query(
        `SELECT count(*)::int AS n FROM deposit_request_settlement WHERE folio_id = $1`,
        [x.folioId])
      expect(zuordnung.rows[0].n).toBe(1)

      const v = await sicht(x.folioRef)
      expect(v.requests[0]).toMatchObject({ state: 'received', depositInvoiceMissing: true })
      expect(v.paymentLinks[0]!.status).toBe('succeeded')
      expect((await seite(x.token)).body).toContain('has been received')
      expect((await zurKasse(x.token)).statusCode).toBe(200)
      expect(stripe.angelegt).toBe(1)
    })

  it('haelt je Link hoechstens einen offenen Checkout in der Datenbank fest', async () => {
    const x = await anforderungMitLink()
    await oeffnen(x.token)
    // Wer an der Route vorbei einen zweiten offenen anlegen will, scheitert
    // am Index -- nicht an einer Pruefung, die man vergessen kann.
    await expect(owner.query(
      `INSERT INTO payment_intent (property_id, folio_id, provider, provider_reference,
                                   amount_cent, payment_link_id)
       VALUES ($1,$2,'stripe','cs_daneben',9000,$3)`,
      [fx.propertyId, x.folioId, x.linkId])).rejects.toThrow(/payment_intent_one_open_per_link/)
  })

  it('nimmt eine spaete Zahlung auf einen ersetzten Checkout trotzdem an', async () => {
    // Abgelaufen markiert, aber beim Anbieter im letzten Augenblick bezahlt:
    // das Geld ist da und muss im Folio stehen, nicht verschwinden.
    const x = await anforderungMitLink()
    const erst = await oeffnen(x.token)
    stripe.sitzungen.get(erst)!.status = 'expired'
    await oeffnen(x.token)
    await webhook(bezahltEreignis('evt_spaet', erst, 9_000))
    const vermerke = await owner.query(
      `SELECT amount_cent FROM settlement WHERE folio_id = $1`, [x.folioId])
    expect(vermerke.rows).toEqual([{ amount_cent: 9_000 }])
  })

  it('verlangt per Link nicht mehr als den offenen Rest, und je Anforderung einen', async () => {
    const auf = await aufenthalt()
    const a = (await anfordern(auf.folioRef, { amountCent: 9_000, dueDate: '2026-10-10' }))
      .json() as { requestRef: string }
    const s = await eingang(auf.folioId, 4_000)
    await app.inject({ method: 'POST', url: `/v1/deposit-requests/${a.requestRef}/settlements`,
                       headers: auth, payload: { settlementId: s } })

    const zuviel = await link(auf.folioRef, { amountCent: 9_000, depositRequestRef: a.requestRef })
    expect(zuviel.json().code).toBe('deposit.linkExceedsOpen')
    expect((await link(auf.folioRef,
      { amountCent: 5_000, depositRequestRef: a.requestRef })).statusCode).toBe(201)
    const zweiter = await link(auf.folioRef,
      { amountCent: 5_000, depositRequestRef: a.requestRef })
    expect(zweiter.statusCode).toBe(409)
    expect(zweiter.json().code).toBe('payments.linkActive')
  })

  it('gibt die Adresse bei einer Wiederholung nicht noch einmal heraus', async () => {
    const auf = await aufenthalt()
    const k = key()
    const erst = await app.inject({ method: 'POST',
      url: `/v1/folios/${auf.folioRef}/payment-links`,
      headers: { ...auth, 'idempotency-key': k }, payload: { amountCent: 1_000 } })
    const zweit = await app.inject({ method: 'POST',
      url: `/v1/folios/${auf.folioRef}/payment-links`,
      headers: { ...auth, 'idempotency-key': k }, payload: { amountCent: 1_000 } })
    expect((erst.json() as { url: string }).url).toMatch(/t=/)
    expect(zweit.json()).toMatchObject({ url: null,
      linkId: (erst.json() as { linkId: number }).linkId })
    // Auch im Idempotenzspeicher steht das Token nicht.
    const gespeichert = await owner.query(`SELECT response_body::text AS b FROM idempotency_key`)
    const token = tokenAus((erst.json() as { url: string }).url)
    expect(gespeichert.rows.map(r => r.b).join()).not.toContain(token)
  })
})

describe('Was der Gast sieht, wenn nicht gezahlt werden kann', () => {
  it('sagt bei einem unbekannten Token nur, dass es ungueltig ist', async () => {
    const r = await seite('A'.repeat(43), { 'accept-language': 'nl-NL,nl;q=0.9' })
    expect(r.statusCode).toBe(404)
    expect(r.body).toContain('Deze link is ongeldig')
    expect(r.body).not.toContain('Testhotel')
    expect((await seite('kurz')).statusCode).toBe(404)
  })

  it('nimmt einen widerrufenen Link nicht mehr an und schliesst den Checkout', async () => {
    const x = await anforderungMitLink()
    const ref = await oeffnen(x.token)

    // Mit gueltigem Link laesst sich die Anforderung nicht zurueckziehen.
    const zu = await app.inject({ method: 'POST',
      url: `/v1/deposit-requests/${x.requestRef}/cancel`, headers: auth })
    expect(zu.json().code).toBe('deposit.requestHasOpenLink')

    // Lehnt der Anbieter das Beenden ab, bleibt alles, wie es ist.
    stripe.verweigern = true
    const abgelehnt = await app.inject({ method: 'POST',
      url: `/v1/payment-links/${x.linkId}/cancel`, headers: auth })
    expect(abgelehnt.statusCode).toBe(409)
    expect((await seite(x.token)).body).toContain('Continue to payment')

    stripe.verweigern = false
    const ok = await app.inject({ method: 'POST',
      url: `/v1/payment-links/${x.linkId}/cancel`, headers: auth })
    expect(ok.statusCode).toBe(200)
    expect(stripe.beendet).toEqual([ref])
    // Der Hash ist weg: das Token aus der Mail fuehrt ins Leere.
    expect((await seite(x.token)).statusCode).toBe(404)
    expect((await sicht(x.folioRef)).paymentLinks[0]!.status).toBe('canceled')
    expect((await app.inject({ method: 'POST',
      url: `/v1/payment-links/${x.linkId}/cancel`, headers: auth })).json().code)
      .toBe('payments.linkNotOpen')

    // Jetzt geht das Zurueckziehen, und danach gibt es keinen neuen Link.
    expect((await app.inject({ method: 'POST',
      url: `/v1/deposit-requests/${x.requestRef}/cancel`, headers: auth })).statusCode).toBe(200)
    expect((await link(x.folioRef, { amountCent: 9_000, depositRequestRef: x.requestRef }))
      .json().code).toBe('deposit.requestCanceled')
  })

  it('laeuft gegen den Geschaeftstag ab, nicht gegen die Uhr', async () => {
    const x = await anforderungMitLink()
    await geschaeftstagWechseln('2026-10-17')
    expect((await seite(x.token)).body).toContain('Continue to payment')
    await geschaeftstagWechseln('2026-10-18')
    const r = await seite(x.token)
    expect(r.body).toContain('has expired')
    expect((await zurKasse(x.token)).statusCode).toBe(200)
    expect(stripe.angelegt).toBe(0)
    expect((await sicht(x.folioRef)).paymentLinks[0]!.expired).toBe(true)
  })

  it('legt im Uebungshaus nie einen Checkout an, auch nicht fuer einen alten Link', async () => {
    const x = await anforderungMitLink()
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])
    const r = await zurKasse(x.token)
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('training property')
    expect(stripe.angelegt).toBe(0)
    // Und neu anlegen geht dort gar nicht erst.
    const neu = await link(x.folioRef, { amountCent: 1_000 })
    expect(neu.json().code).toBe('training.noPaymentLink')
  })

  it('zeigt nach der Rueckkehr vom Anbieter eine Seite ohne Token', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/pay/done?lang=pl&ergebnis=abgebrochen' })
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('nie została zakończona')
  })

  it('schreibt das Token nicht ins Protokoll', async () => {
    const x = await anforderungMitLink()
    const zeilen: string[] = []
    const { Writable } = await import('node:stream')
    const strom = new Writable({ write(chunk, _enc, fertig) {
      zeilen.push(String(chunk)); fertig() } })
    const mitProtokoll = await buildServer({ pool: appPool(2), logStream: strom })
    registerAllRoutes(mitProtokoll.app, { payments: { stripe } })
    await mitProtokoll.app.ready()
    try {
      await mitProtokoll.app.inject({ method: 'GET', url: `/v1/pay?t=${x.token}` })
      await mitProtokoll.app.inject({ method: 'GET', url: `/v1/pay/checkout?t=${x.token}` })
    } finally {
      await mitProtokoll.app.close(); await mitProtokoll.pool.end()
    }
    const alles = zeilen.join('\n')
    expect(alles).toContain('/v1/pay?t=[redigiert]')
    expect(alles).not.toContain(x.token)
  })
})

describe('Zahlungslink per Gastpost', () => {
  it('schickt den dauerhaften Link und entfernt das Token nach dem Versand', async () => {
    await postEinschalten()
    const x = await anforderungMitLink(9_000, { sendEmail: true })
    expect(x.messageRef).not.toBeNull()

    const mail = await owner.query<{ kind: string; reservation_id: number; to_email: string
                                     subject: string; body_text: string; body_html: string }>(
      `SELECT kind, reservation_id, to_email, subject, body_text, body_html
         FROM outbound_email WHERE public_ref = $1`, [x.messageRef])
    expect(mail.rows[0]).toMatchObject({ kind: 'payment_link',
      reservation_id: x.reservationId, to_email: 'gast@example.org' })
    expect(mail.rows[0]!.subject).toContain('Payment for your stay')
    // Unser Link, nicht der eines Checkouts; dazu Betrag, Frist, Gueltigkeit.
    expect(mail.rows[0]!.body_text).toContain(x.url)
    expect(mail.rows[0]!.body_text).not.toContain('checkout.stripe')
    expect(mail.rows[0]!.body_text).toContain('90,00 EUR')
    expect(mail.rows[0]!.body_text).toContain('2026-10-10')
    expect(mail.rows[0]!.body_text).toContain('2026-10-17')
    expect((await sicht(x.folioRef)).paymentLinks[0]!.mailStatus).toBe('pending')

    // Zugestellt: danach steht das Token nicht mehr im Rumpf.
    await owner.query(`UPDATE outbound_email SET status = 'sent', sent_at = now()
                        WHERE public_ref = $1`, [x.messageRef])
    const danach = await owner.query<{ body_text: string; body_html: string }>(
      `SELECT body_text, body_html FROM outbound_email WHERE public_ref = $1`, [x.messageRef])
    expect(danach.rows[0]!.body_text).not.toContain(x.token)
    expect(danach.rows[0]!.body_html).not.toContain(x.token)
    expect(danach.rows[0]!.body_text).toContain('t=[entfernt]')
    // Der Link selbst gilt weiter -- er steht ja in der Mail beim Gast.
    expect((await seite(x.token)).statusCode).toBe(200)
  })

  it('zieht eine noch wartende Mail zurueck, wenn ihr Link widerrufen wird', async () => {
    await postEinschalten()
    const x = await anforderungMitLink(9_000, { sendEmail: true })
    const r = await app.inject({ method: 'POST',
      url: `/v1/payment-links/${x.linkId}/cancel`, headers: auth })
    expect(r.statusCode).toBe(200)
    const mail = await owner.query<{ status: string; body_text: string }>(
      `SELECT status, body_text FROM outbound_email WHERE public_ref = $1`, [x.messageRef])
    expect(mail.rows[0]!.status).toBe('canceled')
    expect(mail.rows[0]!.body_text).not.toContain(x.token)
  })

  it('prueft die Post, bevor etwas angelegt wird', async () => {
    const { folioRef } = await aufenthalt()
    const r = await link(folioRef, { amountCent: 5_000, sendEmail: true })
    expect(r.statusCode).toBe(422)
    expect(r.json().code).toBe('mail.sendingDisabled')
    const n = await owner.query(`SELECT count(*)::int AS n FROM payment_link`)
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
  })
})

describe('Loeschung des Gastes', () => {
  it('widerruft seine Links und entfernt den Hash, in beiden Fassungen der Loeschung',
    async () => {
      for (const fassung of ['guest_erase_one', 'guest_erase_partial']) {
        const x = await anforderungMitLink()
        expect((await seite(x.token)).statusCode).toBe(200)
        const g = await owner.query<{ id: number; account_id: number }>(
          `SELECT g.id, g.account_id FROM reservation r JOIN guest g ON g.id = r.primary_guest_id
            WHERE r.id = $1`, [x.reservationId])
        const c = await pool.connect()
        try {
          await c.query('BEGIN')
          await c.query(`SELECT set_config('app.account_ids', $1, true),
                                set_config('app.property_ids', $2, true)`,
            [String(g.rows[0]!.account_id), String(fx.propertyId)])
          await c.query(`SELECT ${fassung}($1)`, [g.rows[0]!.id])
          await c.query('COMMIT')
        } finally { c.release() }

        const l = await owner.query<{ token_hash: string | null; revoked: boolean }>(
          `SELECT token_hash, revoked_at IS NOT NULL AS revoked FROM payment_link WHERE id = $1`,
          [x.linkId])
        expect(l.rows[0], fassung).toEqual({ token_hash: null, revoked: true })
        expect((await seite(x.token)).statusCode, fassung).toBe(404)
      }
    })

  it('fuehrt den Hash auf der Redaktionsliste des Audits', async () => {
    const r = await owner.query(
      `SELECT 1 FROM audit_redaction WHERE table_name = 'payment_link'
          AND column_name = 'token_hash'`)
    expect(r.rowCount).toBe(1)
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
    expect(stripe.angelegt).toBe(0)
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
