import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

interface SeriesReport {
  dryRun: boolean; planned: number; created: number; skipped: number
  rooms: Array<{ code: string; exists: boolean; reason?: string }>
}

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
  fx = await makeProperty(owner)
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
})

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(admin.sessionId), payload })
const patch = (url: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url, headers: auth(admin.sessionId), payload })
const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: auth(admin.sessionId) })

async function gruppe(code = 'DZ', extra: Record<string, unknown> = {}): Promise<number> {
  const r = await post(`/v1/properties/${fx.propertyId}/categories`,
    { code, name: `Gruppe ${code}`, ...extra })
  expect(r.statusCode).toBe(201)
  return (JSON.parse(r.body) as { categoryId: number }).categoryId
}

describe('Zimmergruppen', () => {
  it('legt eine Gruppe an und weist ein doppeltes Kuerzel ab', async () => {
    await gruppe('DZ')
    const zweite = await post(`/v1/properties/${fx.propertyId}/categories`,
      { code: 'DZ', name: 'Nochmal' })
    expect(zweite.statusCode).toBe(409)
  })

  it('vergibt die Sortierung fortlaufend, wenn keine angegeben ist', async () => {
    await gruppe('EZ')
    await gruppe('DZ')
    await gruppe('FEWO')
    const l = await get(`/v1/properties/${fx.propertyId}/categories`)
    const cats = (JSON.parse(l.body) as
      { categories: Array<{ code: string; sortOrder: number }> }).categories
    expect(cats.map(c => c.code)).toEqual(['EZ', 'DZ', 'FEWO'])
    expect(cats.map(c => c.sortOrder)).toEqual([10, 20, 30])
  })

  it('zaehlt aktive und stillgelegte Zimmer je Gruppe', async () => {
    const cat = await gruppe('DZ')
    await post('/v1/rooms/series',
      { propertyId: fx.propertyId, categoryId: cat, prefix: '1', from: 1, to: 4,
        pad: 2, commit: true })
    const zimmer = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE property_id = $1 ORDER BY code LIMIT 1`,
      [fx.propertyId])
    await patch(`/v1/rooms/${zimmer.rows[0]!.id}`, { active: false })

    const l = await get(`/v1/properties/${fx.propertyId}/categories`)
    const c = (JSON.parse(l.body) as
      { categories: Array<{ activeRooms: number; inactiveRooms: number }> }).categories[0]!
    expect(c.activeRooms).toBe(3)
    expect(c.inactiveRooms).toBe(1)
  })

  it('laesst eine Gruppe mit kuenftigen Reservierungen nicht stilllegen', async () => {
    const cat = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
    await makeResources(owner, fx.propertyId, cat, 2)
    await owner.query(
      `SELECT inventory_materialize($1, current_date, (current_date + 400)::date)`,
      [fx.propertyId])
    const morgen = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const uebermorgen = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: cat,
      arrival: morgen, departure: uebermorgen })

    const r = await patch(`/v1/categories/${cat}`, { active: false })
    expect(r.statusCode).toBe(409)
    expect(JSON.parse(r.body).detail).toContain('umbuchen')
  })

  it('weist eine andere Zeiteinheit als die Nacht noch ab', async () => {
    const r = await post(`/v1/properties/${fx.propertyId}/categories`,
      { code: 'TAG', name: 'Tagungsraum', timeUnit: 'hour' })
    expect(r.statusCode).toBe(422)
  })
})

describe('Zimmerserie', () => {
  it('zeigt eine Vorschau ohne zu schreiben', async () => {
    const cat = await gruppe('DZ')
    const r = await post('/v1/rooms/series',
      { propertyId: fx.propertyId, categoryId: cat, prefix: '1', from: 1, to: 30, pad: 2 })
    expect(r.statusCode).toBe(200)
    const b = JSON.parse(r.body) as SeriesReport
    expect(b.dryRun).toBe(true)
    expect(b.planned).toBe(30)
    expect(b.rooms[0]!.code).toBe('101')
    expect(b.rooms[29]!.code).toBe('130')

    const da = await owner.query(`SELECT 1 FROM resource WHERE property_id = $1`,
      [fx.propertyId])
    expect(da.rowCount).toBe(0)
  })

  it('legt die Serie mit commit an und erhoeht die Kapazitaet', async () => {
    const cat = await gruppe('DZ')
    await owner.query(
      `SELECT inventory_materialize($1, current_date, (current_date + 400)::date)`,
      [fx.propertyId])

    const r = await post('/v1/rooms/series',
      { propertyId: fx.propertyId, categoryId: cat, prefix: '1', from: 1, to: 30,
        pad: 2, floor: '1', commit: true })
    expect((JSON.parse(r.body) as SeriesReport).created).toBe(30)

    const kap = await owner.query<{ capacity: number }>(
      `SELECT capacity FROM inventory_day WHERE property_id=$1 AND category_id=$2
         AND date = current_date + 10`, [fx.propertyId, cat])
    expect(kap.rows[0]!.capacity).toBe(30)
    const haus = await owner.query<{ capacity: number }>(
      `SELECT capacity FROM inventory_day WHERE property_id=$1 AND category_id=0
         AND date = current_date + 10`, [fx.propertyId])
    expect(haus.rows[0]!.capacity).toBe(30)
  })

  it('laesst Nummern aus und benennt bereits vergebene', async () => {
    const cat = await gruppe('DZ')
    await post('/v1/rooms/series',
      { propertyId: fx.propertyId, categoryId: cat, prefix: '1', from: 1, to: 5,
        pad: 2, commit: true })

    // Zweiter Lauf mit ueberlappendem Bereich, Zimmer 113 ausgelassen.
    const r = await post('/v1/rooms/series',
      { propertyId: fx.propertyId, categoryId: cat, prefix: '1', from: 3, to: 15,
        pad: 2, skip: [13], commit: true })
    const b = JSON.parse(r.body) as SeriesReport
    expect(b.planned).toBe(12)                 // 3 bis 15 ohne die 13
    expect(b.skipped).toBe(3)                  // 103, 104, 105 gibt es schon
    expect(b.created).toBe(9)
    expect(b.rooms.find(x => x.code === '103')!.reason).toContain('bereits vergeben')

    const codes = await owner.query<{ code: string }>(
      `SELECT code FROM resource WHERE property_id=$1 ORDER BY code`, [fx.propertyId])
    expect(codes.rows.map(c => c.code)).not.toContain('113')
    expect(codes.rowCount).toBe(14)
  })

  it('baut auch Namen ohne Nummernlogik', async () => {
    const cat = await gruppe('FEWO')
    const r = await post('/v1/rooms/series',
      { propertyId: fx.propertyId, categoryId: cat, prefix: 'Wohnung ', from: 1, to: 3,
        suffix: ' Nord', commit: true })
    const b = JSON.parse(r.body) as SeriesReport
    expect(b.rooms.map(x => x.code))
      .toEqual(['Wohnung 1 Nord', 'Wohnung 2 Nord', 'Wohnung 3 Nord'])
  })

  it('begrenzt die Seriengroesse', async () => {
    const cat = await gruppe('DZ')
    const r = await post('/v1/rooms/series',
      { propertyId: fx.propertyId, categoryId: cat, from: 1, to: 5000 })
    expect(r.statusCode).toBe(422)
  })

  it('weist eine Gruppe eines fremden Hauses ab', async () => {
    const andere = await makeProperty(owner, { code: 'FREMD' })
    const fremdeGruppe = await makeCategory(owner, andere.propertyId, { code: 'X' })
    const r = await post('/v1/rooms/series',
      { propertyId: fx.propertyId, categoryId: fremdeGruppe, from: 1, to: 3, commit: true })
    expect(r.statusCode).toBe(404)
  })
})

describe('Zimmer aendern', () => {
  it('verschiebt Kapazitaet beim Umgruppieren zwischen beiden Gruppen', async () => {
    const dz = await gruppe('DZ')
    const ez = await gruppe('EZ')
    await owner.query(
      `SELECT inventory_materialize($1, current_date, (current_date + 400)::date)`,
      [fx.propertyId])
    await post('/v1/rooms/series',
      { propertyId: fx.propertyId, categoryId: dz, prefix: '2', from: 1, to: 4,
        pad: 2, commit: true })

    const zimmer = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE property_id=$1 ORDER BY code LIMIT 1`, [fx.propertyId])
    const r = await patch(`/v1/rooms/${zimmer.rows[0]!.id}`, { categoryId: ez })
    expect(r.statusCode).toBe(200)

    const kap = await owner.query<{ category_id: number; capacity: number }>(
      `SELECT category_id, capacity FROM inventory_day
        WHERE property_id=$1 AND date = current_date + 10 ORDER BY category_id`,
      [fx.propertyId])
    const byCat = new Map(kap.rows.map(k => [k.category_id, k.capacity]))
    expect(byCat.get(dz)).toBe(3)
    expect(byCat.get(ez)).toBe(1)
    expect(byCat.get(0)).toBe(4)    // Die Haussumme bleibt unveraendert.
  })

  it('senkt die Kapazitaet beim Stilllegen und legt nicht geloescht ab', async () => {
    const cat = await gruppe('DZ')
    await owner.query(
      `SELECT inventory_materialize($1, current_date, (current_date + 400)::date)`,
      [fx.propertyId])
    await post('/v1/rooms/series',
      { propertyId: fx.propertyId, categoryId: cat, prefix: '3', from: 1, to: 3,
        pad: 2, commit: true })
    const zimmer = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE property_id=$1 ORDER BY code LIMIT 1`, [fx.propertyId])

    await patch(`/v1/rooms/${zimmer.rows[0]!.id}`, { active: false })

    const kap = await owner.query<{ capacity: number }>(
      `SELECT capacity FROM inventory_day WHERE property_id=$1 AND category_id=$2
         AND date = current_date + 10`, [fx.propertyId, cat])
    expect(kap.rows[0]!.capacity).toBe(2)

    // Die Zeile bleibt: an ihr haengen Reservierungen und Rechnungen.
    const da = await owner.query(`SELECT 1 FROM resource WHERE id=$1`, [zimmer.rows[0]!.id])
    expect(da.rowCount).toBe(1)
  })

  it('laesst ein Zimmer mit kuenftiger Reservierung nicht stilllegen', async () => {
    const cat = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
    const zimmer = await makeResources(owner, fx.propertyId, cat, 2)
    await owner.query(
      `SELECT inventory_materialize($1, current_date, (current_date + 400)::date)`,
      [fx.propertyId])
    const morgen = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const uebermorgen = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: cat,
      arrival: morgen, departure: uebermorgen, resourceId: zimmer[0]! })

    const r = await patch(`/v1/rooms/${zimmer[0]!}`, { active: false })
    expect(r.statusCode).toBe(409)
    expect(JSON.parse(r.body).detail).toContain('umbuchen')
  })
})

describe('Einrichtungsstand', () => {
  it('nennt den naechsten fehlenden Schritt', async () => {
    const leer = await get(`/v1/properties/${fx.propertyId}/setup-status`)
    const a = JSON.parse(leer.body) as
      { bookable: boolean; complete: boolean; nextStep: string }
    expect(a.bookable).toBe(false)
    expect(a.nextStep).toBe('Zimmergruppen angelegt')

    const cat = await gruppe('DZ')
    const b = JSON.parse((await get(`/v1/properties/${fx.propertyId}/setup-status`)).body) as
      { nextStep: string }
    expect(b.nextStep).toBe('Zimmer angelegt')

    await post('/v1/rooms/series',
      { propertyId: fx.propertyId, categoryId: cat, prefix: '1', from: 1, to: 5,
        pad: 2, commit: true })
    const c = JSON.parse((await get(`/v1/properties/${fx.propertyId}/setup-status`)).body) as
      { nextStep: string; bookable: boolean }
    expect(c.nextStep).toBe('Inventar materialisiert')
    expect(c.bookable).toBe(false)

    await owner.query(
      `SELECT inventory_materialize($1, current_date, (current_date + 400)::date)`,
      [fx.propertyId])
    const d = JSON.parse((await get(`/v1/properties/${fx.propertyId}/setup-status`)).body) as
      { bookable: boolean; complete: boolean }
    // Buchbar, aber noch nicht vollstaendig: Preise und Steuern fehlen.
    expect(d.bookable).toBe(true)
    expect(d.complete).toBe(false)
  })
})
