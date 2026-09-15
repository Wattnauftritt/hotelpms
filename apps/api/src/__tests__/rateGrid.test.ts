import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Das Preis- und Restriktionsraster, wie die Pflegeansicht es liest
 * (Spur B, B1 bis B3 in Dokument 20).
 *
 * Die Massenpflege selbst ist in `routes.test.ts` geprüft; hier steht die
 * **Leseseite**, an der die Oberfläche hängt. Sie hat drei Eigenschaften,
 * auf die sich das Raster verlässt und die alle drei still brechen können:
 * der Zeitraum schließt den letzten Tag ein, die Preise kommen als Zahlen
 * je Belegung zurück und nicht als Zeichenketten, und ein Tag ohne
 * gepflegten Preis ist `null` und nicht null Euro.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

interface Zelle {
  ratePlanId: number
  ratePlanCode: string
  date: string
  priceCent: number[] | null
  minLos: number | null
  maxLos: number | null
  closed: boolean
  closedToArrival: boolean
  closedToDeparture: boolean
}

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
  catId = await makeCategory(owner, fx.propertyId)
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
})

async function ratePlan(code: string, categoryId = catId): Promise<number> {
  const r = await app.inject({
    method: 'POST', url: `/v1/properties/${fx.propertyId}/rate-plans`,
    headers: auth(admin.sessionId),
    payload: { code, name: code, categoryId } })
  expect(r.statusCode, r.body).toBe(201)
  return (JSON.parse(r.body) as { ratePlanId: number }).ratePlanId
}

const setzePreise = (ratePlanId: number, from: string, to: string,
                     priceCent: number[], weekdays?: number[]) =>
  app.inject({
    method: 'PUT', url: '/v1/rates/bulk', headers: auth(admin.sessionId),
    payload: { propertyId: fx.propertyId, ratePlanId, from, to, priceCent,
               ...(weekdays === undefined ? {} : { weekdays }) } })

const raster = (from: string, to: string, categoryId?: number) =>
  app.inject({
    method: 'GET',
    url: `/v1/properties/${fx.propertyId}/rate-grid?from=${from}&to=${to}`
       + (categoryId === undefined ? '' : `&categoryId=${categoryId}`),
    headers: auth(admin.sessionId) })

const zellen = (body: string): Zelle[] => (JSON.parse(body) as { cells: Zelle[] }).cells

describe('Preisraster lesen', () => {
  /**
   * Ein Preisraster zählt Tage, kein Aufenthalt Nächte: der letzte Tag
   * trägt einen Preis. Fehlte er, stünde an Silvester nichts — sichtbar
   * erst am 31. Dezember.
   */
  it('deckt den Zeitraum einschliesslich des letzten Tages ab', async () => {
    const plan = await ratePlan('BAR')
    const r = await raster('2026-12-29', '2026-12-31')
    expect(r.statusCode, r.body).toBe(200)
    const c = zellen(r.body).filter(z => z.ratePlanId === plan)
    expect(c.map(z => z.date)).toEqual(['2026-12-29', '2026-12-30', '2026-12-31'])
  })

  /**
   * `price_cent` ist ein `bigint[]`. Ohne den Parser für 1016 in
   * `packages/db/src/pool.ts` kämen die Werte als Zeichenketten an, und die
   * Oberfläche rechnete damit — sichtbar als „NaN" oder, schlimmer, als
   * plausible Zahl aus einer Zeichenkettenverkettung.
   */
  it('liefert Preise als Zahlen je Belegung', async () => {
    const plan = await ratePlan('BAR')
    await setzePreise(plan, '2026-10-01', '2026-10-03', [9_000, 12_000, 14_500])

    const c = zellen((await raster('2026-10-01', '2026-10-03')).body)
      .find(z => z.ratePlanId === plan && z.date === '2026-10-02')
    expect(c?.priceCent).toEqual([9_000, 12_000, 14_500])
    for (const p of c?.priceCent ?? []) expect(typeof p).toBe('number')
  })

  /**
   * Ein Tag ohne gepflegten Preis ist nicht ein Tag, der null Euro kostet.
   * Käme dort eine 0, verkaufte das Haus umsonst.
   */
  it('unterscheidet ungepflegt von null Euro', async () => {
    const plan = await ratePlan('BAR')
    await setzePreise(plan, '2026-10-01', '2026-10-01', [9_000])

    const c = zellen((await raster('2026-10-01', '2026-10-02')).body)
      .filter(z => z.ratePlanId === plan)
    expect(c.find(z => z.date === '2026-10-01')?.priceCent).toEqual([9_000])
    expect(c.find(z => z.date === '2026-10-02')?.priceCent).toBeNull()
  })

  it('gibt Restriktionen an derselben Zelle aus', async () => {
    const plan = await ratePlan('BAR')
    await app.inject({
      method: 'PUT', url: '/v1/restrictions/bulk', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: plan,
                 from: '2026-10-02', to: '2026-10-02',
                 minLos: 3, closedToArrival: true } })

    const c = zellen((await raster('2026-10-01', '2026-10-02')).body)
      .filter(z => z.ratePlanId === plan)
    const mit = c.find(z => z.date === '2026-10-02')
    expect(mit?.minLos).toBe(3)
    expect(mit?.closedToArrival).toBe(true)
    expect(mit?.closed).toBe(false)
    // Ein Tag ohne Eintrag ist offen, nicht unbekannt: die Oberflaeche
    // zeigt sonst an jedem ungepflegten Tag eine Sperre.
    const ohne = c.find(z => z.date === '2026-10-01')
    expect(ohne?.closed).toBe(false)
    expect(ohne?.minLos).toBeNull()
  })

  it('haelt die Wochentagspflege im Raster auseinander', async () => {
    const plan = await ratePlan('WE')
    // Freitag und Samstag im Oktober 2026.
    await setzePreise(plan, '2026-10-01', '2026-10-31', [15_000], [4, 5])

    const c = zellen((await raster('2026-10-01', '2026-10-31')).body)
      .filter(z => z.ratePlanId === plan)
    expect(c).toHaveLength(31)
    expect(c.filter(z => z.priceCent !== null)).toHaveLength(10)
    for (const z of c.filter(x => x.priceCent !== null)) {
      const wd = new Date(`${z.date}T00:00:00Z`).getUTCDay()
      expect([5, 6]).toContain(wd)
    }
  })

  it('filtert auf eine Zimmergruppe', async () => {
    const a = await ratePlan('A')
    const zweite = await makeCategory(owner, fx.propertyId, { code: 'EZ', name: 'Einzel' })
    const b = await ratePlan('B', zweite)

    const gefiltert = zellen((await raster('2026-10-01', '2026-10-02', zweite)).body)
    expect(gefiltert.some(z => z.ratePlanId === b)).toBe(true)
    expect(gefiltert.some(z => z.ratePlanId === a)).toBe(false)
  })

  /**
   * Ein Jahr am Stück ist der Zweck dieses Endpunkts — daran hängt die
   * Ansicht, aus der die Preise an den Channel Manager gehen. Darüber
   * hinaus ist jeder Zeitraumparameter ein Selbstangriff.
   */
  it('traegt 400 Tage und weist 401 ab', async () => {
    await ratePlan('BAR')
    const gut = await raster('2026-01-01', '2027-02-04')      // 400 Tage
    expect(gut.statusCode).toBe(200)
    expect(zellen(gut.body)).toHaveLength(400)

    const zuViel = await raster('2026-01-01', '2027-02-05')   // 401 Tage
    expect(zuViel.statusCode).toBe(422)
  })

  it('zeigt das Raster eines fremden Hauses nicht', async () => {
    const fremd = await makeProperty(owner, { name: 'Fremdhotel', code: 'FREMD' })
    const u = await makeUser(owner,
      { email: 'fremd@test.de', propertyId: fremd.propertyId, roleKey: 'hotel_director' })
    const r = await app.inject({
      method: 'GET',
      url: `/v1/properties/${fx.propertyId}/rate-grid?from=2026-10-01&to=2026-10-02`,
      headers: auth(u.sessionId) })
    expect(r.statusCode).toBe(403)
  })
})
