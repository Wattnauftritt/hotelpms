import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, openBusinessDay, type Fixture } from '@hotelpms/testing'
import { withTransaction, type DbContext, type Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { emitEvent } from '../platform/events.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let ctx: DbContext
let catId: number
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, never>
const EMPFAENGER = 'https://portal.example.de/hotelpms'

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

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
  catId = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, catId, 5)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, '2026-10-01')
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [admin.userId, fx.accountId])
})

async function anlegen(body: Record<string, unknown> = {}): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: '/v1/webhook-subscriptions', headers: auth(admin.sessionId),
    payload: { url: EMPFAENGER, ...body } })
  expect(r.statusCode).toBe(201)
  return (json(r) as unknown as { subscriptionRef: string }).subscriptionRef
}

async function buchen(arrival = '2026-10-10', departure = '2026-10-12'): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: '/v1/bookings',
    headers: { ...auth(admin.sessionId), 'idempotency-key': `k-${Math.random()}` },
    payload: { propertyId: fx.propertyId, categoryId: catId, arrival, departure } })
  expect(r.statusCode).toBe(201)
  return (json(r) as unknown as { reservationRef: string }).reservationRef
}

interface ZustellZeile { event_type: string; payload: { data: Record<string, unknown> } }

async function eingereiht(): Promise<ZustellZeile[]> {
  const r = await owner.query<ZustellZeile>(
    `SELECT event_type, payload FROM webhook_delivery
      WHERE property_id = $1 ORDER BY id`, [fx.propertyId])
  return r.rows
}

describe('Abonnements', () => {
  it('gibt den gemeinsamen Schluessel genau einmal heraus', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/webhook-subscriptions', headers: auth(admin.sessionId),
      payload: { url: EMPFAENGER } })
    expect(r.statusCode).toBe(201)
    const angelegt = json(r) as unknown as { subscriptionRef: string; signingSecret: string }
    expect(angelegt.signingSecret.length).toBeGreaterThan(30)

    const liste = await app.inject({
      method: 'GET', url: '/v1/webhook-subscriptions', headers: auth(admin.sessionId) })
    expect(liste.body).not.toContain(angelegt.signingSecret)
    const abos = (json(liste) as unknown as
      { subscriptions: Array<{ subscriptionRef: string; allEventTypes: boolean }> }).subscriptions
    expect(abos).toHaveLength(1)
    // Ohne Angabe gilt das Abonnement fuer alle Ereignisarten.
    expect(abos[0]!.allEventTypes).toBe(true)
  })

  it('besteht auf https und auf bekannten Ereignisarten', async () => {
    const unverschluesselt = await app.inject({
      method: 'POST', url: '/v1/webhook-subscriptions', headers: auth(admin.sessionId),
      payload: { url: 'http://portal.example.de/hook' } })
    expect(unverschluesselt.statusCode).toBe(422)

    const unbekannt = await app.inject({
      method: 'POST', url: '/v1/webhook-subscriptions', headers: auth(admin.sessionId),
      payload: { url: EMPFAENGER, eventTypes: ['reservation.erfunden'] } })
    expect(unbekannt.statusCode).toBe(422)
  })

  /*
   * Befund B1. Der Praefix https:// sagte nichts darueber, wohin das Ziel
   * zeigt, und der Worker steht neben Datenbank und API.
   */
  it('weist ein Ziel im inneren Netz ab, auch mit https davor', async () => {
    for (const url of [
      'https://127.0.0.1:6379/',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.0.0.5/hook',
      'https://[::1]/hook',
      'https://[::ffff:127.0.0.1]/hook'
    ]) {
      const r = await app.inject({
        method: 'POST', url: '/v1/webhook-subscriptions', headers: auth(admin.sessionId),
        payload: { url } })
      expect(r.statusCode, url).toBe(422)
      expect((r.json() as { errorKeys?: Record<string, string[]> })
        .errorKeys?.url).toContain('field.blockedTarget')
    }
  })

  it('weist Zugangsdaten im Ziel ab', async () => {
    // Der gemeinsame Schluessel ist der Weg; im URL stehen sie im Protokoll.
    const r = await app.inject({
      method: 'POST', url: '/v1/webhook-subscriptions', headers: auth(admin.sessionId),
      payload: { url: 'https://nutzer:geheim@portal.example.de/hook' } })
    expect(r.statusCode).toBe(422)
  })

  it('weist ein Haus ab, das dem Account nicht gehoert', async () => {
    const fremd = await makeProperty(owner, { code: 'FREMD' })
    const r = await app.inject({
      method: 'POST', url: '/v1/webhook-subscriptions', headers: auth(admin.sessionId),
      payload: { url: EMPFAENGER, propertyIds: [fremd.propertyId] } })
    expect(r.statusCode).toBe(404)
  })

  it('nimmt ein stillgelegtes Abonnement wieder in Betrieb', async () => {
    const ref = await anlegen()
    await owner.query(
      `UPDATE webhook_subscription SET status='disabled', disabled_at=now(),
              disabled_reason='Test' WHERE public_ref = $1`, [ref])
    // Stillgelegt reiht es nichts mehr ein.
    await buchen()
    expect(await eingereiht()).toHaveLength(0)

    const r = await app.inject({
      method: 'POST', url: `/v1/webhook-subscriptions/${ref}/enable`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)

    await buchen('2026-10-20', '2026-10-22')
    expect(await eingereiht()).toHaveLength(1)
  })

  it('sieht die Abonnements eines fremden Accounts nicht', async () => {
    const fremd = await makeProperty(owner, { code: 'ANDERS' })
    await owner.query(
      `INSERT INTO webhook_subscription (account_id, url, signing_secret)
       VALUES ($1,$2,'geheim')`, [fremd.accountId, 'https://fremd.example.de/hook'])

    const liste = await app.inject({
      method: 'GET', url: '/v1/webhook-subscriptions', headers: auth(admin.sessionId) })
    expect((json(liste) as unknown as { subscriptions: unknown[] }).subscriptions).toHaveLength(0)
  })
})

describe('Einreihen aus den Fachrouten', () => {
  it('reiht beim Anlegen einer Buchung ein Ereignis ein', async () => {
    await anlegen()
    const reservationRef = await buchen()

    const zeilen = await eingereiht()
    expect(zeilen).toHaveLength(1)
    expect(zeilen[0]!.event_type).toBe('reservation.created')
    expect(zeilen[0]!.payload.data).toMatchObject({
      reservationRef, status: 'Confirmed', arrival: '2026-10-10', departure: '2026-10-12' })
  })

  it('gibt jedem Schritt des Aufenthalts seine eigene Ereignisart', async () => {
    await anlegen()
    const ref = await buchen()
    const zimmer = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE property_id = $1 ORDER BY id LIMIT 1`, [fx.propertyId])

    const schritt = async (url: string, payload: Record<string, unknown> = {}) => {
      const r = await app.inject({
        method: 'POST', url, headers: auth(admin.sessionId),
        payload: { propertyId: fx.propertyId, ...payload } })
      expect(r.statusCode).toBe(200)
    }
    // Check-in setzt ein zugewiesenes Zimmer voraus.
    await schritt(`/v1/reservations/${ref}/assign-unit`, { resourceId: zimmer.rows[0]!.id })
    await schritt(`/v1/reservations/${ref}/check-in`)
    await schritt(`/v1/reservations/${ref}/check-out`)

    expect((await eingereiht()).map(z => z.event_type)).toEqual([
      'reservation.created', 'reservation.changed',
      'reservation.checked_in', 'reservation.checked_out'])
  })

  it('meldet den Storno als eigene Ereignisart', async () => {
    await anlegen()
    const ref = await buchen()
    const r = await app.inject({
      method: 'POST', url: `/v1/reservations/${ref}/cancel`, headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId } })
    expect(r.statusCode).toBe(200)

    const zeilen = await eingereiht()
    expect(zeilen.map(z => z.event_type))
      .toEqual(['reservation.created', 'reservation.canceled'])
    expect(zeilen[1]!.payload.data).toMatchObject({ reservationRef: ref, status: 'Canceled' })
  })

  it('meldet eine Verlaengerung mit dem Zeitraum davor', async () => {
    await anlegen({ eventTypes: ['reservation.changed'] })
    const ref = await buchen('2026-10-10', '2026-10-12')

    const r = await app.inject({
      method: 'POST', url: `/v1/reservations/${ref}/change-stay`, headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, departure: '2026-10-15' } })
    expect(r.statusCode).toBe(200)

    const zeilen = await eingereiht()
    expect(zeilen).toHaveLength(1)
    expect(zeilen[0]!.payload.data).toMatchObject({
      reservationRef: ref, departure: '2026-10-15', previousDeparture: '2026-10-12' })
  })

  it('reiht beim Festschreiben einer Rechnung ein Ereignis ein', async () => {
    await anlegen({ eventTypes: ['invoice.finalized'] })
    await buchen()
    const folio = await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM folio WHERE property_id = $1 ORDER BY id LIMIT 1`, [fx.propertyId])
    const folioRef = folio.rows[0]!.public_ref

    await app.inject({
      method: 'POST', url: `/v1/folios/${folioRef}/charges`,
      headers: { ...auth(admin.sessionId), 'idempotency-key': 'c1' },
      payload: { description: 'Uebernachtung', netCent: 10_000, taxRateBp: 700 } })
    const r = await app.inject({
      method: 'POST', url: `/v1/folios/${folioRef}/invoice`,
      headers: { ...auth(admin.sessionId), 'idempotency-key': 'i1' },
      payload: {} })
    expect(r.statusCode).toBe(201)

    const zeilen = await eingereiht()
    // Nur die abonnierte Art, die Buchung von vorhin ist nicht dabei.
    expect(zeilen).toHaveLength(1)
    expect(zeilen[0]!.event_type).toBe('invoice.finalized')
    expect(zeilen[0]!.payload.data).toMatchObject({
      number: (json(r) as unknown as { number: string }).number, folioRef, kind: 'final' })
  })

  /**
   * Der Kern der Zusage: die Zustellung entsteht in der Transaktion der
   * Fachbuchung. Faellt die Buchung, faellt das Ereignis mit ihr, und kein
   * Empfaenger erfaehrt von einer Reservierung, die es nie gab.
   */
  it('reiht nichts ein, wenn die Fachbuchung zurueckgerollt wird', async () => {
    await anlegen()

    await expect(withTransaction(pool, ctx, async client => {
      await client.query(
        `INSERT INTO booking (property_id, source) VALUES ($1,'direct')`, [fx.propertyId])
      await emitEvent(client, fx.propertyId, 'reservation.created',
        { reservationRef: 'WIRD-NIE-GEBEN' })
      throw new Error('Kontingent doch nicht frei')
    })).rejects.toThrow('Kontingent doch nicht frei')

    expect(await eingereiht()).toHaveLength(0)
    const buchungen = await owner.query(
      `SELECT 1 FROM booking WHERE property_id = $1`, [fx.propertyId])
    expect(buchungen.rowCount).toBe(0)
  })

  /**
   * Einreihen braucht die Property im Mandantenkontext. Wer nur eine
   * Account-Rolle hat, bekommt seine Haeuser erst ueber die Aufloesung des
   * Zugriffsbereichs (Migration 0018) -- genau die Stelle, an der schon
   * zweimal still etwas fehlte.
   */
  it('reiht auch fuer einen Nutzer mit reiner Account-Rolle ein', async () => {
    await anlegen()
    const nurAccount = await makeUser(owner,
      { email: 'inhaber@test.de', accountId: fx.accountId, roleKey: 'account_admin' })

    const r = await app.inject({
      method: 'POST', url: '/v1/bookings',
      headers: { ...auth(nurAccount.sessionId), 'idempotency-key': 'nur-account' },
      payload: { propertyId: fx.propertyId, categoryId: catId,
                 arrival: '2026-11-01', departure: '2026-11-03' } })
    expect(r.statusCode).toBe(201)

    expect((await eingereiht()).map(z => z.event_type)).toEqual(['reservation.created'])
  })

  it('reiht nichts fuer ein Abonnement eines fremden Accounts ein', async () => {
    const fremd = await makeProperty(owner, { code: 'ANDERS' })
    await owner.query(
      `INSERT INTO webhook_subscription (account_id, url, signing_secret)
       VALUES ($1,$2,'geheim')`, [fremd.accountId, 'https://fremd.example.de/hook'])

    await buchen()
    const alle = await owner.query(`SELECT 1 FROM webhook_delivery`)
    expect(alle.rowCount).toBe(0)
  })

  it('beschraenkt ein Abonnement auf die genannten Haeuser', async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name) VALUES ($1,'ZWEI','Zweites')
       RETURNING id`, [fx.accountId])
    await anlegen({ propertyIds: [zweites.rows[0]!.id] })

    await buchen()
    expect(await eingereiht()).toHaveLength(0)
  })
})

describe('Zustellprotokoll', () => {
  it('zeigt Zustellungen mit ihren Versuchen', async () => {
    const ref = await anlegen()
    await buchen()

    const d = await owner.query<{ id: number }>(
      `SELECT id FROM webhook_delivery WHERE property_id = $1`, [fx.propertyId])
    await owner.query(
      `UPDATE webhook_delivery SET attempts = 1, last_status_code = 500,
              last_error = 'HTTP 500' WHERE id = $1`, [d.rows[0]!.id])
    await owner.query(
      `INSERT INTO webhook_delivery_attempt
         (delivery_id, property_id, attempt, status_code, error, duration_ms)
       VALUES ($1,$2,1,500,'HTTP 500',42)`, [d.rows[0]!.id, fx.propertyId])

    const r = await app.inject({
      method: 'GET', url: `/v1/webhook-subscriptions/${ref}/deliveries`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    const zustellungen = (json(r) as unknown as {
      deliveries: Array<{ eventType: string; attempts: number
                          attemptLog: Array<{ attempt: number; statusCode: number }> }>
    }).deliveries
    expect(zustellungen).toHaveLength(1)
    expect(zustellungen[0]!.eventType).toBe('reservation.created')
    expect(zustellungen[0]!.attemptLog).toEqual([
      expect.objectContaining({ attempt: 1, statusCode: 500 })])
  })
})
