import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'
import { NUR_FUER_MASCHINEN } from '../routes/oauth.js'

/*
 * Die Rechteausweitungen aus dem Sicherheitsaudit vom 11.10.2026
 * (Bericht in den Projektdateien, security/audit-2026-10-11.md). Jeder Fall
 * hier lief vor der Behebung durch.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

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
beforeEach(async () => { await truncateAll(); limiters.reset() })

async function rolleImHaus(userId: number, propertyId: number, roleKey: string): Promise<void> {
  await owner.query(
    `INSERT INTO user_property_role (user_id, property_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = $3 AND account_id IS NULL`,
    [userId, propertyId, roleKey])
}

async function zweitesHaus(accountId: number): Promise<number> {
  const r = await owner.query<{ id: string }>(
    `INSERT INTO property (account_id, code, name, address_line1, postal_code, city, country)
     VALUES ($1, 'ZWEI', 'Zweites Haus', 'x', '1', 'y', 'DE') RETURNING id`, [accountId])
  return Number(r.rows[0]!.id)
}

async function refVon(userId: number): Promise<string> {
  const r = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM app_user WHERE id = $1`, [userId])
  return r.rows[0]!.public_ref
}

describe('K1: Account-Rechte gelten nur im eigenen Account', () => {
  it('Inhaber in A mit Hausrolle in B wird in B nicht Inhaber', async () => {
    const A = await makeProperty(owner, { name: 'Kunde A', code: 'AAA' })
    const B = await makeProperty(owner, { name: 'Kunde B', code: 'BBB' })
    await makeUser(owner, { email: 'inhaber-b@b.de', accountId: B.accountId, roleKey: 'owner' })
    const x = await makeUser(owner, { email: 'x@a.de', accountId: A.accountId, roleKey: 'owner' })
    await rolleImHaus(x.userId, B.propertyId, 'reception')
    const ref = await refVon(x.userId)

    const rollen = await app.inject({
      method: 'PUT', url: `/v1/properties/${B.propertyId}/users/${ref}/account-roles`,
      headers: auth(x.sessionId), payload: { roleKeys: ['owner'] } })
    expect(rollen.statusCode).toBe(403)
    const liste = await app.inject({
      method: 'GET', url: `/v1/properties/${B.propertyId}/users`, headers: auth(x.sessionId) })
    expect(liste.statusCode).toBe(403)
    const zugang = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(x.sessionId),
      payload: { name: 'y', scopes: ['guest:read'], accountId: B.accountId } })
    expect(zugang.statusCode).toBe(403)

    // Im eigenen Betrieb bleibt alles, wie es war.
    const eigene = await app.inject({
      method: 'GET', url: `/v1/properties/${A.propertyId}/users`, headers: auth(x.sessionId) })
    expect(eigene.statusCode).toBe(200)
    const me = JSON.parse((await app.inject({
      method: 'GET', url: '/v1/auth/me', headers: auth(x.sessionId) })).body) as {
        properties: { id: number; permissions: string[] }[] }
    const imHausA = me.properties.find(p => p.id === A.propertyId)!.permissions
    const imHausB = me.properties.find(p => p.id === B.propertyId)!.permissions
    expect(imHausA).toContain('settings:account')
    expect(imHausB).not.toContain('settings:account')
  })
})

describe('H1: die geprüfte Property ist die, die der Handler benutzt', () => {
  it('weist eine abweichende Angabe in Abfrage und Rumpf ab', async () => {
    const a = await makeProperty(owner)
    const b = await zweitesHaus(a.accountId)
    const u = await makeUser(owner, {
      email: 'leitung-a@test.de', propertyId: a.propertyId, roleKey: 'hotel_director' })
    await rolleImHaus(u.userId, b, 'reception')
    const csv = 'code;name;max_occupancy\r\nHACK;Eingeschleust;2\r\n'

    const umweg = await app.inject({
      method: 'POST', url: `/v1/imports/categories?propertyId=${a.propertyId}`,
      headers: auth(u.sessionId), payload: { propertyId: b, csv, commit: true } })
    expect(umweg.statusCode).toBe(403)
    const keineZahl = await app.inject({
      method: 'POST', url: '/v1/imports/categories?propertyId=x',
      headers: auth(u.sessionId), payload: { propertyId: b, csv, commit: true } })
    expect(keineZahl.statusCode).toBe(422)
    const r = await owner.query(`SELECT 1 FROM resource_category WHERE code = 'HACK'`)
    expect(r.rowCount).toBe(0)
  })
})

describe('H2: Maschinenzugänge reichen nicht weiter als ihr Anleger', () => {
  it('Hoteldirektion eines Hauses legt keinen Zugang für alle Häuser an', async () => {
    const fx = await makeProperty(owner)
    await zweitesHaus(fx.accountId)
    await makeUser(owner, { email: 'inhaber@k.de', accountId: fx.accountId, roleKey: 'owner' })
    const dir = await makeUser(owner, {
      email: 'dir@k.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })

    const alle = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(dir.sessionId),
      payload: { name: 'x', scopes: ['reservation:read'] } })
    expect(alle.statusCode).toBe(403)
    const zuViel = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(dir.sessionId),
      payload: { name: 'x', scopes: ['settings:account'], propertyIds: [fx.propertyId] } })
    expect(zuViel.statusCode).toBe(403)
    const eigenesHaus = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(dir.sessionId),
      payload: { name: 'x', scopes: ['reservation:read'], propertyIds: [fx.propertyId] } })
    expect(eigenesHaus.statusCode).toBe(201)

    const abo = await app.inject({
      method: 'POST', url: '/v1/webhook-subscriptions', headers: auth(dir.sessionId),
      payload: { url: 'https://example.org/hook', eventTypes: ['reservation.created'] } })
    expect(abo.statusCode).toBe(403)
  })

  it('der Inhaber legt weiter Zugänge für alle Häuser an, auch mit Maschinenrechten', async () => {
    const fx = await makeProperty(owner)
    const inhaber = await makeUser(owner, {
      email: 'inhaber@k.de', accountId: fx.accountId, roleKey: 'owner' })
    const r = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(inhaber.sessionId),
      payload: { name: 'Adminpanel', scopes: ['reservation:read', 'cashbook:import'] } })
    expect(r.statusCode).toBe(201)
  })

  it('jedes Recht ohne Rolle ist als reines Maschinenrecht geführt', async () => {
    const r = await owner.query<{ key: string }>(
      `SELECT key FROM permission p
        WHERE NOT EXISTS (SELECT 1 FROM role_permission rp WHERE rp.permission_key = p.key)
          AND key NOT LIKE 'platform:%' AND key NOT LIKE 'terminal:%'`)
    for (const { key } of r.rows) expect(NUR_FUER_MASCHINEN.has(key), key).toBe(true)
  })
})

describe('H3: Zimmergruppe und Zimmer ändern nur mit dem Recht in ihrem Haus', () => {
  it('Rezeption in Haus B ändert dort keine Zimmergruppe', async () => {
    const a = await makeProperty(owner)
    const b = await zweitesHaus(a.accountId)
    const katB = await makeCategory(owner, b, { code: 'DZB' })
    const u = await makeUser(owner, {
      email: 'leitung-a@test.de', propertyId: a.propertyId, roleKey: 'hotel_director' })
    await rolleImHaus(u.userId, b, 'reception')

    const r = await app.inject({
      method: 'PATCH', url: `/v1/categories/${katB}`, headers: auth(u.sessionId),
      payload: { name: 'Umbenannt' } })
    expect(r.statusCode).toBe(403)
  })
})
