import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeReservation, openBusinessDay, type Fixture } from '@hotelpms/testing'
import { type DbContext, type Pool } from '@hotelpms/db'
import { taxFromGross, VAT_ACCOMMODATION } from '@hotelpms/domain'
import { runNightAudit } from '../jobs/nightAudit.js'

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext
let catId: number
let rooms: number[]

const TAG = '2026-10-01'          // der Geschaeftstag, der geschlossen wird
const MORGEN = '2026-10-02'

/** Uhrzeit, zu der der Tageswechsel faellig ist: gut nach 04:00 des Folgetags. */
const NACH_MITTERNACHT = new Date('2026-10-02T10:00:00Z')

/**
 * Vollstaendige Momentaufnahme aller vom Nachtlauf beruehrten Tabellen.
 * Zwei Laeufe sind genau dann gleichwertig, wenn diese Aufnahme gleich ist.
 */
async function snapshot(propertyId: number): Promise<unknown> {
  const q = async (sql: string): Promise<unknown[]> =>
    (await owner.query(sql, [propertyId])).rows

  return {
    businessDays: await q(
      `SELECT date::text, status FROM business_day WHERE property_id=$1 ORDER BY date`),
    charges: await q(
      `SELECT business_date::text, description, net_cent, tax_cent, gross_cent, tax_rate_bp,
              revenue_account
         FROM charge WHERE property_id=$1 ORDER BY business_date, description, id`),
    reservations: await q(
      `SELECT id, status::text, (canceled_at IS NOT NULL) AS storniert
         FROM reservation WHERE property_id=$1 ORDER BY id`),
    nights: await q(
      `SELECT reservation_id, date::text, posted FROM reservation_night
        WHERE property_id=$1 ORDER BY reservation_id, date`),
    inventory: await q(
      `SELECT category_id, date::text, capacity, sold, blocked FROM inventory_day
        WHERE property_id=$1 AND date BETWEEN '2026-09-28' AND '2026-10-08'
        ORDER BY category_id, date`),
    blocks: await q(
      `SELECT id, status FROM availability_block WHERE property_id=$1 ORDER BY id`),
    steps: await q(
      `SELECT business_date::text, step, detail FROM night_audit_step
        WHERE property_id=$1 ORDER BY business_date, step`),
    stats: await q(
      `SELECT date::text, capacity, sold, arrivals, departures, room_revenue_cent
         FROM business_day_stat WHERE property_id=$1 ORDER BY date`)
  }
}

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
  rooms = await makeResources(owner, fx.propertyId, catId, 5)
  await owner.query(`SELECT inventory_materialize($1,$2::date,$3::date)`,
    [fx.propertyId, '2026-09-01', '2026-12-01'])
  await openBusinessDay(owner, fx.propertyId, TAG)
})

/** Der Ausgangszustand jedes Szenarios: je ein Fall fuer jeden Schritt. */
async function szenario(): Promise<{ inhouse: number; noshow: number; option: number
                                     block: number }> {
  const inhouse = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: catId, arrival: TAG, departure: '2026-10-04',
    status: 'InHouse', resourceId: rooms[0]!, priceCent: 11_000
  })
  const noshow = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: catId, arrival: TAG, departure: '2026-10-03',
    status: 'Confirmed'
  })
  const option = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: catId, arrival: '2026-10-20',
    departure: '2026-10-22', status: 'Optional',
    optionExpiresAt: '2026-09-30T12:00:00Z'
  })
  const b = await owner.query<{ id: number }>(
    `INSERT INTO availability_block (property_id, name, category_id, from_date, to_date,
                                     quantity, picked_up, release_date)
     VALUES ($1,'Busgruppe',$2,'2026-10-15','2026-10-17',2,0,'2026-09-25') RETURNING id`,
    [fx.propertyId, catId])
  const blockId = b.rows[0]!.id
  await owner.query(`SELECT inventory_block($1,$2,'2026-10-15','2026-10-17',2)`,
    [fx.propertyId, catId])

  return { inhouse: inhouse.reservationId, noshow: noshow.reservationId,
           option: option.reservationId, block: blockId }
}

const run = (opts: Parameters<typeof runNightAudit>[3] = {}) =>
  runNightAudit(app, ctx, fx.propertyId, opts)

describe('Nachtlauf', () => {
  it('schliesst den Tag, bucht Logis und oeffnet den Folgetag', async () => {
    const s = await szenario()
    const r = await run({ businessDate: TAG })

    expect(r).not.toBeNull()
    expect(r!.businessDate).toBe(TAG)
    expect(r!.skipped).toEqual([])
    expect(r!.steps).toEqual({
      rollover: 1, post_accommodation: 1, post_city_tax: 0, no_shows: 1,
      expire_options: 1, release_blocks: 1, statistics: 1
    })

    const tage = await owner.query<{ date: string; status: string }>(
      `SELECT date::text, status FROM business_day WHERE property_id=$1 ORDER BY date`,
      [fx.propertyId])
    expect(tage.rows).toEqual([
      { date: TAG, status: 'closed' }, { date: MORGEN, status: 'open' }])

    // Logis genau einmal, mit dem geschlossenen Datum, nicht mit heute.
    const c = await owner.query<{ business_date: string; gross_cent: number
                                  net_cent: number; tax_cent: number }>(
      `SELECT business_date::text, gross_cent, net_cent, tax_cent FROM charge
        WHERE property_id=$1 AND reservation_id=$2`, [fx.propertyId, s.inhouse])
    expect(c.rowCount).toBe(1)
    expect(c.rows[0]!.business_date).toBe(TAG)
    expect(c.rows[0]!.gross_cent).toBe(11_000)
    // Die Steuer wird in SQL herausgerechnet, die Rechnungssummen spaeter in
    // TypeScript. Beide muessen zum selben Cent kommen, sonst stimmt die
    // Rechnung nicht mit dem Folio ueberein.
    expect(c.rows[0]!.tax_cent).toBe(taxFromGross(11_000, VAT_ACCOMMODATION))
    expect(c.rows[0]!.tax_cent).toBe(720)
    expect(c.rows[0]!.net_cent).toBe(11_000 - 720)
  })

  it('setzt No-Show, Option und Kontingent und gibt das Inventar frei', async () => {
    const s = await szenario()
    const vorher = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
      [fx.propertyId, catId, TAG])
    expect(vorher.rows[0]!.sold).toBe(2)      // InHouse und No-Show-Kandidat

    await run({ businessDate: TAG })

    const status = await owner.query<{ id: number; status: string }>(
      `SELECT id, status::text FROM reservation WHERE property_id=$1 ORDER BY id`,
      [fx.propertyId])
    const byId = new Map(status.rows.map(r => [r.id, r.status]))
    expect(byId.get(s.inhouse)).toBe('InHouse')
    expect(byId.get(s.noshow)).toBe('NoShow')
    expect(byId.get(s.option)).toBe('Canceled')

    // Der No-Show gibt sein Kontingent frei, die InHouse-Nacht nicht.
    const nachher = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
      [fx.propertyId, catId, TAG])
    expect(nachher.rows[0]!.sold).toBe(1)

    // Die verfallene Option gibt ihre Naechte frei.
    const opt = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2
         AND date='2026-10-20'`, [fx.propertyId, catId])
    expect(opt.rows[0]!.sold).toBe(0)

    // Das nicht abgerufene Kontingent faellt zurueck.
    const blk = await owner.query<{ blocked: number }>(
      `SELECT blocked FROM inventory_day WHERE property_id=$1 AND category_id=$2
         AND date='2026-10-15'`, [fx.propertyId, catId])
    expect(blk.rows[0]!.blocked).toBe(0)
    const bs = await owner.query<{ status: string }>(
      `SELECT status FROM availability_block WHERE id=$1`, [s.block])
    expect(bs.rows[0]!.status).toBe('released')
  })

  // Definition of Done aus Dokument 11, AP 8.
  it('laeuft zweimal fuer denselben Tag mit identischem Ergebnis', async () => {
    await szenario()

    const erster = await run({ businessDate: TAG })
    const nachErstem = await snapshot(fx.propertyId)

    const zweiter = await run({ businessDate: TAG })
    const nachZweitem = await snapshot(fx.propertyId)

    expect(nachZweitem).toEqual(nachErstem)
    expect(zweiter!.businessDate).toBe(erster!.businessDate)
    expect(zweiter!.steps).toEqual(erster!.steps)
    expect(zweiter!.checklist).toEqual(erster!.checklist)
    // Der Unterschied ist genau der, der sein soll: nichts wurde neu getan.
    expect(erster!.skipped).toEqual([])
    expect(zweiter!.skipped).toEqual(
      ['rollover', 'post_accommodation', 'post_city_tax', 'no_shows', 'expire_options',
       'release_blocks', 'statistics'])
  })

  it('bucht die Logis auch nach einem Abbruch nur einmal', async () => {
    const s = await szenario()

    // Ein Lauf, der nach Schritt 2 abgebrochen ist: die Marken der spaeteren
    // Schritte fehlen, der Tag ist bereits geschlossen.
    await run({ businessDate: TAG })
    await owner.query(
      `DELETE FROM night_audit_step WHERE property_id=$1 AND business_date=$2::date
         AND step IN ('no_shows','expire_options','release_blocks','statistics')`,
      [fx.propertyId, TAG])

    // Ohne Vorgabe des Datums muss der Lauf den unvollstaendigen Tag finden,
    // nicht den frisch geoeffneten Folgetag.
    const wieder = await run({ now: NACH_MITTERNACHT })
    expect(wieder!.businessDate).toBe(TAG)
    expect(wieder!.skipped).toEqual(['rollover', 'post_accommodation', 'post_city_tax'])

    const c = await owner.query(
      `SELECT 1 FROM charge WHERE property_id=$1 AND reservation_id=$2`,
      [fx.propertyId, s.inhouse])
    expect(c.rowCount).toBe(1)
  })

  it('laeuft nicht, solange der Geschaeftstag noch offen ist', async () => {
    await szenario()
    // Mitten am Tag: 2026-10-01 ist der laufende Geschaeftstag.
    const r = await run({ now: new Date('2026-10-01T14:00:00Z') })
    expect(r).toBeNull()

    const tag = await owner.query<{ status: string }>(
      `SELECT status FROM business_day WHERE property_id=$1 AND date=$2::date`,
      [fx.propertyId, TAG])
    expect(tag.rows[0]!.status).toBe('open')
  })

  it('bucht keine Logis fuer eine stornierte Reservierung', async () => {
    const r = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: TAG, departure: '2026-10-03',
      status: 'Confirmed'
    })
    await owner.query(
      `UPDATE reservation SET status='Canceled', canceled_at=now() WHERE id=$1`,
      [r.reservationId])

    await run({ businessDate: TAG })

    const c = await owner.query(
      `SELECT 1 FROM charge WHERE property_id=$1 AND reservation_id=$2`,
      [fx.propertyId, r.reservationId])
    expect(c.rowCount).toBe(0)
  })

  it('meldet einen hohen offenen Saldo auf der Pruefliste', async () => {
    const r = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-09-20',
      departure: '2026-10-10', status: 'InHouse', resourceId: rooms[1]!, priceCent: 40_000
    })
    await owner.query(
      `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account)
       VALUES ($1,$2,'2026-09-30','Vorschuss',1,56075,3925,60000,700,'8300')`,
      [fx.propertyId, r.folioId])

    const result = await run({ businessDate: TAG })
    expect(result!.checklist.some(c => c.kind === 'hoher_saldo')).toBe(true)
  })
})
