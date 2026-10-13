import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Centgenauer Preis aus einem Umsystem (Migration 0160).
 *
 * Geprueft wird die Rangfolge, die Sven gesetzt hat: der Preis der Quelle
 * ersetzt die Schaetzung der Rezeption, eine Aenderung in StayGrid danach
 * aber nie. Dazu, was ein Beleg ist: eine gebuchte Nacht bleibt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let katId: number
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
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [admin.userId, fx.accountId])
})

async function maschine(scopes: string[]): Promise<Record<string, string>> {
  const z = await app.inject({
    method: 'POST', url: '/v1/oauth-clients', headers: auth(admin.sessionId),
    payload: { name: 'Adminpanel', scopes, propertyIds: [fx.propertyId] } })
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

/** Drei Naechte zu je 133 Euro: so traegt die Rezeption 399 Euro ein. */
async function reservierung() {
  const r = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: katId,
    arrival: '2026-11-02', departure: '2026-11-05', priceCent: 13_300,
    reserveInventory: false, withFolio: false })
  const ref = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [r.reservationId])
  return { ...r, ref: ref.rows[0]!.public_ref }
}

const QUELLE = { system: 'roomcloud', reference: 'RC-4711' }
const ZEITRAUM = { arrival: '2026-11-02', departure: '2026-11-05' }

const senden = (headers: Record<string, string>, ref: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/v1/reservations/${ref}/price`, headers,
               payload: { source: QUELLE, ...ZEITRAUM, ...payload } })

async function naechte(id: number): Promise<number[]> {
  const { rows } = await owner.query<{ price_cent: string }>(
    `SELECT price_cent FROM reservation_night WHERE reservation_id = $1 ORDER BY date`, [id])
  return rows.map(r => Number(r.price_cent))
}

describe('Preis aus der Quelle', () => {
  it('ersetzt den geschaetzten Betrag je Nacht auf den Cent', async () => {
    const m = await maschine(['reservation:price_import'])
    const r = await reservierung()
    const a = await senden(m, r.ref, { totalCent: 39_887, nights: [
      { date: '2026-11-04', priceCent: 14_900 },
      { date: '2026-11-02', priceCent: 12_493 },
      { date: '2026-11-03', priceCent: 12_494 }] })
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json()).toEqual({ reservationRef: r.ref, result: 'applied', perNight: true,
                               totalCent: 39_887 })
    expect(await naechte(r.reservationId)).toEqual([12_493, 12_494, 14_900])

    // Derselbe Aufruf noch einmal aendert nichts.
    const b = await senden(m, r.ref, { totalCent: 39_887, nights: [
      { date: '2026-11-02', priceCent: 12_493 }, { date: '2026-11-03', priceCent: 12_494 },
      { date: '2026-11-04', priceCent: 14_900 }] })
    expect(b.json<{ result: string }>().result).toBe('unchanged')
  })

  it('verteilt eine Summe ohne Naechte mit dem Rest-Cent auf der ersten', async () => {
    const m = await maschine(['reservation:price_import'])
    const r = await reservierung()
    const a = await senden(m, r.ref, { totalCent: 39_887 })
    expect(a.json()).toMatchObject({ result: 'applied', perNight: false, totalCent: 39_887 })
    expect(await naechte(r.reservationId)).toEqual([13_297, 13_295, 13_295])
  })

  it('folgt einer spaeteren Aenderung der Quelle, solange StayGrid nichts geaendert hat', async () => {
    const m = await maschine(['reservation:price_import'])
    const r = await reservierung()
    await senden(m, r.ref, { totalCent: 39_887 })
    const b = await senden(m, r.ref, { totalCent: 42_000 })
    expect(b.json<{ result: string }>().result).toBe('applied')
    expect(await naechte(r.reservationId)).toEqual([14_000, 14_000, 14_000])
  })

  it('laesst stehen, was die Rezeption nach der Uebernahme geaendert hat', async () => {
    const m = await maschine(['reservation:price_import'])
    const r = await reservierung()
    await senden(m, r.ref, { totalCent: 39_887 })
    // Die Rezeption vereinbart einen anderen Preis.
    await owner.query(
      `UPDATE reservation_night SET price_cent = 12_000 WHERE reservation_id = $1`,
      [r.reservationId])
    const b = await senden(m, r.ref, { totalCent: 39_887 })
    expect(b.json()).toEqual({ reservationRef: r.ref, result: 'kept_existing',
                               reason: 'changed_locally', totalCent: 36_000 })
    expect(await naechte(r.reservationId)).toEqual([12_000, 12_000, 12_000])
  })

  it('ersetzt eine Aenderung der Rezeption vor der ersten Uebernahme', async () => {
    const m = await maschine(['reservation:price_import'])
    const r = await reservierung()
    await owner.query(
      `UPDATE reservation_night SET price_cent = 12_000 WHERE reservation_id = $1`,
      [r.reservationId])
    const a = await senden(m, r.ref, { totalCent: 39_887 })
    expect(a.json<{ result: string }>().result).toBe('applied')
  })

  it('nimmt keinen Preis fuer einen anderen Zeitraum', async () => {
    const m = await maschine(['reservation:price_import'])
    const r = await reservierung()
    const a = await senden(m, r.ref, { totalCent: 26_000, departure: '2026-11-04' })
    expect(a.json()).toMatchObject({ result: 'kept_existing', reason: 'stay_differs' })
    expect(await naechte(r.reservationId)).toEqual([13_300, 13_300, 13_300])
  })

  it('laesst gebuchte Naechte stehen und verteilt den Rest', async () => {
    const m = await maschine(['reservation:price_import'])
    const r = await reservierung()
    await owner.query(
      `UPDATE reservation_night SET posted = true
        WHERE reservation_id = $1 AND date = '2026-11-02'`, [r.reservationId])
    // Je Nacht passt nicht: die erste lief zu 133 Euro. Dann die Summe.
    const a = await senden(m, r.ref, { totalCent: 39_887, nights: [
      { date: '2026-11-02', priceCent: 12_493 }, { date: '2026-11-03', priceCent: 12_494 },
      { date: '2026-11-04', priceCent: 14_900 }] })
    expect(a.json()).toMatchObject({ result: 'applied', perNight: false, totalCent: 39_887 })
    expect(await naechte(r.reservationId)).toEqual([13_300, 13_294, 13_293])

    // Weniger als schon gebucht laesst sich nicht verteilen.
    await owner.query(`DELETE FROM reservation_external_price`)
    const b = await senden(m, r.ref, { totalCent: 10_000 })
    expect(b.json()).toMatchObject({ result: 'kept_existing', reason: 'posted' })
  })

  it('weist widerspruechliche Angaben ab', async () => {
    const m = await maschine(['reservation:price_import'])
    const r = await reservierung()
    const summe = await senden(m, r.ref, { totalCent: 1, nights: [
      { date: '2026-11-02', priceCent: 1 }, { date: '2026-11-03', priceCent: 1 },
      { date: '2026-11-04', priceCent: 1 }] })
    expect(summe.statusCode).toBe(422)
    const luecke = await senden(m, r.ref, { totalCent: 2, nights: [
      { date: '2026-11-02', priceCent: 1 }, { date: '2026-11-04', priceCent: 1 }] })
    expect(luecke.statusCode).toBe(422)
    const komma = await senden(m, r.ref, { totalCent: 398.87 })
    expect(komma.statusCode).toBe(422)
    const ohneQuelle = await app.inject({ method: 'PUT', url: `/v1/reservations/${r.ref}/price`,
      headers: m, payload: { ...ZEITRAUM, totalCent: 100 } })
    expect(ohneQuelle.statusCode).toBe(422)
  })

  it('verlangt das eigene Recht', async () => {
    const m = await maschine(['guest:contact_write'])
    const r = await reservierung()
    const a = await senden(m, r.ref, { totalCent: 39_887 })
    expect(a.statusCode).toBe(403)
  })
})
