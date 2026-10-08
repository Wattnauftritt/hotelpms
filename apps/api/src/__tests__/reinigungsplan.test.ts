import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Reinigungsplan (Migration 0106, Baustein 2 des Personalsystems).
 *
 * Geprueft wird, was an Geld haengt: die Minuten werden beim Planen
 * festgeschrieben, eine erledigte Reinigung bleibt bei der Kraft, die sie
 * gemacht hat, jede Aenderung steht im Verlauf -- und nur Reinigungskraefte
 * dieses Hauses bekommen Zimmer.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let hausdame: { userId: number; sessionId: string }
let anna: { userId: number }
let olga: { userId: number }
let zimmer: number[]
let kategorie: number

const TAG = '2026-10-01'
const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const url = (pfad = '') => `/v1/properties/${fx.propertyId}/cleaning-plan${pfad}`

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
  // Zimmer 101 und 102 reisen ab, 103 bleibt, 104 ist leer.
  for (const [i, an, ab] of [[0, '2026-09-28', TAG], [1, '2026-09-29', TAG],
                             [2, '2026-09-30', '2026-10-03']] as const) {
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
      resourceId: zimmer[i], arrival: an, departure: ab, status: 'InHouse',
      reserveInventory: false, withFolio: false })
  }
})

const lies = () => app.inject({ method: 'GET', url: url(`?date=${TAG}`),
  headers: auth(hausdame.sessionId) })
const speichern = (assignments: unknown, session = hausdame.sessionId) =>
  app.inject({ method: 'PUT', url: url(), headers: auth(session),
    payload: { date: TAG, assignments } })

describe('Reinigungsplan lesen', () => {
  it('zeigt Abreisen, Bleiber und Kraefte in einem Aufruf', async () => {
    const r = await lies()
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.date).toBe(TAG)
    expect(b.rooms.map((z: { code: string; due: string | null; minutes: number }) =>
      [z.code, z.due, z.minutes])).toEqual([
      ['101', 'departure', 30], ['102', 'departure', 30],
      ['103', 'stayover', 10], ['104', null, 0]])
    expect(b.staff.map((k: { userId: number }) => k.userId).sort())
      .toEqual([anna.userId, olga.userId].sort())
  })

  it('bleibt der Rezeption verschlossen', async () => {
    const rezeption = await makeUser(owner, { email: 'rez@kunde.de',
      propertyId: fx.propertyId, roleKey: 'reception' })
    const r = await app.inject({ method: 'GET', url: url(),
      headers: auth(rezeption.sessionId) })
    expect(r.statusCode).toBe(403)
  })
})

describe('Sollminuten', () => {
  it('nimmt Zimmer vor Kategorie vor Haus und haelt geplante Minuten fest', async () => {
    const n = await app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/cleaning-norms`, headers: auth(hausdame.sessionId),
      payload: { norms: [
        { kind: 'departure', categoryId: null, resourceId: null, minutes: 25 },
        { kind: 'departure', categoryId: kategorie, resourceId: null, minutes: 35 },
        { kind: 'departure', categoryId: null, resourceId: zimmer[0], minutes: 60 }
      ] } })
    expect(n.statusCode).toBe(200)

    const s = await speichern([
      { resourceId: zimmer[0], kind: 'departure', assignedTo: anna.userId },
      { resourceId: zimmer[1], kind: 'departure', assignedTo: anna.userId }])
    expect(s.statusCode).toBe(200)
    const geplant = s.json().rooms.slice(0, 2).map((z: { minutes: number }) => z.minutes)
    expect(geplant).toEqual([60, 35])

    // Spaeter geaenderte Sollminuten verschieben den geplanten Tag nicht.
    await app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/cleaning-norms`, headers: auth(hausdame.sessionId),
      payload: { norms: [] } })
    const nochmal = await speichern([
      { resourceId: zimmer[0], kind: 'departure', assignedTo: olga.userId },
      { resourceId: zimmer[1], kind: 'departure', assignedTo: anna.userId }])
    expect(nochmal.json().rooms.slice(0, 2).map((z: { minutes: number }) => z.minutes))
      .toEqual([60, 35])
  })

  it('weist Kategorie und Zimmer zugleich ab', async () => {
    const r = await app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/cleaning-norms`, headers: auth(hausdame.sessionId),
      payload: { norms: [{ kind: 'stayover', categoryId: kategorie,
                           resourceId: zimmer[0], minutes: 5 }] } })
    expect(r.statusCode).toBe(422)
    expect(r.json().errorKeys.resourceId).toContain('cleaning.normTarget')
  })
})

describe('Zuteilen', () => {
  it('schlaegt gleich viele Abreisen vor, dann Bleiber zur kuerzeren Gesamtzeit', async () => {
    const r = await app.inject({ method: 'POST', url: url('/suggest'),
      headers: auth(hausdame.sessionId),
      payload: { date: TAG, staff: [anna.userId, olga.userId] } })
    expect(r.statusCode).toBe(200)
    // Je eine Abreise; der Bleiber geht bei Gleichstand an die vordere.
    expect(r.json().assignments).toEqual([
      { resourceId: zimmer[0], kind: 'departure', assignedTo: anna.userId },
      { resourceId: zimmer[1], kind: 'departure', assignedTo: olga.userId },
      { resourceId: zimmer[2], kind: 'stayover', assignedTo: anna.userId }])
    // Nur ein Vorschlag: gespeichert ist nichts.
    const t = await owner.query(`SELECT 1 FROM housekeeping_task`)
    expect(t.rowCount).toBe(0)
  })

  it('gibt Zimmer nur an Reinigungskraefte dieses Hauses', async () => {
    const r = await speichern([
      { resourceId: zimmer[0], kind: 'departure', assignedTo: hausdame.userId }])
    expect(r.statusCode).toBe(422)
    expect(r.json().errorKeys.assignedTo).toContain('cleaning.notStaff')

    const anderesHaus = await makeProperty(owner, { name: 'Neptun', code: 'NEP' })
    const fremd = await makeUser(owner, { email: 'fremd@kunde.de',
      propertyId: anderesHaus.propertyId, roleKey: 'housekeeping_staff' })
    const f = await speichern([
      { resourceId: zimmer[0], kind: 'departure', assignedTo: fremd.userId }])
    expect(f.statusCode).toBe(422)
  })

  it('ersetzt offene Aufgaben, laesst erledigte aber bei ihrer Kraft', async () => {
    await speichern([
      { resourceId: zimmer[0], kind: 'departure', assignedTo: anna.userId },
      { resourceId: zimmer[2], kind: 'stayover', assignedTo: anna.userId }])
    await owner.query(`UPDATE housekeeping_task SET status = 'done', done_at = now()
                        WHERE resource_id = $1`, [zimmer[0]])

    const umteilen = await speichern([
      { resourceId: zimmer[0], kind: 'departure', assignedTo: olga.userId }])
    expect(umteilen.statusCode).toBe(409)
    expect(umteilen.json().code).toBe('cleaning.taskDone')

    // Ohne 103 gespeichert: die offene Bleiberaufgabe faellt weg.
    const ok = await speichern([
      { resourceId: zimmer[0], kind: 'departure', assignedTo: anna.userId }])
    expect(ok.statusCode).toBe(200)
    const offen = await owner.query(`SELECT resource_id FROM housekeeping_task`)
    expect(offen.rows.map(r => Number(r.resource_id))).toEqual([zimmer[0]])
  })

  it('schreibt jede Aenderung mit Wer und Wann in den Verlauf', async () => {
    await speichern([{ resourceId: zimmer[0], kind: 'departure', assignedTo: anna.userId }])
    await speichern([{ resourceId: zimmer[0], kind: 'departure', assignedTo: olga.userId }])
    // Unveraendert gespeichert hinterlaesst nichts.
    await speichern([{ resourceId: zimmer[0], kind: 'departure', assignedTo: olga.userId }])
    await speichern([])

    const v = (await lies()).json().log as Array<{ action: string; assignedFrom: number | null
      assignedTo: number | null; changedBy: string }>
    expect(v.map(e => [e.action, e.assignedFrom, e.assignedTo])).toEqual([
      ['deleted', olga.userId, null],
      ['changed', anna.userId, olga.userId],
      ['created', null, anna.userId]])
    expect(v.every(e => e.changedBy === 'hausdame@kunde.de')).toBe(true)

    // Der Verlauf ist nur anzuhaengen, auch fuer die Anwendung.
    const client = await pool.connect()
    try {
      await expect(client.query(`DELETE FROM housekeeping_task_log`)).rejects.toThrow()
    } finally { client.release() }
  })

  it('weist ein Zimmer aus dem Nachbarhaus ab', async () => {
    const anderesHaus = await makeProperty(owner, { name: 'Neptun', code: 'NEP' })
    const k = await makeCategory(owner, anderesHaus.propertyId)
    const [fremdesZimmer] = await makeResources(owner, anderesHaus.propertyId, k, 1, 'N')
    const r = await speichern([
      { resourceId: fremdesZimmer, kind: 'departure', assignedTo: anna.userId }])
    expect(r.statusCode).toBe(404)
  })
})

describe('Kalender aendert sich nach dem Speichern', () => {
  it('folgt einer frueheren Abreise, bis die Hausdame speichert', async () => {
    // 103 ist als Bleiber geplant; dann reist der Gast doch heute ab.
    expect((await speichern([
      { resourceId: zimmer[2], kind: 'stayover', assignedTo: anna.userId }])).statusCode).toBe(200)
    await owner.query(`UPDATE reservation SET departure = $2::date WHERE resource_id = $1`,
      [zimmer[2], TAG])

    const vorher = (await lies()).json().rooms.find(
      (z: { resourceId: number }) => z.resourceId === zimmer[2])
    expect(vorher).toMatchObject({ due: 'departure', kind: 'departure', kindChanged: true,
                                   minutes: 30, assignedTo: anna.userId })

    expect((await speichern([
      { resourceId: zimmer[2], kind: 'departure', assignedTo: anna.userId }])).statusCode).toBe(200)
    const { rows } = await owner.query<{ kind: string; minutes: number }>(
      `SELECT kind, minutes FROM housekeeping_task WHERE resource_id = $1`, [zimmer[2]])
    expect(rows).toEqual([{ kind: 'departure', minutes: 30 }])
    const nachher = (await lies()).json().rooms.find(
      (z: { resourceId: number }) => z.resourceId === zimmer[2])
    expect(nachher.kindChanged).toBe(false)
  })

  it('laesst eine erledigte Aufgabe, wie sie ist', async () => {
    await speichern([{ resourceId: zimmer[2], kind: 'stayover', assignedTo: anna.userId }])
    await owner.query(`UPDATE housekeeping_task SET status = 'done', outcome = 'cleaned',
                         done_at = now() WHERE resource_id = $1`, [zimmer[2]])
    await owner.query(`UPDATE reservation SET departure = $2::date WHERE resource_id = $1`,
      [zimmer[2], TAG])
    const z = (await lies()).json().rooms.find(
      (x: { resourceId: number }) => x.resourceId === zimmer[2])
    expect(z).toMatchObject({ kind: 'stayover', kindChanged: false, minutes: 10 })
  })
})
