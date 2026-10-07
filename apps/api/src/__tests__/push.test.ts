import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Push an das Personal (0113, Baustein 8) -- die Seite der API und der
 * Datenbank: wer ein Telefon anmelden darf, wohin, und wann eine Meldung
 * eingereiht wird. Das Senden prueft `apps/worker/src/__tests__/staffPush.test.ts`.
 */

// Vor dem Aufbau der Routen: die Route liest die Konfiguration beim Anlegen.
process.env.VAPID_PUBLIC_KEY = 'BOeffentlicherTestschluessel'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let hausdame: { userId: number; sessionId: string }
let olga: { userId: number; sessionId: string }
let anna: { userId: number; sessionId: string }
let zimmer: number[]
let abreise: number

const TAG = '2026-10-01'
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/geraet-1'
const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
               auth: 'tBHItJI5svbpez7KI4CCXg' }
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
  hausdame = await makeUser(owner, { email: 'hd@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping' })
  olga = await makeUser(owner, { email: 'olga@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping_staff' })
  anna = await makeUser(owner, { email: 'anna@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping_staff' })
  abreise = (await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
    resourceId: zimmer[0], arrival: '2026-09-28', departure: TAG, status: 'InHouse',
    reserveInventory: false, withFolio: false })).reservationId
})

const meldungen = async () => (await owner.query<{ user_id: number; kind: string
                                                   params: Record<string, string> }>(
  `SELECT user_id::int, kind, params FROM staff_push WHERE status = 'pending'
    ORDER BY id`)).rows

const planen = (zuteilung: Array<[number, number | null]>) =>
  app.inject({ method: 'PUT', url: p('/cleaning-plan'), headers: auth(hausdame.sessionId),
    payload: { date: TAG, assignments: zuteilung.map(([i, wer]) =>
      ({ resourceId: zimmer[i], kind: 'departure', assignedTo: wer })) } })

describe('Telefon anmelden', () => {
  it('gibt den Schluessel und nimmt nur Adressen der Browserhersteller', async () => {
    const k = await app.inject({ method: 'GET', url: p('/push'), headers: auth(olga.sessionId) })
    expect(k.json()).toEqual({ publicKey: 'BOeffentlicherTestschluessel' })

    for (const endpoint of ['https://169.254.169.254/latest/meta-data/',
                            'http://fcm.googleapis.com/fcm/send/x', 'https://intern.local/x']) {
      const r = await app.inject({ method: 'POST', url: p('/push'), headers: auth(olga.sessionId),
        payload: { endpoint, keys: KEYS } })
      expect(r.statusCode, endpoint).toBe(422)
    }
    const ok = await app.inject({ method: 'POST', url: p('/push'), headers: auth(olga.sessionId),
      payload: { endpoint: ENDPOINT, keys: KEYS } })
    expect(ok.statusCode).toBe(201)
    const { rows } = await owner.query<{ user_id: number; session_id: string }>(
      'SELECT user_id::int, session_id FROM push_subscription')
    expect(rows).toEqual([{ user_id: olga.userId, session_id: olga.sessionId }])
  })

  it('gibt dasselbe Telefon an die naechste Person weiter und verliert es beim Abmelden', async () => {
    for (const s of [olga, anna]) {
      const r = await app.inject({ method: 'POST', url: p('/push'), headers: auth(s.sessionId),
        payload: { endpoint: ENDPOINT, keys: KEYS } })
      expect(r.statusCode).toBe(201)
    }
    const nach = await owner.query<{ user_id: number }>('SELECT user_id::int FROM push_subscription')
    expect(nach.rows).toEqual([{ user_id: anna.userId }])

    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: auth(anna.sessionId) })
    expect((await owner.query('SELECT 1 FROM push_subscription')).rowCount).toBe(0)
  })

  it('schaltet aus, aber nur das eigene', async () => {
    await app.inject({ method: 'POST', url: p('/push'), headers: auth(olga.sessionId),
      payload: { endpoint: ENDPOINT, keys: KEYS } })
    await app.inject({ method: 'POST', url: p('/push/off'), headers: auth(anna.sessionId),
      payload: { endpoint: ENDPOINT } })
    expect((await owner.query('SELECT 1 FROM push_subscription')).rowCount).toBe(1)
    const r = await app.inject({ method: 'POST', url: p('/push/off'), headers: auth(olga.sessionId),
      payload: { endpoint: ENDPOINT } })
    expect(r.statusCode).toBe(200)
    expect((await owner.query('SELECT 1 FROM push_subscription')).rowCount).toBe(0)
  })
})

describe('Anlaesse', () => {
  it('meldet einen geaenderten Plan an alle Betroffenen, einmal', async () => {
    expect((await planen([[0, olga.userId], [1, olga.userId]])).statusCode).toBe(200)
    expect(await meldungen()).toEqual([{ user_id: olga.userId, kind: 'plan', params: { date: TAG } }])

    // Dasselbe noch einmal gespeichert: nichts Neues, und keine zweite Meldung.
    await owner.query(`UPDATE staff_push SET status = 'sent'`)
    await planen([[0, olga.userId], [1, olga.userId]])
    expect(await meldungen()).toEqual([])

    // Ein Zimmer wandert von Olga zu Anna: beide erfahren es.
    await planen([[0, olga.userId], [1, anna.userId]])
    expect((await meldungen()).map(m => m.user_id).sort()).toEqual(
      [olga.userId, anna.userId].sort())
    await planen([[0, olga.userId], [1, olga.userId]])
    expect(await meldungen()).toHaveLength(2)
  })

  it('meldet das frei gewordene Zimmer, sobald der letzte Gast abreist', async () => {
    await planen([[0, olga.userId], [1, olga.userId]])
    await owner.query(`DELETE FROM staff_push`)
    await owner.query(`UPDATE reservation SET status = 'CheckedOut' WHERE id = $1`, [abreise])
    const m = await meldungen()
    expect(m).toEqual([{ user_id: olga.userId, kind: 'room_free', params: { room: expect.any(String) } }])
    // Eine weitere Aenderung an derselben Reservierung meldet nichts mehr.
    await owner.query(`UPDATE reservation SET status = 'CheckedOut' WHERE id = $1`, [abreise])
    expect(await meldungen()).toHaveLength(1)
  })

  it('meldet nacharbeiten an die Kraft des Zimmers', async () => {
    await planen([[0, olga.userId]])
    await owner.query(`DELETE FROM staff_push`)
    await owner.query(`UPDATE reservation SET status = 'CheckedOut' WHERE id = $1`, [abreise])
    await owner.query(`DELETE FROM staff_push`)
    const meine = await app.inject({ method: 'GET', url: p('/my-rooms'), headers: auth(olga.sessionId) })
    const taskId = meine.json().rooms[0].taskId as number
    await app.inject({ method: 'POST', url: p(`/my-rooms/${taskId}`), headers: auth(olga.sessionId),
      payload: { outcome: 'cleaned' } })
    const r = await app.inject({ method: 'POST', url: p(`/inspection/${taskId}`),
      headers: auth(hausdame.sessionId), payload: { result: 'rework', note: 'Spiegel' } })
    expect(r.statusCode).toBe(200)
    expect(await meldungen()).toEqual([
      { user_id: olga.userId, kind: 'rework', params: { room: meine.json().rooms[0].code } }])
  })
})
