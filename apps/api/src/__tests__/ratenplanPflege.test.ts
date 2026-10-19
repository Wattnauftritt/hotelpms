import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeReservation, makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Ratenplaene anlegen und loeschen, wie Sven es aus RoomCloud kennt.
 *
 * Eine Rate fuer mehrere Zimmergruppen ergibt je Gruppe einen Plan, weil
 * Preis und Buchung je Gruppe verschieden sind; das Kuerzel bleibt dabei
 * im Haus eindeutig, denn ueber das Kuerzel findet das Umsystem den Plan.
 * Ein doppeltes Kuerzel ist ein Hinweis, kein "Interner Fehler". Geloescht
 * wird nur, was nichts traegt: eine Buchung nennt ihre Rate auch spaeter.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let ez: number
let dz: number
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

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
  ez = await makeCategory(owner, fx.propertyId, { code: 'EZ', name: 'Einzelzimmer' })
  dz = await makeCategory(owner, fx.propertyId, { code: 'DZ', name: 'Doppelzimmer' })
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
})

/** Ein zweites Haus im selben Account: die Zeilenrichtlinie laesst es durch. */
async function zweitesHaus(): Promise<number> {
  const p = await owner.query<{ id: number }>(
    `INSERT INTO property (account_id, code, name, address_line1, postal_code, city, country)
     VALUES ($1, 'GH', 'Gaestehaus', 'Hafenstr. 2', '25813', 'Husum', 'DE')
     ON CONFLICT DO NOTHING RETURNING id`, [fx.accountId])
  if (p.rows[0] !== undefined) return p.rows[0].id
  const q = await owner.query<{ id: number }>(
    `SELECT id FROM property WHERE account_id = $1 AND code = 'GH'`, [fx.accountId])
  return q.rows[0]!.id
}

const anlegen = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/v1/properties/${fx.propertyId}/rate-plans`,
               headers: auth(admin.sessionId), payload })

const loeschen = (ratePlanId: number) =>
  app.inject({ method: 'DELETE',
               url: `/v1/properties/${fx.propertyId}/rate-plans/${ratePlanId}`,
               headers: auth(admin.sessionId) })

async function plaene(): Promise<Array<{ code: string; name: string; categoryId: number }>> {
  const r = await app.inject({ method: 'GET', url: `/v1/properties/${fx.propertyId}/rate-plans`,
                               headers: auth(admin.sessionId) })
  return r.json<{ ratePlans: Array<{ code: string; name: string; categoryId: number }> }>()
    .ratePlans
}

describe('Ratenplan anlegen', () => {
  it('legt eine Rate fuer mehrere Zimmergruppen als je einen Plan an', async () => {
    const r = await anlegen({ code: 'mehrtages', name: 'Mehrtagesrate', categoryIds: [ez, dz] })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json<{ ratePlans: Array<{ code: string }> }>().ratePlans.map(p => p.code))
      .toEqual(['mehrtages-DZ', 'mehrtages-EZ'])
    const p = await plaene()
    expect(p.find(x => x.code === 'mehrtages-EZ')).toMatchObject(
      { name: 'Mehrtagesrate', categoryId: ez })
    expect(p.find(x => x.code === 'mehrtages-DZ')).toMatchObject(
      { name: 'Mehrtagesrate', categoryId: dz })
  })

  it('behaelt bei einer Gruppe das Kuerzel, wie getippt', async () => {
    const r = await anlegen({ code: 'standard', name: 'Standardrate', categoryId: dz })
    expect(r.statusCode, r.body).toBe(201)
    expect((await plaene()).map(p => p.code)).toEqual(['standard'])
  })

  it('meldet ein doppeltes Kuerzel als Konflikt und legt nichts halb an', async () => {
    await anlegen({ code: 'mehrtages-DZ', name: 'Alt', categoryId: dz })
    const r = await anlegen({ code: 'mehrtages', name: 'Mehrtagesrate', categoryIds: [ez, dz] })
    expect(r.statusCode).toBe(409)
    expect(r.json<{ code: string }>().code).toBe('ratePlan.codeTaken')
    expect(r.body).toContain('mehrtages-DZ')
    // Die EZ-Rate wurde vorher in derselben Anfrage angelegt und geht mit zurueck.
    expect((await plaene()).map(p => p.code)).toEqual(['mehrtages-DZ'])
  })

  it('nimmt keine Zimmergruppe eines anderen Hauses', async () => {
    const k = await makeCategory(owner, await zweitesHaus(), { code: 'XX' })
    const r = await anlegen({ code: 'standard', name: 'Standardrate', categoryIds: [dz, k] })
    expect(r.statusCode).toBe(404)
    expect(await plaene()).toEqual([])
  })

  // Audit 19.10.2026, N3: fremde Regel ergab 201, unbekannte Kennung 500.
  it('nimmt keine Stornoregel eines anderen Hauses oder Kunden', async () => {
    const regel = async (propertyId: number) => (await owner.query<{ id: number }>(
      `INSERT INTO cancellation_policy (property_id, code, name)
       VALUES ($1, 'flex', 'Flexibel') RETURNING id`, [propertyId])).rows[0]!.id
    const eigene = await regel(fx.propertyId)
    const nachbar = await regel(await zweitesHaus())
    const fremd = await regel((await makeProperty(owner, { code: 'FREMD' })).propertyId)

    for (const id of [nachbar, fremd, 999999]) {
      const r = await anlegen({ code: `s${id}`, name: 'Standardrate', categoryIds: [dz],
                                cancellationPolicyId: id })
      expect(r.statusCode, r.body).toBe(422)
    }
    expect(await plaene()).toEqual([])

    const ok = await anlegen({ code: 'standard', name: 'Standardrate', categoryIds: [dz],
                               cancellationPolicyId: eigene })
    expect(ok.statusCode, ok.body).toBe(201)
  })
})

describe('Ratenplan loeschen', () => {
  const id = async (code: string, categoryId = dz, extra: Record<string, unknown> = {}) => {
    const r = await anlegen({ code, name: code, categoryId, ...extra })
    expect(r.statusCode, r.body).toBe(201)
    return r.json<{ ratePlanId: number }>().ratePlanId
  }

  it('loescht einen vertippten Plan mit seinen Preisen und Restriktionen', async () => {
    const plan = await id('standrad')
    await app.inject({ method: 'PUT', url: '/v1/rates/bulk', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: plan, from: '2027-05-01',
                 to: '2027-05-03', priceCent: [9000] } })
    await app.inject({ method: 'PUT', url: '/v1/restrictions/bulk',
      headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: plan, from: '2027-05-01',
                 to: '2027-05-01', minLos: 2 } })

    const r = await loeschen(plan)
    expect(r.statusCode, r.body).toBe(200)
    expect(await plaene()).toEqual([])
    const rest = await owner.query(
      `SELECT 1 FROM rate_day WHERE rate_plan_id = $1
       UNION ALL SELECT 1 FROM restriction_day WHERE rate_plan_id = $1`, [plan])
    expect(rest.rowCount).toBe(0)
  })

  it('weist ab, solange ein abgeleiteter Plan daran haengt', async () => {
    const basis = await id('standard')
    await id('nonref', dz, { baseRatePlanId: basis, deriveKind: 'percent', deriveValue: -10 })
    const r = await loeschen(basis)
    expect(r.statusCode).toBe(409)
    expect(r.json<{ code: string }>().code).toBe('ratePlan.hasDerived')
  })

  it('weist ab, wenn eine Buchung die Rate nennt', async () => {
    const plan = await id('standard')
    const res = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2027-05-01', departure: '2027-05-03', reserveInventory: false })
    await owner.query(`UPDATE reservation SET rate_plan_id = $1 WHERE id = $2`,
      [plan, res.reservationId])
    const r = await loeschen(plan)
    expect(r.statusCode).toBe(409)
    expect(r.json<{ code: string }>().code).toBe('ratePlan.inUse')
  })

  it('loescht keinen Plan eines anderen Hauses', async () => {
    const k = await makeCategory(owner, await zweitesHaus(), { code: 'XX' })
    const p = await owner.query<{ id: number }>(
      `INSERT INTO rate_plan (property_id, category_id, code, name)
       VALUES ($1, $2, 'fremd', 'Fremd') RETURNING id`, [await zweitesHaus(), k])
    expect((await loeschen(p.rows[0]!.id)).statusCode).toBe(404)
  })
})
