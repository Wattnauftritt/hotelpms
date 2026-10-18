import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { addDays } from '@hotelpms/domain'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Preise an den Channel Manager senden, nur auf Knopfdruck (Migration 0179).
 *
 * Geprueft wird, was hinausgeht und was nicht: "nur Aenderungen" braucht
 * ein vorheriges Senden und nimmt nur, was seit dessen Abholen geschrieben
 * wurde; "gesendet" setzt voraus, dass das Umsystem die Werte abgeholt hat;
 * ein Uebungshaus sendet nie.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let katId: number
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
// Senden reicht ab dem heutigen Tag des Hauses; feste Daten liefen irgendwann ab.
const HEUTE = new Date().toISOString().slice(0, 10)
const VON = addDays(HEUTE, 10)
const BIS = addDays(HEUTE, 14)

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
             ARRAY['rate.calendar_push_requested'])`, [fx.accountId])
}

const senden = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/v1/properties/${fx.propertyId}/rate-calendar-pushes`,
               headers: auth(admin.sessionId), payload })

const stand = async () => {
  const r = await app.inject({
    method: 'GET', url: `/v1/properties/${fx.propertyId}/rate-calendar-pushes/current`,
    headers: auth(admin.sessionId) })
  expect(r.statusCode, r.body).toBe(200)
  return r.json<{ push: { pushRef: string; status: string; days: number | null } | null
                  lastSentAt: string | null; pendingChanges: number | null }>()
}

interface Werte {
  plans: Array<{ ratePlanCode: string; categoryCode: string
                 days: Array<{ date: string; priceCent: number[] | null; minLos: number | null }> }>
}

const abholen = (headers: Record<string, string>, ref: string) =>
  app.inject({ method: 'GET', url: `/v1/rate-calendar-pushes/${ref}`, headers })

const melden = (headers: Record<string, string>, ref: string, status: string) =>
  app.inject({ method: 'PUT', url: `/v1/rate-calendar-pushes/${ref}`, headers,
               payload: { status } })

const preisSetzen = (plan: number, from: string, to: string, priceCent: number[]) =>
  app.inject({ method: 'PUT', url: '/v1/rates/bulk', headers: auth(admin.sessionId),
    payload: { propertyId: fx.propertyId, ratePlanId: plan, from, to, priceCent } })

/** Einmal ganz senden, abholen, zurueckmelden: die Grundlage fuer "nur Aenderungen". */
async function ganzGesendet(m: Record<string, string>): Promise<void> {
  const ref = (await senden({ mode: 'all' })).json<{ pushRef: string }>().pushRef
  expect((await abholen(m, ref)).statusCode).toBe(200)
  expect((await melden(m, ref, 'done')).statusCode).toBe(200)
}

describe('Senden an den Channel Manager', () => {
  it('geht ohne Abonnenten nicht und sagt, welches Ereignis fehlt', async () => {
    const r = await senden({ mode: 'all' })
    expect(r.statusCode).toBe(409)
    expect(r.json<{ code: string }>().code).toBe('rateCalendar.noReceiver')
    expect(r.body).toContain('rate.calendar_push_requested')
  })

  it('weist ein Uebungshaus ab', async () => {
    await abonnieren()
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])
    const r = await senden({ mode: 'all' })
    expect(r.statusCode).toBe(422)
    expect(r.json<{ code: string }>().code).toBe('training.noChannel')
  })

  it('sendet den gewaehlten Zeitraum je Plancode mit Preis und Restriktion', async () => {
    await abonnieren()
    const m = await maschine(['rate:channel_sync'])
    const std = await ratenplan('DZ-STD')
    await preisSetzen(std, VON, BIS, [8000, 9000])

    const r = await senden({ mode: 'range', from: VON, to: BIS })
    expect(r.statusCode, r.body).toBe(201)
    const ref = r.json<{ pushRef: string }>().pushRef

    const w = await abholen(m, ref)
    expect(w.statusCode, w.body).toBe(200)
    const plan = w.json<Werte>().plans.find(p => p.ratePlanCode === 'DZ-STD')!
    expect(plan.categoryCode).toBe('DZ')
    expect(plan.days).toHaveLength(5)
    expect(plan.days[0]).toMatchObject({ date: VON, priceCent: [8000, 9000] })

    expect((await melden(m, ref, 'done')).statusCode).toBe(200)
    const s = await stand()
    expect(s.push).toMatchObject({ status: 'done', days: 5 })
    expect(s.lastSentAt).not.toBeNull()
  })

  it('"nur Aenderungen" braucht ein vorheriges Senden', async () => {
    await abonnieren()
    await ratenplan('DZ-STD')
    expect((await stand()).pendingChanges).toBeNull()
    const r = await senden({ mode: 'changes' })
    expect(r.statusCode).toBe(409)
    expect(r.json<{ code: string }>().code).toBe('rateCalendar.noBaseline')
  })

  it('"nur Aenderungen" nimmt nur, was seit dem letzten Abholen geschrieben wurde', async () => {
    await abonnieren()
    const m = await maschine(['rate:channel_sync'])
    const std = await ratenplan('DZ-STD')
    await preisSetzen(std, VON, BIS, [8000, 9000])
    await ganzGesendet(m)
    expect((await stand()).pendingChanges).toBe(0)

    await preisSetzen(std, VON, addDays(VON, 1), [8500, 9500])
    expect((await stand()).pendingChanges).toBe(2)

    const ref = (await senden({ mode: 'changes' })).json<{ pushRef: string }>().pushRef
    const tage = (await abholen(m, ref)).json<Werte>().plans.flatMap(p => p.days)
    expect(tage.map(d => d.date)).toEqual([VON, addDays(VON, 1)])
    expect(tage[0]!.priceCent).toEqual([8500, 9500])
  })

  it('"gesendet" ohne Abholen wird abgewiesen, "gescheitert" nicht', async () => {
    await abonnieren()
    const m = await maschine(['rate:channel_sync'])
    await ratenplan('DZ-STD')
    const ref = (await senden({ mode: 'all' })).json<{ pushRef: string }>().pushRef
    const r = await melden(m, ref, 'done')
    expect(r.statusCode).toBe(409)
    expect(r.json<{ code: string }>().code).toBe('rateCalendar.notServed')
    expect((await melden(m, ref, 'failed')).statusCode).toBe(200)
    // Ein gescheitertes Senden ist keine Grundlage fuer "nur Aenderungen".
    expect((await stand()).lastSentAt).toBeNull()
  })

  it('ein neuer Knopfdruck loest den offenen Auftrag ab', async () => {
    await abonnieren()
    const m = await maschine(['rate:channel_sync'])
    await ratenplan('DZ-STD')
    const alt = (await senden({ mode: 'all' })).json<{ pushRef: string }>().pushRef
    await senden({ mode: 'range', from: VON, to: BIS })
    const r = await abholen(m, alt)
    expect(r.statusCode).toBe(409)
    expect(r.json<{ code: string }>().code).toBe('rateCalendar.closed')
  })

  it('eine Sitzung kann die Werte nicht abholen; das Recht hat nur die Maschine', async () => {
    await abonnieren()
    await ratenplan('DZ-STD')
    const ref = (await senden({ mode: 'all' })).json<{ pushRef: string }>().pushRef
    expect((await abholen(auth(admin.sessionId), ref)).statusCode).toBe(403)
  })
})
