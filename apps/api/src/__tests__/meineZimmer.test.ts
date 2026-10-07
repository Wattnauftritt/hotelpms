import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Meine Zimmer in der Personal-App (Migration 0108, Baustein 3).
 *
 * Die Kraft sieht und aendert nur die eigenen Zimmer des offenen Tages.
 * Eine Abreise ist erst nach dem Check-out frei, ein Zimmer ohne
 * abreisenden Gast immer. Abgerechnet wird nur, was gereinigt ist, und
 * jeder Ausgang steht im Verlauf.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let hausdame: { userId: number; sessionId: string }
let anna: { userId: number; sessionId: string }
let olga: { userId: number; sessionId: string }
let zimmer: number[]
let kategorie: number
let abreise: number

const TAG = '2026-10-01'
const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
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
  kategorie = await makeCategory(owner, fx.propertyId)
  zimmer = await makeResources(owner, fx.propertyId, kategorie, 4)
  hausdame = await makeUser(owner, { email: 'hausdame@kunde.de',
    propertyId: fx.propertyId, roleKey: 'housekeeping' })
  anna = await makeUser(owner, { email: 'anna@kunde.de',
    propertyId: fx.propertyId, roleKey: 'housekeeping_staff' })
  olga = await makeUser(owner, { email: 'olga@kunde.de',
    propertyId: fx.propertyId, roleKey: 'housekeeping_staff' })
  // 101 reist ab (noch im Haus), 102 bleibt, 103 bleibt, 104 ist leer --
  // das Gemeinschaftsbad, das trotzdem geputzt wird.
  abreise = (await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
    resourceId: zimmer[0], arrival: '2026-09-28', departure: TAG, status: 'InHouse',
    reserveInventory: false, withFolio: false })).reservationId
  for (const i of [1, 2]) {
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
      resourceId: zimmer[i], arrival: '2026-09-30', departure: '2026-10-03',
      status: 'InHouse', reserveInventory: false, withFolio: false })
  }
  const plan = await app.inject({ method: 'PUT',
    url: `/v1/properties/${fx.propertyId}/cleaning-plan`, headers: auth(hausdame.sessionId),
    payload: { date: TAG, assignments: [
      { resourceId: zimmer[0], kind: 'departure', assignedTo: anna.userId },
      { resourceId: zimmer[1], kind: 'stayover', assignedTo: anna.userId },
      { resourceId: zimmer[2], kind: 'stayover', assignedTo: olga.userId },
      { resourceId: zimmer[3], kind: 'departure', assignedTo: anna.userId }] } })
  expect(plan.statusCode).toBe(200)
})

type Zimmer = { taskId: number; code: string; kind: string; free: boolean
                status: string; outcome: string | null; minutes: number }
const lies = async (session = anna.sessionId): Promise<{ rooms: Zimmer[]; minutes: number }> => {
  const r = await app.inject({ method: 'GET', url: meine(), headers: auth(session) })
  expect(r.statusCode).toBe(200)
  return r.json()
}
const setze = (taskId: number, outcome: string | null, session = anna.sessionId) =>
  app.inject({ method: 'POST', url: meine(`/${taskId}`), headers: auth(session),
    payload: { outcome } })

describe('Meine Zimmer', () => {
  it('zeigt nur die eigenen Zimmer, mit frei und wartet', async () => {
    const b = await lies()
    expect(b.rooms.map(z => [z.code, z.kind, z.free])).toEqual([
      ['101', 'departure', false], ['102', 'stayover', true], ['104', 'departure', true]])
    expect((await lies(olga.sessionId)).rooms.map(z => z.code)).toEqual(['103'])
  })

  it('macht die Abreise frei, sobald der Gast ausgecheckt ist', async () => {
    await owner.query(`UPDATE reservation SET status = 'CheckedOut' WHERE id = $1`, [abreise])
    expect((await lies()).rooms[0]!.free).toBe(true)
  })

  it('setzt Ausgang und Zimmerstand, rechnet nur Gereinigtes ab und nimmt zurueck', async () => {
    const [ab, bleiber] = (await lies()).rooms
    const r = await setze(ab!.taskId, 'cleaned')
    expect(r.statusCode).toBe(200)
    expect(r.json().minutes).toBe(30)
    const s = await setze(bleiber!.taskId, 'declined')
    expect(s.json().rooms[1]).toMatchObject({ status: 'skipped', outcome: 'declined' })
    expect(s.json().minutes).toBe(30)

    const stand = await owner.query<{ status: string }>(
      `SELECT status FROM housekeeping_status WHERE resource_id = $1`, [zimmer[0]])
    expect(stand.rows[0]!.status).toBe('clean')

    const z = await setze(ab!.taskId, null)
    expect(z.json().rooms[0]).toMatchObject({ status: 'open', outcome: null })
    expect(z.json().minutes).toBe(0)
    const danach = await owner.query<{ status: string }>(
      `SELECT status FROM housekeeping_status WHERE resource_id = $1`, [zimmer[0]])
    expect(danach.rows[0]!.status).toBe('dirty')

    const log = await owner.query<{ outcome_from: string | null; outcome_to: string | null
                                     changed_by: string }>(
      `SELECT outcome_from, outcome_to, changed_by FROM housekeeping_task_log
        WHERE task_id = $1 AND action = 'changed' ORDER BY id`, [ab!.taskId])
    expect(log.rows.map(l => [l.outcome_from, l.outcome_to]))
      .toEqual([[null, 'cleaned'], ['cleaned', null]])
    expect(Number(log.rows[0]!.changed_by)).toBe(anna.userId)
  })

  it('findet ein fremdes Zimmer nicht', async () => {
    const fremd = (await lies(olga.sessionId)).rooms[0]!
    expect((await setze(fremd.taskId, 'cleaned')).statusCode).toBe(404)
    const p = await app.inject({ method: 'POST', url: meine(`/${fremd.taskId}/problem`),
      headers: auth(anna.sessionId), payload: { text: 'Hahn tropft' } })
    expect(p.statusCode).toBe(404)
  })

  it('aendert nur den offenen Tag', async () => {
    const ab = (await lies()).rooms[0]!
    await owner.query(`UPDATE business_day SET status = 'closed' WHERE property_id = $1`,
      [fx.propertyId])
    await openBusinessDay(owner, fx.propertyId, '2026-10-02')
    expect((await setze(ab.taskId, 'cleaned')).statusCode).toBe(404)
  })

  it('weist einen unbekannten Ausgang ab', async () => {
    const ab = (await lies()).rooms[0]!
    expect((await setze(ab.taskId, 'egal')).statusCode).toBe(422)
  })

  it('macht aus einem Problem eine Wartungsmeldung am Zimmer', async () => {
    const ab = (await lies()).rooms[0]!
    const r = await app.inject({ method: 'POST', url: meine(`/${ab.taskId}/problem`),
      headers: auth(anna.sessionId), payload: { text: 'Duschkopf lose\nBitte Technik' } })
    expect(r.statusCode).toBe(201)
    expect(r.json().rooms[0].openProblems).toBe(1)
    const t = await owner.query<{ title: string; resource_id: string; created_by: string }>(
      `SELECT title, resource_id, created_by FROM maintenance_ticket WHERE id = $1`,
      [r.json().ticketId])
    expect(t.rows[0]).toMatchObject({ title: 'Duschkopf lose' })
    expect(Number(t.rows[0]!.resource_id)).toBe(zimmer[0])
    expect(Number(t.rows[0]!.created_by)).toBe(anna.userId)
  })

  it('bleibt der Rezeption verschlossen', async () => {
    const rez = await makeUser(owner, { email: 'rez@kunde.de',
      propertyId: fx.propertyId, roleKey: 'reception' })
    const r = await app.inject({ method: 'GET', url: meine(), headers: auth(rez.sessionId) })
    expect(r.statusCode).toBe(403)
  })
})

describe('Gaestehaus ohne Bleiberreinigung', () => {
  it('laesst Bleiber mit null Sollminuten aus dem faelligen Plan', async () => {
    await app.inject({ method: 'PUT', url: `/v1/properties/${fx.propertyId}/cleaning-plan`,
      headers: auth(hausdame.sessionId), payload: { date: TAG, assignments: [] } })
    const n = await app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/cleaning-norms`, headers: auth(hausdame.sessionId),
      payload: { norms: [{ kind: 'stayover', categoryId: null, resourceId: zimmer[1],
                           minutes: 0 }] } })
    expect(n.statusCode).toBe(200)
    const r = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/cleaning-plan?date=${TAG}`,
      headers: auth(hausdame.sessionId) })
    const due = r.json().rooms.map((z: { code: string; due: string | null }) => [z.code, z.due])
    expect(due).toEqual([['101', 'departure'], ['102', null], ['103', 'stayover'], ['104', null]])
  })
})

describe('Maschinenzugang', () => {
  it('bekommt die Personal-App nicht als Zugriffsbereich', async () => {
    const chef = await makeUser(owner, { email: 'chef@kunde.de',
      accountId: fx.accountId, roleKey: 'owner' })
    const r = await app.inject({ method: 'POST', url: '/v1/oauth-clients',
      headers: auth(chef.sessionId), payload: { name: 'Kasse', scopes: ['staff:app'] } })
    expect(r.statusCode).toBe(422)
  })
})
