import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, makeReservation, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Zimmer sortieren im Zimmerplan (Migration 0122, Sven 10.10.2026: "ich
 * habe im kalender keinen knopf zum zimmer sortieren"). Gegen die echte
 * Datenbank, weil die Zusagen in Sperren, Triggern und der Zeilenrichtlinie
 * stecken: Uebernehmen schreibt nur, was die Vorschau zeigte, eine gepushte
 * Buchung bleibt der Quelle, und Rueckgaengig verwirft keine fremde Arbeit.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let dz: number
let z10: number
let z11: number
let rezeption: Record<string, string>

const HEUTE = '2026-10-10'

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
  dz = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  z10 = (await owner.query<{ id: number }>(
    `INSERT INTO resource (property_id, category_id, code, quality) VALUES ($1,$2,'10',90)
     RETURNING id`, [fx.propertyId, dz])).rows[0]!.id
  z11 = (await owner.query<{ id: number }>(
    `INSERT INTO resource (property_id, category_id, code, quality) VALUES ($1,$2,'11',40)
     RETURNING id`, [fx.propertyId, dz])).rows[0]!.id
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, HEUTE)
  const r = await makeUser(owner,
    { email: 'rezeption@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  rezeption = { cookie: `hp_session=${r.sessionId}` }
})

const url = (teil: string): string => `/v1/properties/${fx.propertyId}/room-sort/${teil}`
const ZEITRAUM = { from: HEUTE, to: '2026-10-24' }

async function ref(id: number): Promise<string> {
  return (await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [id])).rows[0]!.public_ref
}
async function zimmerVon(id: number): Promise<number | null> {
  return (await owner.query<{ resource_id: number | null }>(
    `SELECT resource_id FROM reservation WHERE id = $1`, [id])).rows[0]!.resource_id
}

/** Der Lange liegt im schlechten Zimmer, der Kurze im guten. */
async function verkehrtHerum(): Promise<{ lang: number; kurz: number }> {
  const lang = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
    arrival: '2026-10-12', departure: '2026-10-19', resourceId: z11, priceCent: 12000 })
  const kurz = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
    arrival: '2026-10-12', departure: '2026-10-13', resourceId: z10, priceCent: 12000 })
  return { lang: lang.reservationId, kurz: kurz.reservationId }
}

describe('Vorschau', () => {
  it('schlaegt Zuege vor und schreibt nichts', async () => {
    const { lang, kurz } = await verkehrtHerum()
    const r = await app.inject({ method: 'POST', url: url('preview'), headers: rezeption,
      payload: ZEITRAUM })
    expect(r.statusCode).toBe(200)
    const v = r.json()
    expect(v.moves).toHaveLength(2)
    expect(v.moves.find((m: { reservationRef: string }) => m.reservationRef === undefined))
      .toBeUndefined()
    expect(v.costAfter).toBeLessThan(v.costBefore)
    expect(await zimmerVon(lang)).toBe(z11)
    expect(await zimmerVon(kurz)).toBe(z10)
  })

  it('weist einen zu langen Zeitraum ab', async () => {
    const r = await app.inject({ method: 'POST', url: url('preview'), headers: rezeption,
      payload: { from: HEUTE, to: '2027-01-10' } })
    expect(r.statusCode).toBe(422)
  })

  it('sortiert nicht, wenn das Haus es abgeschaltet hat', async () => {
    await owner.query(`INSERT INTO room_sort_setting (property_id, mode) VALUES ($1, 'off')`,
      [fx.propertyId])
    const r = await app.inject({ method: 'POST', url: url('preview'), headers: rezeption,
      payload: ZEITRAUM })
    expect(r.statusCode).toBe(409)
  })

  it('laesst feste, angereiste und heutige Gaeste liegen', async () => {
    const fest = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2026-10-12', departure: '2026-10-19', resourceId: z11 })
    await owner.query(`UPDATE reservation SET room_fixed = true WHERE id = $1`,
      [fest.reservationId])
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2026-10-12', departure: '2026-10-13', resourceId: z10 })
    const heute = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: HEUTE, departure: '2026-10-12', resourceId: z11 })
    const v = (await app.inject({ method: 'POST', url: url('preview'), headers: rezeption,
      payload: ZEITRAUM })).json()
    const refs = v.moves.map((m: { reservationRef: string }) => m.reservationRef)
    expect(refs).not.toContain(await ref(fest.reservationId))
    expect(refs).not.toContain(await ref(heute.reservationId))
  })
})

describe('Uebernehmen und Rueckgaengig', () => {
  it('schreibt die Zuege der Vorschau und nimmt sie wieder zurueck', async () => {
    const { lang, kurz } = await verkehrtHerum()
    const v = (await app.inject({ method: 'POST', url: url('preview'), headers: rezeption,
      payload: ZEITRAUM })).json()
    const a = await app.inject({ method: 'POST', url: url('apply'), headers: rezeption,
      payload: { ...ZEITRAUM, basis: v.basis,
                 moves: v.moves.map((m: { reservationRef: string; toRoomId: number }) =>
                   ({ reservationRef: m.reservationRef, toRoomId: m.toRoomId })) } })
    expect(a.statusCode).toBe(200)
    expect(a.json().moved).toBe(2)
    // Ein Ringtausch: jeder Zwischenstand waere belegt, das Ergebnis nicht.
    expect(await zimmerVon(lang)).toBe(z10)
    expect(await zimmerVon(kurz)).toBe(z11)

    const u = await app.inject({ method: 'POST', headers: rezeption,
      url: url(`runs/${a.json().runRef}/undo`) })
    expect(u.statusCode).toBe(200)
    expect(await zimmerVon(lang)).toBe(z11)
    expect(await zimmerVon(kurz)).toBe(z10)

    const nochmal = await app.inject({ method: 'POST', headers: rezeption,
      url: url(`runs/${a.json().runRef}/undo`) })
    expect(nochmal.statusCode).toBe(409)
  })

  it('schreibt nichts, wenn sich der Plan seit der Vorschau geaendert hat', async () => {
    const { lang } = await verkehrtHerum()
    const v = (await app.inject({ method: 'POST', url: url('preview'), headers: rezeption,
      payload: ZEITRAUM })).json()
    await owner.query(`UPDATE reservation SET notes = 'angerufen', updated_at = now()
                        WHERE id = $1`, [lang])
    const a = await app.inject({ method: 'POST', url: url('apply'), headers: rezeption,
      payload: { ...ZEITRAUM, basis: v.basis,
                 moves: v.moves.map((m: { reservationRef: string; toRoomId: number }) =>
                   ({ reservationRef: m.reservationRef, toRoomId: m.toRoomId })) } })
    expect(a.statusCode).toBe(409)
    expect(await zimmerVon(lang)).toBe(z11)
  })

  it('nimmt keinen Zug an, den der Sortierer nicht vorgeschlagen hat', async () => {
    const { lang } = await verkehrtHerum()
    const v = (await app.inject({ method: 'POST', url: url('preview'), headers: rezeption,
      payload: ZEITRAUM })).json()
    const a = await app.inject({ method: 'POST', url: url('apply'), headers: rezeption,
      payload: { ...ZEITRAUM, basis: v.basis,
                 moves: [{ reservationRef: await ref(lang), toRoomId: z11 }] } })
    expect(a.statusCode).toBe(409)
  })

  it('nimmt nicht zurueck, was danach jemand von Hand umgelegt hat', async () => {
    const { lang } = await verkehrtHerum()
    const v = (await app.inject({ method: 'POST', url: url('preview'), headers: rezeption,
      payload: ZEITRAUM })).json()
    const a = (await app.inject({ method: 'POST', url: url('apply'), headers: rezeption,
      payload: { ...ZEITRAUM, basis: v.basis,
                 moves: v.moves.map((m: { reservationRef: string; toRoomId: number }) =>
                   ({ reservationRef: m.reservationRef, toRoomId: m.toRoomId })) } })).json()
    await owner.query(`UPDATE reservation SET resource_id = NULL WHERE id = $1`, [lang])
    const u = await app.inject({ method: 'POST', headers: rezeption,
      url: url(`runs/${a.runRef}/undo`) })
    expect(u.statusCode).toBe(409)
    expect(await zimmerVon(lang)).toBeNull()
  })

  it('stellt eine gepushte Buchung nicht auf lokal', async () => {
    const { lang } = await verkehrtHerum()
    const conn = await owner.query<{ id: number }>(
      `INSERT INTO channel_connection (property_id, account_id, provider, name, token_hash)
       SELECT id, account_id, 'generic', 'Umsystem', 'x' FROM property WHERE id = $1
       RETURNING id`, [fx.propertyId])
    await owner.query(
      `UPDATE booking SET source = 'channel', channel_connection_id = $2,
                          channel_owner = 'source', external_reference = 'rc-1'
        WHERE id = (SELECT booking_id FROM reservation WHERE id = $1)`,
      [lang, conn.rows[0]!.id])
    const v = (await app.inject({ method: 'POST', url: url('preview'), headers: rezeption,
      payload: ZEITRAUM })).json()
    const a = await app.inject({ method: 'POST', url: url('apply'), headers: rezeption,
      payload: { ...ZEITRAUM, basis: v.basis,
                 moves: v.moves.map((m: { reservationRef: string; toRoomId: number }) =>
                   ({ reservationRef: m.reservationRef, toRoomId: m.toRoomId })) } })
    expect(a.statusCode).toBe(200)
    expect(await zimmerVon(lang)).toBe(z10)
    const b = await owner.query<{ channel_owner: string }>(
      `SELECT b.channel_owner FROM booking b JOIN reservation r ON r.booking_id = b.id
        WHERE r.id = $1`, [lang])
    expect(b.rows[0]!.channel_owner).toBe('source')
  })

  it('verlangt das Recht, Reservierungen zu aendern', async () => {
    const hk = await makeUser(owner,
      { email: 'hk@test.de', propertyId: fx.propertyId, roleKey: 'housekeeping' })
    const r = await app.inject({ method: 'POST', url: url('preview'),
      headers: { cookie: `hp_session=${hk.sessionId}` }, payload: ZEITRAUM })
    expect(r.statusCode).toBe(403)
  })
})
