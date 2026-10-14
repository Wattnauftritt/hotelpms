import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeReservation, openBusinessDay, type Fixture }
  from '@hotelpms/testing'
import type { DbContext, Pool } from '@hotelpms/db'
import { runNightAudit } from '../jobs/nightAudit.js'

/**
 * Mit dem Tag endet der Aufenthalt (Sven, 14.10.2026). Seit der Nachtlauf
 * nicht eingecheckte Anreisen eincheckt (0088), aber niemand die Abreisen
 * auscheckt, blieb ein Zimmer nach der Abreise auf "belegt" und fiel aus dem
 * Reinigungsplan, obwohl es niemand gereinigt hatte.
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
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  rooms = await makeResources(owner, fx.propertyId, catId, 5)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, TAG)
})

async function gast(room: number, arrival: string, departure: string,
                    status: 'Confirmed' | 'InHouse' = 'InHouse'): Promise<void> {
  await makeReservation(owner, { propertyId: fx.propertyId, categoryId: catId,
    resourceId: room, arrival, departure, status, reserveInventory: false,
    withFolio: false })
}

async function stand(room: number, status: string): Promise<void> {
  await owner.query(
    `INSERT INTO housekeeping_status (property_id, resource_id, status) VALUES ($1,$2,$3)`,
    [fx.propertyId, room, status])
}

async function staende(): Promise<Record<number, string>> {
  const { rows } = await owner.query<{ resource_id: number; status: string }>(
    `SELECT resource_id::int, status FROM housekeeping_status WHERE property_id = $1`,
    [fx.propertyId])
  return Object.fromEntries(rows.map(r => [r.resource_id, r.status]))
}

describe('Tageswechsel', () => {
  it('setzt ein abgereistes, nicht gereinigtes Zimmer auf schmutzig', async () => {
    await gast(rooms[0]!, '2026-09-28', TAG)              // reist heute ab, nie ausgecheckt
    await stand(rooms[0]!, 'occupied')
    await gast(rooms[1]!, '2026-09-28', TAG)              // reist ab, schon gereinigt
    await stand(rooms[1]!, 'clean')
    await gast(rooms[2]!, '2026-09-30', '2026-10-03')     // bleibt
    await stand(rooms[2]!, 'occupied')
    await gast(rooms[3]!, '2026-09-28', TAG)              // reist ab, neuer Gast heute
    await gast(rooms[3]!, TAG, '2026-10-02', 'Confirmed')
    await stand(rooms[3]!, 'occupied')
    await gast(rooms[4]!, '2026-10-02', '2026-10-05')     // schon fuer morgen eingecheckt
    await stand(rooms[4]!, 'occupied')

    await runNightAudit(app, ctx, fx.propertyId, { businessDate: TAG })

    expect(await staende()).toEqual({
      [rooms[0]!]: 'dirty', [rooms[1]!]: 'clean', [rooms[2]!]: 'occupied',
      [rooms[3]!]: 'occupied', [rooms[4]!]: 'occupied' })
  })

  it('laesst ein schmutziges Zimmer schmutzig', async () => {
    // Vorgestern abgereist und ausgecheckt, seither nicht gereinigt.
    await stand(rooms[0]!, 'dirty')
    await runNightAudit(app, ctx, fx.propertyId, { businessDate: TAG })
    expect((await staende())[rooms[0]!]).toBe('dirty')
  })
})
