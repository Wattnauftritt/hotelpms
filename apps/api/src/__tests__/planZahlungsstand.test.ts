import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeGuest, makeReservation, makePaymentMethod,
         openBusinessDay, countQueries, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import type { TapeChart } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Zahlungs- und Reinigungsstand im Belegungsplan.
 *
 * Beides kommt im **einen** Aufruf des Plans mit, und beides haengt an einem
 * eigenen Recht. Geprueft wird mit echten Positionen, Zahlungsvermerken und
 * Anzahlungsrechnungen ueber die Routen, nicht mit vorgefertigten Summen:
 * der Fehler, der hier droht, ist eine plausibel aussehende falsche Zahl --
 * eine frische Buchung, die "bezahlt" heisst, weil ihr Saldo null ist.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let rooms: number[]
let rezeption: Record<string, string>

const VON = '2026-10-01'
const BIS = '2026-10-31'
const PREIS = 10_000

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(10) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

let lauf = 0
const key = (): string => `plan-zs-${++lauf}-${Date.now()}`

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  await openBusinessDay(owner, fx.propertyId, VON)
  await makePaymentMethod(owner, fx.propertyId, 'TRANSFER')
  catId = await makeCategory(owner, fx.propertyId)
  rooms = await makeResources(owner, fx.propertyId, catId, 4)
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  rezeption = { cookie: `hp_session=${u.sessionId}` }
})

type Reservierung = TapeChart['reservations'][number]

async function plan(wer = rezeption, von = VON, bis = BIS): Promise<TapeChart> {
  const r = await app.inject({
    method: 'GET', url: `/v1/properties/${fx.propertyId}/tape-chart?from=${von}&to=${bis}`,
    headers: wer })
  expect(r.statusCode).toBe(200)
  return r.json() as TapeChart
}

async function balken(reservationId: number, wer = rezeption): Promise<Reservierung> {
  const p = await plan(wer)
  const r = p.reservations.find(x => x.id === reservationId)
  expect(r).toBeDefined()
  return r!
}

/** Ein Aufenthalt mit Gast und Anschrift am Folio, wie ihn eine Rechnung braucht. */
async function aufenthalt(opts: { arrival?: string; departure?: string
                                  resourceId?: number } = {}) {
  const gast = await makeGuest(owner, fx.accountId)
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: catId,
    arrival: opts.arrival ?? '2026-10-05', departure: opts.departure ?? '2026-10-08',
    resourceId: opts.resourceId ?? rooms[0]!, priceCent: PREIS, reserveInventory: false })
  const f = await owner.query<{ public_ref: string }>(
    `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`,
    [res.folioId, gast.id])
  return { ...res, folioRef: f.rows[0]!.public_ref }
}

/**
 * Eine Nacht so buchen, wie der Nachtlauf es tut: Position zum
 * eingefrorenen Bruttopreis, Nacht als gebucht markiert. Der Nachtlauf
 * selbst liegt im Worker, und eine App greift nicht in die andere.
 */
async function nachtBuchen(reservationId: number, folioId: number, date: string) {
  await owner.query(
    `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                         net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account,
                         reservation_id)
     VALUES ($1,$2,$3::date,'Uebernachtung',1,$4 - 654,654,$4,700,'8300',$5)`,
    [fx.propertyId, folioId, date, PREIS, reservationId])
  await owner.query(
    `UPDATE reservation_night SET posted = true WHERE reservation_id = $1 AND date = $2::date`,
    [reservationId, date])
}

const zahlen = (folioRef: string, amountCent: number) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/settlements`,
  headers: { ...rezeption, 'idempotency-key': key() },
  payload: { amountCent, paymentMethodCode: 'TRANSFER' } })

const minibar = (folioRef: string) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/charges`,
  headers: { ...rezeption, 'idempotency-key': key() },
  payload: { description: 'Minibar', netCent: 420, taxRateBp: 1900 } })

describe('Zahlungsstand am Balken', () => {
  it('nennt eine frische Buchung weder offen noch bezahlt, und nennt den Erwartungswert', async () => {
    const a = await aufenthalt()
    const b = await balken(a.reservationId)
    expect(b.payment).toMatchObject({
      state: 'none', charged_cent: 0, settled_cent: 0, balance_cent: 0,
      expected_cent: 3 * PREIS, unposted_nights: 3, requested_cent: 0, group: null })
  })

  it('nennt gebuchte, unbezahlte Naechte offen', async () => {
    const a = await aufenthalt()
    await nachtBuchen(a.reservationId, a.folioId, '2026-10-05')
    const b = await balken(a.reservationId)
    expect(b.payment).toMatchObject({
      state: 'open', charged_cent: PREIS, balance_cent: PREIS,
      expected_cent: 3 * PREIS, unposted_nights: 2 })
  })

  it('misst teilweise am ganzen Aufenthalt, auch wenn der Saldo heute null ist', async () => {
    const a = await aufenthalt()
    await nachtBuchen(a.reservationId, a.folioId, '2026-10-05')
    expect((await zahlen(a.folioRef, PREIS)).statusCode).toBe(201)
    const b = await balken(a.reservationId)
    expect(b.payment).toMatchObject({
      state: 'partial', balance_cent: 0, settled_cent: PREIS, expected_cent: 3 * PREIS })
  })

  it('nennt den gedeckten Aufenthalt bezahlt und faellt nach der Minibar zurueck', async () => {
    const a = await aufenthalt()
    expect((await zahlen(a.folioRef, 3 * PREIS)).statusCode).toBe(201)
    expect((await balken(a.reservationId)).payment?.state).toBe('paid')

    const m = await minibar(a.folioRef)
    expect(m.statusCode).toBe(201)
    const brutto = (m.json() as { grossCent: number }).grossCent
    const b = await balken(a.reservationId)
    expect(b.payment).toMatchObject({
      state: 'partial', charged_cent: brutto, expected_cent: 3 * PREIS + brutto })
  })

  it('nennt Geld vor der ersten Nacht eine Anzahlung, mit Anzahlungsrechnung', async () => {
    const a = await aufenthalt()
    const z = await zahlen(a.folioRef, 12_000)
    expect(z.statusCode).toBe(201)
    const settlementId = (z.json() as { settlementId: number }).settlementId
    const r = await app.inject({
      method: 'POST', url: `/v1/folios/${a.folioRef}/deposit-invoice`,
      headers: { ...rezeption, 'idempotency-key': key() },
      payload: { settlementId, taxRateBp: 700 } })
    expect(r.statusCode).toBe(201)

    const b = await balken(a.reservationId)
    expect(b.payment).toMatchObject({
      state: 'deposit', settled_cent: 12_000, deposit_cent: 12_000, charged_cent: 0 })
  })

  it('nennt einen offenen Zahlungslink angefordert, und erst die Zahlung deckt ihn', async () => {
    const a = await aufenthalt()
    await owner.query(
      `INSERT INTO payment_intent (property_id, folio_id, provider, provider_reference,
                                   amount_cent)
       VALUES ($1,$2,'stripe','cs_plan_offen',$3)`,
      [fx.propertyId, a.folioId, 3 * PREIS])
    expect((await balken(a.reservationId)).payment)
      .toMatchObject({ state: 'requested', requested_cent: 3 * PREIS })

    expect((await zahlen(a.folioRef, 3 * PREIS)).statusCode).toBe(201)
    expect((await balken(a.reservationId)).payment?.state).toBe('paid')
  })

  it('nennt einen abgelaufenen Zahlungslink nicht mehr angefordert', async () => {
    // Ein Link, den der Gast nicht mehr einloesen kann, fordert nichts an.
    // Seit Migration 0060 tragen Links ihren Ablauf.
    const a = await aufenthalt()
    await owner.query(
      `INSERT INTO payment_intent (property_id, folio_id, provider, provider_reference,
                                   amount_cent, expires_at)
       VALUES ($1,$2,'stripe','cs_plan_abgelaufen',$3, now() - interval '1 hour')`,
      [fx.propertyId, a.folioId, 3 * PREIS])
    expect((await balken(a.reservationId)).payment)
      .toMatchObject({ state: 'none', requested_cent: 0 })
  })

  it('nimmt umgeleitete Logis aus der Erwartung', async () => {
    const a = await aufenthalt()
    const firma = await owner.query<{ id: number }>(
      `INSERT INTO folio (property_id, kind, label) VALUES ($1,'company','Firma')
       RETURNING id`, [fx.propertyId])
    await owner.query(
      `INSERT INTO routing_rule (property_id, reservation_id, target_folio_id, match_kind)
       VALUES ($1,$2,$3,'accommodation')`,
      [fx.propertyId, a.reservationId, firma.rows[0]!.id])
    const b = await balken(a.reservationId)
    expect(b.payment).toMatchObject({ state: 'none', routed: true, expected_cent: 0,
                                      unposted_nights: 0 })
  })
})

describe('Zahlungsstand einer Gruppe', () => {
  /**
   * Zwei Zimmer einer Buchung, und der Bucher zahlt fuer beide auf sein
   * eigenes. Am Balken steht je Zimmer, was auf **dessen** Folio steht --
   * abgerechnet wird je Folio --, und daneben die Rechnung ueber die ganze
   * Gruppe, damit das zweite Zimmer nicht wie ein Versaeumnis aussieht.
   *
   * Das dritte Zimmer derselben Buchung liegt ausserhalb des Zeitraums.
   * Aus den sichtbaren Balken summiert fehlte es, und die Gruppensumme
   * saehe richtig aus.
   */
  it('zeigt je Zimmer das eigene Folio und daneben die ganze Gruppe', async () => {
    const eins = await aufenthalt({ resourceId: rooms[0]! })
    const zwei = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-10-05',
      departure: '2026-10-08', resourceId: rooms[1]!, priceCent: PREIS,
      reserveInventory: false })
    const drei = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-11-20',
      departure: '2026-11-22', resourceId: rooms[2]!, priceCent: PREIS,
      reserveInventory: false })
    await owner.query(`UPDATE reservation SET booking_id = $1 WHERE id = ANY($2)`,
      [eins.bookingId, [zwei.reservationId, drei.reservationId]])

    expect((await zahlen(eins.folioRef, 6 * PREIS)).statusCode).toBe(201)

    const p = await plan()
    expect(p.reservations.map(r => r.id)).not.toContain(drei.reservationId)
    const b1 = p.reservations.find(r => r.id === eins.reservationId)!
    const b2 = p.reservations.find(r => r.id === zwei.reservationId)!
    expect(b1.payment?.state).toBe('paid')
    expect(b2.payment?.state).toBe('none')
    // Drei Zimmer, nicht zwei: das dritte liegt im November.
    // Noch keine Nacht gebucht: die Gruppe hat eine Anzahlung, keine Teilzahlung.
    const gruppe = { state: 'deposit', rooms: 3, expected_cent: 8 * PREIS,
                     settled_cent: 6 * PREIS }
    expect(b1.payment?.group).toMatchObject(gruppe)
    expect(b2.payment?.group).toMatchObject(gruppe)
  })
})

describe('Rechte', () => {
  it('liefert den Plan ohne Folio-Recht, aber ohne Betraege', async () => {
    const a = await aufenthalt()
    await zahlen(a.folioRef, PREIS)
    // Die Rolle "Reservierung" bucht und verschiebt, Konten fuehrt sie nicht.
    const u = await makeUser(owner,
      { email: 'res@test.de', propertyId: fx.propertyId, roleKey: 'reservations' })
    const r = await app.inject({
      method: 'GET',
      url: `/v1/properties/${fx.propertyId}/tape-chart?from=${VON}&to=${BIS}`,
      headers: { cookie: `hp_session=${u.sessionId}` } })
    expect(r.statusCode).toBe(200)
    const p = r.json() as TapeChart
    expect(p.reservations).toHaveLength(1)
    expect(p.reservations[0]).not.toHaveProperty('payment')
    // Und kein Betrag irgendwo im Rumpf, auch nicht unter anderem Namen.
    expect(r.body).not.toContain('_cent')
    // Housekeeping-Leserecht hat die Rolle ebenfalls nicht.
    expect(p.units[0]).not.toHaveProperty('housekeeping')
  })

  it('liefert den Zahlungsstand mit Folio-Recht', async () => {
    const a = await aufenthalt()
    expect((await balken(a.reservationId)).payment).not.toBeNull()
  })
})

describe('Reinigungsstand im Plan', () => {
  it('steht je Zimmer im selben Aufruf und folgt der Housekeeping-Route', async () => {
    const vorher = await plan()
    // Ohne Eintrag gilt sauber -- wie auf dem Housekeeping-Bildschirm.
    expect(vorher.units.map(u => u.housekeeping)).toEqual(['clean', 'clean', 'clean', 'clean'])

    const r = await app.inject({
      method: 'PUT', url: '/v1/housekeeping/status', headers: rezeption,
      payload: { propertyId: fx.propertyId, resourceIds: [rooms[0]!, rooms[2]!],
                 status: 'dirty' } })
    expect(r.statusCode).toBe(200)
    await app.inject({
      method: 'PUT', url: '/v1/housekeeping/status', headers: rezeption,
      payload: { propertyId: fx.propertyId, resourceIds: [rooms[1]!], status: 'inspected' } })

    const nachher = await plan()
    const stand = new Map(nachher.units.map(u => [u.id, u.housekeeping]))
    expect(stand.get(rooms[0]!)).toBe('dirty')
    expect(stand.get(rooms[1]!)).toBe('inspected')
    expect(stand.get(rooms[2]!)).toBe('dirty')
    expect(stand.get(rooms[3]!)).toBe('clean')
  })

  it('setzt mehrere Zimmer ganz oder gar nicht', async () => {
    // Ein fremdes Zimmer in der Liste: die Route weist alles ab, und keines
    // der eigenen ist danach umgestellt. Darauf verlaesst sich das
    // Kontextmenue bei einer Mehrfachmarkierung.
    const fremd = await makeProperty(owner, { code: 'FREMD' })
    const fremdKat = await makeCategory(owner, fremd.propertyId)
    const [fremdesZimmer] = await makeResources(owner, fremd.propertyId, fremdKat, 1)
    const r = await app.inject({
      method: 'PUT', url: '/v1/housekeeping/status', headers: rezeption,
      payload: { propertyId: fx.propertyId, resourceIds: [rooms[0]!, fremdesZimmer!],
                 status: 'dirty' } })
    expect(r.statusCode).toBe(404)
    const p = await plan()
    expect(p.units.find(u => u.id === rooms[0]!)?.housekeeping).toBe('clean')
  })
})

describe('Anweisungen je Aufruf', () => {
  /**
   * Die Zahl der Anweisungen haengt nicht an der Zahl der Reservierungen.
   * Ein Zahlungsstand je Balken nachgeladen waere das N+1, vor dem das
   * Aggregat schuetzt -- und im Test mit einer Reservierung saehe es
   * genauso schnell aus.
   */
  it('bleibt bei mehr Reservierungen, Buchungen und Zahlungen konstant', async () => {
    const einmal = await aufenthalt()
    await zahlen(einmal.folioRef, PREIS)
    const wenige = await countQueries(pool, () => plan())

    for (let i = 1; i < 4; i++) {
      const a = await aufenthalt({ resourceId: rooms[i]!, arrival: '2026-10-10',
                                   departure: '2026-10-14' })
      await nachtBuchen(a.reservationId, a.folioId, '2026-10-10')
      await zahlen(a.folioRef, 2_500)
      await minibar(a.folioRef)
    }
    const viele = await countQueries(pool, () => plan())

    expect(viele.result.reservations).toHaveLength(4)
    // Gezaehlt wurde wirklich: 0 = 0 waere auch gleich. Die Anmeldung, die
    // drei Teile des Plans und der Zahlungsstand.
    expect(wenige.report.count).toBeGreaterThanOrEqual(4)
    expect(viele.report.count).toBe(wenige.report.count)
  })
})
