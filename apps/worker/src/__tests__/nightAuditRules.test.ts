import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeReservation, openBusinessDay, type Fixture }
  from '@hotelpms/testing'
import { withTransaction, SYSTEM_CONTEXT, type DbContext, type Pool } from '@hotelpms/db'
import { runNightAudit } from '../jobs/nightAudit.js'
import { overdueNightAudits } from '../jobs/maintenance.js'

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
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  rooms = await makeResources(owner, fx.propertyId, catId, 5)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, TAG)
})

const lauf = () => runNightAudit(app, ctx, fx.propertyId, { businessDate: TAG })

/** Ein Ratenplan mit Stornoregel, an dem die No-Show-Gebuehr haengt. */
async function ratenplanMitRegel(
  opts: { guaranteed: boolean; feeKind?: string; feeValue?: number }
): Promise<number> {
  const cp = await owner.query<{ id: number }>(
    `INSERT INTO cancellation_policy (property_id, code, name, fee_kind, fee_value,
                                      guaranteed)
     VALUES ($1,'REGEL','Regel',$2,$3,$4) RETURNING id`,
    [fx.propertyId, opts.feeKind ?? 'none', opts.feeValue ?? 0, opts.guaranteed])
  const rp = await owner.query<{ id: number }>(
    `INSERT INTO rate_plan (property_id, category_id, code, name, cancellation_policy_id)
     VALUES ($1,$2,'BAR','Basisrate',$3) RETURNING id`,
    [fx.propertyId, catId, cp.rows[0]!.id])
  return rp.rows[0]!.id
}

async function anreiseHeute(ratePlanId?: number): Promise<number> {
  const r = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: catId, arrival: TAG, departure: '2026-10-04',
    status: 'Confirmed', priceCent: 12_000 })
  if (ratePlanId !== undefined) {
    await owner.query(`UPDATE reservation SET rate_plan_id = $2 WHERE id = $1`,
      [r.reservationId, ratePlanId])
  }
  return r.reservationId
}

async function gebuehren(): Promise<Array<{ gross_cent: number; tax_rate_bp: number
                                            revenue_account: string }>> {
  const r = await owner.query<{ gross_cent: number; tax_rate_bp: number
                                revenue_account: string }>(
    `SELECT gross_cent, tax_rate_bp, revenue_account FROM charge
      WHERE property_id = $1 AND description = 'No-Show-Gebuehr'`, [fx.propertyId])
  return r.rows
}

describe('No-Show mit Stornoregel', () => {
  it('berechnet bei garantierter Buchung die erste Nacht', async () => {
    const plan = await ratenplanMitRegel({ guaranteed: true, feeKind: 'first_night' })
    await anreiseHeute(plan)
    await lauf()

    const g = await gebuehren()
    expect(g).toHaveLength(1)
    expect(g[0]!.gross_cent).toBe(12_000)
    // Eine Gebuehr ist keine Beherbergung: voller Steuersatz, eigenes Konto,
    // sonst faelscht sie ADR und RevPAR.
    expect(g[0]!.tax_rate_bp).toBe(1900)
    expect(g[0]!.revenue_account).toBe('8400')
  })

  it('berechnet bei ungarantierter Buchung nichts', async () => {
    const plan = await ratenplanMitRegel({ guaranteed: false, feeKind: 'first_night' })
    await anreiseHeute(plan)
    await lauf()
    expect(await gebuehren()).toHaveLength(0)
  })

  /**
   * Eine Gebühr ohne vereinbarte Grundlage ist nicht durchsetzbar. Sie
   * trotzdem aufs Folio zu buchen erzeugt einen Streit, den das Haus
   * verliert.
   */
  it('berechnet ohne hinterlegte Regel nichts', async () => {
    await anreiseHeute()
    await lauf()
    expect(await gebuehren()).toHaveLength(0)
  })

  it('rechnet einen Prozentsatz auf den ganzen Aufenthalt', async () => {
    const plan = await ratenplanMitRegel(
      { guaranteed: true, feeKind: 'percent', feeValue: 50 })
    await anreiseHeute(plan)
    await lauf()
    // Drei Naechte zu 120 Euro sind 360, davon die Haelfte.
    expect((await gebuehren())[0]!.gross_cent).toBe(18_000)
  })

  it('setzt in jedem Fall den Zustand und gibt das Kontingent frei', async () => {
    const plan = await ratenplanMitRegel({ guaranteed: true, feeKind: 'first_night' })
    const id = await anreiseHeute(plan)
    await lauf()

    const r = await owner.query<{ status: string; cancellation_fee_cent: number | null }>(
      `SELECT status::text, cancellation_fee_cent FROM reservation WHERE id = $1`, [id])
    expect(r.rows[0]!.status).toBe('NoShow')
    expect(r.rows[0]!.cancellation_fee_cent).toBe(12_000)

    const inv = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
      [fx.propertyId, catId, TAG])
    expect(inv.rows[0]!.sold).toBe(0)
  })
})

describe('Umleitung der Logis', () => {
  it('bucht Logis auf das Folio, das die Regel nennt', async () => {
    const gast = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: TAG, departure: '2026-10-04',
      status: 'InHouse', resourceId: rooms[0]!, priceCent: 11_000 })

    // Firmenfolio als Ziel.
    const firma = await owner.query<{ id: number }>(
      `INSERT INTO folio (property_id, kind, label) VALUES ($1,'company','Firma AG')
       RETURNING id`, [fx.propertyId])
    await owner.query(
      `INSERT INTO routing_rule (property_id, reservation_id, target_folio_id, match_kind)
       VALUES ($1,$2,$3,'accommodation')`,
      [fx.propertyId, gast.reservationId, firma.rows[0]!.id])

    await lauf()

    const aufFirma = await owner.query(
      `SELECT 1 FROM charge WHERE folio_id = $1 AND revenue_account = '8300'`,
      [firma.rows[0]!.id])
    const aufGast = await owner.query(
      `SELECT 1 FROM charge WHERE folio_id = $1`, [gast.folioId])
    // Ohne Umleitung landete die Firmenrechnung beim Gast, und der Check-out
    // am Morgen wuerde zur Diskussion.
    expect(aufFirma.rowCount).toBe(1)
    expect(aufGast.rowCount).toBe(0)
  })

  it('bucht ohne Regel auf das Folio des Gastes', async () => {
    const gast = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: TAG, departure: '2026-10-04',
      status: 'InHouse', resourceId: rooms[1]!, priceCent: 11_000 })
    await lauf()
    const aufGast = await owner.query(`SELECT 1 FROM charge WHERE folio_id = $1`,
      [gast.folioId])
    expect(aufGast.rowCount).toBe(1)
  })

  it('laesst die genauere Regel gewinnen', async () => {
    const gast = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: TAG, departure: '2026-10-04',
      status: 'InHouse', resourceId: rooms[2]!, priceCent: 11_000 })
    const alles = await owner.query<{ id: number }>(
      `INSERT INTO folio (property_id, kind, label) VALUES ($1,'company','Alles')
       RETURNING id`, [fx.propertyId])
    const nurLogis = await owner.query<{ id: number }>(
      `INSERT INTO folio (property_id, kind, label) VALUES ($1,'company','Nur Logis')
       RETURNING id`, [fx.propertyId])
    await owner.query(
      `INSERT INTO routing_rule (property_id, reservation_id, target_folio_id, match_kind)
       VALUES ($1,$2,$3,'all'), ($1,$2,$4,'accommodation')`,
      [fx.propertyId, gast.reservationId, alles.rows[0]!.id, nurLogis.rows[0]!.id])

    await lauf()
    const treffer = await owner.query(`SELECT 1 FROM charge WHERE folio_id = $1`,
      [nurLogis.rows[0]!.id])
    expect(treffer.rowCount).toBe(1)
  })
})

describe('Alarm bei ausgefallenem Nachtlauf', () => {
  it('meldet nichts, solange der Geschaeftstag aktuell ist', async () => {
    await owner.query(`UPDATE business_day SET date = current_date WHERE property_id = $1`,
      [fx.propertyId])
    const r = await withTransaction(owner, SYSTEM_CONTEXT, c => overdueNightAudits(c))
    expect(r.find(x => x.propertyId === fx.propertyId)).toBeUndefined()
  })

  /**
   * Der schlimmste Ausfall ist der stille: die Rezeption bucht weiter, nur
   * die Logis fehlt auf den Folios, und bemerkt wird es vom Gast beim
   * Check-out.
   */
  it('meldet einen zurueckliegenden offenen Geschaeftstag', async () => {
    await owner.query(
      `UPDATE business_day SET date = current_date - 3 WHERE property_id = $1`,
      [fx.propertyId])
    const r = await withTransaction(owner, SYSTEM_CONTEXT, c => overdueNightAudits(c))
    const treffer = r.find(x => x.propertyId === fx.propertyId)
    expect(treffer).toBeDefined()
    expect(treffer!.daysBehind).toBe(3)
  })

  it('meldet eine Property ganz ohne offenen Geschaeftstag', async () => {
    await owner.query(`DELETE FROM business_day WHERE property_id = $1`, [fx.propertyId])
    const r = await withTransaction(owner, SYSTEM_CONTEXT, c => overdueNightAudits(c))
    const treffer = r.find(x => x.propertyId === fx.propertyId)
    expect(treffer).toBeDefined()
    expect(treffer!.openDate).toBeNull()
  })
})
