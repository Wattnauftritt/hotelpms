import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Arbeitszeit (Migration 0111, Baustein 6).
 *
 * Die Zeit eines Tages = gereinigte Zimmer + Zusatzarbeiten + Kueche +
 * Korrekturen. Die Kraft sieht nur sich und traegt nur heute und gestern
 * ein; die Leitung korrigiert mit Grund, schliesst ab und gibt aus. Ein
 * abgeschlossener Monat aendert sich nicht mehr.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: { userId: number; sessionId: string }
let hausdame: { userId: number; sessionId: string }
let anna: { userId: number; sessionId: string }
let olga: { userId: number; sessionId: string }
let koch: { userId: number; sessionId: string }
let zimmer: number[]

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
  zimmer = await makeResources(owner, fx.propertyId, kategorie, 3)
  chef = await makeUser(owner, { email: 'chef@kunde.de', propertyId: fx.propertyId,
    roleKey: 'hotel_director' })
  hausdame = await makeUser(owner, { email: 'hd@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping' })
  anna = await makeUser(owner, { email: 'anna@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping_staff' })
  olga = await makeUser(owner, { email: 'olga@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping_staff' })
  koch = await makeUser(owner, { email: 'koch@kunde.de', propertyId: fx.propertyId,
    roleKey: 'kitchen' })
  // Am 30.09. hat Anna zwei Zimmer gereinigt (30 + 30) und eines nicht
  // (Gast wollte nicht), am 01.10. eines.
  for (const [datum, liste] of [['2026-09-30', [0, 1, 2]], [TAG, [0]]] as const) {
    const r = await app.inject({ method: 'PUT', url: p('/cleaning-plan'),
      headers: auth(hausdame.sessionId), payload: { date: datum, assignments:
        liste.map(i => ({ resourceId: zimmer[i], kind: 'departure', assignedTo: anna.userId })) } })
    expect(r.statusCode).toBe(200)
  }
  await owner.query(
    `UPDATE housekeeping_task SET status = 'done', outcome = 'cleaned'
      WHERE assigned_to = $1 AND NOT (business_date = '2026-09-30' AND resource_id = $2)`,
    [anna.userId, zimmer[2]])
  await owner.query(
    `UPDATE housekeeping_task SET status = 'skipped', outcome = 'declined'
      WHERE business_date = '2026-09-30' AND resource_id = $1`, [zimmer[2]])
})

const eintragen = (session: string, payload: unknown) =>
  app.inject({ method: 'POST', url: p('/my-time'), headers: auth(session), payload })

describe('Meine Arbeitszeit', () => {
  it('rechnet Zimmer und Zusatzarbeit, nur Gereinigtes, und zeigt nur mich', async () => {
    const e = await eintragen(anna.sessionId,
      { date: '2026-09-30', kind: 'extra', description: 'Waesche gelegt', minutes: 25 })
    expect(e.statusCode).toBe(201)
    const sep = e.json()
    const tag = sep.days.find((d: { date: string }) => d.date === '2026-09-30')
    expect(tag).toMatchObject({ roomMinutes: 60, rooms: 2, total: 85 })
    expect(sep.totals).toMatchObject({ rooms: 60, extra: 25, total: 85 })
    expect(sep.days).toHaveLength(30)

    const olgas = await app.inject({ method: 'GET', url: p('/my-time?month=2026-09'),
      headers: auth(olga.sessionId) })
    expect(olgas.json().totals.total).toBe(0)
  })

  it('laesst nur heute und gestern selbst eintragen', async () => {
    const r = await eintragen(anna.sessionId,
      { date: '2026-09-29', kind: 'extra', description: 'x', minutes: 10 })
    expect(r.statusCode).toBe(422)
    expect(r.json().errorKeys.date).toContain('worktime.ownDays')
  })

  it('rechnet Kuechendienste ueber Mitternacht und nur fuer die Kueche', async () => {
    const r = await eintragen(koch.sessionId, { kind: 'kitchen', start: '22:00', end: '06:30' })
    expect(r.statusCode).toBe(201)
    expect(r.json().totals.kitchen).toBe(510)
    expect(r.json().days[0].entries[0]).toMatchObject({ start: '22:00', end: '06:30' })
    const nein = await eintragen(anna.sessionId, { kind: 'kitchen', start: '06:00', end: '10:00' })
    expect(nein.statusCode).toBe(403)
  })

  it('zieht zurueck, statt zu loeschen', async () => {
    const r = await eintragen(anna.sessionId, { kind: 'extra', description: 'Fenster', minutes: 15 })
    const id = r.json().days[0].entries[0].id
    const w = await app.inject({ method: 'POST', url: p(`/my-time/${id}/withdraw`),
      headers: auth(anna.sessionId) })
    expect(w.statusCode).toBe(200)
    expect(w.json().days[0].entries[0].withdrawn).toBe(true)
    expect(w.json().totals.extra).toBe(0)
    // Fremde Eintraege gibt es fuer Olga nicht.
    const f = await app.inject({ method: 'POST', url: p(`/my-time/${id}/withdraw`),
      headers: auth(olga.sessionId) })
    expect(f.statusCode).toBe(404)
  })
})

describe('Leitung', () => {
  it('sieht alle, die Hausdame niemanden', async () => {
    const r = await app.inject({ method: 'GET', url: p('/worktime?month=2026-09'),
      headers: auth(chef.sessionId) })
    expect(r.statusCode).toBe(200)
    const a = r.json().staff.find((k: { userId: number }) => k.userId === anna.userId)
    expect(a.totals.rooms).toBe(60)
    expect(a.days['2026-09-30']).toBe(60)
    expect(r.json().staff.map((k: { userId: number }) => k.userId))
      .toEqual(expect.arrayContaining([anna.userId, olga.userId, koch.userId]))

    const hd = await app.inject({ method: 'GET', url: p('/worktime?month=2026-09'),
      headers: auth(hausdame.sessionId) })
    expect(hd.statusCode).toBe(403)
  })

  it('korrigiert mit Grund, und die Kraft sieht es', async () => {
    const ohne = await app.inject({ method: 'POST', url: p('/worktime/corrections'),
      headers: auth(chef.sessionId),
      payload: { userId: anna.userId, date: '2026-09-15', minutes: -20, reason: ' ' } })
    expect(ohne.statusCode).toBe(422)
    const r = await app.inject({ method: 'POST', url: p('/worktime/corrections'),
      headers: auth(chef.sessionId),
      payload: { userId: anna.userId, date: '2026-09-15', minutes: -20,
                 reason: 'Zimmer 102 doppelt gezaehlt' } })
    expect(r.statusCode).toBe(201)
    const meins = await app.inject({ method: 'GET', url: p('/my-time?month=2026-09'),
      headers: auth(anna.sessionId) })
    const tag = meins.json().days.find((d: { date: string }) => d.date === '2026-09-15')
    expect(tag.entries[0]).toMatchObject({ kind: 'correction', minutes: -20,
      description: 'Zimmer 102 doppelt gezaehlt' })
    expect(meins.json().totals.total).toBe(40)
  })

  it('schliesst ab, gibt aus, sperrt den Monat und oeffnet mit Grund', async () => {
    const laeuft = await app.inject({ method: 'POST', url: p('/worktime/close'),
      headers: auth(chef.sessionId), payload: { month: '2026-10' } })
    expect(laeuft.statusCode).toBe(409)
    const vorher = await app.inject({ method: 'GET', url: p('/worktime/export?month=2026-09'),
      headers: auth(chef.sessionId) })
    expect(vorher.statusCode).toBe(409)

    await eintragen(anna.sessionId,
      { date: '2026-09-30', kind: 'extra', description: 'Flur gewischt', minutes: 5 })
    const zu = await app.inject({ method: 'POST', url: p('/worktime/close'),
      headers: auth(chef.sessionId), payload: { month: '2026-09' } })
    expect(zu.statusCode).toBe(200)
    expect(zu.json().closed).not.toBeNull()

    const csv = await app.inject({ method: 'GET', url: p('/worktime/export?month=2026-09'),
      headers: auth(chef.sessionId) })
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    const zeilen = csv.body.replace('﻿', '').trim().split('\r\n')
    expect(zeilen[0]).toContain('Summe Stunden')
    expect(zeilen.find(z => z.includes('2026-09-30'))!.split(';').slice(2))
      .toEqual(['2026-09-30', '2', '60', '5', '0', '0', '65', '1,08'])

    // Nichts mehr im September: keine Korrektur, kein Plan.
    const korr = await app.inject({ method: 'POST', url: p('/worktime/corrections'),
      headers: auth(chef.sessionId),
      payload: { userId: anna.userId, date: '2026-09-15', minutes: 10, reason: 'nachgetragen' } })
    expect(korr.statusCode).toBe(409)
    const plan = await app.inject({ method: 'PUT', url: p('/cleaning-plan'),
      headers: auth(hausdame.sessionId), payload: { date: '2026-09-30', assignments: [] } })
    expect(plan.statusCode).toBe(409)
    await expect(owner.query(`UPDATE staff_work_entry SET minutes = 99`)).rejects.toThrow()

    const ohne = await app.inject({ method: 'POST', url: p('/worktime/reopen'),
      headers: auth(chef.sessionId), payload: { month: '2026-09' } })
    expect(ohne.statusCode).toBe(422)
    const auf = await app.inject({ method: 'POST', url: p('/worktime/reopen'),
      headers: auth(chef.sessionId), payload: { month: '2026-09', reason: 'Nachtrag Zeitarbeit' } })
    expect(auf.statusCode).toBe(200)
    expect(auf.json().closed).toBeNull()
    const nachher = await app.inject({ method: 'POST', url: p('/worktime/corrections'),
      headers: auth(chef.sessionId),
      payload: { userId: anna.userId, date: '2026-09-15', minutes: 10, reason: 'nachgetragen' } })
    expect(nachher.statusCode).toBe(201)
  })

  it('zeigt einen Tag je Kraft mit Zimmern und Zusatzarbeiten', async () => {
    await eintragen(anna.sessionId,
      { date: '2026-09-30', kind: 'extra', description: 'Gelber Container', minutes: 25 })
    const r = await app.inject({ method: 'GET', url: p('/worktime/day?date=2026-09-30'),
      headers: auth(chef.sessionId) })
    expect(r.statusCode).toBe(200)
    // Nur wer an dem Tag etwas hat; Olga und der Koch stehen nicht da.
    expect(r.json().staff.map((k: { userId: number }) => k.userId)).toEqual([anna.userId])
    const a = r.json().staff[0]
    expect(a.rooms).toHaveLength(3)
    expect(a.rooms.map((z: { outcome: string }) => z.outcome).sort())
      .toEqual(['cleaned', 'cleaned', 'declined'])
    expect(a.entries[0]).toMatchObject({ description: 'Gelber Container', minutes: 25 })
    // Das abgelehnte Zimmer zaehlt nicht, wie im Monat.
    expect(a.totals).toMatchObject({ departure: 60, stayover: 0, extra: 25, total: 85 })

    const kaputt = await app.inject({ method: 'GET', url: p('/worktime/day?date=30.09.2026'),
      headers: auth(chef.sessionId) })
    expect(kaputt.statusCode).toBe(422)
    const hd = await app.inject({ method: 'GET', url: p('/worktime/day?date=2026-09-30'),
      headers: auth(hausdame.sessionId) })
    expect(hd.statusCode).toBe(403)
  })

  it('summiert die Monatshaelften fuer die Zeitarbeitsfirma', async () => {
    await app.inject({ method: 'POST', url: p('/worktime/corrections'),
      headers: auth(chef.sessionId),
      payload: { userId: anna.userId, date: '2026-09-15', minutes: 45, reason: 'Nachtrag' } })
    const r = await app.inject({ method: 'GET', url: p(`/worktime/${anna.userId}?month=2026-09`),
      headers: auth(chef.sessionId) })
    // Der 15. gehoert zur ersten Haelfte, der 30. zur zweiten.
    expect(r.json().halves).toEqual([
      { from: '2026-09-01', to: '2026-09-15', total: 45 },
      { from: '2026-09-16', to: '2026-09-30', total: 60 }])
    const meins = await app.inject({ method: 'GET', url: p('/my-time?month=2026-09'),
      headers: auth(anna.sessionId) })
    expect(meins.json().halves.map((h: { total: number }) => h.total)).toEqual([45, 60])
  })

  it('passt die Minuten einer Zusatzarbeit an, und die Kraft sieht, was sie hatte', async () => {
    const e = await eintragen(anna.sessionId,
      { kind: 'extra', description: 'Flur', minutes: 40 })
    const id = e.json().days[0].entries[0].id
    const anpassen = (minutes: number, session = chef.sessionId) =>
      app.inject({ method: 'PUT', url: p(`/worktime/entries/${id}`), headers: auth(session),
                   payload: { minutes } })

    const r = await anpassen(10)
    expect(r.statusCode).toBe(200)
    const eintrag = r.json().staff[0].entries[0]
    expect(eintrag).toMatchObject({ minutes: 10, originalMinutes: 40 })
    expect(eintrag.adjustedBy).not.toBeNull()
    expect(r.json().staff[0].totals.extra).toBe(10)
    // Eine zweite Anpassung laesst stehen, was die Kraft eingetragen hatte.
    expect((await anpassen(15)).json().staff[0].entries[0])
      .toMatchObject({ minutes: 15, originalMinutes: 40 })
    expect((await anpassen(0)).statusCode).toBe(422)
    expect((await anpassen(20, hausdame.sessionId)).statusCode).toBe(403)

    // Die Kraft sieht es und kippt es nicht mit einem Tipp.
    const meins = await app.inject({ method: 'GET', url: p('/my-time'),
      headers: auth(anna.sessionId) })
    expect(meins.json().days[0].entries[0]).toMatchObject({ minutes: 15, originalMinutes: 40 })
    const selbst = await app.inject({ method: 'PUT', url: p(`/my-time/${id}`),
      headers: auth(anna.sessionId), payload: { kind: 'extra', description: 'Flur', minutes: 40 } })
    expect(selbst.statusCode).toBe(409)
    expect(selbst.json().code).toBe('worktime.adjustedByLead')
    const zurueck = await app.inject({ method: 'POST', url: p(`/my-time/${id}/withdraw`),
      headers: auth(anna.sessionId) })
    expect(zurueck.statusCode).toBe(409)

    // Kuechendienste haben Beginn und Ende; dort bleibt die Korrektur.
    const k = await eintragen(koch.sessionId, { kind: 'kitchen', start: '06:00', end: '10:00' })
    const kid = k.json().days[0].entries[0].id
    const kueche = await app.inject({ method: 'PUT', url: p(`/worktime/entries/${kid}`),
      headers: auth(chef.sessionId), payload: { minutes: 60 } })
    expect(kueche.statusCode).toBe(409)
  })

  it('nimmt eine Zusatzarbeit heraus, und die Kraft sieht, von wem', async () => {
    const e = await eintragen(anna.sessionId,
      { kind: 'extra', description: 'Toilette', minutes: 10 })
    const id = e.json().days[0].entries[0].id
    const r = await app.inject({ method: 'POST', url: p(`/worktime/entries/${id}/withdraw`),
      headers: auth(chef.sessionId) })
    expect(r.statusCode).toBe(200)
    const a = r.json().staff[0]
    expect(a.entries[0].withdrawn).toBe(true)
    expect(a.entries[0].withdrawnBy).not.toBeNull()
    expect(a.totals.extra).toBe(0)
    const meins = await app.inject({ method: 'GET', url: p('/my-time'),
      headers: auth(anna.sessionId) })
    expect(meins.json().days[0].entries[0].withdrawnBy).not.toBeNull()
    // Zieht die Kraft selbst zurueck, steht kein fremder Name daran.
    const f = await eintragen(anna.sessionId, { kind: 'extra', description: 'Fenster', minutes: 5 })
    const fid = f.json().days[0].entries[1].id
    const w = await app.inject({ method: 'POST', url: p(`/my-time/${fid}/withdraw`),
      headers: auth(anna.sessionId) })
    expect(w.json().days[0].entries[1]).toMatchObject({ withdrawn: true, withdrawnBy: null })
  })

  it('kennt keine Kraft aus einem fremden Haus', async () => {
    const fremd = await makeProperty(owner, { name: 'Anderes' })
    const x = await makeUser(owner, { email: 'x@anders.de', propertyId: fremd.propertyId,
      roleKey: 'housekeeping_staff' })
    const r = await app.inject({ method: 'GET', url: p(`/worktime/${x.userId}?month=2026-09`),
      headers: auth(chef.sessionId) })
    expect(r.statusCode).toBe(404)
  })
})
