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
    // Die Kraft sieht ihren Monat ueber beide Haeuser (Sven, 16.10.2026).
    expect(t.json().houses.map((h: { propertyId: number }) => h.propertyId))
      .toEqual([hotel.propertyId, gh])
    expect(t.json().totals.total).toBe(0)
    const z = (await app.inject({ method: 'GET', url: `/v1/properties/${gh}/my-rooms`,
      headers: auth(olga.sessionId) })).json().rooms[0]
    await app.inject({ method: 'POST', url: `/v1/properties/${gh}/my-rooms/${z.taskId}`,
      headers: auth(olga.sessionId), payload: { outcome: 'cleaned' } })
    const t2 = await app.inject({ method: 'GET', url: `/v1/properties/${hotel.propertyId}/my-time`,
      headers: auth(olga.sessionId) })
    const m2 = t2.json()
    expect(m2.totals.total).toBe(30)
    expect(m2.houses.map((h: { name: string; total: number }) => [h.name, h.total]))
      .toEqual([['Hotel', 0], ['Gaestehaus', 30]])
    expect(m2.days.find((d: { date: string }) => d.date === TAG).byHouse).toEqual({ [gh]: 30 })

    // Eine Zusatzarbeit im Gaestehaus steht im selben Monat, mit ihrem Haus;
    // zurueckgezogen wird dort, und die Antwort ist wieder der ganze Monat.
    const e = await app.inject({ method: 'POST', url: `/v1/properties/${gh}/my-time`,
      headers: auth(olga.sessionId), payload: { kind: 'extra', description: 'Waesche', minutes: 10 } })
    expect(e.statusCode, e.body).toBe(201)
    const m3 = (await app.inject({ method: 'GET', url: `/v1/properties/${hotel.propertyId}/my-time`,
      headers: auth(olga.sessionId) })).json()
    expect(m3.totals.total).toBe(40)
    const eintrag = m3.days.find((d: { date: string }) => d.date === TAG).entries[0]
    expect(eintrag.propertyId).toBe(gh)
    const w = await app.inject({ method: 'POST',
      url: `/v1/properties/${gh}/my-time/${eintrag.id}/withdraw`, headers: auth(olga.sessionId) })
    expect(w.statusCode, w.body).toBe(200)
    expect(w.json().totals.total).toBe(30)
    expect(w.json().houses).toHaveLength(2)
  })
})

describe('Arbeitszeit ueber alle Haeuser', () => {
  /** Olga reinigt am 30.09. ein Zimmer im Hotel und eines im Gaestehaus. */
  const zweiHaeuser = async () => {
    // Getrennt geplant, aber dieselbe Kraft in beiden Haeusern -- der Fall,
    // in dem die Leitung bisher zwei Monatsplaene zusammenzaehlte.
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'housekeeping_staff' AND account_id IS NULL`,
      [olga.userId, gh])
    for (const [haus, zimmerId] of [[hotel.propertyId, hotelZimmer[0]],
                                    [gh, ghZimmer[0]]] as const) {
      const r = await app.inject({ method: 'PUT', url: `/v1/properties/${haus}/cleaning-plan`,
        headers: auth(inhaber.sessionId), payload: { date: '2026-09-30', assignments: [
          { resourceId: zimmerId, kind: 'departure', assignedTo: olga.userId }] } })
      expect(r.statusCode, r.body).toBe(200)
    }
    await owner.query(
      `UPDATE housekeeping_task SET status = 'done', outcome = 'cleaned' WHERE assigned_to = $1`,
      [olga.userId])
    await owner.query(
      `INSERT INTO staff_work_entry (property_id, user_id, business_date, kind, description,
                                     minutes, created_by)
       VALUES ($1, $2, '2026-09-30', 'extra', 'Waesche', 15, $2)`, [gh, olga.userId])
  }
  const lies = (pfad: string, session = inhaber.sessionId) =>
    app.inject({ method: 'GET', url: `/v1/properties/${hotel.propertyId}${pfad}`,
      headers: auth(session) })

  it('ein Monatsplan je Kraft, die Minuten je Haus daneben', async () => {
    await zweiHaeuser()
    // Je Haus wie bisher: nur das Hotel, das Gaestehaus als Hinweis.
    const einzeln = (await lies('/worktime?month=2026-09')).json()
    expect(einzeln.houses).toHaveLength(1)
    expect(einzeln.combinable).toBe(true)
    expect(einzeln.staff[0].totals.total).toBe(30)
    expect(einzeln.staff[0].elsewhere).toEqual([{ propertyId: gh, name: 'Gaestehaus', total: 45 }])

    const alle = await lies('/worktime?month=2026-09&scope=all')
    expect(alle.statusCode, alle.body).toBe(200)
    const u = alle.json()
    expect(u.houses.map((h: { propertyId: number }) => h.propertyId))
      .toEqual([hotel.propertyId, gh])
    const o = u.staff.find((k: { userId: number }) => k.userId === olga.userId)
    expect(o.totals).toEqual({ rooms: 60, extra: 15, kitchen: 0, correction: 0, total: 75 })
    expect(o.byHouse).toEqual({ [hotel.propertyId]: 30, [gh]: 45 })
    expect(o.days).toEqual({ '2026-09-30': 75 })
    expect(o.elsewhere).toEqual([])

    const m = (await lies(`/worktime/${olga.userId}?month=2026-09&scope=all`)).json()
    const tag = m.days.find((d: { date: string }) => d.date === '2026-09-30')
    expect(tag.total).toBe(75)
    expect(tag.rooms).toBe(2)
    expect(tag.byHouse).toEqual({ [hotel.propertyId]: 30, [gh]: 45 })
    expect(tag.entries[0].propertyId).toBe(gh)
    expect(m.houses.map((h: { total: number }) => h.total)).toEqual([30, 45])
    expect(m.halves[1].total).toBe(75)

    expect((await lies('/worktime?month=2026-09&scope=irgendwas')).statusCode).toBe(422)
  })

  it('wer nur im Hotel leitet, bekommt auch mit scope=all nur das Hotel', async () => {
    await zweiHaeuser()
    const direktor = await makeUser(owner, { email: 'dir@kunde.de', propertyId: hotel.propertyId,
      roleKey: 'hotel_director' })
    const u = (await lies('/worktime?month=2026-09&scope=all', direktor.sessionId)).json()
    expect(u.houses).toHaveLength(1)
    expect(u.combinable).toBe(false)
    expect(u.staff[0].totals.total).toBe(30)
    const m = (await lies(`/worktime/${olga.userId}?month=2026-09&scope=all`,
      direktor.sessionId)).json()
    expect(m.totals.total).toBe(30)
  })

  it('abschliessen und ausgeben ueber beide Haeuser', async () => {
    await zweiHaeuser()
    // Nur das Hotel zu: ueber beide ist der Monat noch offen.
    const z1 = await app.inject({ method: 'POST', url: `/v1/properties/${hotel.propertyId}/worktime/close`,
      headers: auth(inhaber.sessionId), payload: { month: '2026-09' } })
    expect(z1.statusCode, z1.body).toBe(200)
    expect((await lies('/worktime?month=2026-09&scope=all')).json().closed).toBeNull()
    expect((await lies('/worktime/export?month=2026-09&scope=all')).statusCode).toBe(409)

    const z2 = await app.inject({ method: 'POST', url: `/v1/properties/${hotel.propertyId}/worktime/close`,
      headers: auth(inhaber.sessionId), payload: { month: '2026-09', scope: 'all' } })
    expect(z2.statusCode, z2.body).toBe(200)
    expect(z2.json().closed).not.toBeNull()
    const zu = await owner.query(
      `SELECT property_id::int FROM staff_month_close WHERE reopened_at IS NULL ORDER BY 1`)
    expect(zu.rows.map(r => r.property_id)).toEqual([hotel.propertyId, gh].sort((a, b) => a - b))

    const csv = await lies('/worktime/export?month=2026-09&scope=all')
    expect(csv.statusCode, csv.body).toBe(200)
    expect(csv.headers['content-disposition']).toContain('alle-haeuser')
    const zeilen = csv.body.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    expect(zeilen[0]).toContain('Hotel Minuten;Gaestehaus Minuten')
    expect(zeilen.find(z => z.includes('2026-09-30'))).toMatch(/;75;1,25;30;45$/)

    const auf = await app.inject({ method: 'POST', url: `/v1/properties/${hotel.propertyId}/worktime/reopen`,
      headers: auth(inhaber.sessionId), payload: { month: '2026-09', reason: 'Nachtrag', scope: 'all' } })
    expect(auf.statusCode, auf.body).toBe(200)
    expect((await owner.query(
      `SELECT 1 FROM staff_month_close WHERE reopened_at IS NULL`)).rowCount).toBe(0)
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
