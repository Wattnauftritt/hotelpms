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
 * ein vorheriges Senden und nimmt nur, was vom gesendeten Stand abweicht
 * (Migration 0180) -- ein zurueckgenommener Preis ist keine Aenderung;
 * "gesendet" setzt voraus, dass das Umsystem die Werte abgeholt hat;
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

const raster = async () => {
  const r = await app.inject({
    method: 'GET', url: `/v1/properties/${fx.propertyId}/rate-grid?from=${VON}&to=${BIS}`,
    headers: auth(admin.sessionId) })
  expect(r.statusCode, r.body).toBe(200)
  return r.json<{ cells: Array<{ date: string; priceUnsent: boolean
                                 restrictionUnsent: boolean }> }>().cells
}

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

  it('"nur Aenderungen" nimmt nur, was vom gesendeten Stand abweicht', async () => {
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

  it('ein zurueckgenommener Preis ist keine Aenderung, im Raster nicht und beim Senden nicht',
    async () => {
      await abonnieren()
      const m = await maschine(['rate:channel_sync'])
      const std = await ratenplan('DZ-STD')
      await preisSetzen(std, VON, BIS, [8000, 9000])
      await ganzGesendet(m)

      await preisSetzen(std, VON, VON, [8500, 9500])
      expect((await stand()).pendingChanges).toBe(1)
      let z = (await raster()).find(c => c.date === VON)!
      expect(z.priceUnsent).toBe(true)
      expect(z.restrictionUnsent).toBe(false)

      await preisSetzen(std, VON, VON, [8000, 9000])
      expect((await stand()).pendingChanges).toBe(0)
      z = (await raster()).find(c => c.date === VON)!
      expect(z.priceUnsent).toBe(false)
    })

  it('markiert einen geaenderten Mindestaufenthalt getrennt vom Preis', async () => {
    await abonnieren()
    const m = await maschine(['rate:channel_sync'])
    const std = await ratenplan('DZ-STD')
    await preisSetzen(std, VON, BIS, [8000, 9000])
    await ganzGesendet(m)
    const r = await app.inject({
      method: 'PUT', url: '/v1/restrictions/bulk', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: std, from: VON, to: VON, minLos: 3 } })
    expect(r.statusCode, r.body).toBe(200)
    const z = (await raster()).find(c => c.date === VON)!
    expect(z.restrictionUnsent).toBe(true)
    expect(z.priceUnsent).toBe(false)
  })

  it('gesendet ist, was abgeholt wurde; was danach getippt wurde, bleibt offen', async () => {
    await abonnieren()
    const m = await maschine(['rate:channel_sync'])
    const std = await ratenplan('DZ-STD')
    await preisSetzen(std, VON, BIS, [8000, 9000])
    await ganzGesendet(m)

    await preisSetzen(std, VON, VON, [8500, 9500])
    const ref = (await senden({ mode: 'changes' })).json<{ pushRef: string }>().pushRef
    expect((await abholen(m, ref)).statusCode).toBe(200)
    await preisSetzen(std, addDays(VON, 1), addDays(VON, 1), [7000, 7500])
    expect((await melden(m, ref, 'done')).statusCode).toBe(200)

    expect((await stand()).pendingChanges).toBe(1)
    const offen = (await raster()).filter(c => c.priceUnsent).map(c => c.date)
    expect(offen).toEqual([addDays(VON, 1)])
  })

  it('ein gescheitertes Senden aendert den gesendeten Stand nicht', async () => {
    await abonnieren()
    const m = await maschine(['rate:channel_sync'])
    const std = await ratenplan('DZ-STD')
    await preisSetzen(std, VON, BIS, [8000, 9000])
    await ganzGesendet(m)

    await preisSetzen(std, VON, addDays(VON, 1), [8500, 9500])
    const ref = (await senden({ mode: 'changes' })).json<{ pushRef: string }>().pushRef
    expect((await abholen(m, ref)).statusCode).toBe(200)
    expect((await melden(m, ref, 'failed')).statusCode).toBe(200)
    expect((await stand()).pendingChanges).toBe(2)
  })

  it('markiert nichts, solange noch nie gesendet wurde', async () => {
    const std = await ratenplan('DZ-STD')
    await preisSetzen(std, VON, BIS, [8000, 9000])
    expect((await raster()).some(c => c.priceUnsent || c.restrictionUnsent)).toBe(false)
  })

  it('ein nie gesendeter Tag ohne Wert ist keine Aenderung, einer mit Preis schon', async () => {
    // So entstanden die "21 Aenderungen" vom 22.10.2026: das Fenster rueckt
    // jeden Tag einen leeren Tag je Plan nach.
    await abonnieren()
    const m = await maschine(['rate:channel_sync'])
    const std = await ratenplan('DZ-STD')
    await preisSetzen(std, VON, BIS, [8000, 9000])
    const ref = (await senden({ mode: 'range', from: VON, to: BIS }))
      .json<{ pushRef: string }>().pushRef
    expect((await abholen(m, ref)).statusCode).toBe(200)
    expect((await melden(m, ref, 'done')).statusCode).toBe(200)
    expect((await stand()).pendingChanges).toBe(0)

    await preisSetzen(std, addDays(BIS, 3), addDays(BIS, 3), [7000, 7500])
    expect((await stand()).pendingChanges).toBe(1)
  })

  it('nennt die offenen Tage mit Plan und Datum', async () => {
    await abonnieren()
    const m = await maschine(['rate:channel_sync'])
    const std = await ratenplan('DZ-STD')
    await preisSetzen(std, VON, BIS, [8000, 9000])
    await ganzGesendet(m)
    await preisSetzen(std, VON, VON, [8500, 9500])
    await app.inject({
      method: 'PUT', url: '/v1/restrictions/bulk', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: std, from: addDays(VON, 1),
                 to: addDays(VON, 1), minLos: 3 } })

    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/rate-calendar-pushes/pending`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode, r.body).toBe(200)
    const body = r.json<{ total: number; days: Array<Record<string, unknown>> }>()
    expect(body.total).toBe(2)
    expect(body.days).toEqual([
      expect.objectContaining({ ratePlanCode: 'DZ-STD', date: VON, price: true,
                                restriction: false, neverSent: false,
                                priceCent: [8500, 9500], sentPriceCent: [8000, 9000] }),
      expect.objectContaining({ date: addDays(VON, 1), price: false, restriction: true })
    ])
  })

  it('verwerfen setzt auf den gesendeten Stand zurueck und sendet nichts', async () => {
    await abonnieren()
    const m = await maschine(['rate:channel_sync'])
    const std = await ratenplan('DZ-STD')
    await preisSetzen(std, VON, BIS, [8000, 9000])
    const ref = (await senden({ mode: 'range', from: VON, to: BIS }))
      .json<{ pushRef: string }>().pushRef
    expect((await abholen(m, ref)).statusCode).toBe(200)
    expect((await melden(m, ref, 'done')).statusCode).toBe(200)

    await preisSetzen(std, VON, addDays(VON, 1), [8500, 9500])
    await app.inject({
      method: 'PUT', url: '/v1/restrictions/bulk', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: std, from: VON, to: VON,
                 minLos: 3, closed: true } })
    // Nie gesendet: bleibt stehen, StayGrid weiss nicht, was drueben steht.
    await preisSetzen(std, addDays(BIS, 3), addDays(BIS, 3), [7000, 7500])
    expect((await stand()).pendingChanges).toBe(3)
    const vorher = await owner.query(`SELECT count(*)::int AS n FROM rate_calendar_push`)

    const r = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/rate-calendar-pushes/discard`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toEqual({ prices: 2, restrictions: 1, remaining: 1 })

    const preise = await owner.query<{ date: string; price_cent: string[] }>(
      `SELECT date::text, price_cent FROM rate_day WHERE rate_plan_id = $1
        ORDER BY date`, [std])
    expect(preise.rows.find(z => z.date === VON)!.price_cent.map(Number)).toEqual([8000, 9000])
    expect(preise.rows.find(z => z.date === addDays(BIS, 3))!.price_cent.map(Number))
      .toEqual([7000, 7500])
    const sperre = await owner.query<{ min_los: number | null; closed: boolean }>(
      `SELECT min_los, closed FROM restriction_day WHERE rate_plan_id = $1 AND date = $2`,
      [std, VON])
    expect(sperre.rows[0]).toEqual({ min_los: null, closed: false })
    expect((await stand()).pendingChanges).toBe(1)

    const nachher = await owner.query(`SELECT count(*)::int AS n FROM rate_calendar_push`)
    expect(nachher.rows[0]).toEqual(vorher.rows[0])
  })

  it('verwerfen braucht Schreibrecht', async () => {
    const leser = await makeUser(owner,
      { email: 'leser@test.de', propertyId: fx.propertyId, roleKey: 'housekeeping',
        accountId: fx.accountId })
    const r = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/rate-calendar-pushes/discard`,
      headers: auth(leser.sessionId) })
    expect(r.statusCode).toBe(403)
  })
})

describe('Gegenpruefung vor dem Senden (Migration 0218)', () => {
  const pruefen = (headers: Record<string, string>, ref: string, conflicts: unknown[]) =>
    app.inject({ method: 'PUT', url: `/v1/rate-calendar-pushes/${ref}`, headers,
                 payload: { status: 'checked', conflicts } })

  const entscheiden = (ref: string, decisions: unknown[]) =>
    app.inject({ method: 'POST',
                 url: `/v1/properties/${fx.propertyId}/rate-calendar-pushes/${ref}/resolve`,
                 headers: auth(admin.sessionId), payload: { decisions } })

  async function preis(plan: number, date: string): Promise<number[] | null> {
    const r = await owner.query<{ price_cent: string[] }>(
      `SELECT price_cent FROM rate_day WHERE rate_plan_id = $1 AND date = $2::date`, [plan, date])
    return r.rows[0]?.price_cent.map(Number) ?? null
  }

  /** Gesendet mit 80/90, danach hier zwei Tage auf 85/95 geaendert. */
  async function aufbauen() {
    await abonnieren()
    const m = await maschine(['rate:channel_sync'])
    const std = await ratenplan('DZ-STD')
    await preisSetzen(std, VON, BIS, [8000, 9000])
    await ganzGesendet(m)
    await preisSetzen(std, VON, addDays(VON, 1), [8500, 9500])
    const ref = (await senden({ mode: 'changes' })).json<{ pushRef: string }>().pushRef
    return { m, std, ref }
  }

  it('gibt zu jedem Tag den zuletzt abgeglichenen Stand mit', async () => {
    const { m, ref } = await aufbauen()
    const tage = (await abholen(m, ref)).json<{ plans: Array<{ days: Array<{
      sent: { priceCent: number[] } | null }> }> }>().plans.flatMap(p => p.days)
    expect(tage[0]!.sent).toMatchObject({ priceCent: [8000, 9000], closed: false })
  })

  it('ohne Abweichung geht das Senden weiter wie bisher', async () => {
    const { m, ref } = await aufbauen()
    await abholen(m, ref)
    const r = await pruefen(m, ref, [])
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json<{ proceed: boolean; status: string }>()).toMatchObject(
      { proceed: true, status: 'requested' })
    expect((await melden(m, ref, 'done')).statusCode).toBe(200)
  })

  it('haelt bei Abweichung an, sendet nichts und zeigt drei Staende je Tag', async () => {
    const { m, ref } = await aufbauen()
    expect((await pruefen(m, ref, [])).statusCode).toBe(409) // erst abholen
    await abholen(m, ref)
    const r = await pruefen(m, ref, [{ ratePlanCode: 'DZ-STD', date: VON, priceCent: [8800] }])
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json<{ proceed: boolean }>().proceed).toBe(false)
    // Danach wird nicht mehr gesendet.
    expect((await melden(m, ref, 'done')).statusCode).toBe(409)

    const s = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/rate-calendar-pushes/current`,
      headers: auth(admin.sessionId) })
    const push = s.json<{ push: { status: string; conflicts: unknown[] } }>().push
    expect(push.status).toBe('conflict')
    expect(push.conflicts).toEqual([expect.objectContaining({
      ratePlanCode: 'DZ-STD', date: VON,
      sent: expect.objectContaining({ priceCent: [8000, 9000] }),
      local: expect.objectContaining({ priceCent: [8500, 9500] }),
      channel: { priceCent: [8800] } })])
    // Gesendeter Stand unveraendert: beide Tage bleiben offen.
    expect((await stand()).pendingChanges).toBe(2)
  })

  it('weist Abweichungen an Tagen ab, die nicht hinausgehen sollten', async () => {
    const { m, ref } = await aufbauen()
    await abholen(m, ref)
    const r = await pruefen(m, ref, [{ ratePlanCode: 'DZ-STD', date: BIS, priceCent: [1] }])
    expect(r.statusCode).toBe(422)
  })

  it('"uebernehmen" schreibt den Wert von drueben, "meinen" sendet den eigenen', async () => {
    const { m, std, ref } = await aufbauen()
    await abholen(m, ref)
    const zweiter = addDays(VON, 1)
    await pruefen(m, ref, [
      { ratePlanCode: 'DZ-STD', date: VON, priceCent: [8800], minLos: 3 },
      { ratePlanCode: 'DZ-STD', date: zweiter, priceCent: [8700] }])

    // Unvollstaendig wird abgewiesen.
    expect((await entscheiden(ref, [
      { ratePlanCode: 'DZ-STD', date: VON, take: 'channel' }])).statusCode).toBe(422)

    const r = await entscheiden(ref, [
      { ratePlanCode: 'DZ-STD', date: VON, take: 'channel' },
      { ratePlanCode: 'DZ-STD', date: zweiter, take: 'mine' }])
    expect(r.statusCode, r.body).toBe(201)
    const neu = r.json<{ pushRef: string; mode: string; status: string }>()
    expect(neu).toMatchObject({ mode: 'changes', status: 'requested' })
    expect(neu.pushRef).not.toBe(ref)

    expect(await preis(std, VON)).toEqual([8800])
    expect(await preis(std, zweiter)).toEqual([8500, 9500])
    const rs = await owner.query<{ min_los: number }>(
      `SELECT min_los FROM restriction_day WHERE rate_plan_id = $1 AND date = $2`, [std, VON])
    expect(rs.rows[0]?.min_los).toBe(3)

    // Hinaus geht nur der Tag, an dem der eigene Wert gewaehlt wurde.
    const tage = (await abholen(m, neu.pushRef)).json<Werte>().plans.flatMap(p => p.days)
    expect(tage.map(d => d.date)).toEqual([zweiter])
    expect(tage[0]!.priceCent).toEqual([8500, 9500])

    // Ein zweites Mal entscheiden geht nicht.
    expect((await entscheiden(ref, [
      { ratePlanCode: 'DZ-STD', date: VON, take: 'channel' },
      { ratePlanCode: 'DZ-STD', date: zweiter, take: 'mine' }])).statusCode).toBe(409)
  })
})
