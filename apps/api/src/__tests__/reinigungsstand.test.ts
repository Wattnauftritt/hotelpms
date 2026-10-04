import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Reinigungsstand aus einem fremden System (Abschnitt 3.5 des API-Entwurfs
 * fuers Adminpanel).
 *
 * Das Adminpanel gleicht nachts den Stand aus einem externen
 * Reinigungssystem ab: viele Zimmer, gemischte Staende, adressiert ueber die
 * Zimmernummer, mit einem Maschinenzugang. Was hier geprueft wird, ist vor
 * allem die Hausgrenze: dieselbe Zimmernummer gibt es im Nachbarhaus
 * desselben Accounts, und die Zeilenrichtlinie trennt Haeuser nicht.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let nachbar: number
let zimmer: number[]
let katId: number
let nachbarZimmer: number[]
let admin: { userId: number; sessionId: string }

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
  katId = await makeCategory(owner, fx.propertyId)
  zimmer = await makeResources(owner, fx.propertyId, katId, 4)
  // Zweites Haus im selben Account, mit denselben Zimmernummern 101 bis 104.
  const zweites = await owner.query<{ id: number }>(
    `INSERT INTO property (account_id, code, name, address_line1, postal_code,
                           city, country, tax_number)
     VALUES ($1,'NACHBAR','Nachbarhaus','Hafenstr. 2','25813','Husum','DE',
             '21/815/00124') RETURNING id`,
    [fx.accountId])
  nachbar = zweites.rows[0]!.id
  const kat2 = await makeCategory(owner, nachbar)
  nachbarZimmer = await makeResources(owner, nachbar, kat2, 4)
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [admin.userId, fx.accountId])
})

async function maschine(scopes: string[], propertyIds: number[]): Promise<Record<string, string>> {
  const z = await app.inject({
    method: 'POST', url: '/v1/oauth-clients', headers: auth(admin.sessionId),
    payload: { name: 'Adminpanel', scopes, propertyIds } })
  expect(z.statusCode, z.body).toBe(201)
  const { clientId, clientSecret } = z.json<{ clientId: string; clientSecret: string }>()
  const t = await app.inject({
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'client_credentials',
                                   client_id: clientId, client_secret: clientSecret })
      .toString() })
  expect(t.statusCode, t.body).toBe(200)
  return { authorization: `Bearer ${t.json<{ access_token: string }>().access_token}` }
}

const setzen = (headers: Record<string, string>, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: '/v1/housekeeping/status', headers, payload })

async function staende(propertyId: number): Promise<Record<string, string>> {
  const { rows } = await owner.query<{ code: string; status: string }>(
    `SELECT r.code, COALESCE(h.status, 'clean') AS status
       FROM resource r LEFT JOIN housekeeping_status h ON h.resource_id = r.id
      WHERE r.property_id = $1 ORDER BY r.code`, [propertyId])
  return Object.fromEntries(rows.map(r => [r.code, r.status]))
}

describe('Reinigungsstand je Zimmernummer', () => {
  it('setzt gemischte Staende mit einem Maschinenzugang in einem Aufruf', async () => {
    const m = await maschine(['housekeeping:write'], [fx.propertyId])
    const r = await setzen(m, { propertyId: fx.propertyId, items: [
      { roomCode: '101', status: 'dirty' },
      { roomCode: '102', status: 'clean' },
      { roomCode: '103', status: 'inspected' }] })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toEqual({ updated: 3 })
    expect(await staende(fx.propertyId))
      .toEqual({ '101': 'dirty', '102': 'clean', '103': 'inspected', '104': 'clean' })
    // Das Nachbarhaus mit denselben Nummern bleibt unberuehrt.
    expect(Object.values(await staende(nachbar))).toEqual(['clean', 'clean', 'clean', 'clean'])

    // Ein zweiter Lauf ueberschreibt, statt doppelt anzulegen.
    const zweiter = await setzen(m, { propertyId: fx.propertyId, items: [
      { roomCode: '101', status: 'clean' }] })
    expect(zweiter.statusCode).toBe(200)
    expect((await staende(fx.propertyId))['101']).toBe('clean')
  })

  it('erreicht mit einem Zugang fuer ein Haus das andere nicht', async () => {
    const m = await maschine(['housekeeping:write'], [fx.propertyId])
    const r = await setzen(m, { propertyId: nachbar, items: [
      { roomCode: '101', status: 'dirty' }] })
    expect(r.statusCode).toBe(403)
    expect((await staende(nachbar))['101']).toBe('clean')
  })

  it('verlangt das Schreibrecht, Lesen genuegt nicht', async () => {
    const m = await maschine(['housekeeping:read'], [fx.propertyId])
    const r = await setzen(m, { propertyId: fx.propertyId, items: [
      { roomCode: '101', status: 'dirty' }] })
    expect(r.statusCode).toBe(403)
  })

  it('weist eine unbekannte Nummer ab, nennt sie und setzt nichts', async () => {
    const m = await maschine(['housekeeping:write'], [fx.propertyId])
    const r = await setzen(m, { propertyId: fx.propertyId, items: [
      { roomCode: '101', status: 'dirty' },
      { roomCode: '999', status: 'dirty' }] })
    expect(r.statusCode).toBe(422)
    expect(r.body).toContain('999')
    expect((await staende(fx.propertyId))['101']).toBe('clean')
  })

  it('weist doppelte Zimmer, falsche Staende und beide Formen zugleich ab', async () => {
    const m = await maschine(['housekeeping:write'], [fx.propertyId])
    const doppelt = await setzen(m, { propertyId: fx.propertyId, items: [
      { roomCode: '101', status: 'dirty' }, { roomCode: '101', status: 'clean' }] })
    expect(doppelt.statusCode).toBe(422)

    const falsch = await setzen(m, { propertyId: fx.propertyId, items: [
      { roomCode: '101', status: 'keiner' }] })
    expect(falsch.statusCode).toBe(422)

    const leer = await setzen(m, { propertyId: fx.propertyId, items: [] })
    expect(leer.statusCode).toBe(422)

    const beides = await setzen(m, { propertyId: fx.propertyId, status: 'dirty',
      resourceIds: [zimmer[0]!], items: [{ roomCode: '101', status: 'dirty' }] })
    expect(beides.statusCode).toBe(422)

    const zuviel = await setzen(m, { propertyId: fx.propertyId,
      items: Array.from({ length: 501 }, (_, i) => ({ roomCode: String(i), status: 'dirty' })) })
    expect(zuviel.statusCode).toBe(422)
    expect(Object.values(await staende(fx.propertyId))).toEqual(['clean', 'clean', 'clean', 'clean'])
  })

  it('laesst eine Zuteilung vom Bildschirm stehen', async () => {
    await setzen(auth(admin.sessionId), { propertyId: fx.propertyId,
      resourceIds: [zimmer[0]!], status: 'dirty', assignedTo: admin.userId })
    const m = await maschine(['housekeeping:write'], [fx.propertyId])
    await setzen(m, { propertyId: fx.propertyId, items: [{ roomCode: '101', status: 'clean' }] })
    const { rows } = await owner.query<{ assigned_to: number | null }>(
      `SELECT assigned_to FROM housekeeping_status WHERE resource_id = $1`, [zimmer[0]!])
    expect(Number(rows[0]!.assigned_to)).toBe(admin.userId)
  })

  it('die bisherige Form mit IDs und einem Stand geht weiter', async () => {
    const r = await setzen(auth(admin.sessionId), { propertyId: fx.propertyId,
      resourceIds: zimmer.slice(0, 2), status: 'dirty' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toEqual({ updated: 2, status: 'dirty' })
    // Fremde ID aus dem Nachbarhaus: abgewiesen wie bisher.
    const fremd = await setzen(auth(admin.sessionId), { propertyId: fx.propertyId,
      resourceIds: [nachbarZimmer[0]!], status: 'dirty' })
    expect(fremd.statusCode).toBe(404)
  })
})

describe('Verfuegbarkeit', () => {
  it('nennt das Kuerzel der Kategorie neben ihrer ID', async () => {
    await owner.query(`SELECT inventory_materialize($1,'2026-10-01'::date,'2026-10-03'::date)`,
      [fx.propertyId])
    const r = await app.inject({
      method: 'GET',
      url: `/v1/properties/${fx.propertyId}/availability?from=2026-10-01&to=2026-10-03`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode, r.body).toBe(200)
    const { days } = r.json<{ days: Array<{ category_code: string; available: number }> }>()
    expect(days).toHaveLength(2)
    expect(days.every(d => d.category_code === 'DZ' && d.available === 4)).toBe(true)
  })
})

describe('Tagesplan fuer ein externes Reinigungssystem', () => {
  it('sagt je Zimmer Abreise, ob schon ausgecheckt, Bleiber und Anreise', async () => {
    await owner.query(`SELECT inventory_materialize($1,'2026-09-28'::date,'2026-10-10'::date)`,
      [fx.propertyId])
    const tag = '2026-10-02'
    // 101: Abreise heute, Gast noch im Haus -- warten
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: katId,
      resourceId: zimmer[0], arrival: '2026-09-30', departure: tag, status: 'InHouse' })
    // 102: Abreise heute, schon ausgecheckt -- frei zum Reinigen
    const weg = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: katId,
      resourceId: zimmer[1], arrival: '2026-09-30', departure: tag, status: 'InHouse' })
    await owner.query(
      `UPDATE reservation SET status = 'CheckedOut', checked_out_at = now() WHERE id = $1`,
      [weg.reservationId])
    // 103: Bleiber
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: katId,
      resourceId: zimmer[2], arrival: '2026-09-30', departure: '2026-10-05', status: 'InHouse' })
    // 104: leer, aber Anreise heute
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: katId,
      resourceId: zimmer[3], arrival: tag, departure: '2026-10-04' })

    const r = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/housekeeping?date=${tag}`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode, r.body).toBe(200)
    const { rooms } = r.json<{ rooms: Array<{ code: string; departureRef: string | null
      departureCheckedOut: boolean | null; stayoverRef: string | null
      arrivalRef: string | null }> }>()
    const plan = Object.fromEntries(rooms.map(z => [z.code, {
      abreise: z.departureRef !== null, ausgecheckt: z.departureCheckedOut,
      bleiber: z.stayoverRef !== null, anreise: z.arrivalRef !== null }]))
    expect(plan).toEqual({
      '101': { abreise: true, ausgecheckt: false, bleiber: false, anreise: false },
      '102': { abreise: true, ausgecheckt: true, bleiber: false, anreise: false },
      '103': { abreise: false, ausgecheckt: null, bleiber: true, anreise: false },
      '104': { abreise: false, ausgecheckt: null, bleiber: false, anreise: true }
    })
  })
})
