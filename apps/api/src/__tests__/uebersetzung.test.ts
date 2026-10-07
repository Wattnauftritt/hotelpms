import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Uebersetzung der Personaltexte (0112, Baustein 7) -- die Seite der API:
 * was eingereiht wird, was nicht, und dass eine Uebersetzung nur zum Text
 * gehoert, fuer den sie entstand. Den Worker prueft
 * `apps/worker/src/__tests__/staffTranslation.test.ts`.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: { userId: number; sessionId: string }
let hausdame: { userId: number; sessionId: string }
let olga: { userId: number; sessionId: string }
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
  zimmer = await makeResources(owner, fx.propertyId, kategorie, 2)
  chef = await makeUser(owner, { email: 'chef@kunde.de', propertyId: fx.propertyId,
    roleKey: 'hotel_director' })
  hausdame = await makeUser(owner, { email: 'hd@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping' })
  olga = await makeUser(owner, { email: 'olga@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping_staff' })
  await owner.query(`UPDATE app_user SET locale = 'ru' WHERE id = $1`, [olga.userId])
})

const auftraege = async () => (await owner.query<{ source_kind: string; source_id: number
                                                   targets: string[]; status: string }>(
  `SELECT source_kind, source_id::int, targets, status FROM staff_text_job ORDER BY id`)).rows

async function uebersetzt(kind: string, id: number, lang: string, text: string,
                          quelle: string): Promise<void> {
  await owner.query(
    `INSERT INTO staff_text_translation (property_id, source_kind, source_id, source_hash,
                                         source_lang, lang, text, origin)
     VALUES ($1, $2, $3, digest($4::text, 'sha256'), 'ru', $5, $6, 'machine')`,
    [fx.propertyId, kind, id, quelle, lang, text])
}

describe('Einreihen', () => {
  it('reiht einen Eintrag der Kraft nach Deutsch ein, einen Kuechendienst ohne Text nicht', async () => {
    const r = await app.inject({ method: 'POST', url: p('/my-time'), headers: auth(olga.sessionId),
      payload: { date: TAG, kind: 'extra', description: 'Сложила бельё', minutes: 20 } })
    expect(r.statusCode).toBe(201)
    const id = r.json().days.find((d: { date: string }) => d.date === TAG).entries[0].id
    expect(await auftraege()).toEqual([
      { source_kind: 'work_entry', source_id: id, targets: ['de'], status: 'pending' }])

    // Neu eingereiht wird nur, wenn sich der Text aendert -- und dann als
    // derselbe Auftrag, zurueckgesetzt.
    await owner.query(`UPDATE staff_text_job SET status = 'done'`)
    const minuten = await app.inject({ method: 'PUT', url: p(`/my-time/${id}`),
      headers: auth(olga.sessionId),
      payload: { date: TAG, kind: 'extra', description: 'Сложила бельё', minutes: 30 } })
    expect(minuten.statusCode).toBe(200)
    expect((await auftraege())[0]!.status).toBe('done')
    await app.inject({ method: 'PUT', url: p(`/my-time/${id}`), headers: auth(olga.sessionId),
      payload: { date: TAG, kind: 'extra', description: 'Сложила полотенца', minutes: 30 } })
    expect(await auftraege()).toHaveLength(1)
    expect((await auftraege())[0]!.status).toBe('pending')
  })

  it('schickt nichts an DeepL, wer Deutsch gewaehlt hat', async () => {
    await owner.query(`UPDATE app_user SET locale = 'de' WHERE id = $1`, [olga.userId])
    const r = await app.inject({ method: 'POST', url: p('/my-time'), headers: auth(olga.sessionId),
      payload: { date: TAG, kind: 'extra', description: 'Waesche gelegt', minutes: 20 } })
    expect(r.statusCode).toBe(201)
    expect(await auftraege()).toEqual([])
  })

  it('reiht die Notiz der Hausdame in der Sprache der Kraft ein und das Problem nach Deutsch', async () => {
    const plan = await app.inject({ method: 'PUT', url: p('/cleaning-plan'),
      headers: auth(hausdame.sessionId), payload: { date: TAG, assignments:
        [{ resourceId: zimmer[0], kind: 'departure', assignedTo: olga.userId }] } })
    expect(plan.statusCode).toBe(200)
    const meine = await app.inject({ method: 'GET', url: p('/my-rooms'), headers: auth(olga.sessionId) })
    const taskId = meine.json().rooms[0].taskId as number

    const problem = await app.inject({ method: 'POST', url: p(`/my-rooms/${taskId}/problem`),
      headers: auth(olga.sessionId), payload: { text: 'Кран капает' } })
    expect(problem.statusCode).toBe(201)
    const ticketId = problem.json().ticketId as number

    await app.inject({ method: 'POST', url: p(`/my-rooms/${taskId}`),
      headers: auth(olga.sessionId), payload: { outcome: 'cleaned' } })
    const k = await app.inject({ method: 'POST', url: p(`/inspection/${taskId}`),
      headers: auth(hausdame.sessionId), payload: { result: 'rework', note: 'Spiegel streifig' } })
    expect(k.statusCode).toBe(200)

    expect(await auftraege()).toEqual([
      { source_kind: 'problem', source_id: ticketId, targets: ['de'], status: 'pending' },
      { source_kind: 'inspection_note', source_id: taskId, targets: ['ru'], status: 'pending' }])

    // Sobald uebersetzt: die Kraft liest russisch, die Wartung deutsch.
    await uebersetzt('inspection_note', taskId, 'ru', 'Зеркало в разводах', 'Spiegel streifig')
    await uebersetzt('problem', ticketId, 'de', 'Wasserhahn tropft', 'Кран капает')
    const danach = await app.inject({ method: 'GET', url: p('/my-rooms'), headers: auth(olga.sessionId) })
    expect(danach.json().rooms[0]).toMatchObject({
      inspectionNote: 'Spiegel streifig', inspectionNoteTranslated: 'Зеркало в разводах' })
    const wartung = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/maintenance-tickets`, headers: auth(chef.sessionId) })
    expect(wartung.statusCode).toBe(200)
    expect(wartung.json().tickets[0]).toMatchObject({ translationDe: 'Wasserhahn tropft' })

    // Eine neue Notiz macht die alte Uebersetzung wertlos -- sie verschwindet,
    // bis der Worker die neue geliefert hat.
    await app.inject({ method: 'POST', url: p(`/inspection/${taskId}`),
      headers: auth(hausdame.sessionId), payload: { result: 'rework', note: 'Bad nass wischen' } })
    const neu = await app.inject({ method: 'GET', url: p('/my-rooms'), headers: auth(olga.sessionId) })
    expect(neu.json().rooms[0]).toMatchObject({
      inspectionNote: 'Bad nass wischen', inspectionNoteTranslated: null })
  })
})

describe('Berichtigung von Hand', () => {
  it('zeigt der Leitung Deutsch, nimmt eine Berichtigung an und gibt sie an DeepL zurueck', async () => {
    const r = await app.inject({ method: 'POST', url: p('/my-time'), headers: auth(olga.sessionId),
      payload: { date: TAG, kind: 'extra', description: 'Сложила бельё', minutes: 20 } })
    const id = r.json().days.find((d: { date: string }) => d.date === TAG).entries[0].id as number
    await uebersetzt('work_entry', id, 'de', 'Waesche zusammengelegt', 'Сложила бельё')
    await owner.query(`UPDATE staff_text_job SET status = 'done'`)

    const eintrag = async () => {
      const m = await app.inject({ method: 'GET', url: p(`/worktime/${olga.userId}?month=2026-10`),
        headers: auth(chef.sessionId) })
      expect(m.statusCode).toBe(200)
      return m.json().days.find((d: { date: string }) => d.date === TAG).entries[0]
    }
    expect(await eintrag()).toMatchObject({
      translationDe: 'Waesche zusammengelegt', translationManual: false })

    const url = p(`/worktime/entries/${id}/translation`)
    // Die Kraft selbst darf das nicht, die Hausdame auch nicht.
    for (const s of [olga, hausdame]) {
      const nein = await app.inject({ method: 'PUT', url, headers: auth(s.sessionId),
        payload: { text: 'x' } })
      expect(nein.statusCode).toBe(403)
    }
    const hand = await app.inject({ method: 'PUT', url, headers: auth(chef.sessionId),
      payload: { text: 'Bettwaesche gelegt' } })
    expect(hand.statusCode).toBe(200)
    expect(await eintrag()).toMatchObject({
      translationDe: 'Bettwaesche gelegt', translationManual: true })

    const zurueck = await app.inject({ method: 'PUT', url, headers: auth(chef.sessionId),
      payload: { text: null } })
    expect(zurueck.statusCode).toBe(200)
    expect(await eintrag()).toMatchObject({ translationDe: null, translationManual: false })
    expect((await auftraege())[0]).toMatchObject({ status: 'pending', targets: ['de'] })
  })

  it('verweist auf eine Korrektur der Leitung nicht -- die ist schon deutsch', async () => {
    const k = await app.inject({ method: 'POST', url: p('/worktime/corrections'),
      headers: auth(chef.sessionId),
      payload: { userId: olga.userId, date: TAG, minutes: 10, reason: 'Nachtrag' } })
    expect(k.statusCode).toBe(201)
    const id = k.json().days.find((d: { date: string }) => d.date === TAG).entries[0].id
    const r = await app.inject({ method: 'PUT', url: p(`/worktime/entries/${id}/translation`),
      headers: auth(chef.sessionId), payload: { text: 'x' } })
    expect(r.statusCode).toBe(404)
    expect(await auftraege()).toEqual([])
  })
})
