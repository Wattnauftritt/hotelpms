import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Die Bildschirme der Spur C stehen auf zwei Zahlen, die man nicht sehen
 * kann: der Vorjahresvergleich und der Rueckstand des Nachtlaufs. Beide
 * sehen falsch genauso plausibel aus wie richtig, und genau deshalb steht
 * hier ein Test und keine Sichtpruefung.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(5) })
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
  await makeCategory(owner, fx.propertyId)
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

/** Aufzeichnung eines abgeschlossenen Tages, wie sie der Nachtlauf hinterlaesst. */
async function stat(
  date: string, opts: { capacity?: number; sold?: number; revenue?: number } = {}
): Promise<void> {
  await owner.query(
    `INSERT INTO business_day_stat (property_id, date, capacity, sold, room_revenue_cent)
     VALUES ($1, $2::date, $3, $4, $5)
     ON CONFLICT (property_id, date) DO UPDATE
       SET capacity = EXCLUDED.capacity, sold = EXCLUDED.sold,
           room_revenue_cent = EXCLUDED.room_revenue_cent`,
    [fx.propertyId, date, opts.capacity ?? 10, opts.sold ?? 5, opts.revenue ?? 50_000])
}

describe('Kennzahlen mit Vorjahresvergleich', () => {
  it('liefert den Vergleich nur auf Verlangen und im selben Aufruf', async () => {
    await stat('2020-06-01', { sold: 8, revenue: 80_000 })
    await stat('2019-06-01', { sold: 4, revenue: 30_000 })

    const ohne = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/kpi?from=2020-06-01&to=2020-06-01` })
    expect(ohne.statusCode).toBe(200)
    expect(ohne.json()).not.toHaveProperty('comparison')

    const mit = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/kpi`
         + `?from=2020-06-01&to=2020-06-01&compare=previous-year` })
    expect(mit.statusCode).toBe(200)
    const b = mit.json()
    expect(b.total.sold).toBe(8)
    expect(b.comparison.total.sold).toBe(4)
    expect(b.comparison.total.roomRevenueCent).toBe(30_000)
    // Der Vergleichszeitraum ist ein anderer und wird auch so benannt.
    expect(b.comparison.days[0].date).toBe('2019-06-01')
  })

  /**
   * Der 29. Februar hat im Vorjahr keine Entsprechung. Wer ein Jahr durch
   * Abziehen von der Jahreszahl in der Zeichenkette bildet, erzeugt hier den
   * 29.2.2027 -- ein Datum, das es nicht gibt, und die Abfrage bricht ab.
   */
  it('haelt den 29. Februar aus', async () => {
    await stat('2028-02-29')
    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/kpi`
         + `?from=2028-02-29&to=2028-02-29&compare=previous-year` })
    expect(r.statusCode).toBe(200)
    expect(r.json().comparison.total.sold).toBe(0)
  })

  it('weist einen unbekannten Vergleich ab, statt ihn stillschweigend zu ignorieren', async () => {
    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/kpi`
         + `?from=2026-01-01&to=2026-01-02&compare=letzte-woche` })
    expect(r.statusCode).toBe(422)
  })

  it('begrenzt den Zeitraum', async () => {
    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/kpi?from=2020-01-01&to=2026-01-01` })
    expect(r.statusCode).toBe(422)
  })
})

describe('Nachtlauf-Stand', () => {
  it('meldet einen Rueckstand gegen das Geschaeftsdatum des Hauses', async () => {
    // Ein Tag, der vor Jahren geoeffnet wurde und nie geschlossen: genau das
    // Bild eines Hauses, in dem der Worker steht.
    await openBusinessDay(owner, fx.propertyId, '2020-03-01')

    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/night-audit-status` })
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.openDate).toBe('2020-03-01')
    expect(b.overdue).toBe(true)
    expect(b.daysBehind).toBeGreaterThan(1000)
    expect(b.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  /**
   * Kein offener Tag ist der schwerere Fall, nicht der harmlosere: dann
   * laeuft im Haus nichts mehr, was ein Geschaeftsdatum braucht. Er darf
   * deshalb nicht als "kein Rueckstand" durchgehen.
   */
  it('behandelt einen fehlenden Geschaeftstag als Ausfall', async () => {
    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/night-audit-status` })
    const b = r.json()
    expect(b.openDate).toBeNull()
    expect(b.daysBehind).toBeNull()
    expect(b.overdue).toBe(true)
  })

  it('zeigt die Schritte je Tag und laesst einen unvollstaendigen Lauf erkennen', async () => {
    await openBusinessDay(owner, fx.propertyId, '2026-10-02')
    await owner.query(
      `INSERT INTO business_day (property_id, date, status, closed_at)
       VALUES ($1, '2026-10-01'::date, 'closed', now())`, [fx.propertyId])
    for (const s of ['rollover', 'post_accommodation']) {
      await owner.query(
        `INSERT INTO night_audit_step (property_id, business_date, step, detail)
         VALUES ($1, '2026-10-01'::date, $2, '{"count": 3}'::jsonb)`, [fx.propertyId, s])
    }
    await stat('2026-10-01', { sold: 7 })

    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/night-audit-status` })
    const b = r.json()
    expect(b.expectedSteps).toHaveLength(7)
    const tag = b.days.find((d: { date: string }) => d.date === '2026-10-01')
    expect(tag.status).toBe('closed')
    expect(tag.steps).toHaveLength(2)
    expect(tag.steps.map((s: { step: string }) => s.step)).toContain('rollover')
    // Die Kennzahl des Tages kommt im selben Aufruf mit, nicht je Zeile.
    expect(tag.sold).toBe(7)
    // Der noch offene Tag hat keine Aufzeichnung und sagt das mit null,
    // statt eine Null zu behaupten, die wie "nichts verkauft" aussaehe.
    const offen = b.days.find((d: { date: string }) => d.date === '2026-10-02')
    expect(offen.sold).toBeNull()
  })

  it('begrenzt die Zahl der Tage nach oben', async () => {
    for (let i = 0; i < 5; i++) {
      await owner.query(
        `INSERT INTO business_day (property_id, date, status)
         VALUES ($1, ('2026-10-01'::date + $2::int), 'closed')`, [fx.propertyId, i])
    }
    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/night-audit-status?days=9999` })
    expect(r.json().days.length).toBeLessThanOrEqual(60)
    const zwei = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/night-audit-status?days=2` })
    expect(zwei.json().days).toHaveLength(2)
  })
})

/**
 * Der Bildschirm zeigt vier Bereiche mit drei verschiedenen Rechten. Wer sie
 * nicht auseinanderhaelt, baut eine Rezeptionsansicht, die fuer die
 * Rezeption zur Haelfte aus 403 besteht.
 */
describe('Rechte je Bereich', () => {
  it('trennt Betrieb, Umsatz und Export', async () => {
    const u = await makeUser(owner,
      { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const rez = { cookie: `hp_session=${u.sessionId}` }
    await openBusinessDay(owner, fx.propertyId)

    const stand = await app.inject({ method: 'GET', headers: rez,
      url: `/v1/properties/${fx.propertyId}/night-audit-status` })
    expect(stand.statusCode).toBe(200)

    const kpi = await app.inject({ method: 'GET', headers: rez,
      url: `/v1/properties/${fx.propertyId}/kpi?from=2026-10-01&to=2026-10-02` })
    expect(kpi.statusCode).toBe(403)

    const export_ = await app.inject({ method: 'GET', headers: rez,
      url: `/v1/properties/${fx.propertyId}/accommodation-statistics?month=2026-10` })
    expect(export_.statusCode).toBe(403)
  })
})

/**
 * Ein Stapel aus Uebungsdaten in der echten Buchhaltung ist schwerer zu
 * entfernen als zu verhindern (C11, Dokument 13). Die Oberflaeche bietet den
 * Knopf nicht an -- die API verlaesst sich darauf nicht.
 */
describe('Uebungshaus', () => {
  it('weist Statistik und Export ab', async () => {
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`,
      [fx.propertyId])

    const stat_ = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/accommodation-statistics?month=2026-10` })
    expect(stat_.statusCode).toBe(422)

    const datev = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/exports/datev?from=2026-10-01&to=2026-10-31` })
    expect(datev.statusCode).toBe(422)

    // Der Nachtlauf-Stand bleibt sichtbar: er geht nicht nach draussen.
    await openBusinessDay(owner, fx.propertyId)
    const stand = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/night-audit-status` })
    expect(stand.statusCode).toBe(200)
  })
})
