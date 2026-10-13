import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeReservation, openBusinessDay, type Fixture } from '@hotelpms/testing'
import { type DbContext, type Pool } from '@hotelpms/db'
import { breakfastPerNight, splitNight } from '@hotelpms/domain'
import { runNightAudit } from '../jobs/nightAudit.js'

/**
 * Fruehstueck im Zimmerpreis (Migration 0158): der Nachtlauf rechnet es
 * heraus und bucht Speisen zu 7 % und Getraenke zu 19 %, mit dem
 * BMF-Pauschalanteil von 30 %. Die Kennzahlen zaehlen davon nur die Logis.
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

describe('Fruehstueck im Zimmerpreis', () => {
  it('teilt die Nacht in Logis, Speisen und Getraenke', async () => {
    const mit = await gast({ ratePlanId: await rate(1_500), personen: 2,
                             preis: 11_000, zimmer: 0 })
    const ohne = await gast({ ratePlanId: await rate(null), personen: 2,
                              preis: 11_000, zimmer: 1 })
    await runNightAudit(app, ctx, fx.propertyId, { businessDate: TAG })

    // 2 x 15 Euro Fruehstueck: 9 Euro Getraenke (30 %), 21 Euro Speisen.
    expect(await buchungen(mit)).toEqual([
      { description: 'Uebernachtung 01.10.2026', gross_cent: 8_000, tax_cent: 523,
        tax_rate_bp: 700, revenue_account: '8300', package_part: null },
      { description: 'Fruehstueck Speisen 01.10.2026', gross_cent: 2_100, tax_cent: 137,
        tax_rate_bp: 700, revenue_account: '8300', package_part: 'breakfast_food' },
      { description: 'Fruehstueck Getraenke 01.10.2026', gross_cent: 900, tax_cent: 144,
        tax_rate_bp: 1900, revenue_account: '8400', package_part: 'breakfast_drinks' }
    ])
    // Dieselbe Rechnung wie in der Domain, damit beide nicht auseinanderlaufen.
    const fruehstueck = breakfastPerNight({ adultCent: 1_500, childCent: null, persons: 2,
                                            adults: null, children: null })
    expect(splitNight({ priceCent: 11_000, breakfastCent: fruehstueck }))
      .toEqual({ lodgingCent: 8_000, foodCent: 2_100, drinksCent: 900 })

    // Ohne Fruehstueck in der Rate bleibt es bei einer Zeile.
    expect((await buchungen(ohne)).map(z => z.gross_cent)).toEqual([11_000])

    // Zimmerumsatz der Kennzahlen: beide Logis netto, kein Fruehstueck.
    const s = await owner.query<{ room_revenue_cent: string }>(
      `SELECT room_revenue_cent FROM business_day_stat WHERE property_id = $1 AND date = $2`,
      [fx.propertyId, TAG])
    expect(Number(s.rows[0]!.room_revenue_cent)).toBe((8_000 - 523) + (11_000 - 720))
  })

  it('nimmt nie mehr Fruehstueck heraus, als die Nacht kostet', async () => {
    const r = await gast({ ratePlanId: await rate(1_500), personen: 2,
                           preis: 2_000, zimmer: 0 })
    await runNightAudit(app, ctx, fx.propertyId, { businessDate: TAG })

    const z = await buchungen(r)
    expect(z.map(x => x.gross_cent)).toEqual([0, 1_400, 600])
    expect(z.reduce((s, x) => s + x.gross_cent, 0)).toBe(2_000)
  })

  it('rechnet ohne Personenzahl mit einer Person', async () => {
    const res = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: TAG, departure: '2026-10-03',
      status: 'InHouse', resourceId: rooms[0]!, priceCent: 11_000 })
    await owner.query(`UPDATE reservation SET rate_plan_id = $2 WHERE id = $1`,
      [res.reservationId, await rate(1_500)])
    await runNightAudit(app, ctx, fx.propertyId, { businessDate: TAG })

    expect((await buchungen(res.reservationId)).map(x => x.gross_cent))
      .toEqual([9_500, 1_050, 450])
  })

  /**
   * Kinderpreis (Sven, 13.10.2026): greift nur, wenn die Buchung Erwachsene
   * und Kinder getrennt nennt. Nennt sie nur eine Gesamtzahl, zahlen alle
   * wie Erwachsene -- wer Kind ist, steht dann nirgends.
   */
  it('rechnet Kinder zu ihrem eigenen Preis, frei mit 0', async () => {
    const getrennt = await gast({ ratePlanId: await rate(1_500, 800), personen: 3,
                                  preis: 15_000, zimmer: 0 })
    await owner.query(`UPDATE reservation SET adults = 2, children = 1 WHERE id = $1`,
      [getrennt])
    const frei = await gast({ ratePlanId: await rate(1_500, 0), personen: 3,
                              preis: 15_000, zimmer: 1 })
    await owner.query(`UPDATE reservation SET adults = 2, children = 1 WHERE id = $1`,
      [frei])
    const nurSumme = await gast({ ratePlanId: await rate(1_500, 900), personen: 3,
                                  preis: 15_000, zimmer: 2 })
    await runNightAudit(app, ctx, fx.propertyId, { businessDate: TAG })

    const summe = async (id: number): Promise<number> =>
      (await buchungen(id)).filter(z => z.package_part !== null)
        .reduce((s, z) => s + z.gross_cent, 0)
    expect(await summe(getrennt)).toBe(2 * 1_500 + 800)
    expect(await summe(frei)).toBe(2 * 1_500)
    expect(await summe(nurSumme)).toBe(3 * 1_500)
    expect(breakfastPerNight({ adultCent: 1_500, childCent: 800, persons: 3,
                               adults: 2, children: 1 })).toBe(3_800)
  })
})
