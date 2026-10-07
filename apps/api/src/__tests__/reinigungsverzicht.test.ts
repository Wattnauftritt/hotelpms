import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { CHECKIN_TOKEN_HEADER, checkinTokenAusFragment } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Reinigungsverzicht des Gastes (Baustein 10, Migration 0115): der Gast
 * ueber seinen Link, die Rezeption am Tresen, der Plan der Hausdame und das
 * Wasser der Kraft.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: { userId: number; sessionId: string }
let hausdame: { userId: number; sessionId: string }
let olga: { userId: number; sessionId: string }
let zimmer: number[]
let ref: string
let token: string

const TAG = '2026-10-01'
const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const p = (pfad: string) => `/v1/properties/${fx.propertyId}${pfad}`

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
  chef = await makeUser(owner, { email: 'chef@kunde.de', propertyId: fx.propertyId,
    roleKey: 'hotel_director' })
  hausdame = await makeUser(owner, { email: 'hd@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping' })
  olga = await makeUser(owner, { email: 'olga@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping_staff' })

  // Angereist am 30.09., reist am 04.10. ab: Bleibetage ab heute sind der
  // 01., 02. und 03.10.
  const r = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
    resourceId: zimmer[0], arrival: '2026-09-30', departure: '2026-10-04', status: 'InHouse',
    reserveInventory: false, withFolio: false })
  const g = await owner.query<{ id: number }>(
    `INSERT INTO guest (account_id, last_name, first_name, language)
     VALUES ($1, 'Petersen', 'Anna', 'de') RETURNING id`, [fx.accountId])
  await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
    [r.reservationId, g.rows[0]!.id])
  ref = (await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [r.reservationId])).rows[0]!.public_ref
  const l = await app.inject({ method: 'POST', url: `/v1/reservations/${ref}/online-checkin/link`,
    headers: auth(chef.sessionId) })
  expect(l.statusCode, l.body).toBe(201)
  const link = l.json<{ link: string }>().link
  token = checkinTokenAusFragment(link.slice(link.indexOf('#')))!
})

const einstellen = (enabled: boolean, waterGift: boolean) =>
  app.inject({ method: 'PUT', url: p('/cleaning-waiver-settings'), headers: auth(hausdame.sessionId),
    payload: { enabled, waterGift } })
const gast = (date: string, waived: boolean) =>
  app.inject({ method: 'POST', url: '/v1/checkin/cleaning-waiver',
    headers: { [CHECKIN_TOKEN_HEADER]: token }, payload: { date, waived } })
const formular = async () => {
  const r = await app.inject({ method: 'GET', url: '/v1/checkin/form',
    headers: { [CHECKIN_TOKEN_HEADER]: token } })
  expect(r.statusCode, r.body).toBe(200)
  return r.json<{ cleaningWaiver: unknown }>().cleaningWaiver
}
const planZimmer = async (date: string) => {
  const r = await app.inject({ method: 'GET', url: p(`/cleaning-plan?date=${date}`),
    headers: auth(hausdame.sessionId) })
  expect(r.statusCode).toBe(200)
  return r.json<{ rooms: Array<{ resourceId: number; due: string | null; waived: boolean }> }>()
    .rooms.find(z => z.resourceId === zimmer[0])!
}

describe('Reinigungsverzicht', () => {
  it('gibt es nur, wenn das Haus ihn anbietet', async () => {
    expect(await formular()).toBeNull()
    expect((await gast('2026-10-02', true)).statusCode).toBe(422)
    const d = await app.inject({ method: 'GET', url: `/v1/reservations/${ref}`,
      headers: auth(chef.sessionId) })
    expect(d.json().cleaningWaiver).toBeNull()
  })

  it('setzt der Gast fuer Bleibetage, und ohne Wasser faellt das Zimmer aus dem Plan', async () => {
    expect((await einstellen(true, false)).statusCode).toBe(200)
    expect(await formular()).toEqual({ waterGift: false, mayEdit: true, days: [
      { date: '2026-10-01', waived: false, locked: false },
      { date: '2026-10-02', waived: false, locked: false },
      { date: '2026-10-03', waived: false, locked: false }] })

    const r = await gast('2026-10-02', true)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().days[1]).toEqual({ date: '2026-10-02', waived: true, locked: false })
    // Abreisetag und vergangene Tage gehen nicht.
    expect((await gast('2026-10-04', true)).statusCode).toBe(422)
    expect((await gast('2026-09-30', true)).statusCode).toBe(422)

    expect(await planZimmer('2026-10-02')).toMatchObject({ due: null, waived: true })
    expect(await planZimmer('2026-10-03')).toMatchObject({ due: 'stayover', waived: false })

    // Die Rezeption sieht es im Seitenfenster und nimmt es fuer den Gast zurueck.
    const d = await app.inject({ method: 'GET', url: `/v1/reservations/${ref}`,
      headers: auth(chef.sessionId) })
    expect(d.json().cleaningWaiver.days[1].waived).toBe(true)
    const z = await app.inject({ method: 'PUT', url: `/v1/reservations/${ref}/cleaning-waiver`,
      headers: auth(chef.sessionId), payload: { date: '2026-10-02', waived: false } })
    expect(z.statusCode, z.body).toBe(200)
    expect(await planZimmer('2026-10-02')).toMatchObject({ due: 'stayover', waived: false })
    // Zurueckgenommen, nicht geloescht.
    const { rows } = await owner.query<{ source: string; zurueck: boolean }>(
      `SELECT source, withdrawn_at IS NOT NULL AS zurueck FROM cleaning_waiver`)
    expect(rows).toEqual([{ source: 'guest', zurueck: true }])
  })

  it('mit Wasser hakt die Kraft die Flasche ab, und danach ist der Tag gesperrt', async () => {
    await einstellen(true, true)
    expect((await gast(TAG, true)).statusCode).toBe(200)
    expect(await planZimmer(TAG)).toMatchObject({ due: 'stayover', waived: true })
    const plan = await app.inject({ method: 'PUT', url: p('/cleaning-plan'),
      headers: auth(hausdame.sessionId), payload: { date: TAG, assignments: [
        { resourceId: zimmer[0], kind: 'stayover', assignedTo: olga.userId }] } })
    expect(plan.statusCode, plan.body).toBe(200)

    const meine = await app.inject({ method: 'GET', url: p('/my-rooms'), headers: auth(olga.sessionId) })
    const zimmer0 = meine.json().rooms[0]
    expect(zimmer0.waiver).toEqual({ water: true, delivered: false })

    const w = await app.inject({ method: 'POST', url: p(`/my-rooms/${zimmer0.taskId}/water`),
      headers: auth(olga.sessionId) })
    expect(w.statusCode, w.body).toBe(200)
    expect(w.json().rooms[0]).toMatchObject({ outcome: 'declined', status: 'skipped',
      waiver: { water: true, delivered: true } })
    expect(w.json().minutes).toBe(0)

    expect((await gast(TAG, false)).statusCode).toBe(409)
    expect((await formular() as { days: unknown[] }).days[0])
      .toEqual({ date: TAG, waived: true, locked: true })
  })

  it('ohne Wasser gibt es nichts abzuhaken, und die Kraft setzt nichts am Tresen', async () => {
    await einstellen(true, false)
    await gast(TAG, true)
    const plan = await app.inject({ method: 'PUT', url: p('/cleaning-plan'),
      headers: auth(hausdame.sessionId), payload: { date: TAG, assignments: [
        { resourceId: zimmer[0], kind: 'stayover', assignedTo: olga.userId }] } })
    expect(plan.statusCode).toBe(200)
    const meine = await app.inject({ method: 'GET', url: p('/my-rooms'), headers: auth(olga.sessionId) })
    const t = meine.json().rooms[0]
    expect(t.waiver).toEqual({ water: false, delivered: false })
    expect((await app.inject({ method: 'POST', url: p(`/my-rooms/${t.taskId}/water`),
      headers: auth(olga.sessionId) })).statusCode).toBe(422)

    expect((await app.inject({ method: 'PUT', url: `/v1/reservations/${ref}/cleaning-waiver`,
      headers: auth(olga.sessionId), payload: { date: '2026-10-02', waived: true } })).statusCode)
      .toBe(403)
    expect((await app.inject({ method: 'PUT', url: p('/cleaning-waiver-settings'),
      headers: auth(olga.sessionId), payload: { enabled: false, waterGift: false } })).statusCode)
      .toBe(403)
  })
})
