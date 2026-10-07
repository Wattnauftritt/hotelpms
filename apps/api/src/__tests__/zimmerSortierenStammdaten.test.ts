import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { DEFAULT_ROOM_SORT_WEIGHTS } from '@hotelpms/domain'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Zimmer sortieren, Schritt 1 (Migration 0103, Sven 07.10.2026): Qualitaet
 * und Gebaeude am Zimmer, "Zimmer fest" an der Reservierung, Einstellung je
 * Haus. Der Sortierer selbst kommt danach; hier geht es darum, dass die
 * Angaben ankommen, geprueft werden und nichts nebenher anstossen.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let zimmer: number[]
let chef: Record<string, string>
let rezeption: Record<string, string>

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
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  zimmer = await makeResources(owner, fx.propertyId, catId, 3)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const c = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  chef = { cookie: `hp_session=${c.sessionId}` }
  const r = await makeUser(owner,
    { email: 'rezeption@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  rezeption = { cookie: `hp_session=${r.sessionId}` }
})

const url = (): string => `/v1/properties/${fx.propertyId}/room-sort-settings`

describe('Einstellung je Haus', () => {
  it('liefert ohne Eintrag die Vorgabe: auf Knopfdruck, heutige Anreisen fest', async () => {
    const r = await app.inject({ method: 'GET', url: url(), headers: rezeption })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({
      configured: false, mode: 'manual', keepToday: true, weights: {},
      effective: { pricePercent: 70, topRoomPenalty: 1000, smallRoomAttribute: 'klein' }
    })
  })

  it('speichert nur die Abweichung und rechnet die Vorgabe dazu', async () => {
    const r = await app.inject({ method: 'PUT', url: url(), headers: chef,
      payload: { mode: 'auto', keepToday: false,
                 weights: { wishPenalty: 500,
                            wishes: [{ keyword: 'Meerblick', attribute: 'meerblick' }] } } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ configured: true, mode: 'auto', keepToday: false,
      weights: { wishPenalty: 500, wishes: [{ keyword: 'meerblick', attribute: 'meerblick' }] } })
    expect(r.json().effective.topRoomPenalty).toBe(DEFAULT_ROOM_SORT_WEIGHTS.topRoomPenalty)
    expect(r.json().effective.wishPenalty).toBe(500)

    const db = await owner.query(`SELECT weights FROM room_sort_setting WHERE property_id = $1`,
      [fx.propertyId])
    expect(Object.keys(db.rows[0].weights).sort()).toEqual(['wishPenalty', 'wishes'])
  })

  it('weist einen vertippten Schluessel ab, statt ihn still zu speichern', async () => {
    const r = await app.inject({ method: 'PUT', url: url(), headers: chef,
      payload: { mode: 'manual', weights: { wishPenality: 500 } } })
    expect(r.statusCode).toBe(422)
    expect(JSON.stringify(r.json())).toContain('weights.wishPenality')
  })

  it('weist unbekannten Modus und Bruchzahlen ab', async () => {
    const a = await app.inject({ method: 'PUT', url: url(), headers: chef,
      payload: { mode: 'immer' } })
    expect(a.statusCode).toBe(422)
    const b = await app.inject({ method: 'PUT', url: url(), headers: chef,
      payload: { weights: { pricePercent: 70.5 } } })
    expect(b.statusCode).toBe(422)
    const c = await app.inject({ method: 'PUT', url: url(), headers: chef,
      payload: { weights: { pricePercent: 101 } } })
    expect(c.statusCode).toBe(422)
  })

  it('die Rezeption sieht die Einstellung, aendert sie aber nicht', async () => {
    const r = await app.inject({ method: 'PUT', url: url(), headers: rezeption,
      payload: { mode: 'off' } })
    expect(r.statusCode).toBe(403)
  })

  it('ein fremdes Haus bleibt unerreichbar', async () => {
    const anderes = await makeProperty(owner)
    const r = await app.inject({ method: 'GET',
      url: `/v1/properties/${anderes.propertyId}/room-sort-settings`, headers: chef })
    expect(r.statusCode).toBe(403)
  })
})

describe('Qualitaet und Gebaeude am Zimmer', () => {
  it('ein neues Zimmer ist gewoehnlich: Qualitaet 50, kein Gebaeude', async () => {
    const r = await app.inject({ method: 'GET', url: `/v1/properties/${fx.propertyId}/rooms`,
      headers: chef })
    expect(r.json().rooms[0]).toMatchObject({ quality: 50, building: null })
  })

  it('setzt und loescht beides ueber PATCH', async () => {
    const a = await app.inject({ method: 'PATCH', url: `/v1/rooms/${zimmer[0]}`, headers: chef,
      payload: { quality: 90, building: ' Nebenhaus ' } })
    expect(a.statusCode).toBe(200)
    expect(a.json()).toMatchObject({ quality: 90, building: 'Nebenhaus' })

    // Ohne Angabe bleibt beides stehen.
    const b = await app.inject({ method: 'PATCH', url: `/v1/rooms/${zimmer[0]}`, headers: chef,
      payload: { name: 'Seeblick' } })
    expect(b.json()).toMatchObject({ quality: 90, building: 'Nebenhaus' })

    const c = await app.inject({ method: 'PATCH', url: `/v1/rooms/${zimmer[0]}`, headers: chef,
      payload: { building: '' } })
    expect(c.json()).toMatchObject({ quality: 90, building: null })
  })

  it('nimmt beides beim Anlegen, einzeln und in Serie', async () => {
    const a = await app.inject({ method: 'POST', url: '/v1/rooms', headers: chef,
      payload: { propertyId: fx.propertyId, categoryId: catId, code: '31',
                 quality: 100, building: 'Haupthaus' } })
    expect(a.statusCode).toBe(201)
    const s = await app.inject({ method: 'POST', url: '/v1/rooms/series', headers: chef,
      payload: { propertyId: fx.propertyId, categoryId: catId, from: 1, to: 3,
                 quality: 20, building: 'Nebenhaus', commit: true } })
    expect(s.statusCode).toBe(200)
    const db = await owner.query<{ code: string; quality: number; building: string }>(
      `SELECT code, quality, building FROM resource
        WHERE property_id = $1 AND code IN ('31','1','2','3') ORDER BY code`, [fx.propertyId])
    expect(db.rows).toEqual([
      { code: '1', quality: 20, building: 'Nebenhaus' },
      { code: '2', quality: 20, building: 'Nebenhaus' },
      { code: '3', quality: 20, building: 'Nebenhaus' },
      { code: '31', quality: 100, building: 'Haupthaus' }
    ])
  })

  it('weist eine Qualitaet ausserhalb von 0 bis 100 ab', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/v1/rooms/${zimmer[0]}`, headers: chef,
      payload: { quality: 120 } })
    expect(r.statusCode).toBe(422)
  })
})

describe('Zimmer fest', () => {
  it('setzt das Schloss, zeigt es im Plan und am Aufenthalt', async () => {
    const res = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: catId,
      arrival: '2026-10-10', departure: '2026-10-12', resourceId: zimmer[1] })
    const ref = (await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM reservation WHERE id = $1`, [res.reservationId])).rows[0]!.public_ref

    const p = await app.inject({ method: 'PATCH', url: `/v1/reservations/${ref}`,
      headers: rezeption, payload: { roomFixed: true } })
    expect(p.statusCode).toBe(200)
    expect(p.json()).toMatchObject({ roomFixed: true })

    const g = await app.inject({ method: 'GET', url: `/v1/reservations/${ref}`,
      headers: rezeption })
    expect(g.json().roomFixed).toBe(true)

    const t = await app.inject({ method: 'GET', headers: rezeption,
      url: `/v1/properties/${fx.propertyId}/tape-chart?from=2026-10-09&to=2026-10-14` })
    expect(t.statusCode).toBe(200)
    const balken = (t.json().reservations as Array<{ public_ref: string; room_fixed: boolean }>)
      .find(x => x.public_ref === ref)
    expect(balken?.room_fixed).toBe(true)
  })

  it('stellt eine gepushte Buchung nicht auf lokal: das Schloss bewegt nichts', async () => {
    const res = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: catId,
      arrival: '2026-10-10', departure: '2026-10-12', resourceId: zimmer[1] })
    const conn = await owner.query<{ id: number }>(
      `INSERT INTO channel_connection (property_id, account_id, provider, name, token_hash)
       SELECT id, account_id, 'generic', 'Umsystem', 'x' FROM property WHERE id = $1
       RETURNING id`, [fx.propertyId])
    await owner.query(
      `UPDATE booking SET source = 'channel', channel_connection_id = $2,
                          channel_owner = 'source', external_reference = 'rc-1'
        WHERE id = $1`, [res.bookingId, conn.rows[0]!.id])
    const ref = (await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM reservation WHERE id = $1`, [res.reservationId])).rows[0]!.public_ref

    const p = await app.inject({ method: 'PATCH', url: `/v1/reservations/${ref}`,
      headers: rezeption, payload: { roomFixed: true } })
    expect(p.statusCode).toBe(200)
    const b = await owner.query<{ channel_owner: string }>(
      `SELECT channel_owner FROM booking WHERE id = $1`, [res.bookingId])
    expect(b.rows[0]!.channel_owner).toBe('source')
  })

  it('nimmt nur wahr oder falsch', async () => {
    const res = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: catId,
      arrival: '2026-10-10', departure: '2026-10-12' })
    const ref = (await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM reservation WHERE id = $1`, [res.reservationId])).rows[0]!.public_ref
    const p = await app.inject({ method: 'PATCH', url: `/v1/reservations/${ref}`,
      headers: rezeption, payload: { roomFixed: 'ja' } })
    expect(p.statusCode).toBe(422)
  })
})
