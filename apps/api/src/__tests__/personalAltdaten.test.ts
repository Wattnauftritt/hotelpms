import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { legacyChecksum } from '@hotelpms/domain'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Altdaten der alten Personal-App (Baustein 9, Dokument 34, Migration 0114):
 * Trockenlauf, Zuordnung, Ersetzen ganzer Tage, StayGrid gewinnt,
 * abgeschlossene Monate bleiben unberuehrt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: { userId: number; sessionId: string }
let hausdame: { userId: number; sessionId: string }
let olga: { userId: number; sessionId: string }
let codes: string[]
let zimmer: number[]

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const URL_ = () => `/v1/properties/${fx.propertyId}/staff-import`

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
  await openBusinessDay(owner, fx.propertyId, '2026-10-01')
  const kategorie = await makeCategory(owner, fx.propertyId)
  zimmer = await makeResources(owner, fx.propertyId, kategorie, 3)
  codes = (await owner.query<{ code: string }>(
    'SELECT code FROM resource WHERE id = ANY($1::bigint[]) ORDER BY id', [zimmer])).rows.map(r => r.code)
  chef = await makeUser(owner, { email: 'chef@kunde.de', propertyId: fx.propertyId,
    roleKey: 'hotel_director' })
  hausdame = await makeUser(owner, { email: 'hd@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping' })
  olga = await makeUser(owner, { email: 'olga@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping_staff' })
  await owner.query(`UPDATE app_user SET username = 'olga' WHERE id = $1`, [olga.userId])
})

type Zeile = Record<string, unknown>
function datei(teil: { since?: string | null; until?: string; schedules?: Zeile[]
                       workEntries?: Zeile[]; staff?: Zeile[] }) {
  const staff = teil.staff ?? [
    { username: 'olga', displayName: 'Olga K.', roles: ['reinigung'], status: 'active', language: 'ru' },
    { username: 'ivan', displayName: 'Ivan', roles: ['reinigung'], status: 'inactive', language: null }]
  const schedules = teil.schedules ?? []
  const workEntries = teil.workEntries ?? []
  return {
    format: 'zurseerobbe-staygrid', schemaVersion: 1, exportedAt: '2026-10-07T18:00:00+02:00',
    since: teil.since === undefined ? '2026-09-29' : teil.since, until: teil.until ?? '2026-10-01',
    manifest: {
      staff: { rows: staff.length, sha256: legacyChecksum(staff) },
      schedules: { rows: schedules.length, sha256: legacyChecksum(schedules) },
      workEntries: { rows: workEntries.length, sha256: legacyChecksum(workEntries) }
    },
    staff, schedules, workEntries
  }
}

const plan = (date: string, room: number, username: string | null, status = 'cleaned',
              minutes = 30, kind = 'departure') =>
  ({ date, room: codes[room], kind, username, status, minutes })

const senden = (data: unknown, extra: Record<string, unknown> = {}, session = chef.sessionId) =>
  app.inject({ method: 'POST', url: URL_(), headers: auth(session), payload: { data, ...extra } })

async function arbeitszeit(month = '2026-09') {
  const r = await app.inject({ method: 'GET',
    url: `/v1/properties/${fx.propertyId}/worktime/${olga.userId}?month=${month}`,
    headers: auth(chef.sessionId) })
  expect(r.statusCode).toBe(200)
  return r.json()
}

describe('Altdaten der Personal-App', () => {
  it('rechnet im Trockenlauf, schlaegt Personen vor und schreibt nichts', async () => {
    const d = datei({
      schedules: [plan('2026-09-30', 0, 'olga'), plan('2026-09-30', 1, 'ivan'),
                  plan('2026-09-30', 2, 'olga', 'declined', 0), { ...plan('2026-09-30', 0, null),
                  room: 'Bad' }],
      workEntries: [{ date: '2026-09-30', username: 'olga', text: 'Сложила бельё', minutes: 25,
                      language: 'ru', translationDe: 'Wäsche gelegt', translationManual: true }]
    })
    const r = await senden(d)
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b).toMatchObject({
      dryRun: true, days: { from: '2026-09-29', to: '2026-10-01', replaced: 3, closed: 0 },
      schedules: { total: 4, imported: 2, unmapped: 1, unknownRoom: 1 },
      workEntries: { total: 1, imported: 1, translations: 1 },
      unknownRooms: ['Bad']
    })
    expect(b.staff).toEqual([
      expect.objectContaining({ username: 'ivan', userId: null, decided: false, schedules: 1 }),
      expect.objectContaining({ username: 'olga', userId: olga.userId, decided: false,
                                schedules: 2, workEntries: 1 })])
    expect((await owner.query(`SELECT 1 FROM housekeeping_task`)).rowCount).toBe(0)
    expect((await owner.query(`SELECT 1 FROM staff_legacy_user`)).rowCount).toBe(0)
  })

  it('uebernimmt mit gespeicherten Minuten, Status und Uebersetzung', async () => {
    const d = datei({
      schedules: [plan('2026-09-30', 0, 'olga', 'cleaned', 45), plan('2026-09-30', 1, 'olga', 'declined', 0),
                  plan('2026-09-30', 2, 'olga', 'problem', 0)],
      workEntries: [{ date: '2026-09-30', username: 'olga', text: 'Сложила бельё', minutes: 25,
                      language: 'ru', translationDe: 'Wäsche gelegt', translationManual: true }]
    })
    const r = await senden(d, { commit: true, mapping: { ivan: null } })
    expect(r.statusCode).toBe(200)
    expect(r.json().dryRun).toBe(false)
    const m = await arbeitszeit()
    const tag = m.days.find((x: { date: string }) => x.date === '2026-09-30')
    expect(tag).toMatchObject({ roomMinutes: 45, rooms: 1, total: 70 })
    expect(tag.entries[0]).toMatchObject({ description: 'Сложила бельё', source: 'legacy',
      translationDe: 'Wäsche gelegt', translationManual: true })
    const { rows } = await owner.query<{ legacy_username: string; user_id: number | null }>(
      'SELECT legacy_username, user_id::int FROM staff_legacy_user ORDER BY legacy_username')
    expect(rows).toEqual([{ legacy_username: 'ivan', user_id: null },
                          { legacy_username: 'olga', user_id: olga.userId }])
  })

  it('ersetzt ganze Tage, laesst StayGrid gewinnen und einen abgeschlossenen Monat stehen', async () => {
    await senden(datei({ since: '2026-09-29', schedules: [
      plan('2026-09-29', 0, 'olga'), plan('2026-09-30', 0, 'olga'), plan('2026-09-30', 1, 'olga')] }),
      { commit: true })
    // In StayGrid selbst plant die Hausdame Zimmer 3 am 01.10.
    const p = await app.inject({ method: 'PUT', url: `/v1/properties/${fx.propertyId}/cleaning-plan`,
      headers: auth(hausdame.sessionId), payload: { date: '2026-10-01', assignments:
        [{ resourceId: zimmer[2], kind: 'departure', assignedTo: olga.userId }] } })
    expect(p.statusCode).toBe(200)

    // Der Folgeexport ab dem 30.09.: am 30. wurde in der Alt-App ein Zimmer
    // geloescht, am 01.10. steht Zimmer 3 auch dort.
    const r = await senden(datei({ since: '2026-09-30', schedules: [
      plan('2026-09-30', 0, 'olga', 'cleaned', 30), plan('2026-10-01', 2, 'olga', 'cleaned', 99)] }),
      { commit: true })
    expect(r.json().schedules).toMatchObject({ imported: 1, staygrid: 1 })
    const { rows } = await owner.query<{ d: string; r: number; source: string; minutes: number }>(
      `SELECT business_date::text AS d, resource_id::int AS r, source, minutes FROM housekeeping_task
        ORDER BY business_date, resource_id`)
    expect(rows).toEqual([
      { d: '2026-09-29', r: zimmer[0], source: 'legacy', minutes: 30 },
      { d: '2026-09-30', r: zimmer[0], source: 'legacy', minutes: 30 },
      { d: '2026-10-01', r: zimmer[2], source: 'staygrid', minutes: expect.any(Number) }])

    // September abschliessen: ein weiterer Export aendert ihn nicht mehr.
    const zu = await app.inject({ method: 'POST', url: `/v1/properties/${fx.propertyId}/worktime/close`,
      headers: auth(chef.sessionId), payload: { month: '2026-09' } })
    expect(zu.statusCode).toBe(200)
    const spaet = await senden(datei({ since: '2026-09-29', schedules: [] }), { commit: true })
    expect(spaet.statusCode).toBe(200)
    expect(spaet.json().days).toMatchObject({ replaced: 1, closed: 2 })
    expect((await owner.query(`SELECT 1 FROM housekeeping_task WHERE source = 'legacy'`)).rowCount)
      .toBe(2)
  })

  it('weist eine veraenderte Datei ab und ein fremdes Ziel der Zuordnung', async () => {
    const d = datei({ schedules: [plan('2026-09-30', 0, 'olga')] })
    ;(d.schedules[0] as Zeile).minutes = 300
    const r = await senden(d, { commit: true })
    expect(r.statusCode).toBe(422)
    expect(r.json().errorKeys ?? r.json().code).toBeDefined()
    expect((await owner.query(`SELECT 1 FROM housekeeping_task`)).rowCount).toBe(0)

    const fremd = await makeProperty(owner, { code: 'FREMD' })
    const anderswo = await makeUser(owner, { email: 'x@fremd.de', propertyId: fremd.propertyId,
      roleKey: 'housekeeping_staff' })
    const z = await senden(datei({ schedules: [plan('2026-09-30', 0, 'olga')] }),
      { mapping: { olga: anderswo.userId } })
    expect(z.statusCode).toBe(422)
  })

  it('ist der Leitung vorbehalten', async () => {
    for (const s of [hausdame, olga]) {
      expect((await senden(datei({}), {}, s.sessionId)).statusCode).toBe(403)
    }
  })
})
