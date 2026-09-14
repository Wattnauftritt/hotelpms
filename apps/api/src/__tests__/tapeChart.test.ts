import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Der Zimmerplan liefert **Kalenderdaten**, keine Zeitpunkte.
 *
 * Der Fehler, den diese Datei festhält: `date`-Spalten ohne `::text` kommen
 * durch node-postgres als `Date` zurück und werden als voller Zeitstempel
 * serialisiert. Die Oberfläche rechnet damit `Date.parse('…T00:00:00.000ZT00:00:00Z')`,
 * bekommt `NaN` und setzt jeden Balken auf `left: NaN` — der Zimmerplan
 * zeigte dann kein einziges belegtes Zimmer, und die einzige Spur war eine
 * React-Warnung in der Konsole.
 *
 * Es ist zugleich ein Bruch der Regel aus CLAUDE.md: ein Zeitstempel
 * verschiebt das Datum je nach Zeitzone um einen Tag.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let rooms: number[]
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const KALENDERDATUM = /^\d{4}-\d{2}-\d{2}$/

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
  rooms = await makeResources(owner, fx.propertyId, catId, 3)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
    [fx.propertyId])
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [admin.userId, fx.accountId])
})

interface Plan {
  from: string
  to: string
  reservations: Array<{ arrival: string; departure: string }>
  blocks: Array<{ from_date: string; to_date: string }>
}

async function zimmerplan(): Promise<Plan> {
  const r = await app.inject({
    method: 'GET',
    url: `/v1/properties/${fx.propertyId}/tape-chart?from=2026-10-01&to=2026-10-08`,
    headers: auth(admin.sessionId) })
  expect(r.statusCode).toBe(200)
  return JSON.parse(r.body) as Plan
}

describe('Zimmerplan', () => {
  it('gibt Anreise und Abreise als Kalenderdatum aus, nicht als Zeitstempel', async () => {
    await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-10-02',
      departure: '2026-10-05', status: 'Confirmed', resourceId: rooms[0]! })

    const plan = await zimmerplan()
    expect(plan.reservations).toHaveLength(1)
    const r = plan.reservations[0]!
    expect(r.arrival).toMatch(KALENDERDATUM)
    expect(r.departure).toMatch(KALENDERDATUM)
    // Und zwar genau der Tag, der gebucht wurde -- kein Sprung um einen Tag.
    expect(r.arrival).toBe('2026-10-02')
    expect(r.departure).toBe('2026-10-05')
  })

  it('gibt auch die Sperrungen als Kalenderdatum aus', async () => {
    await owner.query(
      `INSERT INTO maintenance_block (property_id, resource_id, from_date, to_date,
                                      kind, reason)
       VALUES ($1,$2,'2026-10-03'::date,'2026-10-06'::date,'out_of_order','Wasserschaden')`,
      [fx.propertyId, rooms[1]!])

    const plan = await zimmerplan()
    expect(plan.blocks).toHaveLength(1)
    const b = plan.blocks[0]!
    expect(b.from_date).toMatch(KALENDERDATUM)
    expect(b.to_date).toMatch(KALENDERDATUM)
    expect(b.from_date).toBe('2026-10-03')
    expect(b.to_date).toBe('2026-10-06')
  })

  /**
   * Die Rechnung, die die Oberfläche mit diesen Werten anstellt. Sie steht
   * hier, weil ein `NaN` an dieser Stelle keinen Fehler wirft, sondern einen
   * unsichtbaren Balken erzeugt.
   */
  it('liefert Werte, aus denen sich eine Balkenposition rechnen lässt', async () => {
    await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-10-02',
      departure: '2026-10-05', status: 'Confirmed', resourceId: rooms[0]! })

    const plan = await zimmerplan()
    const tage = (von: string, bis: string) =>
      Math.round(
        (Date.parse(`${bis}T00:00:00Z`) - Date.parse(`${von}T00:00:00Z`)) / 86_400_000)

    const r = plan.reservations[0]!
    expect(tage(plan.from, r.arrival)).toBe(1)
    expect(tage(plan.from, r.departure)).toBe(4)
    expect(Number.isNaN(tage(plan.from, r.arrival))).toBe(false)
  })
})
