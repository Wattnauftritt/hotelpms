import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { legacyChecksum } from '@hotelpms/domain'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Hotel und Gaestehaus mit demselben Personal (Migration 0116): das
 * Gemeinschaftsbad als Reinigungsbereich, die Einstellung "gemeinsam oder
 * je Haus", die Liste der Kraft ueber alle Haeuser und der Import, der eine
 * Datei auf beide Haeuser verteilt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let hotel: Fixture
let gh: number
let inhaber: { userId: number; sessionId: string }
let hausdame: { userId: number; sessionId: string }
let olga: { userId: number; sessionId: string }
let hotelZimmer: number[]
let ghZimmer: number[]

const TAG = '2026-10-01'
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
  hotel = await makeProperty(owner, { name: 'Hotel' })
  gh = (await owner.query<{ id: number }>(
    `INSERT INTO property (account_id, code, name, address_line1, postal_code, city, country,
                           tax_number)
     VALUES ($1, 'GH', 'Gaestehaus', 'Hafenstr. 2', '27472', 'Cuxhaven', 'DE', '21/815/00123')
     RETURNING id`, [hotel.accountId])).rows[0]!.id
  await openBusinessDay(owner, hotel.propertyId, TAG)
  await openBusinessDay(owner, gh, TAG)
  hotelZimmer = await makeResources(owner, hotel.propertyId,
    await makeCategory(owner, hotel.propertyId), 2)
  ghZimmer = await makeResources(owner, gh, await makeCategory(owner, gh, { code: 'GZ' }), 2, '6')
  inhaber = await makeUser(owner, { email: 'inhaber@kunde.de', accountId: hotel.accountId,
    roleKey: 'owner' })
  // Hausdame und Kraft haben ihre Rolle nur im Hotel.
  hausdame = await makeUser(owner, { email: 'hd@kunde.de', propertyId: hotel.propertyId,
    roleKey: 'housekeeping' })
  olga = await makeUser(owner, { email: 'olga@kunde.de', propertyId: hotel.propertyId,
    roleKey: 'housekeeping_staff' })
  await owner.query(`UPDATE app_user SET username = 'olga' WHERE id = $1`, [olga.userId])
})

const gemeinsam = (shared: boolean) =>
  app.inject({ method: 'PUT', url: `/v1/properties/${hotel.propertyId}/staff-setting`,
    headers: auth(inhaber.sessionId), payload: { shared } })
const plan = (propertyId: number, session = hausdame.sessionId) =>
  app.inject({ method: 'GET', url: `/v1/properties/${propertyId}/cleaning-plan?date=${TAG}`,
    headers: auth(session) })
/** Ein Zimmer des Gaestehauses schmutzig: das Bad ist faellig. */
const ghSchmutzig = () => owner.query(
  `INSERT INTO housekeeping_status (property_id, resource_id, status) VALUES ($1, $2, 'dirty')`,
  [gh, ghZimmer[0]])
const bad = async () => {
  const r = await app.inject({ method: 'PUT', url: `/v1/properties/${gh}/cleaning-areas`,
    headers: auth(inhaber.sessionId), payload: { areas: [{ code: 'Bad', minutes: 20 }] } })
  expect(r.statusCode, r.body).toBe(200)
  return r.json<{ areas: Array<{ id: number }> }>().areas[0]!.id
}

describe('Reinigungsbereiche', () => {
  it('das Bad ist planbar, zaehlt Minuten und hat keinen Zimmerstand', async () => {
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = $3 AND account_id IS NULL`,
      [olga.userId, gh, 'housekeeping_staff'])
    const badId = await bad()
    // Eine Kennung, die schon ein Zimmer traegt, geht nicht.
    const doppelt = await app.inject({ method: 'PUT', url: `/v1/properties/${gh}/cleaning-areas`,
      headers: auth(inhaber.sessionId), payload: { areas: [{ code: '6101', minutes: 5 }] } })
    expect(doppelt.statusCode).toBe(409)

    // Das Bad haengt am Gaestehaus: leer ist es sauber, ...
    const badIm = async () => {
      const p = await plan(gh, inhaber.sessionId)
      expect(p.statusCode, p.body).toBe(200)
      return p.json().rooms.find((z: { areaId: number | null }) => z.areaId === badId)
    }
    expect(await badIm()).toMatchObject({ code: 'Bad', resourceId: null, due: null })
    // ... war letzte Nacht jemand da, ist es schmutzig ...
    const ghKat = (await owner.query<{ category_id: number }>(
      `SELECT category_id::int FROM resource WHERE id = $1`, [ghZimmer[0]])).rows[0]!.category_id
    const gast = await makeReservation(owner, { propertyId: gh, categoryId: ghKat,
      resourceId: ghZimmer[0], arrival: '2026-09-29', departure: TAG, status: 'InHouse',
      reserveInventory: false, withFolio: false })
    expect(await badIm()).toMatchObject({ due: 'departure', minutes: 20 })
    // ... und ebenso, solange ein Zimmer schmutzig steht.
    await owner.query(`DELETE FROM reservation WHERE id = $1`, [gast.reservationId])
    expect((await badIm()).due).toBeNull()
    await ghSchmutzig()
    expect((await badIm()).due).toBe('departure')

    const s = await app.inject({ method: 'PUT', url: `/v1/properties/${gh}/cleaning-plan`,
      headers: auth(inhaber.sessionId), payload: { date: TAG, assignments: [
        { areaId: badId, kind: 'departure', assignedTo: olga.userId }] } })
    expect(s.statusCode, s.body).toBe(200)

    const meine = await app.inject({ method: 'GET', url: `/v1/properties/${gh}/my-rooms`,
      headers: auth(olga.sessionId) })
    const z = meine.json().rooms[0]
    expect(z).toMatchObject({ code: 'Bad', areaId: badId, resourceId: null, free: true })
    const g = await app.inject({ method: 'POST', url: `/v1/properties/${gh}/my-rooms/${z.taskId}`,
      headers: auth(olga.sessionId), payload: { outcome: 'cleaned' } })
    expect(g.statusCode, g.body).toBe(200)
    expect(g.json().minutes).toBe(20)
    // Das Bad hat keinen Zimmerstand: nur das schmutzige Zimmer steht da.
    const { rows } = await owner.query(
      `SELECT resource_id::int, status FROM housekeeping_status WHERE property_id = $1`, [gh])
    expect(rows).toEqual([{ resource_id: ghZimmer[0], status: 'dirty' }])
  })
})

describe('Gemeinsam oder je Haus', () => {
  it('getrennt: die Kraft des Hotels steht nicht im Plan des Gaestehauses', async () => {
    const r = await plan(gh, inhaber.sessionId)
    expect(r.json().shared).toBe(false)
    expect(r.json().staff).toEqual([])
    // Die Hausdame des Hotels hat im Gaestehaus nichts zu sagen.
    expect((await plan(gh)).statusCode).toBe(403)
  })

  it('gemeinsam: ein Plan ueber beide Haeuser, eine Liste fuer die Kraft', async () => {
    expect((await gemeinsam(true)).statusCode).toBe(200)
    const badId = await bad()
    const r = await plan(hotel.propertyId)
    expect(r.statusCode, r.body).toBe(200)
    const p = r.json()
    expect(p.shared).toBe(true)
    expect(p.houses.map((h: { id: number }) => h.id)).toEqual([hotel.propertyId, gh])
    expect(p.rooms.map((z: { propertyId: number }) => z.propertyId))
      .toEqual([hotel.propertyId, hotel.propertyId, gh, gh, gh])
    expect(p.staff.map((k: { userId: number }) => k.userId)).toEqual([olga.userId])

    const s = await app.inject({ method: 'PUT',
      url: `/v1/properties/${hotel.propertyId}/cleaning-plan`, headers: auth(hausdame.sessionId),
      payload: { date: TAG, assignments: [
        { resourceId: hotelZimmer[0], kind: 'departure', assignedTo: olga.userId },
        { resourceId: ghZimmer[1], kind: 'departure', assignedTo: olga.userId },
        { areaId: badId, kind: 'departure', assignedTo: olga.userId }] } })
    expect(s.statusCode, s.body).toBe(200)
    const { rows } = await owner.query<{ property_id: number }>(
      `SELECT property_id::int FROM housekeeping_task ORDER BY id`)
    expect(rows.map(x => x.property_id)).toEqual([hotel.propertyId, gh, gh])

    const meine = await app.inject({ method: 'GET', url: '/v1/my-rooms',
      headers: auth(olga.sessionId) })
    expect(meine.statusCode, meine.body).toBe(200)
    const haeuser = meine.json().houses as Array<{ propertyId: number; rooms: unknown[] }>
    expect(haeuser.map(h => [h.propertyId, h.rooms.length]).sort())
      .toEqual([[hotel.propertyId, 1], [gh, 2]].sort())

    // Die Kraft setzt am Haus der Aufgabe -- auch dort, wo sie keine eigene
    // Rolle hat.
    const gz = haeuser.find(h => h.propertyId === gh)!.rooms[0] as { taskId: number }
    const g = await app.inject({ method: 'POST', url: `/v1/properties/${gh}/my-rooms/${gz.taskId}`,
      headers: auth(olga.sessionId), payload: { outcome: 'cleaned' } })
    expect(g.statusCode, g.body).toBe(200)

    // Die Kueche: eine Zahl fuer beide Haeuser, die Aufteilung darunter.
    const k = await app.inject({ method: 'GET', url: `/v1/properties/${hotel.propertyId}/kitchen`,
      headers: auth(hausdame.sessionId) })
    expect(k.statusCode, k.body).toBe(200)
    expect(k.json().houses).toHaveLength(2)

    // Zurueck auf getrennt: die Rolle im Hotel wirkt nicht mehr im Gaestehaus.
    await gemeinsam(false)
    expect((await app.inject({ method: 'GET', url: `/v1/properties/${gh}/my-rooms`,
      headers: auth(olga.sessionId) })).statusCode).toBe(403)
  })

  it('getrennt, aber in beiden Haeusern: der Plan zeigt die Last im anderen Haus', async () => {
    for (const [u, rolle] of [[olga.userId, 'housekeeping_staff'],
                              [hausdame.userId, 'housekeeping']] as const) {
      await owner.query(
        `INSERT INTO user_property_role (user_id, property_id, role_id)
         SELECT $1, $2, id FROM role WHERE key = $3 AND account_id IS NULL`, [u, gh, rolle])
    }
    const s = await app.inject({ method: 'PUT', url: `/v1/properties/${gh}/cleaning-plan`,
      headers: auth(hausdame.sessionId), payload: { date: TAG, assignments: [
        { resourceId: ghZimmer[0], kind: 'departure', assignedTo: olga.userId }] } })
    expect(s.statusCode, s.body).toBe(200)
    const p = (await plan(hotel.propertyId)).json()
    expect(p.houses).toHaveLength(1)
    expect(p.staff[0].elsewhere).toEqual([
      { propertyId: gh, propertyName: 'Gaestehaus', rooms: 1, minutes: 30 }])

    const t = await app.inject({ method: 'GET', url: `/v1/properties/${hotel.propertyId}/my-time`,
      headers: auth(olga.sessionId) })
    expect(t.json().otherHouses).toEqual([])
    const z = (await app.inject({ method: 'GET', url: `/v1/properties/${gh}/my-rooms`,
      headers: auth(olga.sessionId) })).json().rooms[0]
    await app.inject({ method: 'POST', url: `/v1/properties/${gh}/my-rooms/${z.taskId}`,
      headers: auth(olga.sessionId), payload: { outcome: 'cleaned' } })
    const t2 = await app.inject({ method: 'GET', url: `/v1/properties/${hotel.propertyId}/my-time`,
      headers: auth(olga.sessionId) })
    expect(t2.json().otherHouses).toEqual([{ propertyId: gh, name: 'Gaestehaus', total: 30 }])
  })
})

describe('Import ueber beide Haeuser', () => {
  it('verteilt die Zeilen nach Zimmernummer, das Bad in seinen Bereich', async () => {
    const badId = await bad()
    const codes = async (ids: number[]) => (await owner.query<{ code: string }>(
      'SELECT code FROM resource WHERE id = ANY($1::bigint[]) ORDER BY id', [ids])).rows
      .map(r => r.code)
    const [h1] = await codes(hotelZimmer)
    const [g1] = await codes(ghZimmer)
    const staff = [{ username: 'olga', displayName: 'Olga', roles: ['reinigung'],
                     status: 'active', language: 'ru' }]
    const schedules = [
      { date: '2026-09-30', room: h1, kind: 'departure', username: 'olga', status: 'cleaned', minutes: 30 },
      { date: '2026-09-30', room: g1, kind: 'departure', username: 'olga', status: 'cleaned', minutes: 20 },
      { date: '2026-09-30', room: 'Bad', kind: 'stayover', username: 'olga', status: 'cleaned', minutes: 20 },
      { date: '2026-09-30', room: '999', kind: 'departure', username: 'olga', status: 'open', minutes: 30 }]
    const data = {
      format: 'zurseerobbe-staygrid', schemaVersion: 1, exportedAt: '2026-10-07T18:00:00+02:00',
      since: null, until: '2026-09-30',
      manifest: {
        staff: { rows: 1, sha256: legacyChecksum(staff) },
        schedules: { rows: schedules.length, sha256: legacyChecksum(schedules) },
        workEntries: { rows: 0, sha256: legacyChecksum([]) }
      },
      staff, schedules, workEntries: []
    }
    // Der Inhaber fuehrt die Arbeitszeit beider Haeuser.
    const r = await app.inject({ method: 'POST',
      url: `/v1/properties/${hotel.propertyId}/staff-import`, headers: auth(inhaber.sessionId),
      payload: { data, commit: true } })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().houses).toEqual([
      { propertyId: hotel.propertyId, name: 'Hotel', schedules: 1 },
      { propertyId: gh, name: 'Gaestehaus', schedules: 2 }])
    expect(r.json().unknownRooms).toEqual(['999'])
    const { rows } = await owner.query<{ property_id: number; area_id: number | null; kind: string }>(
      `SELECT property_id::int, area_id::int, kind FROM housekeeping_task ORDER BY id`)
    expect(rows).toEqual([
      { property_id: hotel.propertyId, area_id: null, kind: 'departure' },
      { property_id: gh, area_id: null, kind: 'departure' },
      { property_id: gh, area_id: badId, kind: 'departure' }])
  })
})
