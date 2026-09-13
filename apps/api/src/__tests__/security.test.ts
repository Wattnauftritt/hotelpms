import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makePaymentMethod, openBusinessDay,
         makeGuest } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { registeredRoutes } from '../platform/routes.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool

async function materialize(propertyId: number) {
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
    [propertyId])
}

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(15) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })
beforeEach(async () => { await truncateAll() })

describe('Mandantentrennung', () => {
  it('liefert einem Token fuer Haus A keine Daten von Haus B', async () => {
    const a = await makeProperty(owner, { code: 'A', name: 'Haus A' })
    const b = await makeProperty(owner, { code: 'B', name: 'Haus B' })
    await makeCategory(owner, a.propertyId)
    await makeCategory(owner, b.propertyId)
    await materialize(a.propertyId)
    await materialize(b.propertyId)

    const userA = await makeUser(owner,
      { email: 'a@test.de', propertyId: a.propertyId, roleKey: 'reception' })

    const eigen = await app.inject({
      method: 'GET',
      url: `/v1/properties/${a.propertyId}/availability?from=2026-10-01&to=2026-10-05`,
      headers: auth(userA.sessionId)
    })
    expect(eigen.statusCode).toBe(200)
    expect(JSON.parse(eigen.body).days.length).toBeGreaterThan(0)

    // Manipulierter Pfadparameter auf das fremde Haus.
    const fremd = await app.inject({
      method: 'GET',
      url: `/v1/properties/${b.propertyId}/availability?from=2026-10-01&to=2026-10-05`,
      headers: auth(userA.sessionId)
    })
    expect(fremd.statusCode).toBe(403)
  })

  it('greift auch dann, wenn die Anwendung die WHERE-Bedingung vergisst', async () => {
    const a = await makeProperty(owner, { code: 'A' })
    const b = await makeProperty(owner, { code: 'B' })
    await makeCategory(owner, a.propertyId)
    await makeCategory(owner, b.propertyId)
    await materialize(a.propertyId)
    await materialize(b.propertyId)

    const { withTransaction } = await import('@hotelpms/db')
    // Absichtlich ohne property_id-Filter: die Zeilenrichtlinie muss greifen.
    const rows = await withTransaction(pool,
      { accountIds: [a.accountId], propertyIds: [a.propertyId], userId: null },
      client => client.query('SELECT DISTINCT property_id FROM inventory_day'))

    expect(rows.rows).toHaveLength(1)
    expect(Number(rows.rows[0]!.property_id)).toBe(a.propertyId)
  })
})

describe('Berechtigungen ueber alle Routen', () => {
  it('deklariert fuer jede Route eine Berechtigung', () => {
    const routes = registeredRoutes()
    expect(routes.length).toBeGreaterThan(5)
    for (const r of routes) {
      // null ist erlaubt, aber nur als ausdrueckliche Entscheidung.
      expect(r.permission === null || typeof r.permission === 'string').toBe(true)
      expect(r.summary.length).toBeGreaterThan(3)
    }
  })

  it('weist jede geschuetzte Route ohne Anmeldung ab', async () => {
    for (const r of registeredRoutes()) {
      if (r.permission === null) continue
      const url = r.url.replace(/:(\w+)/g, '1')
      const res = await app.inject({ method: r.method, url, payload: r.method === 'GET' ? undefined : {} })
      expect(res.statusCode, `${r.method} ${r.url} ohne Anmeldung`).toBe(401)
    }
  })

  it('weist Housekeeping bei Folio und Raten ab', async () => {
    const p = await makeProperty(owner)
    const hk = await makeUser(owner,
      { email: 'hk@test.de', propertyId: p.propertyId, roleKey: 'housekeeping' })

    const res = await app.inject({
      method: 'GET', url: '/v1/folios/XYZ', headers: auth(hk.sessionId)
    })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).title).toBe('Keine Berechtigung')
  })

  it('trennt buchen von stornieren fremder Buchungen', async () => {
    const p = await makeProperty(owner)
    const rez = await makeUser(owner,
      { email: 'r@test.de', propertyId: p.propertyId, roleKey: 'reception' })
    const fom = await makeUser(owner,
      { email: 'f@test.de', propertyId: p.propertyId, roleKey: 'front_office_mgr' })

    const { loadPrincipal } = await import('../platform/auth.js')
    const { can } = await import('../platform/context.js')
    const pRez = await loadPrincipal(pool, rez.userId)
    const pFom = await loadPrincipal(pool, fom.userId)

    expect(can(pRez, 'folio:post', p.propertyId)).toBe(true)
    expect(can(pRez, 'folio:void_own', p.propertyId)).toBe(true)
    // Der klassische Betrugsweg buchen, kassieren, stornieren ist unterbrochen.
    expect(can(pRez, 'folio:void_any', p.propertyId)).toBe(false)
    expect(can(pRez, 'folio:discount_unlimited', p.propertyId)).toBe(false)
    expect(can(pFom, 'folio:void_any', p.propertyId)).toBe(true)
  })

  it('haelt sensible Gastdaten von Housekeeping und Revenue fern', async () => {
    const p = await makeProperty(owner)
    const hk = await makeUser(owner,
      { email: 'hk2@test.de', propertyId: p.propertyId, roleKey: 'housekeeping' })
    const rev = await makeUser(owner,
      { email: 'rev@test.de', accountId: p.accountId, roleKey: 'revenue' })

    const { loadPrincipal } = await import('../platform/auth.js')
    const { can } = await import('../platform/context.js')
    expect(can(await loadPrincipal(pool, hk.userId), 'guest:read_identity')).toBe(false)
    expect(can(await loadPrincipal(pool, rev.userId), 'guest:read_identity')).toBe(false)
  })
})

describe('Plattformpersonal', () => {
  it('erhaelt ohne Support-Sitzung keine einzige Kundenzeile', async () => {
    const p = await makeProperty(owner)
    await makeCategory(owner, p.propertyId)
    await materialize(p.propertyId)
    const staff = await makeUser(owner,
      { email: 'support@wir.de', platformRoleKey: 'platform_support', isPlatformStaff: true })

    const res = await app.inject({
      method: 'GET',
      url: `/v1/properties/${p.propertyId}/availability?from=2026-10-01&to=2026-10-05`,
      headers: auth(staff.sessionId)
    })
    expect(res.statusCode).toBe(403)

    const { loadPrincipal, applySupportSession } = await import('../platform/auth.js')
    const principal = await applySupportSession(pool, await loadPrincipal(pool, staff.userId))
    expect(principal.accountIds).toHaveLength(0)
    expect(principal.permissionsByProperty.size).toBe(0)
  })

  it('sieht Daten erst nach Freigabe durch den Kunden', async () => {
    const p = await makeProperty(owner)
    const staff = await makeUser(owner,
      { email: 'support2@wir.de', platformRoleKey: 'platform_support', isPlatformStaff: true })
    const inhaber = await makeUser(owner,
      { email: 'inhaber@test.de', accountId: p.accountId, roleKey: 'owner' })

    await owner.query(
      `INSERT INTO support_session (account_id, platform_user_id, granted_by, reason,
                                    granted_at, expires_at)
       VALUES ($1,$2,$3,'Fehleranalyse Rechnung', now(), now() + interval '2 hours')`,
      [p.accountId, staff.userId, inhaber.userId])

    const { loadPrincipal, applySupportSession } = await import('../platform/auth.js')
    const principal = await applySupportSession(pool, await loadPrincipal(pool, staff.userId))
    expect(principal.accountIds).toEqual([p.accountId])
    expect(principal.supportSessionId).not.toBeNull()
  })
})

/**
 * Der Zugriffsbereich entsteht bei der Anmeldung aus den Rollen. Beides
 * darin war lange still kaputt: eine Account-Rolle wirkte auf kein Haus, und
 * eine Property-Rolle brachte ihren Account nicht mit (Migration 0018). In
 * den Tests fiel es nicht auf, weil dort immer beides zusammen vergeben
 * wurde. Diese Tests vergeben deshalb bewusst nur eines.
 */
describe('Zugriffsbereich aus Rollen', () => {
  it('laesst eine Account-Rolle auf alle Haeuser des Accounts wirken', async () => {
    const a = await makeProperty(owner, { code: 'EINS' })
    // Zweites Haus im selben Account.
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name) VALUES ($1,'ZWEI','Haus Zwei')
       RETURNING id`, [a.accountId])
    await makeCategory(owner, a.propertyId)
    await makeCategory(owner, zweites.rows[0]!.id)
    await materialize(a.propertyId)
    await materialize(zweites.rows[0]!.id)

    // Nur eine Account-Rolle, ausdruecklich keine Property-Rolle.
    const chef = await makeUser(owner,
      { email: 'chef@kette.de', accountId: a.accountId, roleKey: 'hotel_director' })

    for (const id of [a.propertyId, zweites.rows[0]!.id]) {
      const r = await app.inject({
        method: 'GET',
        url: `/v1/properties/${id}/availability?from=2026-10-01&to=2026-10-05`,
        headers: auth(chef.sessionId)
      })
      expect(r.statusCode, `Haus ${id}`).toBe(200)
    }
  })

  it('bringt eine Property-Rolle ihren Account mit, damit Gaeste sichtbar sind', async () => {
    const p = await makeProperty(owner)
    // Nur eine Property-Rolle. Das Gastprofil haengt am Account.
    const rez = await makeUser(owner,
      { email: 'nurhaus@test.de', propertyId: p.propertyId, roleKey: 'reception' })
    await makeGuest(owner, p.accountId, { lastName: 'Sichtbar' })

    const r = await app.inject({
      method: 'GET', url: '/v1/guests?q=Sichtbar', headers: auth(rez.sessionId) })
    expect(r.statusCode).toBe(200)
    const treffer = (JSON.parse(r.body) as { guests: Array<{ lastName: string }> }).guests
    expect(treffer.map(g => g.lastName)).toContain('Sichtbar')
  })

  it('bleibt der Account des Nachbarn unsichtbar', async () => {
    const a = await makeProperty(owner, { code: 'A' })
    const b = await makeProperty(owner, { code: 'B' })
    const rez = await makeUser(owner,
      { email: 'a@haus.de', propertyId: a.propertyId, roleKey: 'reception' })
    await makeGuest(owner, b.accountId, { lastName: 'Fremdgast' })

    const r = await app.inject({
      method: 'GET', url: '/v1/guests?q=Fremdgast', headers: auth(rez.sessionId) })
    expect(r.statusCode).toBe(200)
    expect((JSON.parse(r.body) as { guests: unknown[] }).guests).toHaveLength(0)
  })
})

describe('Rechnungsnummern', () => {
  it('vergibt lueckenlos und ohne Doppelvergabe bei gleichzeitigen Check-outs', async () => {
    const p = await makeProperty(owner)
    const cat = await makeCategory(owner, p.propertyId)
    await makeResources(owner, p.propertyId, cat, 30)
    await materialize(p.propertyId)
    await makePaymentMethod(owner, p.propertyId)
    await openBusinessDay(owner, p.propertyId)
    const user = await makeUser(owner,
      { email: 'rez@test.de', propertyId: p.propertyId, roleKey: 'reception' })
    const h = auth(user.sessionId)

    // 20 Folios mit je einer Position. Jedes mit Gast, denn eine Rechnung
    // ueber 250 Euro braucht einen Empfaenger mit Anschrift (§ 14 UStG).
    const gast = await makeGuest(owner, p.accountId)
    const folioRefs: string[] = []
    for (let i = 0; i < 20; i++) {
      const f = await owner.query<{ public_ref: string; id: number }>(
        `INSERT INTO folio (property_id, kind, guest_id) VALUES ($1,'guest',$2)
         RETURNING public_ref, id`, [p.propertyId, gast.id])
      folioRefs.push(f.rows[0]!.public_ref)
      await app.inject({
        method: 'POST', url: `/v1/folios/${f.rows[0]!.public_ref}/charges`,
        headers: { ...h, 'idempotency-key': `charge-${i}` },
        payload: { description: 'Uebernachtung', netCent: 10000, taxRateBp: 700 }
      })
    }

    const antworten = await Promise.all(folioRefs.map((ref, i) =>
      app.inject({
        method: 'POST', url: `/v1/folios/${ref}/invoice`,
        headers: { ...h, 'idempotency-key': `inv-${i}` }, payload: {}
      })))

    const nummern = antworten
      .filter(a => a.statusCode === 201)
      .map(a => JSON.parse(a.body).number as string)

    expect(nummern).toHaveLength(20)
    expect(new Set(nummern).size).toBe(20)          // keine Doppelvergabe

    const folgen = nummern.map(n => Number(n.split('-')[1])).sort((a, b) => a - b)
    for (let i = 1; i < folgen.length; i++) {
      expect(folgen[i]! - folgen[i - 1]!).toBe(1)   // keine Luecke
    }
  })

  it('laesst eine festgeschriebene Rechnung nicht mehr aendern', async () => {
    const p = await makeProperty(owner)
    await openBusinessDay(owner, p.propertyId)
    const user = await makeUser(owner,
      { email: 'rez2@test.de', propertyId: p.propertyId, roleKey: 'reception' })
    const h = auth(user.sessionId)

    const gast2 = await makeGuest(owner, p.accountId)
    const f = await owner.query<{ public_ref: string; id: number }>(
      `INSERT INTO folio (property_id, kind, guest_id) VALUES ($1,'guest',$2)
       RETURNING public_ref, id`, [p.propertyId, gast2.id])
    await app.inject({
      method: 'POST', url: `/v1/folios/${f.rows[0]!.public_ref}/charges`,
      headers: { ...h, 'idempotency-key': 'c1' },
      payload: { description: 'Uebernachtung', netCent: 10000, taxRateBp: 700 }
    })
    const inv = await app.inject({
      method: 'POST', url: `/v1/folios/${f.rows[0]!.public_ref}/invoice`,
      headers: { ...h, 'idempotency-key': 'i1' }, payload: {}
    })
    expect(inv.statusCode).toBe(201)

    const { withTransaction } = await import('@hotelpms/db')
    const ctx = { accountIds: [p.accountId], propertyIds: [p.propertyId], userId: null }

    // Zwei Verteidigungslinien: das fehlende Recht und der Trigger. Welche
    // zuerst greift, haengt von der Anweisung ab; abgewiesen wird immer.
    const abgewiesen = /permission denied|unveraenderlich|festgeschrieben|restrict/i

    await expect(withTransaction(pool, ctx, c =>
      c.query(`UPDATE invoice SET number = 'GEFAELSCHT' WHERE property_id = $1`, [p.propertyId])
    )).rejects.toThrow(abgewiesen)

    await expect(withTransaction(pool, ctx, c =>
      c.query(`UPDATE charge SET net_cent = 1 WHERE property_id = $1`, [p.propertyId])
    )).rejects.toThrow(abgewiesen)

    await expect(withTransaction(pool, ctx, c =>
      c.query(`DELETE FROM charge WHERE property_id = $1`, [p.propertyId])
    )).rejects.toThrow(abgewiesen)

    // Und der Trigger greift auch dann, wenn das Recht vorhanden waere:
    // eine bereits zugeordnete Position darf nicht neu zugeordnet werden.
    const ownerPoolLocal = ownerPool()
    await expect(ownerPoolLocal.query(
      `UPDATE charge SET invoice_id = invoice_id + 1 WHERE property_id = $1`, [p.propertyId])
    ).rejects.toThrow(/festgeschrieben/i)
    await ownerPoolLocal.end()
  })
})
