import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeReservation, openBusinessDay, type Fixture } from '@hotelpms/testing'
import { type DbContext, type Pool } from '@hotelpms/db'
import { runNightAudit } from '../jobs/nightAudit.js'

/**
 * Weitere Inklusivleistungen der Rate (Migration 0165): der Nachtlauf
 * rechnet sie wie das Fruehstueck aus dem Nachtpreis heraus, jede zu ihrem
 * Satz und auf ihr Konto. Die Kennzahlen zaehlen davon nur die Logis.
 */

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext
let catId: number
let rooms: number[]

const TAG = '2026-10-01'

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(10)
})
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
  catId = await makeCategory(owner, fx.propertyId)
  rooms = await makeResources(owner, fx.propertyId, catId, 3)
  await owner.query(`SELECT inventory_materialize($1,$2::date,$3::date)`,
    [fx.propertyId, '2026-09-01', '2026-12-01'])
  await openBusinessDay(owner, fx.propertyId, TAG)
})

async function rate(breakfastCent: number | null,
                    childCent: number | null = null): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `INSERT INTO rate_plan (property_id, category_id, code, name, breakfast_cent,
                            breakfast_child_cent)
     VALUES ($1,$2,$3,$3,$4,$5) RETURNING id`,
    [fx.propertyId, catId, `R${breakfastCent ?? 0}-${childCent ?? 'x'}`, breakfastCent,
     childCent])
  return r.rows[0]!.id
}

async function gast(opts: { ratePlanId: number; personen: number; preis: number
                            zimmer: number }): Promise<number> {
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: catId, arrival: TAG, departure: '2026-10-03',
    status: 'InHouse', resourceId: rooms[opts.zimmer]!, priceCent: opts.preis })
  await owner.query(
    `UPDATE reservation SET rate_plan_id = $2, guest_count = $3 WHERE id = $1`,
    [res.reservationId, opts.ratePlanId, opts.personen])
  return res.reservationId
}

interface Zeile {
  description: string; gross_cent: number; tax_cent: number; tax_rate_bp: number
  revenue_account: string; package_part: string | null
}

async function buchungen(reservationId: number): Promise<Zeile[]> {
  const r = await owner.query<Zeile>(
    `SELECT description, gross_cent::int, tax_cent::int, tax_rate_bp, revenue_account,
            package_part
       FROM charge WHERE reservation_id = $1 ORDER BY id`, [reservationId])
  return r.rows
}

async function leistung(planId: number, name: string, cent: number,
                        mode: 'once' | 'per_night' | 'per_person_night',
                        rateBp: number, konto: string): Promise<void> {
  const t = await owner.query<{ id: number }>(
    `INSERT INTO tax_rule (property_id, code, kind, name, basis, rate_bp)
     VALUES ($1,$2,'vat',$2,'percent',$3) RETURNING id`,
    [fx.propertyId, `USt ${name}`, rateBp])
  const p = await owner.query<{ id: number }>(
    `INSERT INTO product (property_id, code, name, price_cent, tax_rule_id, charge_mode,
                          revenue_account)
     VALUES ($1,$2,$2,$3,$4,$5,$6) RETURNING id`,
    [fx.propertyId, name, cent, t.rows[0]!.id, mode, konto])
  await owner.query(
    `INSERT INTO rate_plan_product (rate_plan_id, product_id, property_id) VALUES ($1,$2,$3)`,
    [planId, p.rows[0]!.id, fx.propertyId])
}

const satzLogis = async (): Promise<void> => {
  await owner.query(
    `INSERT INTO tax_rule (property_id, code, kind, name, basis, rate_bp)
     VALUES ($1,'BEH','vat','Beherbergung','percent',700)`, [fx.propertyId])
}

describe('Inklusivleistungen im Zimmerpreis', () => {
  it('bucht Parken zu 19 % neben Logis und Fruehstueck', async () => {
    await satzLogis()
    const plan = await rate(1_500)
    await leistung(plan, 'Parken', 1_000, 'per_night', 1900, '8400')
    const r = await gast({ ratePlanId: plan, personen: 2, preis: 11_000, zimmer: 0 })
    await runNightAudit(app, ctx, fx.propertyId, { businessDate: TAG })

    expect(await buchungen(r)).toEqual([
      { description: 'Uebernachtung 01.10.2026', gross_cent: 7_000, tax_cent: 458,
        tax_rate_bp: 700, revenue_account: '8300', package_part: null },
      { description: 'Fruehstueck Speisen 01.10.2026', gross_cent: 2_100, tax_cent: 137,
        tax_rate_bp: 700, revenue_account: '8300', package_part: 'breakfast_food' },
      { description: 'Fruehstueck Getraenke 01.10.2026', gross_cent: 900, tax_cent: 144,
        tax_rate_bp: 1900, revenue_account: '8400', package_part: 'breakfast_drinks' },
      { description: 'Parken 01.10.2026', gross_cent: 1_000, tax_cent: 160,
        tax_rate_bp: 1900, revenue_account: '8400', package_part: 'inclusion' }
    ])
    const s = await owner.query<{ room_revenue_cent: string }>(
      `SELECT room_revenue_cent FROM business_day_stat WHERE property_id = $1 AND date = $2`,
      [fx.propertyId, TAG])
    expect(Number(s.rows[0]!.room_revenue_cent)).toBe(7_000 - 458)
  })

  it('rechnet je Person und einmal nur in der Anreisenacht', async () => {
    await satzLogis()
    const plan = await rate(null)
    await leistung(plan, 'Sauna', 500, 'per_person_night', 1900, '8400')
    await leistung(plan, 'Sekt', 800, 'once', 1900, '8400')
    const r = await gast({ ratePlanId: plan, personen: 2, preis: 11_000, zimmer: 0 })
    await runNightAudit(app, ctx, fx.propertyId, { businessDate: TAG })
    expect((await buchungen(r)).map(z => [z.description.split(' ')[0], z.gross_cent]))
      .toEqual([['Uebernachtung', 9_200], ['Sauna', 1_000], ['Sekt', 800]])

    await openBusinessDay(owner, fx.propertyId, '2026-10-02')
    await runNightAudit(app, ctx, fx.propertyId, { businessDate: '2026-10-02' })
    const zweite = (await buchungen(r)).filter(z => z.description.endsWith('02.10.2026'))
    expect(zweite.map(z => [z.description.split(' ')[0], z.gross_cent]))
      .toEqual([['Uebernachtung', 10_000], ['Sauna', 1_000]])
  })

  it('nimmt nie mehr heraus, als die Nacht kostet', async () => {
    await satzLogis()
    const plan = await rate(1_500)
    await leistung(plan, 'Parken', 1_000, 'per_night', 1900, '8400')
    await leistung(plan, 'Sauna', 1_000, 'per_night', 1900, '8400')
    const r = await gast({ ratePlanId: plan, personen: 1, preis: 3_000, zimmer: 0 })
    await runNightAudit(app, ctx, fx.propertyId, { businessDate: TAG })

    // 15 Euro Fruehstueck, 10 Euro Parken, fuer die Sauna bleiben 5.
    const z = await buchungen(r)
    expect(z.map(x => x.gross_cent)).toEqual([0, 1_050, 450, 1_000, 500])
    expect(z.reduce((s, x) => s + x.gross_cent, 0)).toBe(3_000)
  })

  it('laesst eine stillgelegte Leistung aus', async () => {
    await satzLogis()
    const plan = await rate(null)
    await leistung(plan, 'Parken', 1_000, 'per_night', 1900, '8400')
    await owner.query(`UPDATE product SET active = false`)
    const r = await gast({ ratePlanId: plan, personen: 1, preis: 11_000, zimmer: 0 })
    await runNightAudit(app, ctx, fx.propertyId, { businessDate: TAG })
    expect((await buchungen(r)).map(x => x.gross_cent)).toEqual([11_000])
  })
})
