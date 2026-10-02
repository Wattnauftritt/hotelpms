import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, openBusinessDay, countQueries,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { steerPrice } from '@hotelpms/domain'
import type { SteerPreview, SteeringOverview, SteerRounding } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Preissteuerung (Dokument 32), von der Route bis in die Datenbank.
 *
 * Geprueft wird, wo ein Fehler Geld kostet: dass die Regeln wirken, wie der
 * Satz in der Oberflaeche es sagt; dass Leitplanken und Rundung halten; dass
 * sich nichts aufschaukelt; dass nichts ohne Uebernahme geschieht; dass eine
 * gebuchte Nacht ihren Preis behaelt; und dass die Uebernahme denselben Weg
 * geht wie die Preispflege von Hand.
 *
 * Belegung wird direkt im Zaehler gesetzt (Eigentuemerrolle), nicht ueber
 * Buchungen: geprueft wird hier die Steuerung, nicht der Buchungsweg. Wo es
 * auf die Buchung ankommt -- der eingefrorene Preis --, ist es eine echte.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const json = <T>(r: { body: string }): T => JSON.parse(r.body) as T

/** Der offene Geschaeftstag. Donnerstag; der 2. ist ein Freitag. */
const TAG = '2026-10-01'
const BIS = '2026-10-10'
const ZIMMER = 10

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
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  await makeResources(owner, fx.propertyId, catId, ZIMMER)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-12-01'::date)`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, TAG)
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
})

// ------------------------------------------------------------------ Helfer

async function ratenplan(code: string, extra: Record<string, unknown> = {},
                         propertyId = fx.propertyId, categoryId = catId,
                         session = admin.sessionId): Promise<number> {
  const r = await app.inject({
    method: 'POST', url: `/v1/properties/${propertyId}/rate-plans`, headers: auth(session),
    payload: { code, name: code, categoryId, ...extra } })
  expect(r.statusCode, r.body).toBe(201)
  return json<{ ratePlanId: number }>(r).ratePlanId
}

const preise = (ratePlanId: number, priceCent: number[], from = TAG, to = BIS,
                headers: Record<string, string> = auth(admin.sessionId)) =>
  app.inject({
    method: 'PUT', url: '/v1/rates/bulk', headers,
    payload: { propertyId: fx.propertyId, ratePlanId, from, to, priceCent } })

async function steuern(ratePlanId: number, s: Record<string, unknown> = {}): Promise<void> {
  const r = await app.inject({
    method: 'PUT', url: `/v1/properties/${fx.propertyId}/rate-steering/plans/${ratePlanId}`,
    headers: auth(admin.sessionId),
    payload: { source: 'rules', rounding: 'euro', ...s } })
  expect(r.statusCode, r.body).toBe(200)
}

async function regel(rule: Record<string, unknown>, session = admin.sessionId): Promise<number> {
  const r = await app.inject({
    method: 'POST', url: `/v1/properties/${fx.propertyId}/rate-steering/rules`,
    headers: auth(session), payload: rule })
  expect(r.statusCode, r.body).toBe(201)
  return json<{ ruleId: number }>(r).ruleId
}

const vorschauRoh = (from = TAG, to = BIS, session = admin.sessionId) =>
  app.inject({
    method: 'GET', headers: auth(session),
    url: `/v1/properties/${fx.propertyId}/rate-steering/preview?from=${from}&to=${to}` })

async function vorschau(from = TAG, to = BIS): Promise<SteerPreview> {
  const r = await vorschauRoh(from, to)
  expect(r.statusCode, r.body).toBe(200)
  return json<SteerPreview>(r)
}

const uebernehmen = (payload: Record<string, unknown>, session = admin.sessionId) =>
  app.inject({
    method: 'POST', url: `/v1/properties/${fx.propertyId}/rate-steering/apply`,
    headers: auth(session), payload })

/** Belegung eines Tages im Zaehler, Kategorie und Haussumme. */
async function belegung(date: string, sold: number): Promise<void> {
  await owner.query(
    `UPDATE inventory_day SET sold = $3
      WHERE property_id = $1 AND category_id IN (0, $2) AND date = $4::date`,
    [fx.propertyId, catId, sold, date])
}

async function verkaufspreis(ratePlanId: number, date: string): Promise<number[] | null> {
  const r = await owner.query<{ price_cent: number[] }>(
    `SELECT price_cent FROM rate_day WHERE rate_plan_id = $1 AND date = $2::date`,
    [ratePlanId, date])
  return r.rows[0]?.price_cent ?? null
}

const zelle = (v: SteerPreview, ratePlanId: number, date: string) =>
  v.cells.find(c => c.ratePlanId === ratePlanId && c.date === date)!

/** Ein gesteuerter Plan zu 100 Euro, zwei Personen 120 Euro. */
async function gesteuerterPlan(s: Record<string, unknown> = {}): Promise<number> {
  const plan = await ratenplan('BAR')
  expect((await preise(plan, [10000, 12000])).statusCode).toBe(200)
  await steuern(plan, s)
  return plan
}

// ------------------------------------------------------------------ Regeln

describe('Regeln', () => {
  it('Belegungsstufen: die staerkste passende wirkt, nicht die Summe', async () => {
    const plan = await gesteuerterPlan()
    const r70 = await regel({ kind: 'occupancy', occupancyMinBp: 7000,
                              effectKind: 'percent', effectValue: 1000 })
    const r85 = await regel({ kind: 'occupancy', occupancyMinBp: 8500,
                              effectKind: 'percent', effectValue: 2000 })
    await belegung('2026-10-01', 6)   // 60 %
    await belegung('2026-10-02', 7)   // 70 %, genau auf der Schwelle
    await belegung('2026-10-03', 9)   // 90 %

    const v = await vorschau()
    expect(zelle(v, plan, '2026-10-01').suggestedCent).toEqual([10000, 12000])
    expect(zelle(v, plan, '2026-10-01').changed).toBe(false)
    expect(zelle(v, plan, '2026-10-02').suggestedCent).toEqual([11000, 13200])
    expect(zelle(v, plan, '2026-10-02').ruleIds).toEqual([r70])
    // +20 %, nicht +30 %: zwei Stufen derselben Art addieren sich nicht.
    expect(zelle(v, plan, '2026-10-03').suggestedCent).toEqual([12000, 14400])
    expect(zelle(v, plan, '2026-10-03').ruleIds).toEqual([r85])
    expect(zelle(v, plan, '2026-10-03').occupancyBp).toBe(9000)
  })

  it('Vorlauf mit Belegungsbedingung: Last Minute nur, wenn das Haus leer ist', async () => {
    const plan = await gesteuerterPlan()
    await regel({ kind: 'lead_time', leadBelowDays: 3, occupancyBelowBp: 4000,
                  effectKind: 'percent', effectValue: -1000, name: 'Last Minute' })
    await belegung('2026-10-01', 3)   // Vorlauf 0, 30 % -> greift
    await belegung('2026-10-02', 5)   // Vorlauf 1, 50 % -> zu voll
    await belegung('2026-10-05', 3)   // Vorlauf 4, 30 % -> zu frueh

    const v = await vorschau()
    expect(zelle(v, plan, '2026-10-01').suggestedCent).toEqual([9000, 10800])
    expect(zelle(v, plan, '2026-10-01').leadDays).toBe(0)
    expect(zelle(v, plan, '2026-10-02').suggestedCent).toEqual([10000, 12000])
    expect(zelle(v, plan, '2026-10-05').suggestedCent).toEqual([10000, 12000])
  })

  it('Wochentag und Zeitraum sind verschiedene Ausloeser und addieren sich', async () => {
    const plan = await gesteuerterPlan()
    await regel({ kind: 'weekday', weekdays: [4, 5], effectKind: 'amount', effectValue: 1500 })
    await regel({ kind: 'period', periodFrom: '2026-10-01', periodTo: '2026-10-03',
                  effectKind: 'percent', effectValue: 1000 })

    const v = await vorschau()
    expect(zelle(v, plan, '2026-10-01').suggestedCent).toEqual([11000, 13200])  // Do
    expect(zelle(v, plan, '2026-10-02').suggestedCent).toEqual([12500, 14700])  // Fr
    expect(zelle(v, plan, '2026-10-03').suggestedCent).toEqual([12500, 14700])  // Sa
    expect(zelle(v, plan, '2026-10-04').suggestedCent).toEqual([10000, 12000])  // So
    expect(zelle(v, plan, '2026-10-09').suggestedCent).toEqual([11500, 13500])  // Fr
  })

  it('eine Regel fuer einen Plan wirkt nur dort; eine stillgelegte gar nicht', async () => {
    const plan = await gesteuerterPlan()
    const zweiter = await ratenplan('FLEX')
    await preise(zweiter, [10000])
    await steuern(zweiter)
    await regel({ kind: 'period', periodFrom: TAG, periodTo: BIS, ratePlanId: zweiter,
                  effectKind: 'amount', effectValue: 500 })
    await regel({ kind: 'period', periodFrom: TAG, periodTo: BIS, active: false,
                  effectKind: 'amount', effectValue: 9000 })

    const v = await vorschau()
    expect(zelle(v, plan, TAG).suggestedCent).toEqual([10000, 12000])
    expect(zelle(v, zweiter, TAG).suggestedCent).toEqual([10500])
  })

  it('weist eine Regel ohne ihre Bedingung und eine absurde Wirkung ab', async () => {
    for (const payload of [
      { kind: 'occupancy', effectKind: 'percent', effectValue: 1000 },
      { kind: 'weekday', weekdays: [7], effectKind: 'percent', effectValue: 1000 },
      { kind: 'period', periodFrom: '2026-10-05', periodTo: '2026-10-01',
        effectKind: 'percent', effectValue: 1000 },
      { kind: 'occupancy', occupancyMinBp: 8000, effectKind: 'percent', effectValue: 50000 },
      { kind: 'occupancy', occupancyMinBp: 8000, effectKind: 'percent', effectValue: 0 }
    ]) {
      const r = await app.inject({
        method: 'POST', url: `/v1/properties/${fx.propertyId}/rate-steering/rules`,
        headers: auth(admin.sessionId), payload })
      expect(r.statusCode, JSON.stringify(payload)).toBe(422)
    }
  })
})

// ------------------------------------------------- Leitplanken und Rundung

describe('Leitplanken und Rundung', () => {
  it('Leitplanken begrenzen die Wirkung, nicht den Grundpreis', async () => {
    const plan = await ratenplan('BAR')
    await preise(plan, [10000], TAG, '2026-10-02')
    // Ein Tag, dessen Grundpreis schon unter dem Mindestpreis liegt.
    await preise(plan, [8000], '2026-10-03', '2026-10-03')
    await steuern(plan, { minCent: 9500, maxCent: 11500 })
    await regel({ kind: 'weekday', weekdays: [3], effectKind: 'percent', effectValue: 2000 })
    await regel({ kind: 'weekday', weekdays: [4, 5], effectKind: 'percent', effectValue: -1000 })

    const v = await vorschau(TAG, '2026-10-03')
    expect(zelle(v, plan, '2026-10-01').suggestedCent).toEqual([11500])  // +20 % gedeckelt
    expect(zelle(v, plan, '2026-10-02').suggestedCent).toEqual([9500])   // -10 % gestuetzt
    // Kein weiterer Rabatt unter den Mindestpreis, aber auch kein Anheben.
    expect(zelle(v, plan, '2026-10-03').suggestedCent).toEqual([8000])
  })

  it('rundet auf volle Euro, auf ,90 oder gar nicht', async () => {
    const erwartung: Record<SteerRounding, number> = { none: 10689, euro: 10700, ninety: 10690 }
    for (const rounding of ['none', 'euro', 'ninety'] as const) {
      const plan = await ratenplan(`R${rounding}`)
      await preise(plan, [9990])
      await steuern(plan, { rounding })
    }
    await regel({ kind: 'period', periodFrom: TAG, periodTo: BIS,
                  effectKind: 'percent', effectValue: 700 })
    const v = await vorschau()
    const plaene = json<SteeringOverview>(await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/rate-steering`,
      headers: auth(admin.sessionId) })).plans
    for (const p of plaene) {
      // 99,90 + 7 % = 106,893 -> 106,89 auf den Cent, dann das Raster.
      expect(zelle(v, p.ratePlanId, TAG).suggestedCent).toEqual([erwartung[p.rounding]])
    }
  })

  it('rechnet in SQL Cent fuer Cent wie der Domaenenkern', async () => {
    // Ein fester Zufall, damit ein Fehlschlag sich wiederholen laesst.
    let saat = 20261001
    const zufall = (n: number): number => {
      saat = (saat * 1103515245 + 12345) % 2147483648
      return saat % n
    }
    const roundings = ['none', 'euro', 'ninety'] as const
    const faelle = Array.from({ length: 400 }, () => {
      const base = 500 + zufall(40000)
      const mitMin = zufall(3) === 0
      const mitMax = zufall(3) === 0
      const min = mitMin ? 500 + zufall(40000) : null
      const max = mitMax ? Math.max(min ?? 0, 500 + zufall(40000)) : null
      return {
        baseCent: base,
        currentCent: zufall(4) === 0 ? null : 500 + zufall(40000),
        percentBp: zufall(2) === 0 ? 0 : zufall(6000) - 3000,
        amountCent: zufall(3) === 0 ? zufall(5000) - 2500 : 0,
        minCent: min, maxCent: max,
        rounding: roundings[zufall(3)]!,
        maxStepBp: zufall(3) === 0 ? 100 + zufall(2000) : null
      }
    })
    const r = await owner.query<{ p: string }>(
      `SELECT rate_steer_price(b, c, p, a, mi, ma, r, s)::text AS p
         FROM unnest($1::bigint[], $2::bigint[], $3::int[], $4::bigint[], $5::bigint[],
                     $6::bigint[], $7::text[], $8::int[])
              WITH ORDINALITY AS x(b, c, p, a, mi, ma, r, s, i)
        ORDER BY i`,
      [faelle.map(f => f.baseCent), faelle.map(f => f.currentCent),
       faelle.map(f => f.percentBp), faelle.map(f => f.amountCent),
       faelle.map(f => f.minCent), faelle.map(f => f.maxCent),
       faelle.map(f => f.rounding), faelle.map(f => f.maxStepBp)])
    faelle.forEach((f, i) => {
      expect(Number(r.rows[i]!.p), JSON.stringify(f)).toBe(steerPrice(f))
    })
  })
})

// ------------------------------------------------------- Belegung und Zeit

describe('Belegung und Zeitraum', () => {
  it('Out of Order senkt die Kapazitaet, Out of Service nicht', async () => {
    const plan = await gesteuerterPlan()
    await regel({ kind: 'occupancy', occupancyMinBp: 8500,
                  effectKind: 'percent', effectValue: 2000 })
    await belegung('2026-10-02', 8)
    await belegung('2026-10-03', 8)
    const zimmer = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE property_id = $1 ORDER BY id LIMIT 2`, [fx.propertyId])
    await owner.query(
      `INSERT INTO maintenance_block (property_id, resource_id, from_date, to_date, kind, reason)
       VALUES ($1, $2, '2026-10-02', '2026-10-03', 'out_of_order', 'Wasserschaden'),
              ($1, $3, '2026-10-03', '2026-10-04', 'out_of_service', 'Anstrich')`,
      [fx.propertyId, zimmer.rows[0]!.id, zimmer.rows[1]!.id])

    const v = await vorschau()
    // 8 von 9 verkaeuflichen Zimmern: 88 %.
    expect(zelle(v, plan, '2026-10-02').occupancyBp).toBe(8888)
    expect(zelle(v, plan, '2026-10-02').suggestedCent).toEqual([12000, 14400])
    // Ausser Dienst bleibt verkaeuflich: 8 von 10.
    expect(zelle(v, plan, '2026-10-03').occupancyBp).toBe(8000)
    expect(zelle(v, plan, '2026-10-03').suggestedCent).toEqual([10000, 12000])
  })

  it('zeigt keine Vergangenheit und haelt den Horizont', async () => {
    const plan = await ratenplan('BAR')
    await preise(plan, [10000], '2026-09-20', '2026-12-31')
    await steuern(plan)
    const s = await app.inject({
      method: 'PUT', url: `/v1/properties/${fx.propertyId}/rate-steering`,
      headers: auth(admin.sessionId), payload: { mode: 'suggest', horizonDays: 5 } })
    expect(s.statusCode).toBe(200)

    const v = await vorschau('2026-09-25', '2026-12-31')
    expect(v.from).toBe(TAG)
    expect(v.to).toBe('2026-10-05')
    expect(v.cells.map(c => c.date)).toEqual(
      ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'])
  })

  it('begrenzt den Zeitraum der Vorschau', async () => {
    const r = await vorschauRoh('2026-10-01', '2028-10-01')
    expect(r.statusCode).toBe(422)
  })
})

// --------------------------------------------------------------- Uebernahme

describe('Uebernehmen', () => {
  it('im Vorschlagsmodus aendert sich nichts bis zur Uebernahme', async () => {
    const plan = await gesteuerterPlan()
    const rid = await regel({ kind: 'occupancy', occupancyMinBp: 8500,
                              effectKind: 'percent', effectValue: 2000 })
    await belegung('2026-10-03', 9)

    const v = await vorschau()
    expect(await verkaufspreis(plan, '2026-10-03')).toEqual([10000, 12000])

    const r = await uebernehmen({ from: TAG, to: BIS, token: v.token })
    expect(r.statusCode, r.body).toBe(200)
    expect(json<{ changed: number }>(r).changed).toBe(1)
    expect(await verkaufspreis(plan, '2026-10-03')).toEqual([12000, 14400])

    // Nachvollziehbar: welcher Lauf, welche Regel, alt -> neu.
    const runs = json<SteeringOverview>(await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/rate-steering`,
      headers: auth(admin.sessionId) })).runs
    expect(runs).toHaveLength(1)
    expect(runs[0]!.kind).toBe('apply')
    expect(runs[0]!.changedDays).toBe(1)
    expect(runs[0]!.userName).toBe('chef@test.de')
    const d = json<{ changes: Array<{ date: string; oldCent: number[]; newCent: number[]
                                       baseCent: number[]; ruleIds: number[] }> }>(
      await app.inject({ method: 'GET', headers: auth(admin.sessionId),
        url: `/v1/properties/${fx.propertyId}/rate-steering/runs/${runs[0]!.runId}` }))
    expect(d.changes).toEqual([expect.objectContaining({
      date: '2026-10-03', oldCent: [10000, 12000], newCent: [12000, 14400],
      baseCent: [10000, 12000], ruleIds: [rid] })])
  })

  it('uebernimmt nur die ausgewaehlten Tage', async () => {
    const plan = await gesteuerterPlan()
    await regel({ kind: 'period', periodFrom: TAG, periodTo: BIS,
                  effectKind: 'amount', effectValue: 1000 })
    const v = await vorschau()
    const r = await uebernehmen({ from: TAG, to: BIS, token: v.token,
                                  cells: [{ ratePlanId: plan, date: '2026-10-04' }] })
    expect(json<{ changed: number }>(r).changed).toBe(1)
    expect(await verkaufspreis(plan, '2026-10-04')).toEqual([11000, 13000])
    expect(await verkaufspreis(plan, '2026-10-05')).toEqual([10000, 12000])
  })

  it('eine veraltete Vorschau wird abgewiesen, und nichts wird uebernommen', async () => {
    const plan = await gesteuerterPlan()
    await regel({ kind: 'occupancy', occupancyMinBp: 8500,
                  effectKind: 'percent', effectValue: 2000 })
    await belegung('2026-10-03', 9)
    const v = await vorschau()
    // Inzwischen wird ein weiterer Tag voll: die Vorschau zeigt ihn nicht.
    await belegung('2026-10-04', 9)

    const r = await uebernehmen({ from: TAG, to: BIS, token: v.token })
    expect(r.statusCode).toBe(409)
    expect(json<{ code: string }>(r).code).toBe('rateSteer.previewStale')
    expect(await verkaufspreis(plan, '2026-10-03')).toEqual([10000, 12000])
    expect(await verkaufspreis(plan, '2026-10-04')).toEqual([10000, 12000])
  })

  it('schaukelt sich ueber mehrere Laeufe nicht auf', async () => {
    const plan = await gesteuerterPlan()
    await regel({ kind: 'occupancy', occupancyMinBp: 8500,
                  effectKind: 'percent', effectValue: 2000 })
    await belegung('2026-10-03', 9)

    for (let lauf = 0; lauf < 4; lauf++) {
      const v = await vorschau()
      expect(zelle(v, plan, '2026-10-03').suggestedCent).toEqual([12000, 14400])
      expect(zelle(v, plan, '2026-10-03').baseCent).toEqual([10000, 12000])
      await uebernehmen({ from: TAG, to: BIS, token: v.token })
      expect(await verkaufspreis(plan, '2026-10-03')).toEqual([12000, 14400])
    }
    // Nur der erste Lauf hat etwas geaendert.
    const n = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM rate_steer_change WHERE rate_plan_id = $1`, [plan])
    expect(n.rows[0]!.n).toBe(1)

    // Faellt die Belegung, kehrt der Preis zum Grundpreis zurueck -- nicht
    // zum gesteuerten.
    await belegung('2026-10-03', 5)
    const v = await vorschau()
    expect(zelle(v, plan, '2026-10-03').suggestedCent).toEqual([10000, 12000])
    await uebernehmen({ from: TAG, to: BIS, token: v.token })
    expect(await verkaufspreis(plan, '2026-10-03')).toEqual([10000, 12000])
  })

  it('eine Preispflege von Hand setzt den Grundpreis neu', async () => {
    const plan = await gesteuerterPlan()
    await regel({ kind: 'occupancy', occupancyMinBp: 8500,
                  effectKind: 'percent', effectValue: 2000 })
    await belegung('2026-10-03', 9)
    const v1 = await vorschau()
    await uebernehmen({ from: TAG, to: BIS, token: v1.token })

    // Ausgerechnet der gesteuerte Betrag: auch der ist danach der Grundpreis.
    await preise(plan, [12000, 14400], '2026-10-03', '2026-10-03')
    const v2 = await vorschau()
    expect(zelle(v2, plan, '2026-10-03').baseCent).toEqual([12000, 14400])
    expect(zelle(v2, plan, '2026-10-03').suggestedCent).toEqual([14400, 17300])
  })

  it('gebuchte Reservierungen behalten ihren Preis', async () => {
    const plan = await gesteuerterPlan()
    await regel({ kind: 'period', periodFrom: TAG, periodTo: BIS,
                  effectKind: 'percent', effectValue: 5000 })
    const res = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-10-02',
      departure: '2026-10-04', priceCent: 10000 })
    const v = await vorschau()
    await uebernehmen({ from: TAG, to: BIS, token: v.token })

    expect(await verkaufspreis(plan, '2026-10-02')).toEqual([15000, 18000])
    const naechte = await owner.query<{ price_cent: number }>(
      `SELECT price_cent FROM reservation_night WHERE reservation_id = $1 ORDER BY date`,
      [res.reservationId])
    expect(naechte.rows.map(n => n.price_cent)).toEqual([10000, 10000])
  })

  it('geht denselben Weg wie die Preispflege: abgeleitete Rate, ARI und Ereignis', async () => {
    const plan = await gesteuerterPlan()
    const nonref = await ratenplan('NONREF',
      { baseRatePlanId: plan, deriveKind: 'percent', deriveValue: -10 })
    const neu = await app.inject({
      method: 'POST', url: '/v1/rates/rebuild-derived', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, from: TAG, to: BIS } })
    expect(neu.statusCode).toBe(200)
    expect(await verkaufspreis(nonref, '2026-10-03')).toEqual([9000, 10800])

    await owner.query(
      `INSERT INTO webhook_subscription (account_id, url, signing_secret)
       VALUES ($1, 'https://rms.example.de/hook', 'geheim')`, [fx.accountId])
    const kanal = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/channel-connections`,
      headers: auth(admin.sessionId), payload: { provider: 'roomcloud', name: 'RC' } })
    const token = json<{ token: string }>(kanal).token

    await regel({ kind: 'occupancy', occupancyMinBp: 8500,
                  effectKind: 'percent', effectValue: 2000 })
    await belegung('2026-10-03', 9)
    const marke = new Date().toISOString()
    const v = await vorschau()
    await uebernehmen({ from: TAG, to: BIS, token: v.token })

    // Die abgeleitete Rate folgt ohne "neu rechnen".
    expect(await verkaufspreis(nonref, '2026-10-03')).toEqual([10800, 12960])
    // Der Channel Manager sieht beide Plaene in der Aenderungsmeldung.
    const delta = await app.inject({
      method: 'GET', headers: { authorization: `Bearer ${token}` },
      url: `/v1/channel/ari/rates?from=${TAG}&to=${BIS}&since=${marke}` })
    expect(delta.statusCode).toBe(200)
    const zellen = json<{ cells: Array<{ ratePlanCode: string; date: string
                                         priceCent: number[] }> }>(delta).cells
    expect(zellen.map(z => `${z.ratePlanCode} ${z.date}`).sort())
      .toEqual(['BAR 2026-10-03', 'NONREF 2026-10-03'])
    // Ein Ereignis fuer den Schreibvorgang, nicht eines je Tag.
    const ereignisse = await owner.query<{ payload: { data: Record<string, unknown> } }>(
      `SELECT payload FROM webhook_delivery
        WHERE property_id = $1 AND event_type = 'rate.changed' ORDER BY id`, [fx.propertyId])
    const letztes = ereignisse.rows[ereignisse.rows.length - 1]!.payload.data
    expect(letztes).toMatchObject({ origin: 'rules', days: 1, derivedDays: 1,
                                    from: '2026-10-03', to: '2026-10-03' })
  })

  it('verlangt rate:write; sehen genuegt rate:read', async () => {
    await gesteuerterPlan()
    const rezeption = await makeUser(owner,
      { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const r = await vorschauRoh(TAG, BIS, rezeption.sessionId)
    expect(r.statusCode).toBe(200)
    const v = json<SteerPreview>(r)
    expect((await uebernehmen({ from: TAG, to: BIS, token: v.token },
                              rezeption.sessionId)).statusCode).toBe(403)
    const regelVersuch = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/rate-steering/rules`,
      headers: auth(rezeption.sessionId),
      payload: { kind: 'occupancy', occupancyMinBp: 1, effectKind: 'percent',
                 effectValue: 100 } })
    expect(regelVersuch.statusCode).toBe(403)
  })
})

// ------------------------------------------------- Quelle und Schnittstelle

describe('Quelle je Ratenplan', () => {
  async function maschine(scopes: string[]): Promise<string> {
    await owner.query(
      `INSERT INTO user_account_role (user_id, account_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
       ON CONFLICT DO NOTHING`, [admin.userId, fx.accountId])
    const z = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(admin.sessionId),
      payload: { name: 'RMS', scopes } })
    expect(z.statusCode, z.body).toBe(201)
    const { clientId, clientSecret } = json<{ clientId: string; clientSecret: string }>(z)
    const t = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'client_credentials',
                                     client_id: clientId, client_secret: clientSecret })
        .toString() })
    expect(t.statusCode, t.body).toBe(200)
    return json<{ access_token: string }>(t).access_token
  }

  it('ein externes RMS setzt Preise, aber nicht auf einem Plan der Regeln', async () => {
    const regelPlan = await gesteuerterPlan()
    const rmsPlan = await ratenplan('RMS')
    await steuern(rmsPlan, { source: 'external' })
    const t = await maschine(['rate:write'])
    const bearer = { authorization: `Bearer ${t}` }

    const ok = await preise(rmsPlan, [13900], TAG, BIS, bearer)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await verkaufspreis(rmsPlan, TAG)).toEqual([13900])

    const nein = await preise(regelPlan, [5000], TAG, BIS, bearer)
    expect(nein.statusCode).toBe(409)
    expect(json<{ code: string }>(nein).code).toBe('rateSteer.sourceRules')
    expect(await verkaufspreis(regelPlan, TAG)).toEqual([10000, 12000])
  })

  it('die Regeln lassen einen extern oder von Hand gefuehrten Plan in Ruhe', async () => {
    const extern = await ratenplan('RMS')
    await preise(extern, [10000])
    await steuern(extern, { source: 'external' })
    const hand = await ratenplan('HAND')
    await preise(hand, [10000])
    await regel({ kind: 'period', periodFrom: TAG, periodTo: BIS,
                  effectKind: 'percent', effectValue: 2000 })
    const v = await vorschau()
    expect(v.cells).toHaveLength(0)
  })

  it('eine abgeleitete Rate folgt ihrer Basis und laesst sich nicht steuern', async () => {
    const plan = await gesteuerterPlan()
    const nonref = await ratenplan('NONREF',
      { baseRatePlanId: plan, deriveKind: 'percent', deriveValue: -10 })
    const r = await app.inject({
      method: 'PUT', url: `/v1/properties/${fx.propertyId}/rate-steering/plans/${nonref}`,
      headers: auth(admin.sessionId), payload: { source: 'rules' } })
    expect(r.statusCode).toBe(422)
  })
})

// ------------------------------------------------- Mandanten und Haeuser

describe('Mandanten- und Haustrennung', () => {
  it('ein Plan eines anderen Hauses desselben Accounts kommt nicht durch', async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name, address_line1, postal_code, city,
                             country, tax_number)
       VALUES ($1,'ZWEI','Zweites Haus','Deich 1','25813','Husum','DE','21/815/00124')
       RETURNING id`, [fx.accountId])
    const p2 = zweites.rows[0]!.id
    const cat2 = await makeCategory(owner, p2, { code: 'EZ' })
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL`,
      [admin.userId, p2])
    const fremd = await ratenplan('FREMD', {}, p2, cat2)

    await gesteuerterPlan()
    const r = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/rate-steering/rules`,
      headers: auth(admin.sessionId),
      payload: { kind: 'period', periodFrom: TAG, periodTo: BIS, ratePlanId: fremd,
                 effectKind: 'percent', effectValue: 1000 } })
    expect(r.statusCode).toBe(404)

    const s = await app.inject({
      method: 'PUT', url: `/v1/properties/${fx.propertyId}/rate-steering/plans/${fremd}`,
      headers: auth(admin.sessionId), payload: { source: 'rules' } })
    expect(s.statusCode).toBe(404)

    const v = await vorschau()
    expect(v.cells.every(c => c.ratePlanId !== fremd)).toBe(true)
  })

  it('ein fremder Mandant sieht nichts und darf nichts', async () => {
    await gesteuerterPlan()
    const anderer = await makeProperty(owner, { code: 'ANDERS', name: 'Anders' })
    const fremderChef = await makeUser(owner,
      { email: 'fremd@test.de', propertyId: anderer.propertyId, roleKey: 'hotel_director' })
    const r = await vorschauRoh(TAG, BIS, fremderChef.sessionId)
    expect(r.statusCode).toBe(403)
    const u = await uebernehmen({ from: TAG, to: BIS, token: 'x' }, fremderChef.sessionId)
    expect(u.statusCode).toBe(403)
  })
})

// --------------------------------------------------------------- Messung

describe('Anweisungen', () => {
  it('Vorschau und Uebernahme kosten gleich viele Anweisungen, ob 7 oder 300 Tage', async () => {
    const plan = await gesteuerterPlan()
    await preise(plan, [10000, 12000], TAG, '2027-07-31')
    await ratenplan('NONREF', { baseRatePlanId: plan, deriveKind: 'percent', deriveValue: -10 })
    await regel({ kind: 'weekday', weekdays: [4, 5], effectKind: 'percent', effectValue: 1500 })
    await regel({ kind: 'occupancy', occupancyMinBp: 5000, effectKind: 'amount',
                  effectValue: 900 })

    const messe = async (bis: string): Promise<[number, number]> => {
      const a = await countQueries(pool, () => vorschau(TAG, bis))
      const b = await countQueries(pool, () =>
        uebernehmen({ from: TAG, to: bis, token: a.result.token }))
      expect(b.result.statusCode, b.result.body).toBe(200)
      return [a.report.count, b.report.count]
    }
    const kurz = await messe('2026-10-07')
    const lang = await messe('2027-07-27')
    expect(lang).toEqual(kurz)
  })
})

// ------------------------------------------------------------ Uebungshaus

describe('Uebungshaus', () => {
  it('steuert, gibt aber nichts an einen Channel Manager aus', async () => {
    const plan = await gesteuerterPlan()
    await regel({ kind: 'period', periodFrom: TAG, periodTo: BIS,
                  effectKind: 'percent', effectValue: 1000 })
    const kanal = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/channel-connections`,
      headers: auth(admin.sessionId), payload: { provider: 'roomcloud', name: 'RC' } })
    const token = json<{ token: string }>(kanal).token
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])

    const v = await vorschau()
    const r = await uebernehmen({ from: TAG, to: BIS, token: v.token })
    expect(r.statusCode).toBe(200)
    expect(await verkaufspreis(plan, TAG)).toEqual([11000, 13200])

    // Ein Zugang aus der Zeit vor der Kennzeichnung liefert nicht mehr ...
    const ari = await app.inject({
      method: 'GET', headers: { authorization: `Bearer ${token}` },
      url: `/v1/channel/ari/rates?from=${TAG}&to=${BIS}` })
    expect(ari.statusCode).toBe(422)
    expect(json<{ code: string }>(ari).code).toBe('training.noChannel')
    // ... und ein neuer laesst sich nicht anlegen.
    const neu = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/channel-connections`,
      headers: auth(admin.sessionId), payload: { provider: 'roomcloud', name: 'RC2' } })
    expect(neu.statusCode).toBe(422)
  })
})
