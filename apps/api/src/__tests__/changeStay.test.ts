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
let dz: number
let ez: number
let auth: Record<string, string>

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
  dz = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  ez = await makeCategory(owner, fx.propertyId, { code: 'EZ' })
  await makeResources(owner, fx.propertyId, dz, 2)
  await makeResources(owner, fx.propertyId, ez, 2, 'E')
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

async function reservierung(
  opts: { categoryId?: number; arrival?: string; departure?: string } = {}
): Promise<string> {
  const r = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: opts.categoryId ?? dz,
    arrival: opts.arrival ?? '2026-10-01', departure: opts.departure ?? '2026-10-04',
    priceCent: 9_000 })
  const ref = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [r.reservationId])
  return ref.rows[0]!.public_ref
}

const aendern = (ref: string, body: Record<string, unknown>) => app.inject({
  method: 'POST', url: `/v1/reservations/${ref}/change-stay`,
  headers: auth, payload: body })

async function sold(categoryId: number, date: string): Promise<number> {
  const r = await owner.query<{ sold: number }>(
    `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
    [fx.propertyId, categoryId, date])
  return r.rows[0]!.sold
}

describe('Aufenthalt aendern', () => {
  it('verlaengert und bindet nur die neue Nacht', async () => {
    const ref = await reservierung()
    const r = await aendern(ref, { departure: '2026-10-06' })
    expect(r.statusCode, r.body).toBe(200)
    expect((JSON.parse(r.body) as { nights: number }).nights).toBe(5)

    expect(await sold(dz, '2026-10-01')).toBe(1)   // unveraendert
    expect(await sold(dz, '2026-10-04')).toBe(1)   // neu gebunden
    expect(await sold(dz, '2026-10-05')).toBe(1)
    expect(await sold(dz, '2026-10-06')).toBe(0)   // Abreisenacht gibt es nicht
  })

  /**
   * Die Falle, deretwegen `inventory_move` nur die Differenz bindet: wer bei
   * einer Verlängerung erst alles freigibt und neu bindet, konkurriert mit
   * sich selbst und scheitert im vollen Haus an der eigenen Buchung.
   */
  it('verlaengert auch dann, wenn das Haus sonst ausgebucht ist', async () => {
    const ref = await reservierung()
    // Das zweite Doppelzimmer ueber den ganzen Zeitraum belegen.
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2026-10-01', departure: '2026-10-06' })
    expect(await sold(dz, '2026-10-03')).toBe(2)   // voll

    const r = await aendern(ref, { departure: '2026-10-05' })
    expect(r.statusCode, r.body).toBe(200)
    expect(await sold(dz, '2026-10-04')).toBe(2)
  })

  it('verkuerzt und gibt die entfallenen Naechte frei', async () => {
    const ref = await reservierung()
    const r = await aendern(ref, { departure: '2026-10-02' })
    expect(r.statusCode).toBe(200)

    expect(await sold(dz, '2026-10-01')).toBe(1)
    expect(await sold(dz, '2026-10-02')).toBe(0)
    expect(await sold(dz, '2026-10-03')).toBe(0)

    const n = await owner.query(`SELECT 1 FROM reservation_night
      WHERE property_id = $1 AND date >= '2026-10-02'`, [fx.propertyId])
    expect(n.rowCount).toBe(0)
  })

  /** Der Fall aus E11: laenger bleiben, aber die Kategorie ist ausgebucht. */
  it('verlaengert mit Kategoriewechsel in einem Zug', async () => {
    const ref = await reservierung()
    // Beide Doppelzimmer ab dem 4. belegt.
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2026-10-04', departure: '2026-10-08' })
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2026-10-04', departure: '2026-10-08' })
    expect(await sold(dz, '2026-10-04')).toBe(2)

    // Im Doppelzimmer ginge es nicht, im Einzelzimmer schon.
    const abgelehnt = await aendern(ref, { departure: '2026-10-06' })
    expect(abgelehnt.statusCode).toBe(409)

    const r = await aendern(ref, { departure: '2026-10-06', categoryId: ez })
    expect(r.statusCode, r.body).toBe(200)

    // Der ganze neue Zeitraum liegt jetzt im Einzelzimmer, das alte ist frei.
    expect(await sold(ez, '2026-10-01')).toBe(1)
    expect(await sold(ez, '2026-10-05')).toBe(1)
    expect(await sold(dz, '2026-10-01')).toBe(0)
  })

  it('laesst bei fehlgeschlagener Aenderung den alten Stand unberuehrt', async () => {
    const ref = await reservierung()
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2026-10-04', departure: '2026-10-08' })
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2026-10-04', departure: '2026-10-08' })

    const r = await aendern(ref, { departure: '2026-10-06' })
    expect(r.statusCode).toBe(409)

    // Der urspruengliche Aufenthalt steht unveraendert.
    expect(await sold(dz, '2026-10-01')).toBe(1)
    expect(await sold(dz, '2026-10-03')).toBe(1)
    const res = await owner.query<{ departure: string }>(
      `SELECT departure::text FROM reservation WHERE public_ref = $1`, [ref])
    expect(res.rows[0]!.departure).toBe('2026-10-04')
  })

  it('loest die Zimmerzuweisung beim Kategoriewechsel', async () => {
    const ref = await reservierung()
    const zimmer = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE category_id = $1 LIMIT 1`, [dz])
    await owner.query(`UPDATE reservation SET resource_id = $2 WHERE public_ref = $1`,
      [ref, zimmer.rows[0]!.id])

    const r = await aendern(ref, { categoryId: ez })
    expect(r.statusCode).toBe(200)
    expect((JSON.parse(r.body) as { roomAssignmentCleared: boolean })
      .roomAssignmentCleared).toBe(true)

    const res = await owner.query<{ resource_id: number | null }>(
      `SELECT resource_id FROM reservation WHERE public_ref = $1`, [ref])
    expect(res.rows[0]!.resource_id).toBeNull()
  })

  it('laesst die Anreise eines Gastes im Haus nicht verlegen', async () => {
    const ref = await reservierung()
    const zimmer = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE category_id = $1 LIMIT 1`, [dz])
    await owner.query(
      `UPDATE reservation SET status = 'InHouse', resource_id = $2 WHERE public_ref = $1`,
      [ref, zimmer.rows[0]!.id])

    expect((await aendern(ref, { arrival: '2026-10-02' })).statusCode).toBe(409)
    // Verlaengern geht dagegen, und das ist der haeufigste Fall ueberhaupt.
    expect((await aendern(ref, { departure: '2026-10-06' })).statusCode).toBe(200)
  })

  it('aendert eine stornierte Reservierung nicht', async () => {
    const ref = await reservierung()
    await owner.query(
      `UPDATE reservation SET status = 'Canceled', canceled_at = now() WHERE public_ref = $1`,
      [ref])
    const r = await aendern(ref, { departure: '2026-10-06' })
    expect(r.statusCode).toBe(409)
    expect(JSON.parse(r.body).detail).toContain('bindet kein Kontingent')
  })

  it('weist eine Zimmergruppe eines fremden Hauses ab', async () => {
    const ref = await reservierung()
    const andere = await makeProperty(owner, { code: 'FREMD' })
    const fremd = await makeCategory(owner, andere.propertyId, { code: 'X' })
    expect((await aendern(ref, { categoryId: fremd })).statusCode).toBe(404)
  })

  it('behaelt bereits gebuchte Naechte beim Verkuerzen', async () => {
    const ref = await reservierung()
    await owner.query(
      `UPDATE reservation_night SET posted = true
        WHERE date = '2026-10-01' AND reservation_id =
              (SELECT id FROM reservation WHERE public_ref = $1)`, [ref])

    await aendern(ref, { arrival: '2026-10-02', departure: '2026-10-04' })
    // Die gebuchte Nacht bleibt: an ihr haengt ein Beleg auf dem Folio.
    const n = await owner.query<{ date: string; posted: boolean }>(
      `SELECT date::text, posted FROM reservation_night
        WHERE property_id = $1 ORDER BY date`, [fx.propertyId])
    expect(n.rows[0]!.date).toBe('2026-10-01')
    expect(n.rows[0]!.posted).toBe(true)
  })
})
