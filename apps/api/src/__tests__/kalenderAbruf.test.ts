import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Preiskalender aus dem Channel Manager abrufen (Migration 0179).
 *
 * Geprueft wird der Weg ueber drei Haende: StayGrid fragt per Ereignis,
 * das Umsystem liefert an den Auftrag, ein Mensch uebernimmt nach der
 * Vorschau. Dazu, was nicht geschehen darf: eine Lieferung schreibt keinen
 * Preis, ein nicht gelieferter Wert bleibt stehen, eine neuere Lieferung
 * wird nicht ungesehen uebernommen.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let katId: number
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const VON = '2027-05-01'
const BIS = '2027-05-10'

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
  limiters.reset()
  fx = await makeProperty(owner)
  katId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [admin.userId, fx.accountId])
})

async function maschine(scopes: string[]): Promise<Record<string, string>> {
  const z = await app.inject({
    method: 'POST', url: '/v1/oauth-clients', headers: auth(admin.sessionId),
    payload: { name: 'Adminpanel', scopes, propertyIds: [fx.propertyId] } })
  expect(z.statusCode, z.body).toBe(201)
  const { clientId, clientSecret } = z.json<{ clientId: string; clientSecret: string }>()
  const t = await app.inject({
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'client_credentials',
                                   client_id: clientId, client_secret: clientSecret })
      .toString() })
  expect(t.statusCode, t.body).toBe(200)
  return { authorization: `Bearer ${t.json<{ access_token: string }>().access_token}` }
}

async function ratenplan(code: string, extra: Record<string, unknown> = {}): Promise<number> {
  const r = await app.inject({
    method: 'POST', url: `/v1/properties/${fx.propertyId}/rate-plans`,
    headers: auth(admin.sessionId), payload: { code, name: code, categoryId: katId, ...extra } })
  expect(r.statusCode, r.body).toBe(201)
  return r.json<{ ratePlanId: number }>().ratePlanId
}

async function abonnieren(): Promise<void> {
  await owner.query(
    `INSERT INTO webhook_subscription (account_id, url, signing_secret, event_types)
     VALUES ($1, 'https://adminpanel.example.de/webhooks/staygrid', 'geheim',
             ARRAY['rate.calendar_pull_requested'])`, [fx.accountId])
}

const anfordern = (from = VON, to = BIS) =>
  app.inject({ method: 'POST', url: `/v1/properties/${fx.propertyId}/rate-calendar-pulls`,
               headers: auth(admin.sessionId), payload: { from, to } })

const liefern = (headers: Record<string, string>, ref: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/v1/rate-calendar-pulls/${ref}`, headers, payload })

const stand = async () => {
  const r = await app.inject({
    method: 'GET', url: `/v1/properties/${fx.propertyId}/rate-calendar-pulls/current`,
    headers: auth(admin.sessionId) })
  expect(r.statusCode, r.body).toBe(200)
  return r.json<{
    pull: { pullRef: string; status: string; version: number; message: string | null
            delivery: Array<{ ratePlanCode: string; result: string; days: number }>
            result: { prices: number; restrictions: number } | null } | null
    preview: { priceChanges: number; restrictionChanges: number
               changes: Array<{ ratePlanCode: string; date: string
                                oldPriceCent: number[] | null; newPriceCent: number[] | null
                                restrictionChanged: boolean }> } | null }>()
}

const uebernehmen = (ref: string, version: number) =>
  app.inject({ method: 'POST',
               url: `/v1/properties/${fx.propertyId}/rate-calendar-pulls/${ref}/apply`,
               headers: auth(admin.sessionId), payload: { version } })

async function preis(plan: number, date: string): Promise<number[] | null> {
  const r = await owner.query<{ price_cent: string[] }>(
    `SELECT price_cent FROM rate_day WHERE rate_plan_id = $1 AND date = $2::date`, [plan, date])
  return r.rows[0]?.price_cent.map(Number) ?? null
}

async function restriktion(plan: number, date: string) {
  const r = await owner.query<{ min_los: number | null; closed: boolean
                                closed_to_arrival: boolean }>(
    `SELECT min_los, closed, closed_to_arrival FROM restriction_day
      WHERE rate_plan_id = $1 AND date = $2::date`, [plan, date])
  return r.rows[0] ?? null
}

describe('Abruf anfordern', () => {
  it('weist ab, wenn kein Umsystem das Ereignis entgegennimmt', async () => {
    const r = await anfordern()
    expect(r.statusCode, r.body).toBe(409)
    expect(r.json<{ code: string }>().code).toBe('rateCalendar.noReceiver')
    const n = await owner.query(`SELECT 1 FROM rate_calendar_pull`)
    expect(n.rowCount).toBe(0)
  })

  it('reiht das Ereignis mit Auftrag und Zeitraum ein, ohne Preise', async () => {
    await abonnieren()
    const r = await anfordern()
    expect(r.statusCode, r.body).toBe(201)
    const pull = r.json<{ pullRef: string; status: string }>()
    expect(pull.status).toBe('requested')
    const e = await owner.query<{ event_type: string; data: Record<string, unknown> }>(
      `SELECT event_type, payload -> 'data' AS data FROM webhook_delivery`)
    expect(e.rows).toEqual([{ event_type: 'rate.calendar_pull_requested',
      data: { pullRef: pull.pullRef, propertyId: fx.propertyId, from: VON, to: BIS } }])
  })

  it('begrenzt den Zeitraum auf 400 Tage', async () => {
    await abonnieren()
    const r = await anfordern('2027-01-01', '2028-02-05')
    expect(r.statusCode).toBe(422)
  })
})

describe('Lieferung, Vorschau, Uebernahme', () => {
  it('uebernimmt erst nach der Vorschau, und nur was geliefert wurde', async () => {
    await abonnieren()
    const std = await ratenplan('DZ-STD')
    const nonref = await ratenplan('DZ-NR',
      { baseRatePlanId: std, deriveKind: 'percent', deriveValue: -10 })
    // Was vorher steht: ein Preis und eine Anreisesperre, die RoomCloud
    // nicht kennt und deshalb nicht liefert.
    await app.inject({ method: 'PUT', url: '/v1/rates/bulk', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: std, from: VON, to: BIS,
                 priceCent: [8000, 9000] } })
    await app.inject({ method: 'PUT', url: '/v1/restrictions/bulk',
      headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: std, from: VON, to: VON,
                 closedToArrival: true } })

    const ref = (await anfordern()).json<{ pullRef: string }>().pullRef
    const m = await maschine(['rate:channel_sync', 'rate:read'])
    const l = await liefern(m, ref, { status: 'delivered', plans: [
      { ratePlanCode: 'DZ-STD', days: [
        { date: VON, priceCent: [9900], minLos: 2, closed: false },
        { date: '2027-05-02', priceCent: [8000, 9000] },
        { date: '2027-05-03', closed: true }] },
      { ratePlanCode: 'DZ-NR', days: [{ date: VON, priceCent: [1] }] },
      { ratePlanCode: 'GIBTS-NICHT', days: [{ date: VON, priceCent: [1] }] }] })
    expect(l.statusCode, l.body).toBe(200)
    expect(l.json<{ delivery: unknown }>().delivery).toEqual([
      { ratePlanCode: 'DZ-STD', result: 'accepted', days: 3 },
      { ratePlanCode: 'DZ-NR', result: 'derived', days: 1 },
      { ratePlanCode: 'GIBTS-NICHT', result: 'unknown_code', days: 1 }])

    // Die Lieferung allein schreibt nichts.
    expect(await preis(std, VON)).toEqual([8000, 9000])

    const s = await stand()
    expect(s.pull?.status).toBe('delivered')
    expect(s.preview).toMatchObject({ priceChanges: 1, restrictionChanges: 2 })
    expect(s.preview?.changes).toEqual([
      { ratePlanCode: 'DZ-STD', date: VON, oldPriceCent: [8000, 9000], newPriceCent: [9900],
        restrictionChanged: true },
      { ratePlanCode: 'DZ-STD', date: '2027-05-03', oldPriceCent: [8000, 9000],
        newPriceCent: null, restrictionChanged: true }])

    // Eine Uebernahme mit einer anderen Lieferung als der gesehenen nicht.
    expect((await uebernehmen(ref, s.pull!.version + 1)).statusCode).toBe(409)

    const u = await uebernehmen(ref, s.pull!.version)
    expect(u.statusCode, u.body).toBe(200)
    expect(u.json()).toMatchObject({ status: 'applied',
                                     result: { prices: 1, restrictions: 2 } })
    expect(await preis(std, VON)).toEqual([9900])
    // Die abgeleitete Rate folgt ihrer Basis, nicht der Lieferung.
    expect(await preis(nonref, VON)).toEqual([8910])
    // Geliefert: Mindestaufenthalt. Nicht geliefert: die Anreisesperre bleibt.
    expect(await restriktion(std, VON)).toEqual(
      { min_los: 2, closed: false, closed_to_arrival: true })
    expect(await restriktion(std, '2027-05-03')).toMatchObject({ closed: true })

    const ev = await owner.query<{ origin: string }>(
      `SELECT payload -> 'data' ->> 'origin' AS origin FROM webhook_delivery
        WHERE event_type = 'rate.changed'`)
    // Das Abonnement nimmt nur den Abruf; `rate.changed` ginge an andere.
    expect(ev.rowCount).toBe(0)

    expect((await uebernehmen(ref, s.pull!.version)).statusCode).toBe(409)
    const spaet = await liefern(m, ref, { status: 'delivered', plans: [
      { ratePlanCode: 'DZ-STD', days: [{ date: VON, priceCent: [1] }] }] })
    expect(spaet.statusCode).toBe(409)
  })

  it('zeigt einen gemeldeten Fehler am Auftrag', async () => {
    await abonnieren()
    const ref = (await anfordern()).json<{ pullRef: string }>().pullRef
    const m = await maschine(['rate:channel_sync'])
    const l = await liefern(m, ref, { status: 'failed', message: 'RoomCloud antwortet nicht' })
    expect(l.statusCode, l.body).toBe(200)
    const s = await stand()
    expect(s.pull).toMatchObject({ status: 'failed', message: 'RoomCloud antwortet nicht' })
    expect(s.preview).toBeNull()
  })

  it('weist Tage ausserhalb des Auftrags und doppelte Tage ab', async () => {
    await abonnieren()
    await ratenplan('DZ-STD')
    const ref = (await anfordern()).json<{ pullRef: string }>().pullRef
    const m = await maschine(['rate:channel_sync'])
    const aussen = await liefern(m, ref, { status: 'delivered', plans: [
      { ratePlanCode: 'DZ-STD', days: [{ date: '2027-06-01', priceCent: [9900] }] }] })
    expect(aussen.statusCode).toBe(422)
    const doppelt = await liefern(m, ref, { status: 'delivered', plans: [
      { ratePlanCode: 'DZ-STD', days: [{ date: VON, priceCent: [9900] },
                                        { date: VON, priceCent: [9800] }] }] })
    expect(doppelt.statusCode).toBe(422)
    const kommastelle = await liefern(m, ref, { status: 'delivered', plans: [
      { ratePlanCode: 'DZ-STD', days: [{ date: VON, priceCent: [99.5] }] }] })
    expect(kommastelle.statusCode).toBe(422)
  })

  it('nimmt eine Lieferung nur mit dem eigenen Recht an', async () => {
    await abonnieren()
    const ref = (await anfordern()).json<{ pullRef: string }>().pullRef
    const nurLesen = await maschine(['rate:read', 'rate:write'])
    const l = await liefern(nurLesen, ref, { status: 'failed' })
    expect(l.statusCode).toBe(403)
  })

  it('ersetzt einen offenen Abruf durch einen neuen', async () => {
    await abonnieren()
    await ratenplan('DZ-STD')
    const alt = (await anfordern()).json<{ pullRef: string }>().pullRef
    const neu = (await anfordern()).json<{ pullRef: string }>().pullRef
    const m = await maschine(['rate:channel_sync'])
    const l = await liefern(m, alt, { status: 'delivered', plans: [
      { ratePlanCode: 'DZ-STD', days: [{ date: VON, priceCent: [9900] }] }] })
    expect(l.statusCode).toBe(409)
    expect((await stand()).pull?.pullRef).toBe(neu)
  })
})
