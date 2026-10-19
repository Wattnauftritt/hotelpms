import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, ownerPool, makeProperty, makeCategory, makeResources,
         makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'

/**
 * Check-out nach der Reinigung (0181).
 *
 * Sven, 19.10.2026: Zimmer 14 und 25 waren am Abreisetag gereinigt, die
 * Rezeption checkte danach aus, und der Check-out setzte sie auf schmutzig.
 * Am Tag darauf standen sie wieder im Reinigungsplan.
 */

let owner: Pool
let fx: Fixture
let zimmer: number
let reservierung: number

const AN = '2026-10-16'
const AB = '2026-10-18'

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
})
afterAll(async () => { await owner.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  const kat = await makeCategory(owner, fx.propertyId)
  zimmer = (await makeResources(owner, fx.propertyId, kat, 1))[0]!
  reservierung = (await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kat,
    resourceId: zimmer, arrival: AN, departure: AB, status: 'InHouse',
    reserveInventory: false, withFolio: false })).reservationId
})

async function gereinigt(datum: string, kind = 'departure', outcome = 'cleaned') {
  await owner.query(
    `INSERT INTO housekeeping_task (property_id, resource_id, business_date, kind,
                                    status, outcome, done_at)
     VALUES ($1, $2, $3::date, $4, $5, $6, now())`,
    [fx.propertyId, zimmer, datum, kind, outcome === 'cleaned' ? 'done' : 'skipped', outcome])
  await owner.query(
    `INSERT INTO housekeeping_status (property_id, resource_id, status) VALUES ($1, $2, 'clean')
     ON CONFLICT (resource_id) DO UPDATE SET status = 'clean'`, [fx.propertyId, zimmer])
}

async function auschecken(): Promise<string> {
  await owner.query(`UPDATE reservation SET status = 'CheckedOut' WHERE id = $1`, [reservierung])
  const r = await owner.query<{ status: string }>(
    `SELECT status FROM housekeeping_status WHERE resource_id = $1`, [zimmer])
  return r.rows[0]!.status
}

describe('Check-out und Zimmerstand', () => {
  it('laesst ein am Abreisetag gereinigtes Zimmer sauber', async () => {
    await gereinigt(AB)
    expect(await auschecken()).toBe('clean')
  })

  it('zaehlt "war sauber" wie gereinigt', async () => {
    await gereinigt(AB, 'departure', 'was_clean')
    expect(await auschecken()).toBe('clean')
  })

  it('setzt schmutzig, wenn vor der Reinigung ausgecheckt wird', async () => {
    expect(await auschecken()).toBe('dirty')
  })

  it('setzt schmutzig, wenn nur eine Bleiberreinigung erledigt ist', async () => {
    await gereinigt(AB, 'stayover')
    expect(await auschecken()).toBe('dirty')
  })

  it('setzt schmutzig, wenn die Reinigung zu einem anderen Tag gehoert', async () => {
    await gereinigt('2026-10-17')
    expect(await auschecken()).toBe('dirty')
  })
})
