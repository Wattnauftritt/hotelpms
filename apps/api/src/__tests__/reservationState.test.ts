import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Bestand bei Zustandswechseln.
 *
 * Gebunden wird nach **Zustand**, nicht nach Handlung. Das ist der Punkt,
 * an dem es vorher auseinanderlief: das Wiederbinden hing am Paar Storno
 * und Wiederherstellen, und der No-Show, der doch noch anreist, geht nicht
 * ueber dieses Paar, sondern direkt nach `InHouse`. Das Zimmer war belegt
 * und der Zaehler sagte frei.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let auth: Record<string, string>

const VON = '2026-10-01'
const BIS = '2026-10-03'

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
  await makeResources(owner, fx.propertyId, catId, 5)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

const post = (url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: auth, payload })

async function buchung(): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...auth, 'idempotency-key': `k-${Math.random()}` },
    payload: { propertyId: fx.propertyId, categoryId: catId,
               arrival: VON, departure: BIS } })
  expect(r.statusCode, r.body).toBe(201)
  return (JSON.parse(r.body) as { reservationRef: string }).reservationRef
}

async function verkauft(date = VON): Promise<number> {
  const r = await owner.query<{ sold: number }>(
    `SELECT sold FROM inventory_day
      WHERE property_id=$1 AND category_id=$2 AND date=$3`, [fx.propertyId, catId, date])
  return r.rows[0]!.sold
}

async function setzeNoShow(ref: string): Promise<void> {
  // Den No-Show setzt sonst der Nachtlauf; hier genuegt der Zustand.
  await owner.query(
    `UPDATE reservation SET status='NoShow' WHERE public_ref=$1`, [ref])
  await owner.query(
    `SELECT inventory_release($1,$2,$3::date,$4::date,1)`,
    [fx.propertyId, catId, VON, BIS])
}

describe('Bestand bei Zustandswechseln', () => {
  it('bindet wieder, wenn ein No-Show doch noch eincheckt', async () => {
    const ref = await buchung()
    expect(await verkauft()).toBe(1)

    await setzeNoShow(ref)
    expect(await verkauft()).toBe(0)

    const zimmer = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE property_id=$1 LIMIT 1`, [fx.propertyId])
    const z = await post(`/v1/reservations/${ref}/assign-unit`,
      { resourceId: zimmer.rows[0]!.id })
    expect(z.statusCode, z.body).toBe(200)

    const c = await post(`/v1/reservations/${ref}/check-in`)
    expect(c.statusCode, c.body).toBe(200)

    // Das Zimmer ist belegt, also muss der Zaehler es auch sagen.
    expect(await verkauft()).toBe(1)
    expect(await verkauft('2026-10-02')).toBe(1)
  })

  it('nimmt einen Storno zurueck und bindet dabei erneut', async () => {
    const ref = await buchung()
    await post(`/v1/reservations/${ref}/cancel`)
    expect(await verkauft()).toBe(0)

    const w = await post(`/v1/reservations/${ref}/reinstate`)
    expect(w.statusCode, w.body).toBe(200)
    expect(JSON.parse(w.body).status).toBe('Confirmed')
    expect(await verkauft()).toBe(1)

    // Der Zeitstempel muss mit dem Zustand zurueckgehen -- sonst zeigt das
    // Seitenfenster "Storniert am" an einer wieder bestaetigten Reservierung.
    const r = await owner.query<{ canceled_at: string | null }>(
      `SELECT canceled_at FROM reservation WHERE public_ref = $1`, [ref])
    expect(r.rows[0]!.canceled_at).toBeNull()
  })

  it('bindet nicht zweimal, wenn eine bindende Handlung auf eine bindende folgt',
    async () => {
      const ref = await buchung()
      const zimmer = await owner.query<{ id: number }>(
        `SELECT id FROM resource WHERE property_id=$1 LIMIT 1`, [fx.propertyId])
      await post(`/v1/reservations/${ref}/assign-unit`,
        { resourceId: zimmer.rows[0]!.id })
      await post(`/v1/reservations/${ref}/check-in`)
      // Confirmed und InHouse binden beide: der Uebergang darf nichts tun.
      expect(await verkauft()).toBe(1)
    })

  it('weist das Wiederherstellen ab, wenn das Haus inzwischen voll ist', async () => {
    const ref = await buchung()
    await post(`/v1/reservations/${ref}/cancel`)
    // Die fuenf Zimmer der Kategorie inzwischen anderweitig verkauft.
    for (let i = 0; i < 5; i++) await buchung()

    const w = await post(`/v1/reservations/${ref}/reinstate`)
    expect(w.statusCode).toBe(409)
    expect(await verkauft()).toBe(5)
  })
})

/**
 * Das Zimmer wieder abnehmen -- der Zwischenablageplatz beim Umsortieren.
 *
 * In einem vollen Haus lassen sich zwei Buchungen nicht tauschen, ohne dass
 * eine von beiden kurz nirgends liegt: das Zimmer, das frei werden soll,
 * ist erst frei, wenn sein Gast woanders liegt -- und der passt nur dorthin,
 * wo der erste noch liegt. Ohne diesen Weg bliebe nur stornieren und neu
 * buchen, und das ist zweimal falsch: der Vorgang verliert seine Geschichte,
 * und zwischen beidem steht der Platz im freien Verkauf.
 */
describe('Das Zimmer wieder abnehmen', () => {
  async function mitZimmer(): Promise<{ ref: string; zimmerId: number }> {
    const ref = await buchung()
    const zimmer = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE property_id=$1 ORDER BY id LIMIT 1`, [fx.propertyId])
    const z = await post(`/v1/reservations/${ref}/assign-unit`,
      { resourceId: zimmer.rows[0]!.id })
    expect(z.statusCode, z.body).toBe(200)
    return { ref, zimmerId: zimmer.rows[0]!.id }
  }

  async function zimmerVon(ref: string): Promise<number | null> {
    const r = await owner.query<{ resource_id: number | null }>(
      `SELECT resource_id FROM reservation WHERE public_ref = $1`, [ref])
    return r.rows[0]!.resource_id
  }

  it('nimmt das Zimmer ab, wenn null kommt', async () => {
    const { ref } = await mitZimmer()
    const r = await post(`/v1/reservations/${ref}/assign-unit`, { resourceId: null })
    expect(r.statusCode, r.body).toBe(200)
    expect(await zimmerVon(ref)).toBeNull()
  })

  it('laesst den Bestand dabei unberuehrt', async () => {
    /*
     * Gezaehlt wird je Zimmergruppe, nicht je Zimmer. Die Buchung haelt
     * ihren Platz weiter -- nur die Zeile im Plan wechselt. Wuerde hier
     * freigegeben, kaufte das Portal in der Zwischenzeit genau diesen Platz.
     */
    const { ref } = await mitZimmer()
    expect(await verkauft()).toBe(1)
    await post(`/v1/reservations/${ref}/assign-unit`, { resourceId: null })
    expect(await verkauft()).toBe(1)
  })

  it('gibt das Zimmer damit fuer eine andere Buchung frei', async () => {
    const { ref, zimmerId } = await mitZimmer()
    const zweite = await buchung()
    // Solange das erste Zimmer belegt ist, geht es nicht.
    expect((await post(`/v1/reservations/${zweite}/assign-unit`,
      { resourceId: zimmerId })).statusCode).toBe(409)

    await post(`/v1/reservations/${ref}/assign-unit`, { resourceId: null })
    const r = await post(`/v1/reservations/${zweite}/assign-unit`, { resourceId: zimmerId })
    expect(r.statusCode, r.body).toBe(200)
    expect(await zimmerVon(zweite)).toBe(zimmerId)
  })

  it('nimmt einem angereisten Gast das Zimmer nicht weg', async () => {
    /*
     * Der liegt darin. Die Zeile im Plan zu leeren hiesse, Hausliste und
     * Reinigung auf ein leeres Zimmer zu schicken, in dem jemand schlaeft.
     */
    const { ref } = await mitZimmer()
    expect((await post(`/v1/reservations/${ref}/check-in`)).statusCode).toBe(200)
    const r = await post(`/v1/reservations/${ref}/assign-unit`, { resourceId: null })
    expect(r.statusCode).toBe(409)
    expect(await zimmerVon(ref)).not.toBeNull()
  })
})
