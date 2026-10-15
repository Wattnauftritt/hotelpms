import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Zimmer und Gast je Position (Sven, 15.10.2026): eine Firma bucht mehrere
 * Zimmer, bekommt eine Sammelrechnung, und jede Zeile muss sagen, wer dort
 * uebernachtet hat.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let categoryId: number
let zimmer: number[]
let lauf = 0

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
  await openBusinessDay(owner, fx.propertyId)
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  categoryId = await makeCategory(owner, fx.propertyId)
  zimmer = await makeResources(owner, fx.propertyId, categoryId, 2)
})

const post = (url: string, payload: unknown = {}) => app.inject({
  method: 'POST', url, headers: { ...auth, 'idempotency-key': `gz-${++lauf}` }, payload })

async function aufenthalt(resourceId: number, vorname: string, nachname: string) {
  const g = await makeGuest(owner, fx.accountId, { firstName: vorname, lastName: nachname })
  const r = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId, resourceId,
    arrival: '2026-10-08', departure: '2026-10-09', reserveInventory: false })
  await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
    [r.reservationId, g.id])
  return { ...r, guestId: g.id }
}

const logis = (folioId: number, reservationId: number, brutto = 10_700) => owner.query(
  `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                       net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account,
                       reservation_id)
   VALUES ($1,$2,'2026-10-08','Übernachtung 08.10.2026',1,$4 - $4 * 7 / 107,
           $4 * 7 / 107,$4,700,'8300',$3)`,
  [fx.propertyId, folioId, reservationId, brutto])

async function firmenfolio(reservationId: number): Promise<{ id: number; ref: string }> {
  const c = await owner.query<{ id: number }>(
    `INSERT INTO company (account_id, name, address_line1, postal_code, city, country)
     VALUES ($1,'Nordsee Bau GmbH','Hafenstr. 1','27472','Cuxhaven','DE') RETURNING id`,
    [fx.accountId])
  const f = await owner.query<{ id: number; public_ref: string }>(
    `INSERT INTO folio (property_id, reservation_id, company_id, kind)
     VALUES ($1,$2,$3,'company') RETURNING id, public_ref`,
    [fx.propertyId, reservationId, c.rows[0]!.id])
  return { id: f.rows[0]!.id, ref: f.rows[0]!.public_ref }
}

describe('Gast je Zimmer auf der Rechnung', () => {
  it('nennt auf der Sammelrechnung der Firma je Position Zimmer und Gast', async () => {
    const a = await aufenthalt(zimmer[0]!, 'Anna', 'Berger')
    const b = await aufenthalt(zimmer[1]!, 'Jan', 'Petersen')
    const f = await firmenfolio(a.reservationId)
    await logis(f.id, a.reservationId)
    await logis(f.id, b.reservationId)

    const v = await post(`/v1/folios/${f.ref}/invoice-preview`)
    expect(v.statusCode, v.body).toBe(200)
    expect((JSON.parse(v.body) as { lines: Array<{ description: string }> }).lines
      .map(l => l.description)).toEqual([
      'Übernachtung 08.10.2026 – Zimmer 101, Anna Berger',
      'Übernachtung 08.10.2026 – Zimmer 102, Jan Petersen'])

    const r = await post(`/v1/folios/${f.ref}/invoice`)
    expect(r.statusCode, r.body).toBe(201)
    const inv = await owner.query<{ id: number; public_ref: string
                                    line_guests: Record<string, string> }>(
      `SELECT id, public_ref, line_guests FROM invoice WHERE folio_id = $1`, [f.id])
    expect(Object.values(inv.rows[0]!.line_guests).sort())
      .toEqual(['Zimmer 101, Anna Berger', 'Zimmer 102, Jan Petersen'])

    // Die Stornorechnung traegt dieselbe Zuordnung; ihre Gegenbuchungen
    // finden sie ueber die Buchung des Originals.
    const s = await post(`/v1/invoices/${inv.rows[0]!.public_ref}/cancel`)
    expect(s.statusCode, s.body).toBe(201)
    const cn = await owner.query<{ line_guests: Record<string, string> }>(
      `SELECT line_guests FROM invoice WHERE reverses_id = $1`, [inv.rows[0]!.id])
    expect(cn.rows[0]!.line_guests).toEqual(inv.rows[0]!.line_guests)

    // Und das Protokoll haelt die Namen nicht fest.
    const log = await owner.query<{ s: string }>(
      `SELECT changed::text AS s FROM audit_log
        WHERE table_name = 'invoice' AND row_id = $1`, [inv.rows[0]!.id])
    expect(log.rowCount).toBeGreaterThan(0)
    for (const z of log.rows) {
      expect(z.s).not.toContain('Berger')
      expect(z.s).not.toContain('Petersen')
    }
  })

  it('wiederholt auf der eigenen Rechnung eines Einzelgastes nichts', async () => {
    const a = await aufenthalt(zimmer[0]!, 'Anna', 'Berger')
    const f = await owner.query<{ public_ref: string }>(
      `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`,
      [a.folioId, a.guestId])
    await logis(a.folioId, a.reservationId)

    const v = await post(`/v1/folios/${f.rows[0]!.public_ref}/invoice-preview`)
    expect(v.statusCode, v.body).toBe(200)
    expect((JSON.parse(v.body) as { lines: Array<{ description: string }> }).lines
      .map(l => l.description)).toEqual(['Übernachtung 08.10.2026'])
  })

  it('nennt den Gast, wenn jemand anderes die Rechnung bekommt', async () => {
    const a = await aufenthalt(zimmer[0]!, 'Anna', 'Berger')
    const zahler = await makeGuest(owner, fx.accountId, { firstName: 'Ole', lastName: 'Berger' })
    const f = await owner.query<{ public_ref: string }>(
      `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`,
      [a.folioId, zahler.id])
    await logis(a.folioId, a.reservationId)

    const v = await post(`/v1/folios/${f.rows[0]!.public_ref}/invoice-preview`)
    expect((JSON.parse(v.body) as { lines: Array<{ description: string }> }).lines
      .map(l => l.description)).toEqual(['Übernachtung 08.10.2026 – Zimmer 101, Anna Berger'])
  })
})
