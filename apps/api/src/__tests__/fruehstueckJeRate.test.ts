import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, makePaymentMethod,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Fruehstueck je Rate (Migration 0158): das Haus setzt es an der Rate, und
 * die Anzahlung weist dieselben Saetze aus, die der Nachtlauf spaeter bucht.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let preise: Record<string, string>
let rezeption: Record<string, string>
let categoryId: number

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

let lauf = 0
const key = (): string => `fr-${++lauf}-${Date.now()}`

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  await openBusinessDay(owner, fx.propertyId, new Date().toISOString().slice(0, 10))
  await makePaymentMethod(owner, fx.propertyId, 'TRANSFER')
  const u = await makeUser(owner,
    { email: 'rev@test.de', propertyId: fx.propertyId, roleKey: 'revenue' })
  preise = { cookie: `hp_session=${u.sessionId}` }
  const r = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  rezeption = { cookie: `hp_session=${r.sessionId}` }
  categoryId = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, categoryId, 1)
})

async function plan(propertyId = fx.propertyId, catId = categoryId): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `INSERT INTO rate_plan (property_id, category_id, code, name)
     VALUES ($1,$2,'BB','Mit Fruehstueck') RETURNING id`, [propertyId, catId])
  return r.rows[0]!.id
}

const setzen = (ratePlanId: number, breakfastCent: unknown,
                headers = preise, propertyId = fx.propertyId,
                childBreakfastCent: unknown = null) => app.inject({
  method: 'PUT',
  url: `/v1/properties/${propertyId}/rate-plans/${ratePlanId}/breakfast`,
  headers, payload: { breakfastCent, childBreakfastCent } })

describe('Fruehstueck an der Rate', () => {
  it('setzt, liest und entfernt den Preis', async () => {
    const id = await plan()
    const r = await setzen(id, 1_250)
    expect(r.statusCode, r.body).toBe(200)

    const liste = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/rate-plans`, headers: preise })
    const plaene = (JSON.parse(liste.body) as {
      ratePlans: Array<{ id: number; breakfastCent: number | null }> }).ratePlans
    expect(plaene.find(p => p.id === id)!.breakfastCent).toBe(1_250)

    expect((await setzen(id, null)).statusCode).toBe(200)
    const z = await owner.query(`SELECT breakfast_cent FROM rate_plan WHERE id = $1`, [id])
    expect(z.rows[0]!.breakfast_cent).toBeNull()
  })

  it('weist null, Bruchteile und zu grosse Betraege ab', async () => {
    const id = await plan()
    for (const falsch of [0, -100, 12.5, 100_001, '1200']) {
      const r = await setzen(id, falsch)
      expect(r.statusCode, String(falsch)).toBe(422)
    }
  })

  it('nimmt einen Kinderpreis an, auch 0, aber nicht ohne Fruehstueck', async () => {
    const id = await plan()
    expect((await setzen(id, 1_500, preise, fx.propertyId, 0)).statusCode).toBe(200)
    let z = await owner.query(`SELECT breakfast_child_cent FROM rate_plan WHERE id = $1`, [id])
    expect(z.rows[0]!.breakfast_child_cent).toBe(0)

    expect((await setzen(id, 1_500, preise, fx.propertyId, -1)).statusCode).toBe(422)
    expect((await setzen(id, 1_500, preise, fx.propertyId, 7.5)).statusCode).toBe(422)

    // Fruehstueck heraus: der Kinderpreis geht mit, sonst stuende er allein.
    expect((await setzen(id, null, preise, fx.propertyId, 800)).statusCode).toBe(200)
    z = await owner.query(`SELECT breakfast_child_cent FROM rate_plan WHERE id = $1`, [id])
    expect(z.rows[0]!.breakfast_child_cent).toBeNull()
  })

  it('verlangt das Recht, Raten zu pflegen', async () => {
    const id = await plan()
    expect((await setzen(id, 1_000, rezeption)).statusCode).toBe(403)
  })

  it('schreibt keine Rate eines anderen Hauses im Account', async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, name, code, timezone)
       SELECT account_id, 'Zweites', 'P2', timezone FROM property WHERE id = $1
       RETURNING id`, [fx.propertyId])
    const fremdeKat = await makeCategory(owner, zweites.rows[0]!.id)
    const fremd = await plan(zweites.rows[0]!.id, fremdeKat)
    const r = await setzen(fremd, 1_000)
    expect(r.statusCode, r.body).toBe(404)
  })
})

describe('Anzahlung mit Fruehstueck aus der Rate', () => {
  /**
   * Derselbe Fall wie das Buffet in `depositSplit.test.ts`, nur ueber das
   * Feld an der Rate statt ueber ein Produkt: fuenf Naechte zu 110 Euro,
   * davon 12 Euro Fruehstueck fuer eine Person. Gleiche Saetze, gleiche
   * Betraege -- sonst wiese die Anzahlung etwas anderes aus als spaeter die
   * Schlussrechnung.
   */
  it('weist Speisen und Getraenke mit dem Pauschalanteil aus', async () => {
    const gast = await makeGuest(owner, fx.accountId)
    const res = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId,
      arrival: '2027-03-01', departure: '2027-03-06',
      priceCent: 11_000, reserveInventory: false })
    const f = await owner.query<{ public_ref: string }>(
      `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`,
      [res.folioId, gast.id])
    const id = await plan()
    expect((await setzen(id, 1_200)).statusCode).toBe(200)
    await owner.query(`UPDATE reservation SET rate_plan_id = $2, guest_count = 1 WHERE id = $1`,
      [res.reservationId, id])

    const pm = await owner.query<{ id: number }>(
      `SELECT id FROM payment_method WHERE property_id = $1 AND code = 'TRANSFER'`,
      [fx.propertyId])
    const s = await owner.query<{ id: number }>(
      `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                               payment_method_id)
       VALUES ($1,$2,current_date,20000,$3) RETURNING id`,
      [fx.propertyId, res.folioId, pm.rows[0]!.id])

    const r = await app.inject({
      method: 'POST', url: `/v1/folios/${f.rows[0]!.public_ref}/deposit-invoice`,
      headers: { ...rezeption, 'idempotency-key': key() },
      payload: { settlementId: s.rows[0]!.id } })
    expect(r.statusCode, r.body).toBe(201)
    const body = JSON.parse(r.body) as { groups: Array<{ rateBp: number; grossCent: number }> }
    expect(body.groups.map(g => ({ rateBp: g.rateBp, grossCent: g.grossCent }))).toEqual([
      { rateBp: 700, grossCent: 19_345 },
      { rateBp: 1900, grossCent: 655 }])
  })
})
