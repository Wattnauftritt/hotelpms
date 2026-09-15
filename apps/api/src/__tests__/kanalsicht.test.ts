import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Was der Channel Manager sieht (B10).
 *
 * Der Kern dieser Ansicht ist eine Behauptung: **dieselbe Antwort**, die der
 * Channel Manager über `GET /v1/channel/ari/*` bekommt. Genau die wird hier
 * geprüft, und zwar gegen die echten ARI-Endpunkte mit echtem
 * Verbindungstoken — nicht gegen eine Erwartung, die jemand aufgeschrieben
 * hat. Sonst wäre die Ansicht beim nächsten Feld eine andere Antwort, und
 * als Auskunft darüber, warum bei einem Portal ein anderer Preis steht,
 * wertlos.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let admin: { userId: number; sessionId: string }
let revenue: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
/** Vier Naechte: das Ende ist bei ARI ausschliesslich. */
const FROM = '2026-10-01'
const TO = '2026-10-05'

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
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  await makeResources(owner, fx.propertyId, catId, 2)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
    [fx.propertyId])
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  revenue = await makeUser(owner,
    { email: 'revenue@test.de', propertyId: fx.propertyId, roleKey: 'revenue' })
})

async function ratenplan(code: string, aktiv = true): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `INSERT INTO rate_plan (property_id, category_id, code, name, active)
     VALUES ($1,$2,$3,$3,$4) RETURNING id`,
    [fx.propertyId, catId, code, aktiv])
  return r.rows[0]!.id
}

async function preis(ratePlanId: number, datum: string, cent: number): Promise<void> {
  await owner.query(
    `INSERT INTO rate_day (property_id, rate_plan_id, date, price_cent)
     VALUES ($1,$2,$3::date,$4::bigint[])`,
    [fx.propertyId, ratePlanId, datum, [cent - 2000, cent]])
}

async function connectionToken(): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: `/v1/properties/${fx.propertyId}/channel-connections`,
    headers: auth(admin.sessionId),
    payload: { provider: 'roomcloud', name: 'Roomcloud Test' } })
  expect(r.statusCode).toBe(201)
  return (r.json() as { token: string }).token
}

const ari = (token: string, pfad: string) => app.inject({
  method: 'GET', url: `/v1/channel/ari/${pfad}?from=${FROM}&to=${TO}`,
  headers: { authorization: `Bearer ${token}` } })

const sicht = (sessionId: string, von = FROM, bis = TO) => app.inject({
  method: 'GET',
  url: `/v1/properties/${fx.propertyId}/channel-view?from=${von}&to=${bis}`,
  headers: auth(sessionId) })

/** `generatedAt` ist je Aufruf ein anderer Zeitpunkt und gehoert nicht zum Vergleich. */
interface Antwort { generatedAt: string; days?: unknown[]; cells?: unknown[] }

describe('Was der Channel Manager sieht', () => {
  it('liefert Zeile für Zeile dasselbe wie die beiden ARI-Endpunkte', async () => {
    const plan = await ratenplan('BAR')
    await preis(plan, '2026-10-01', 12_000)
    await preis(plan, '2026-10-02', 13_000)
    await owner.query(
      `INSERT INTO restriction_day (property_id, rate_plan_id, date, min_los, closed)
       VALUES ($1,$2,'2026-10-02'::date,3,true)`,
      [fx.propertyId, plan])

    const token = await connectionToken()
    const maschine = {
      verfuegbarkeit: (await ari(token, 'availability')).json() as Antwort,
      preise: (await ari(token, 'rates')).json() as Antwort
    }
    const oberflaeche = (await sicht(revenue.sessionId)).json() as Antwort

    // Der eigentliche Punkt: nicht "sieht ähnlich aus", sondern gleich.
    expect(oberflaeche.days).toEqual(maschine.verfuegbarkeit.days)
    expect(oberflaeche.cells).toEqual(maschine.preise.cells)
    expect(oberflaeche.days).toHaveLength(4)
    expect(oberflaeche.cells).toHaveLength(4)
  })

  it('zeigt einen ungepflegten Tag als Tag ohne Preis, nicht als fehlende Zeile',
    async () => {
      const plan = await ratenplan('BAR')
      await preis(plan, '2026-10-01', 12_000)

      const v = (await sicht(revenue.sessionId)).json() as
        { cells: Array<{ date: string; priceCent: number[] | null }> }
      // Vier Naechte, vier Zeilen: der ungepflegte Tag faellt nicht heraus,
      // sondern geht als "kein Preis" hinaus -- und wird drueben nicht
      // verkauft. Faellt er heraus, sucht die Rezeption an der falschen
      // Stelle nach dem Grund.
      expect(v.cells).toHaveLength(4)
      expect(v.cells.filter(z => z.priceCent === null)).toHaveLength(3)
      expect(v.cells.find(z => z.date === '2026-10-01')!.priceCent).toEqual([10_000, 12_000])
    })

  it('lässt einen stillgelegten Ratenplan weg, so wie ARI ihn weglässt', async () => {
    const aktiv = await ratenplan('BAR')
    const still = await ratenplan('ALT', false)
    await preis(aktiv, '2026-10-01', 12_000)
    await preis(still, '2026-10-01', 9_900)

    const token = await connectionToken()
    const maschine = (await ari(token, 'rates')).json() as
      { cells: Array<{ ratePlanCode: string }> }
    const v = (await sicht(revenue.sessionId)).json() as
      { cells: Array<{ ratePlanCode: string }> }

    expect(v.cells.every(z => z.ratePlanCode === 'BAR')).toBe(true)
    expect(v.cells.map(z => z.ratePlanCode)).toEqual(maschine.cells.map(z => z.ratePlanCode))
  })

  it('begrenzt den Zeitraum auf dieselben 400 Tage wie ARI', async () => {
    const zuLang = await sicht(revenue.sessionId, '2026-01-01', '2027-06-01')
    expect(zuLang.statusCode).toBe(422)

    const verdreht = await sicht(revenue.sessionId, '2026-10-05', '2026-10-01')
    expect(verdreht.statusCode).toBe(422)

    const kaputt = await sicht(revenue.sessionId, 'gestern', '2026-10-01')
    expect(kaputt.statusCode).toBe(422)
  })

  it('verlangt das Recht, Preise zu sehen', async () => {
    const hk = await makeUser(owner,
      { email: 'hk@test.de', propertyId: fx.propertyId, roleKey: 'housekeeping' })
    const r = await sicht(hk.sessionId)
    expect(r.statusCode).toBe(403)
  })

  it('zeigt die Preise eines fremden Hauses nicht', async () => {
    await ratenplan('BAR')
    const fremd = await makeProperty(owner)
    const u = await makeUser(owner,
      { email: 'fremd@test.de', propertyId: fremd.propertyId, roleKey: 'revenue' })

    const r = await sicht(u.sessionId)
    expect(r.statusCode).toBe(403)
  })
})
