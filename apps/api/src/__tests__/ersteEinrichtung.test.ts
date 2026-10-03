import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Erste Einrichtung (routes/firstSetup.ts): ein leeres Haus in einem Zug
 * buchbar machen. Geprueft wird, dass danach wirklich gebucht werden kann --
 * mit Preis und ohne auf den Nachtlauf zu warten --, und dass ein Fehler in
 * einer Zimmerart gar nichts schreibt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: { userId: number; sessionId: string }

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
  fx = await makeProperty(owner)
  chef = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
})

const einrichten = (payload: unknown, sessionId = chef.sessionId) =>
  app.inject({ method: 'POST', url: `/v1/properties/${fx.propertyId}/first-setup`,
               headers: auth(sessionId), payload })

const zuschnitt = {
  categories: [
    { code: 'EZ', name: 'Einzelzimmer', maxOccupancy: 1,
      rooms: { from: 101, count: 3 }, priceCent: 8900 },
    { code: 'DZ', name: 'Doppelzimmer', maxOccupancy: 2,
      rooms: { from: 201, count: 5 }, priceCent: 12900 },
    { code: 'FEWO', name: 'Ferienwohnung', maxOccupancy: 4,
      rooms: { prefix: 'App ', from: 1, count: 2 } }
  ],
  ratePlanName: 'Standardpreis'
}

const zaehle = async (tabelle: string): Promise<number> => {
  const r = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${tabelle} WHERE property_id = $1`, [fx.propertyId])
  return r.rows[0]!.n
}

describe('Erste Einrichtung', () => {
  it('zeigt ohne commit eine Vorschau und schreibt nichts', async () => {
    const r = await einrichten(zuschnitt)
    expect(r.statusCode).toBe(200)
    const b = JSON.parse(r.body) as {
      dryRun: boolean; roomCount: number; ratePlanCount: number
      categories: Array<{ code: string; rooms: string[]; ratePlanCode: string | null }> }
    expect(b.dryRun).toBe(true)
    expect(b.roomCount).toBe(10)
    expect(b.ratePlanCount).toBe(2)
    expect(b.categories[0]!.rooms).toEqual(['101', '102', '103'])
    expect(b.categories[2]!.rooms).toEqual(['App 1', 'App 2'])
    expect(b.categories[2]!.ratePlanCode).toBeNull()
    expect(await zaehle('resource_category')).toBe(0)
    expect(await zaehle('resource')).toBe(0)
  })

  it('legt Gruppen, Zimmer, Raten, ein Jahr Preise und den Bestand an', async () => {
    const r = await einrichten({ ...zuschnitt, commit: true })
    expect(r.statusCode).toBe(200)
    const b = JSON.parse(r.body) as {
      created: { categories: number; rooms: number; ratePlans: number; pricedDays: number }
      pricedFrom: string; pricedTo: string }
    expect(b.created).toMatchObject({ categories: 3, rooms: 10, ratePlans: 2,
                                      pricedDays: 2 * 365 })

    const plaene = await owner.query<{ code: string; name: string; cat: string }>(
      `SELECT rp.code, rp.name, c.code AS cat FROM rate_plan rp
         JOIN resource_category c ON c.id = rp.category_id
        WHERE rp.property_id = $1 ORDER BY rp.code`, [fx.propertyId])
    expect(plaene.rows).toEqual([
      { code: 'DZ-STD', name: 'Standardpreis', cat: 'DZ' },
      { code: 'EZ-STD', name: 'Standardpreis', cat: 'EZ' }])

    const preis = await owner.query<{ price_cent: string[] }>(
      `SELECT d.price_cent FROM rate_day d JOIN rate_plan rp ON rp.id = d.rate_plan_id
        WHERE rp.code = 'DZ-STD' AND d.date = $1::date`, [b.pricedFrom])
    // Je Belegung bis zur hoechsten der Art: das Preisraster liest je Belegung.
    expect(preis.rows[0]!.price_cent.map(Number)).toEqual([12900, 12900])

    // Kapazitaet steht sofort, nicht erst nach dem Pflegejob in der Nacht.
    const kap = await owner.query<{ code: string; capacity: number }>(
      `SELECT c.code, i.capacity FROM inventory_day i
         JOIN resource_category c ON c.id = i.category_id
        WHERE i.property_id = $1 AND i.date = current_date ORDER BY c.code`,
      [fx.propertyId])
    expect(kap.rows).toEqual([
      { code: 'DZ', capacity: 5 }, { code: 'EZ', capacity: 3 }, { code: 'FEWO', capacity: 2 }])

    // Der Einrichtungsstand sieht das Haus als buchbar.
    const s = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/setup-status`, headers: auth(chef.sessionId) })
    expect((JSON.parse(s.body) as { bookable: boolean }).bookable).toBe(true)
  })

  it('weist eine vergebene Nummer ab und schreibt dann gar nichts', async () => {
    await einrichten({ categories: [{ code: 'SU', name: 'Suite',
      rooms: { from: 202, count: 1 } }], commit: true })
    const vorher = await zaehle('resource_category')

    const r = await einrichten({ ...zuschnitt, commit: true })
    expect(r.statusCode).toBe(422)
    const fehler = (JSON.parse(r.body) as { errorKeys?: Record<string, string[]>
                                            errors?: Record<string, string[]> })
    expect(JSON.stringify(fehler)).toContain('categories.1.rooms.from')
    expect(await zaehle('resource_category')).toBe(vorher)
    expect(await zaehle('rate_plan')).toBe(0)
  })

  it('findet doppelte Kuerzel und ueberlappende Nummern schon in der Vorschau', async () => {
    const r = await einrichten({ categories: [
      { code: 'DZ', name: 'Doppel', rooms: { from: 1, count: 5 } },
      { code: 'DZ', name: 'Doppel 2', rooms: { from: 5, count: 2 } }] })
    expect(r.statusCode).toBe(422)
    const text = r.body
    expect(text).toContain('categories.1.code')
    expect(text).toContain('categories.1.rooms.from')
  })

  it('bleibt dem verschlossen, der das Haus nicht einrichten darf', async () => {
    const hk = await makeUser(owner,
      { email: 'hk@test.de', propertyId: fx.propertyId, roleKey: 'housekeeping' })
    expect((await einrichten(zuschnitt, hk.sessionId)).statusCode).toBe(403)
  })

  /**
   * Der erste Benutzer eines neuen Kunden ist Inhaber auf Betriebsebene und
   * hat im Haus keine eigene Rolle (`account_provision`). Die Oberflaeche
   * richtet ihre Bildschirme nach den Rechten je Haus in `/v1/auth/me` --
   * standen dort nur die Hausrollen, sah er beim ersten Login keinen
   * einzigen Bildschirm und damit auch diesen Assistenten nicht.
   */
  it('meldet dem Inhaber auf Betriebsebene seine Rechte auch im Haus', async () => {
    const inhaber = await makeUser(owner,
      { email: 'inhaber@test.de', accountId: fx.accountId, roleKey: 'owner' })
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me',
                                  headers: auth(inhaber.sessionId) })
    const haus = (JSON.parse(me.body) as {
      properties: Array<{ id: number; permissions: string[] }> }).properties
      .find(p => p.id === fx.propertyId)!
    expect(haus.permissions).toContain('settings:property')
    expect(haus.permissions).toContain('rate:write')
    expect((await einrichten(zuschnitt, inhaber.sessionId)).statusCode).toBe(200)
  })
})
