import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Kontrolle durch die Hausdame (Migration 0109, Baustein 4).
 *
 * Kontrolliert macht das Zimmer bezugsfertig, nacharbeiten schickt es mit
 * einem Satz zur Kraft zurueck, ohne die Reinigung ein zweites Mal
 * abzurechnen. Die Hausdame sieht dabei keine Minuten.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let hausdame: { userId: number; sessionId: string }
let anna: { userId: number; sessionId: string }
let zimmer: number[]

const TAG = '2026-10-01'
const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const kontrolle = (pfad = '') => `/v1/properties/${fx.propertyId}/inspection${pfad}`
const meine = (pfad = '') => `/v1/properties/${fx.propertyId}/my-rooms${pfad}`

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
  fx = await makeProperty(owner, { name: 'Seerobbe' })
  await openBusinessDay(owner, fx.propertyId, TAG)
  const kategorie = await makeCategory(owner, fx.propertyId)
  zimmer = await makeResources(owner, fx.propertyId, kategorie, 2)
  hausdame = await makeUser(owner, { email: 'hausdame@kunde.de',
    propertyId: fx.propertyId, roleKey: 'housekeeping' })
  anna = await makeUser(owner, { email: 'anna@kunde.de',
    propertyId: fx.propertyId, roleKey: 'housekeeping_staff' })
  for (const i of [0, 1]) {
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
      resourceId: zimmer[i], arrival: '2026-09-28', departure: TAG, status: 'InHouse',
      reserveInventory: false, withFolio: false })
  }
  const plan = await app.inject({ method: 'PUT',
    url: `/v1/properties/${fx.propertyId}/cleaning-plan`, headers: auth(hausdame.sessionId),
    payload: { date: TAG, assignments: [
      { resourceId: zimmer[0], kind: 'departure', assignedTo: anna.userId },
      { resourceId: zimmer[1], kind: 'departure', assignedTo: anna.userId }] } })
  expect(plan.statusCode).toBe(200)
})

type Zimmer = { taskId: number; code: string; inspection: string | null
                inspectionNote: string | null; staffName: string | null }
const liesKontrolle = async (): Promise<Zimmer[]> => {
  const r = await app.inject({ method: 'GET', url: kontrolle(), headers: auth(hausdame.sessionId) })
  expect(r.statusCode).toBe(200)
  return r.json().rooms
}
const pruefe = (taskId: number, result: string | null, note?: string) =>
  app.inject({ method: 'POST', url: kontrolle(`/${taskId}`), headers: auth(hausdame.sessionId),
    payload: { result, note } })
const stand = async (i: number): Promise<string | undefined> =>
  (await owner.query<{ status: string }>(
    `SELECT status FROM housekeeping_status WHERE resource_id = $1`, [zimmer[i]])).rows[0]?.status
const gereinigt = (taskId: number) => app.inject({ method: 'POST', url: meine(`/${taskId}`),
  headers: auth(anna.sessionId), payload: { outcome: 'cleaned' } })

describe('Kontrolle', () => {
  it('zeigt alle Zimmer mit Kraft, aber ohne Minuten', async () => {
    const r = await app.inject({ method: 'GET', url: kontrolle(), headers: auth(hausdame.sessionId) })
    const rooms = r.json().rooms
    expect(rooms.map((z: Zimmer) => z.code)).toEqual(['101', '102'])
    expect(rooms[0].staffName).not.toBeNull()
    expect(JSON.stringify(rooms)).not.toMatch(/minutes/i)
  })

  it('kontrolliert nur Gereinigtes und macht es bezugsfertig', async () => {
    const [a] = await liesKontrolle()
    const zufrueh = await pruefe(a!.taskId, 'passed')
    expect(zufrueh.statusCode).toBe(409)
    expect(zufrueh.json().code).toBe('inspection.notCleaned')

    await gereinigt(a!.taskId)
    const r = await pruefe(a!.taskId, 'passed')
    expect(r.statusCode).toBe(200)
    expect(r.json().rooms[0]).toMatchObject({ inspection: 'passed' })
    expect(await stand(0)).toBe('inspected')
  })

  it('schickt mit Satz zur Nacharbeit und rechnet nicht doppelt ab', async () => {
    const [a] = await liesKontrolle()
    await gereinigt(a!.taskId)
    expect((await pruefe(a!.taskId, 'rework')).statusCode).toBe(422)
    const r = await pruefe(a!.taskId, 'rework', 'Spiegel im Bad')
    expect(r.statusCode).toBe(200)
    expect(await stand(0)).toBe('dirty')

    const bei = (await app.inject({ method: 'GET', url: meine(),
      headers: auth(anna.sessionId) })).json()
    expect(bei.rooms[0]).toMatchObject({ inspection: 'rework', inspectionNote: 'Spiegel im Bad',
                                         outcome: 'cleaned' })
    expect(bei.minutes).toBe(30)

    const nach = await app.inject({ method: 'POST', url: meine(`/${a!.taskId}/reworked`),
      headers: auth(anna.sessionId) })
    expect(nach.statusCode).toBe(200)
    expect(nach.json().rooms[0]).toMatchObject({ inspection: null, inspectionNote: null })
    expect(nach.json().minutes).toBe(30)
    expect(await stand(0)).toBe('clean')

    // Ohne offene Nacharbeit gibt es nichts nachzuarbeiten.
    const nochmal = await app.inject({ method: 'POST', url: meine(`/${a!.taskId}/reworked`),
      headers: auth(anna.sessionId) })
    expect(nochmal.statusCode).toBe(409)

    const log = await owner.query<{ inspection_from: string | null; inspection_to: string | null }>(
      `SELECT inspection_from, inspection_to FROM housekeeping_task_log
        WHERE task_id = $1 AND inspection_from IS DISTINCT FROM inspection_to ORDER BY id`,
      [a!.taskId])
    expect(log.rows.map(l => [l.inspection_from, l.inspection_to]))
      .toEqual([[null, 'rework'], ['rework', null]])
  })

  it('bleibt der Reinigungskraft verschlossen', async () => {
    const r = await app.inject({ method: 'GET', url: kontrolle(), headers: auth(anna.sessionId) })
    expect(r.statusCode).toBe(403)
  })
})
