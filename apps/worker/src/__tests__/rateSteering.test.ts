import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, openBusinessDay, countQueries, type Fixture } from '@hotelpms/testing'
import type { DbContext, Pool } from '@hotelpms/db'
import { runRateSteering } from '../jobs/rateSteering.js'

/**
 * Der automatische Lauf der Preissteuerung (Dokument 32).
 *
 * Die Regeln selbst prueft `apps/api/.../preissteuerung.test.ts`; hier steht,
 * was nur der Worker tut: einmal je Geschaeftstag, ueber den regulaeren
 * Schreibweg, ohne Aufschaukeln ueber viele Tage, und mit einer Zahl von
 * Anweisungen, die nicht von der Zahl der Tage abhaengt.
 */

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext
let catId: number
let plan: number

const TAG = '2026-10-01'

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(5)
})
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  await makeResources(owner, fx.propertyId, catId, 10)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-12-01'::date)`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, TAG)

  const p = await owner.query<{ id: number }>(
    `INSERT INTO rate_plan (property_id, category_id, code, name)
     VALUES ($1, $2, 'BAR', 'Bester Preis') RETURNING id`, [fx.propertyId, catId])
  plan = p.rows[0]!.id
  await owner.query(
    `INSERT INTO rate_day (property_id, rate_plan_id, date, price_cent)
     SELECT $1, $2, d::date, '{10000,12000}'
       FROM generate_series('2026-10-01'::date, '2027-09-30'::date, interval '1 day') d`,
    [fx.propertyId, plan])
  await owner.query(
    `INSERT INTO rate_plan_steering (rate_plan_id, property_id, source, rounding)
     VALUES ($1, $2, 'rules', 'euro')`, [plan, fx.propertyId])
  await owner.query(
    `INSERT INTO rate_steer_rule (property_id, kind, occupancy_min_bp, effect_kind, effect_value)
     VALUES ($1, 'occupancy', 8500, 'percent', 2000)`, [fx.propertyId])
  // 90 % am 5. Oktober.
  await owner.query(
    `UPDATE inventory_day SET sold = 9
      WHERE property_id = $1 AND category_id IN (0, $2) AND date = '2026-10-05'`,
    [fx.propertyId, catId])
})

async function modus(mode: 'suggest' | 'auto', horizonDays = 365): Promise<void> {
  await owner.query(
    `INSERT INTO rate_steer_setting (property_id, mode, horizon_days) VALUES ($1, $2, $3)
     ON CONFLICT (property_id) DO UPDATE SET mode = $2, horizon_days = $3`,
    [fx.propertyId, mode, horizonDays])
}

async function preis(ratePlanId: number, date: string): Promise<number[]> {
  const r = await owner.query<{ price_cent: number[] }>(
    `SELECT price_cent FROM rate_day WHERE rate_plan_id = $1 AND date = $2::date`,
    [ratePlanId, date])
  return r.rows[0]!.price_cent
}

/** Den Geschaeftstag weiterschalten, wie es der Nachtlauf in Schritt 1 tut. */
async function naechsterTag(): Promise<void> {
  await owner.query(
    `WITH alt AS (
       UPDATE business_day SET status = 'closed', closed_at = now()
        WHERE property_id = $1 AND status = 'open' RETURNING date)
     INSERT INTO business_day (property_id, date) SELECT $1, date + 1 FROM alt`,
    [fx.propertyId])
}

describe('Automatische Preissteuerung', () => {
  it('tut im Vorschlagsmodus nichts', async () => {
    const r = await runRateSteering(app, ctx, fx.propertyId)
    expect(r.runId).toBeNull()
    expect(await preis(plan, '2026-10-05')).toEqual([10000, 12000])
    const laeufe = await owner.query(`SELECT 1 FROM rate_steer_run`)
    expect(laeufe.rowCount).toBe(0)
  })

  it('uebernimmt einmal je Geschaeftstag, ueber den regulaeren Weg', async () => {
    await modus('auto')
    const nonref = await owner.query<{ id: number }>(
      `INSERT INTO rate_plan (property_id, category_id, code, name, base_rate_plan_id,
                              derive_kind, derive_value)
       VALUES ($1, $2, 'NONREF', 'Nicht stornierbar', $3, 'percent', -10) RETURNING id`,
      [fx.propertyId, catId, plan])
    await owner.query(
      `INSERT INTO webhook_subscription (account_id, url, signing_secret, event_types)
       VALUES ($1, 'https://rms.example.de/hook', 'geheim', '{rate.changed}')`,
      [fx.accountId])
    await owner.query(`UPDATE rate_day SET updated_at = '2026-01-01' WHERE property_id = $1`,
      [fx.propertyId])

    const erster = await runRateSteering(app, ctx, fx.propertyId)
    expect(erster.runId).not.toBeNull()
    expect(erster.changed).toBe(1)
    expect(erster.businessDate).toBe(TAG)
    expect(await preis(plan, '2026-10-05')).toEqual([12000, 14400])
    // Die abgeleitete Rate folgt im selben Lauf.
    expect(await preis(nonref.rows[0]!.id, '2026-10-05')).toEqual([10800, 12960])
    // Die Aenderungsmeldung an den Channel Manager sieht genau diese Tage.
    const geaendert = await owner.query<{ code: string; date: string }>(
      `SELECT rp.code, d.date::text FROM rate_day d JOIN rate_plan rp ON rp.id = d.rate_plan_id
        WHERE d.property_id = $1 AND d.updated_at > '2026-01-02' ORDER BY rp.code`,
      [fx.propertyId])
    expect(geaendert.rows).toEqual([
      { code: 'BAR', date: '2026-10-05' }, { code: 'NONREF', date: '2026-10-05' }])
    const ereignis = await owner.query(
      `SELECT 1 FROM webhook_delivery WHERE event_type = 'rate.changed'`)
    expect(ereignis.rowCount).toBe(1)

    // Ein zweiter Tick am selben Geschaeftstag tut nichts -- auch dann nicht,
    // wenn sich die Belegung inzwischen bewegt hat.
    await owner.query(
      `UPDATE inventory_day SET sold = 9
        WHERE property_id = $1 AND category_id IN (0, $2) AND date = '2026-10-06'`,
      [fx.propertyId, catId])
    const zweiter = await runRateSteering(app, ctx, fx.propertyId)
    expect(zweiter.runId).toBeNull()
    expect(await preis(plan, '2026-10-06')).toEqual([10000, 12000])
    const laeufe = await owner.query(`SELECT 1 FROM rate_steer_run`)
    expect(laeufe.rowCount).toBe(1)
  })

  it('schaukelt sich ueber viele Geschaeftstage nicht auf', async () => {
    await modus('auto')
    for (let tag = 0; tag < 5; tag++) {
      const r = await runRateSteering(app, ctx, fx.propertyId)
      expect(r.runId).not.toBeNull()
      expect(r.changed).toBe(tag === 0 ? 1 : 0)
      expect(await preis(plan, '2026-10-05')).toEqual([12000, 14400])
      await naechsterTag()
    }
  })

  it('haelt die Schrittgrenze je Lauf und kommt trotzdem an', async () => {
    await modus('auto')
    await owner.query(`UPDATE rate_plan_steering SET max_step_bp = 500 WHERE rate_plan_id = $1`,
      [plan])
    const verlauf: number[] = []
    for (let tag = 0; tag < 5; tag++) {
      await runRateSteering(app, ctx, fx.propertyId)
      verlauf.push((await preis(plan, '2026-10-05'))[0]!)
      await naechsterTag()
    }
    // Hoechstens 5 % je Tag, auf volle Euro nach innen gerundet.
    expect(verlauf).toEqual([10500, 11000, 11500, 12000, 12000])
  })

  it('braucht eine Anweisung, ob zehn Tage oder ein Jahr', async () => {
    await modus('auto', 10)
    const kurz = await countQueries(app, () => runRateSteering(app, ctx, fx.propertyId))
    await naechsterTag()
    await modus('auto', 365)
    const lang = await countQueries(app, () => runRateSteering(app, ctx, fx.propertyId))
    expect(kurz.result.runId).not.toBeNull()
    expect(lang.result.runId).not.toBeNull()
    expect(kurz.report.count).toBe(1)
    expect(lang.report.count).toBe(kurz.report.count)
  })

  it('steuert auch ein Uebungshaus', async () => {
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])
    await modus('auto')
    const r = await runRateSteering(app, ctx, fx.propertyId)
    expect(r.changed).toBe(1)
  })
})
