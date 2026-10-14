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

describe('Weitere Inklusivleistungen an der Rate (0165)', () => {
  const steuer = async (code: string, rateBp: number): Promise<number> =>
    (await owner.query<{ id: number }>(
      `INSERT INTO tax_rule (property_id, code, kind, name, basis, rate_bp)
       VALUES ($1,$2,'vat',$2,'percent',$3) RETURNING id`,
      [fx.propertyId, code, rateBp])).rows[0]!.id
  const inklusiv = (ratePlanId: number, inclusions: unknown, headers = preise) => app.inject({
    method: 'PUT', url: `/v1/properties/${fx.propertyId}/rate-plans/${ratePlanId}/inclusions`,
    headers, payload: { inclusions } })
  const lesen = async (ratePlanId: number) => {
    const r = JSON.parse((await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/rate-plans`, headers: preise })).body
    ) as { ratePlans: Array<{ id: number; inclusions: Array<{ name: string }> }>
           vatRules: Array<{ id: number }> }
    return { plan: r.ratePlans.find(p => p.id === ratePlanId)!, vatRules: r.vatRules }
  }

  it('setzt, ersetzt und leert die Liste, Konto nach Satz', async () => {
    const id = await plan()
    const voll = await steuer('U19', 1900)
    const r = await inklusiv(id, [
      { name: 'Parken', grossCent: 1_000, chargeMode: 'per_night', taxRuleId: voll },
      { name: 'Sekt', grossCent: 800, chargeMode: 'once', taxRuleId: voll }])
    expect(r.statusCode, r.body).toBe(200)
    const gelesen = await lesen(id)
    expect(gelesen.plan.inclusions.map(i => i.name)).toEqual(['Parken', 'Sekt'])
    expect(gelesen.vatRules.map(v => v.id)).toContain(voll)
    const konten = await owner.query<{ revenue_account: string }>(
      `SELECT revenue_account FROM product WHERE active ORDER BY id`)
    expect(konten.rows.map(k => k.revenue_account)).toEqual(['8400', '8400'])

    // Eine entfernte Leistung wird stillgelegt, nicht geloescht.
    expect((await inklusiv(id, [
      { name: 'Parkplatz', grossCent: 1_200, chargeMode: 'per_night', taxRuleId: voll }]))
      .statusCode).toBe(200)
    expect((await lesen(id)).plan.inclusions).toEqual([
      { name: 'Parkplatz', grossCent: 1_200, chargeMode: 'per_night', taxRuleId: voll }])
    const alle = await owner.query<{ n: number; aktiv: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE active)::int AS aktiv FROM product`)
    expect(alle.rows[0]).toEqual({ n: 2, aktiv: 1 })

    expect((await inklusiv(id, [])).statusCode).toBe(200)
    expect((await lesen(id)).plan.inclusions).toEqual([])
  })

  it('weist einen fremden Steuersatz und einen Preis von null ab', async () => {
    const id = await plan()
    const fremd = await makeProperty(owner, { name: 'Fremd', code: 'FREMD' })
    const fremdeSteuer = (await owner.query<{ id: number }>(
      `INSERT INTO tax_rule (property_id, code, kind, name, basis, rate_bp)
       VALUES ($1,'X','vat','X','percent',1900) RETURNING id`, [fremd.propertyId])).rows[0]!.id
    const r = await inklusiv(id, [
      { name: 'Parken', grossCent: 1_000, chargeMode: 'per_night', taxRuleId: fremdeSteuer }])
    expect(r.statusCode, r.body).toBe(422)
    expect(r.body).toContain('inclusions.0.taxRuleId')

    const voll = await steuer('U19', 1900)
    const null_ = await inklusiv(id, [
      { name: 'Parken', grossCent: 0, chargeMode: 'per_night', taxRuleId: voll }])
    expect(null_.statusCode).toBe(422)
    // Die Rezeption pflegt keine Raten.
    expect((await inklusiv(id, [], rezeption)).statusCode).toBe(403)
  })
})

describe('Fruehstueck als Regel des Hauses (0169)', () => {
  const haus = (breakfastCent: unknown, childBreakfastCent: unknown = null,
                headers = preise) => app.inject({
    method: 'PUT', url: `/v1/properties/${fx.propertyId}/breakfast-rule`,
    headers, payload: { breakfastCent, childBreakfastCent } })

  it('setzt, liest und entfernt die Regel', async () => {
    expect((await haus(1_200, 0)).statusCode).toBe(200)
    const liste = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/rate-plans`, headers: preise })
    expect((JSON.parse(liste.body) as { houseBreakfast: unknown }).houseBreakfast)
      .toEqual({ breakfastCent: 1_200, childBreakfastCent: 0 })

    expect((await haus(null, 500)).statusCode).toBe(200)
    const z = await owner.query(
      `SELECT breakfast_cent, breakfast_child_cent FROM property WHERE id = $1`,
      [fx.propertyId])
    expect(z.rows[0]).toEqual({ breakfast_cent: null, breakfast_child_cent: null })
  })

  it('prueft wie an der Rate und verlangt dasselbe Recht', async () => {
    for (const falsch of [0, 12.5, 100_001, '1200']) {
      expect((await haus(falsch)).statusCode, String(falsch)).toBe(422)
    }
    expect((await haus(1_000, null, rezeption)).statusCode).toBe(403)
  })

  it('nimmt eine Reservierung per PATCH vom Fruehstueck aus und zeigt es', async () => {
    const res = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId,
      arrival: '2027-03-01', departure: '2027-03-03',
      priceCent: 11_000, reserveInventory: false })
    const ref = (await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM reservation WHERE id = $1`, [res.reservationId])).rows[0]!.public_ref
    const ohne = await app.inject({
      method: 'PATCH', url: `/v1/reservations/${ref}`,
      headers: rezeption, payload: { breakfastDeclined: true } })
    expect(ohne.statusCode, ohne.body).toBe(200)
    const z = await owner.query(`SELECT breakfast_declined FROM reservation WHERE id = $1`,
      [res.reservationId])
    expect(z.rows[0]!.breakfast_declined).toBe(true)
    const d = await app.inject({
      method: 'GET', url: `/v1/reservations/${ref}`, headers: rezeption })
    expect((JSON.parse(d.body) as { breakfastDeclined: boolean }).breakfastDeclined).toBe(true)
  })
})

describe('Fruehstueck nachtraeglich aufteilen (0169)', () => {
  /** Eine Nacht, wie der Nachtlauf sie vor der Regel gebucht hat. */
  const nacht = (resId: number, folioId: number, datum: string, brutto: number) =>
    owner.query<{ id: number }>(
      `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account,
                           reservation_id)
       VALUES ($1,$2,$3::date,'Uebernachtung ' || to_char($3::date,'DD.MM.YYYY'),1,
               $4::bigint - round($4::bigint * 700 / 10700.0), round($4::bigint * 700 / 10700.0),
               $4::bigint, 700, '8300', $5)
       RETURNING id`,
      [fx.propertyId, folioId, datum, brutto, resId])

  async function aufenthalt(): Promise<{ resId: number; folioId: number; folioRef: string }> {
    const res = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId,
      arrival: '2026-10-08', departure: '2026-10-11',
      priceCent: 8_933, reserveInventory: false })
    await owner.query(`UPDATE reservation SET guest_count = 2 WHERE id = $1`,
      [res.reservationId])
    const f = await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM folio WHERE id = $1`, [res.folioId])
    return { resId: res.reservationId, folioId: res.folioId, folioRef: f.rows[0]!.public_ref }
  }

  const teilen = (folioRef: string, breakfastCent: unknown, childBreakfastCent: unknown = null) =>
    app.inject({ method: 'POST', url: `/v1/folios/${folioRef}/breakfast-split`,
                 headers: { ...rezeption, 'idempotency-key': key() },
                 payload: { breakfastCent, childBreakfastCent } })

  it('bucht jede offene Nacht gegen und teilt sie mit dem Datum der Nacht neu', async () => {
    const a = await aufenthalt()
    await nacht(a.resId, a.folioId, '2026-10-08', 8_933)
    await nacht(a.resId, a.folioId, '2026-10-09', 8_934)

    const r = await teilen(a.folioRef, 1_200)
    expect(r.statusCode, r.body).toBe(201)
    expect(JSON.parse(r.body)).toEqual({ nights: 2, breakfastCent: 2 * 2 * 1_200 })

    const z = await owner.query<{ business_date: string; description: string
                                  gross_cent: number; tax_rate_bp: number
                                  package_part: string | null }>(
      `SELECT business_date::text, description, gross_cent::int, tax_rate_bp, package_part
         FROM charge WHERE folio_id = $1 ORDER BY id`, [a.folioId])
    const erste = z.rows.filter(x => x.business_date === '2026-10-08')
    expect(erste.map(x => [x.description, x.gross_cent, x.tax_rate_bp, x.package_part]))
      .toEqual([
        ['Uebernachtung 08.10.2026', 8_933, 700, null],
        ['Storno Uebernachtung 08.10.2026', -8_933, 700, null],
        ['Uebernachtung 08.10.2026', 8_933 - 2_400, 700, null],
        ['Frühstück Speisen 08.10.2026', 1_680, 700, 'breakfast_food'],
        ['Frühstück Getränke 08.10.2026', 720, 1900, 'breakfast_drinks']])
    // Kein Datum ausser denen der Naechte: der Leistungszeitraum bleibt.
    expect(new Set(z.rows.map(x => x.business_date)))
      .toEqual(new Set(['2026-10-08', '2026-10-09']))
    // Summe des Folios unveraendert, Steuer der Gegenbuchung genau aufgehoben.
    const s = await owner.query<{ brutto: number; paar: number }>(
      `SELECT sum(c.gross_cent)::int AS brutto,
              (SELECT sum(o.tax_cent + g.tax_cent + o.net_cent + g.net_cent)::int
                 FROM charge g JOIN charge o ON o.id = g.reverses_id
                WHERE g.folio_id = $1) AS paar
         FROM charge c WHERE c.folio_id = $1`, [a.folioId])
    expect(s.rows[0]).toEqual({ brutto: 8_933 + 8_934, paar: 0 })

    // Ein zweites Mal gibt es nichts mehr aufzuteilen.
    expect((await teilen(a.folioRef, 1_200)).statusCode).toBe(409)
  })

  it('weist "ohne Fruehstueck" ab und bucht dann nichts', async () => {
    const a = await aufenthalt()
    await nacht(a.resId, a.folioId, '2026-10-08', 8_933)
    await owner.query(`UPDATE reservation SET breakfast_declined = true WHERE id = $1`,
      [a.resId])
    const r = await teilen(a.folioRef, 1_200)
    expect(r.statusCode, r.body).toBe(409)
    expect(r.body).toContain('breakfast.declined')
    const z = await owner.query(`SELECT count(*)::int AS n FROM charge WHERE folio_id = $1`,
      [a.folioId])
    expect(z.rows[0]!.n).toBe(1)
  })

  it('prueft den Preis', async () => {
    const a = await aufenthalt()
    for (const falsch of [0, 12.5, '1200', null]) {
      expect((await teilen(a.folioRef, falsch)).statusCode, String(falsch)).toBe(422)
    }
  })
})
