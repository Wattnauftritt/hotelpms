import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Verkaufscode je Zimmer (Migration 0089).
 *
 * Der Fall dahinter: Familienzimmer 8 und Apartment 9 liegen in einer
 * Zimmergruppe "Apart", RoomCloud verkauft sie als FZ und APT. Ohne Code
 * meldete das Adminpanel Zimmer 8 dauerhaft als frei, weil es die Belegung
 * der Gruppe keinem der beiden zuordnen konnte.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let apart: number
let andere: number
let fz: number
let apt: number
let auth: Record<string, string>

const VON = '2026-10-01'
const BIS = '2026-10-03'

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
  limiters.reset()
  fx = await makeProperty(owner)
  apart = await makeCategory(owner, fx.propertyId, { code: 'APART' })
  andere = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  ;[fz, apt] = await makeResources(owner, fx.propertyId, apart, 2) as [number, number]
  await makeResources(owner, fx.propertyId, andere, 1, 'D')
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

const zimmerSetzen = (id: number, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/v1/rooms/${id}`, headers: auth, payload })

async function codesSetzen(): Promise<void> {
  expect((await zimmerSetzen(fz, { salesCode: 'fz' })).statusCode).toBe(200)
  expect((await zimmerSetzen(apt, { salesCode: 'APT' })).statusCode).toBe(200)
}

async function kanal(): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: `/v1/properties/${fx.propertyId}/channel-connections`,
    headers: auth, payload: { provider: 'roomcloud', name: 'RoomCloud' } })
  expect(r.statusCode).toBe(201)
  return (JSON.parse(r.body) as { token: string }).token
}

const kanalBuchung = (token: string, payload: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/v1/channel/ari/bookings',
  headers: { authorization: `Bearer ${token}` },
  payload: { arrival: VON, departure: BIS, guest: { lastName: 'Test' }, ...payload } })

interface Tag { salesCode: string; date: string; capacity: number; sold: number
                unassigned: number; available: number; categoryCode: string }
async function jeCode(): Promise<Tag[]> {
  const r = await app.inject({ method: 'GET', headers: auth,
    url: `/v1/properties/${fx.propertyId}/availability?from=${VON}&to=${BIS}&by=salesCode` })
  expect(r.statusCode, r.body).toBe(200)
  return (JSON.parse(r.body) as { salesDays: Tag[] }).salesDays
}

describe('Verkaufscode am Zimmer', () => {
  it('setzt, zeigt und loescht ihn, gross geschrieben', async () => {
    await codesSetzen()
    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/rooms` })
    const rooms = (JSON.parse(r.body) as { rooms: Array<{ id: number; salesCode: string | null }> })
      .rooms
    expect(rooms.find(z => z.id === fz)!.salesCode).toBe('FZ')
    expect(rooms.find(z => z.id === apt)!.salesCode).toBe('APT')

    expect((await zimmerSetzen(fz, { salesCode: '' })).statusCode).toBe(200)
    const z = await owner.query(`SELECT sales_code FROM resource WHERE id = $1`, [fz])
    expect(z.rows[0]!.sales_code).toBeNull()
  })

  it('weist ein unbrauchbares Format ab', async () => {
    expect((await zimmerSetzen(fz, { salesCode: 'F Z!' })).statusCode).toBe(422)
  })

  /** Gebunden wird gegen die Gruppe; ein Code in zwei Gruppen haette keinen Bestand. */
  it('haelt einen Code in einer Gruppe', async () => {
    await codesSetzen()
    const dz = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE category_id = $1`, [andere])
    const r = await zimmerSetzen(dz.rows[0]!.id, { salesCode: 'FZ' })
    expect(r.statusCode).toBe(409)
    // Ebenso, wenn das Zimmer mit seinem Code in eine andere Gruppe wandert.
    expect((await zimmerSetzen(apt, { categoryId: andere })).statusCode).toBe(409)
  })
})

describe('Kanalbuchung und Liste', () => {
  it('nimmt einen Verkaufscode statt der Gruppe an und liefert ihn in der Liste', async () => {
    await codesSetzen()
    const token = await kanal()
    const r = await kanalBuchung(token, { externalReference: 'RC-1', categoryCode: 'FZ' })
    expect(r.statusCode, r.body).toBe(201)

    const l = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/reservations` })
    const zeilen = (JSON.parse(l.body) as { reservations: Array<{
      salesCode: string | null; categoryCode: string; roomCode: string | null }> }).reservations
    expect(zeilen).toHaveLength(1)
    expect(zeilen[0]).toMatchObject({ salesCode: 'FZ', categoryCode: 'APART', roomCode: null })
  })

  it('nimmt Gruppe und Code zusammen und weist einen fremden Code ab', async () => {
    await codesSetzen()
    const token = await kanal()
    const ok = await kanalBuchung(token,
      { externalReference: 'RC-2', categoryCode: 'APART', salesCode: 'APT' })
    expect(ok.statusCode, ok.body).toBe(201)
    const falsch = await kanalBuchung(token,
      { externalReference: 'RC-3', categoryCode: 'DZ', salesCode: 'APT' })
    expect(falsch.statusCode).toBe(422)
    const unbekannt = await kanalBuchung(token,
      { externalReference: 'RC-4', categoryCode: 'XX' })
    expect(unbekannt.statusCode).toBe(422)
  })
})

describe('Verfuegbarkeit je Verkaufscode', () => {
  it('zaehlt Zimmer, Belegung und Unzugeordnetes getrennt', async () => {
    await codesSetzen()
    const token = await kanal()
    // FZ ueber den Code, ohne Zimmer.
    expect((await kanalBuchung(token,
      { externalReference: 'RC-5', categoryCode: 'FZ' })).statusCode).toBe(201)
    // Auf die Gruppe, ohne Code und ohne Zimmer: keinem zuzuordnen.
    expect((await kanalBuchung(token,
      { externalReference: 'RC-6', categoryCode: 'APART' })).statusCode).toBe(201)

    const tage = await jeCode()
    expect(tage).toHaveLength(4)
    const fzTag = tage.find(t => t.salesCode === 'FZ' && t.date === VON)!
    expect(fzTag).toMatchObject({ categoryCode: 'APART', capacity: 1, sold: 1,
                                  unassigned: 1, available: 0 })
    const aptTag = tage.find(t => t.salesCode === 'APT' && t.date === VON)!
    expect(aptTag).toMatchObject({ capacity: 1, sold: 0, unassigned: 1, available: 1 })
  })

  it('zaehlt eine Buchung nach dem Code ihres Zimmers', async () => {
    await codesSetzen()
    const token = await kanal()
    const r = await kanalBuchung(token, { externalReference: 'RC-7', categoryCode: 'FZ' })
    const ref = (JSON.parse(r.body) as { reservationRef: string }).reservationRef
    // Zimmer 9 zugewiesen: der Code des Zimmers gilt, nicht der gebuchte.
    await owner.query(`UPDATE reservation SET resource_id = $2 WHERE public_ref = $1`,
      [ref, apt])
    const tage = await jeCode()
    expect(tage.find(t => t.salesCode === 'APT' && t.date === VON)!.sold).toBe(1)
    expect(tage.find(t => t.salesCode === 'FZ' && t.date === VON)!.sold).toBe(0)
  })

  it('kennt den Parameter by und sonst nichts', async () => {
    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/availability?from=${VON}&to=${BIS}&by=x` })
    expect(r.statusCode).toBe(422)
  })
})
