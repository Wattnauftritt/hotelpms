import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, makePaymentMethod,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Split, Umbuchen und Umleitung (Pruefung des Rechnungssystems vom
 * 13.10.2026: "Firma zahlt Logis, Gast zahlt Extras" ging nur umstaendlich).
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let categoryId: number
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
  await makePaymentMethod(owner, fx.propertyId, 'BAR')
  categoryId = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, categoryId, 2)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
})

const post = (url: string, payload: unknown = {}) => app.inject({
  method: 'POST', url, headers: { ...auth, 'idempotency-key': `sp-${++lauf}` }, payload })

async function aufenthalt(): Promise<{ ref: string; id: number; reservationId: number }> {
  const gast = await makeGuest(owner, fx.accountId)
  await owner.query(
    `UPDATE guest SET address_line1 = 'Strandweg 2', postal_code = '27476',
                      city = 'Cuxhaven', country = 'DE' WHERE id = $1`, [gast.id])
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId, arrival: '2026-10-01', departure: '2026-10-03' })
  const f = await owner.query<{ public_ref: string }>(
    `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`, [res.folioId, gast.id])
  return { ref: f.rows[0]!.public_ref, id: res.folioId, reservationId: res.reservationId }
}

async function buchen(folioRef: string, grossCent: number, taxRateBp = 700): Promise<number> {
  const r = await post(`/v1/folios/${folioRef}/charges`,
    { description: taxRateBp === 700 ? 'Uebernachtung' : 'Minibar', grossCent, taxRateBp })
  expect(r.statusCode, r.body).toBe(201)
  return (JSON.parse(r.body) as { chargeId: number }).chargeId
}

interface Konto { folioRef: string; label: string | null; main: boolean
                  balanceCent: number; accommodationHere: boolean }

async function stay(folioRef: string): Promise<Konto[]> {
  const r = await app.inject({ method: 'GET', url: `/v1/folios/${folioRef}`, headers: auth })
  expect(r.statusCode, r.body).toBe(200)
  return (JSON.parse(r.body) as { stay: Konto[] }).stay
}

describe('Split', () => {
  it('legt ein weiteres Folio zum Aufenthalt an, das Gastfolio bleibt vorn', async () => {
    const a = await aufenthalt()
    const r = await post(`/v1/folios/${a.ref}/split`, { label: 'Firma' })
    expect(r.statusCode, r.body).toBe(201)
    const neu = (JSON.parse(r.body) as { folioRef: string }).folioRef

    const s = await stay(neu)
    expect(s.map(x => [x.folioRef, x.main, x.label])).toEqual([
      [a.ref, true, null], [neu, false, 'Firma']])
    const k = await owner.query<{ kind: string; reservation_id: string }>(
      `SELECT kind, reservation_id::text FROM folio WHERE public_ref = $1`, [neu])
    expect(k.rows[0]).toEqual({ kind: 'company', reservation_id: String(a.reservationId) })
  })

  it('begrenzt die Zahl der Folios je Aufenthalt', async () => {
    const a = await aufenthalt()
    for (let i = 0; i < 5; i++) {
      expect((await post(`/v1/folios/${a.ref}/split`)).statusCode).toBe(201)
    }
    const r = await post(`/v1/folios/${a.ref}/split`)
    expect(r.statusCode).toBe(409)
    expect(JSON.parse(r.body).code).toBe('folio.tooMany')
  })
})

describe('Umbuchen', () => {
  it('bucht eine offene Position mit ihrem Geschaeftstag auf das andere Folio', async () => {
    const a = await aufenthalt()
    const logis = await buchen(a.ref, 10_700)
    await buchen(a.ref, 1_190, 1900)
    const neu = (JSON.parse((await post(`/v1/folios/${a.ref}/split`)).body) as
      { folioRef: string }).folioRef

    const r = await post(`/v1/folios/${a.ref}/charges/${logis}/transfer`,
      { targetFolioRef: neu })
    expect(r.statusCode, r.body).toBe(201)

    const s = await stay(a.ref)
    expect(s.map(x => x.balanceCent)).toEqual([1_190, 10_700])
    const z = await owner.query<{ folio: string; gross: string; tag: string
                                  reverses: string | null }>(
      `SELECT f.public_ref AS folio, c.gross_cent::text AS gross,
              c.business_date::text AS tag, c.reverses_id::text AS reverses
         FROM charge c JOIN folio f ON f.id = c.folio_id
        WHERE c.revenue_account = '8300' ORDER BY c.id`)
    const tag = z.rows[0]!.tag
    expect(z.rows).toEqual([
      { folio: a.ref, gross: '10700', tag, reverses: null },
      { folio: a.ref, gross: '-10700', tag, reverses: String(logis) },
      { folio: neu, gross: '10700', tag, reverses: null }
    ])

    // Die Rechnung des neuen Folios traegt die Logis allein.
    const inv = await post(`/v1/folios/${neu}/invoice`)
    expect(inv.statusCode, inv.body).toBe(201)
    const t = await owner.query<{ g: string }>(
      `SELECT totals->>'grossCent' AS g FROM invoice`)
    expect(Number(t.rows[0]!.g)).toBe(10_700)
  })

  it('weist Fakturiertes, Gegengebuchtes und fremde Aufenthalte ab', async () => {
    const a = await aufenthalt()
    const b = await aufenthalt()
    const neu = (JSON.parse((await post(`/v1/folios/${a.ref}/split`)).body) as
      { folioRef: string }).folioRef

    const fremd = await buchen(a.ref, 500, 1900)
    const r1 = await post(`/v1/folios/${a.ref}/charges/${fremd}/transfer`,
      { targetFolioRef: b.ref })
    expect(r1.statusCode).toBe(422)
    expect(JSON.parse(r1.body).code).toBe('charge.transferTarget')
    const r2 = await post(`/v1/folios/${a.ref}/charges/${fremd}/transfer`,
      { targetFolioRef: a.ref })
    expect(r2.statusCode).toBe(422)

    expect((await post(`/v1/folios/${a.ref}/charges/${fremd}/transfer`,
      { targetFolioRef: neu })).statusCode).toBe(201)
    const nochmal = await post(`/v1/folios/${a.ref}/charges/${fremd}/transfer`,
      { targetFolioRef: neu })
    expect(nochmal.statusCode).toBe(409)
    expect(JSON.parse(nochmal.body).code).toBe('charge.alreadyReversed')

    const fakturiert = await buchen(b.ref, 700, 1900)
    expect((await post(`/v1/folios/${b.ref}/invoice`)).statusCode).toBe(201)
    const bNeu = (JSON.parse((await post(`/v1/folios/${b.ref}/split`)).body) as
      { folioRef: string }).folioRef
    const r3 = await post(`/v1/folios/${b.ref}/charges/${fakturiert}/transfer`,
      { targetFolioRef: bNeu })
    expect(r3.statusCode).toBe(409)
    expect(JSON.parse(r3.body).code).toBe('charge.invoiced')
  })
})

describe('Umleitung', () => {
  it('setzt die Logis-Regel auf ein weiteres Folio und nimmt sie wieder weg', async () => {
    const a = await aufenthalt()
    const neu = (JSON.parse((await post(`/v1/folios/${a.ref}/split`)).body) as
      { folioRef: string }).folioRef
    const put = (ref: string, accommodation: boolean) => app.inject({
      method: 'PUT', url: `/v1/folios/${ref}/routing`, headers: auth,
      payload: { accommodation } })

    expect((await put(neu, true)).statusCode).toBe(200)
    expect((await stay(a.ref)).map(x => x.accommodationHere)).toEqual([false, true])
    // Zweimal setzen ergibt keine zweite Regel.
    expect((await put(neu, true)).statusCode).toBe(200)
    const n = await owner.query(`SELECT 1 FROM routing_rule WHERE reservation_id = $1`,
      [a.reservationId])
    expect(n.rowCount).toBe(1)

    // Aufs Gastfolio heisst: keine Regel.
    expect((await put(a.ref, true)).statusCode).toBe(200)
    expect((await stay(a.ref)).map(x => x.accommodationHere)).toEqual([false, false])
  })
})
