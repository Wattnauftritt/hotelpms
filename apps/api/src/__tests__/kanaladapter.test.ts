import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { CHANNEL_CREDENTIALS_PURPOSE, decryptSecret } from '@hotelpms/domain'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/*
 * Verwaltung der Kanaladapter (Migration 0198). Der Abgleich selbst ist im
 * Worker getestet (`kanalabgleich.test.ts`); hier geht es um das, was die
 * Schnittstelle zusagt: Zugangsdaten gehen nie zurueck, Probebetrieb ist
 * der Anfang, und neben dem Adminpanel sendet RoomCloud direkt nicht.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let dz: number
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const SCHLUESSEL = 'cx-api-key-0123456789abcdef'

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
  dz = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
})

const basis = () => `/v1/properties/${fx.propertyId}/channel-adapters`

const anlegen = (payload: Record<string, unknown> = {}) => app.inject({
  method: 'POST', url: basis(), headers: auth(admin.sessionId),
  payload: { provider: 'channex', name: 'Channex', externalPropertyId: 'prop-1',
             credentials: SCHLUESSEL, ...payload } })

async function liste(): Promise<Array<Record<string, unknown>>> {
  const r = await app.inject({ method: 'GET', url: basis(), headers: auth(admin.sessionId) })
  expect(r.statusCode).toBe(200)
  return (JSON.parse(r.body) as { adapters: Array<Record<string, unknown>> }).adapters
}

async function adminpanelZugang(): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: `/v1/properties/${fx.propertyId}/channel-connections`,
    headers: auth(admin.sessionId), payload: { provider: 'adminpanel', name: 'Adminpanel' } })
  expect(r.statusCode).toBe(201)
  return (JSON.parse(r.body) as { connectionRef: string }).connectionRef
}

describe('Kanaladapter anlegen', () => {
  it('beginnt im Probebetrieb und gibt die Zugangsdaten nie zurueck', async () => {
    const r = await anlegen()
    expect(r.statusCode).toBe(201)
    expect(r.body).not.toContain(SCHLUESSEL)
    expect(JSON.parse(r.body)).toMatchObject({ mode: 'shadow' })

    const l = await liste()
    expect(JSON.stringify(l)).not.toContain(SCHLUESSEL)
    expect(l).toEqual([expect.objectContaining({
      provider: 'channex', mode: 'shadow', credentialsHint: 'cx-a…cdef',
      externalPropertyId: 'prop-1', roomMap: [], rateMap: [] })])

    // Gespeichert verschluesselt, unter eigenem Zweck.
    const c = await owner.query<{ credentials_enc: Buffer }>(
      `SELECT credentials_enc FROM channel_connection WHERE kind = 'adapter'`)
    expect(c.rows[0]!.credentials_enc.toString('utf8')).not.toContain(SCHLUESSEL)
    expect(decryptSecret(c.rows[0]!.credentials_enc, process.env.ID_DOCUMENT_KEY!,
      CHANNEL_CREDENTIALS_PURPOSE)).toBe(SCHLUESSEL)
  })

  it('legt je Anbieter nur einen Adapter an', async () => {
    expect((await anlegen()).statusCode).toBe(201)
    const r = await anlegen()
    expect(r.statusCode).toBe(409)
    expect(r.body).toContain('channel.adapterExists')
  })

  it('weist einen unbekannten Anbieter ab', async () => {
    const r = await anlegen({ provider: 'adminpanel' })
    expect(r.statusCode).toBe(422)
  })

  it('legt im Uebungshaus keinen Adapter an', async () => {
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])
    const r = await anlegen()
    expect(r.statusCode).toBe(422)
    expect(r.body).toContain('training.noChannel')
  })

  it('zeigt Adapter nicht unter den Zugaengen fuer Umsysteme', async () => {
    await anlegen()
    await adminpanelZugang()
    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/channel-connections`,
      headers: auth(admin.sessionId) })
    const { connections } = JSON.parse(r.body) as { connections: Array<{ provider: string }> }
    expect(connections.map(c => c.provider)).toEqual(['adminpanel'])
    expect((await liste()).map(a => a.provider)).toEqual(['channex'])
  })

  it('nimmt fuer Umsysteme den alten Namen roomcloud nicht mehr an', async () => {
    const r = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/channel-connections`,
      headers: auth(admin.sessionId), payload: { provider: 'roomcloud', name: 'Alt' } })
    expect(r.statusCode).toBe(422)
  })
})

describe('RoomCloud neben dem Adminpanel', () => {
  it('bleibt im Probebetrieb, solange das Adminpanel verbunden ist', async () => {
    await adminpanelZugang()
    const aktiv = await anlegen({ provider: 'roomcloud', mode: 'active' })
    expect(aktiv.statusCode).toBe(409)
    expect(aktiv.body).toContain('channel.adminpanelStillActive')

    const probe = await anlegen({ provider: 'roomcloud' })
    expect(probe.statusCode).toBe(201)
    const ref = (JSON.parse(probe.body) as { connectionRef: string }).connectionRef
    const umschalten = await app.inject({
      method: 'PATCH', url: `${basis()}/${ref}`, headers: auth(admin.sessionId),
      payload: { mode: 'active' } })
    expect(umschalten.statusCode).toBe(409)
  })

  it('schaltet um, wenn das Adminpanel getrennt ist, und sendet dann alles neu', async () => {
    const ap = await adminpanelZugang()
    const probe = await anlegen({ provider: 'roomcloud' })
    const ref = (JSON.parse(probe.body) as { connectionRef: string }).connectionRef
    await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/channel-connections/${ap}/disable`,
      headers: auth(admin.sessionId) })
    const r = await app.inject({
      method: 'PATCH', url: `${basis()}/${ref}`, headers: auth(admin.sessionId),
      payload: { mode: 'active' } })
    expect(r.statusCode).toBe(200)
    expect((await liste())[0]).toMatchObject({ mode: 'active' })
    expect((await liste())[0]!.fullSyncRequestedAt).not.toBeNull()

    // Und andersherum: kein neuer Adminpanel-Zugang neben dem direkten.
    const neu = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/channel-connections`,
      headers: auth(admin.sessionId), payload: { provider: 'adminpanel', name: 'Wieder' } })
    expect(neu.statusCode).toBe(409)
  })

  it('laesst Channex neben dem Adminpanel aktiv zu', async () => {
    await adminpanelZugang()
    expect((await anlegen({ mode: 'active' })).statusCode).toBe(201)
  })
})

describe('Zuordnung und Protokoll', () => {
  async function adapter(): Promise<string> {
    return (JSON.parse((await anlegen()).body) as { connectionRef: string }).connectionRef
  }

  it('ordnet Gruppen zu und verlangt danach den ganzen Bestand', async () => {
    const ref = await adapter()
    const r = await app.inject({
      method: 'PUT', url: `${basis()}/${ref}/room-map`, headers: auth(admin.sessionId),
      payload: { entries: [{ categoryId: dz, externalRoomType: 'DBL' }] } })
    expect(r.statusCode).toBe(200)
    const a = (await liste())[0]!
    expect(a.roomMap).toEqual([{ categoryId: dz, categoryCode: 'DZ', externalRoomType: 'DBL' }])
    expect(a.fullSyncRequestedAt).not.toBeNull()

    // Als Ganzes gesetzt: was fehlt, ist danach weg.
    await app.inject({
      method: 'PUT', url: `${basis()}/${ref}/room-map`, headers: auth(admin.sessionId),
      payload: { entries: [] } })
    expect((await liste())[0]!.roomMap).toEqual([])
  })

  it('nimmt keine Gruppe eines anderen Hauses im selben Account an', async () => {
    const ref = await adapter()
    const p = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name, address_line1, postal_code, city, country)
       VALUES ($1,'GH','Gaestehaus','Hafenstr. 2','25813','Husum','DE') RETURNING id`,
      [fx.accountId])
    const fremd = await makeCategory(owner, p.rows[0]!.id, { code: 'FW' })
    const r = await app.inject({
      method: 'PUT', url: `${basis()}/${ref}/room-map`, headers: auth(admin.sessionId),
      payload: { entries: [{ categoryId: fremd, externalRoomType: 'APT' }] } })
    expect(r.statusCode).toBe(422)
    expect(r.body).toContain('field.unknownCategory')
  })

  it('weist doppelte Zimmertypen ab', async () => {
    const ref = await adapter()
    const ez = await makeCategory(owner, fx.propertyId, { code: 'EZ' })
    const r = await app.inject({
      method: 'PUT', url: `${basis()}/${ref}/room-map`, headers: auth(admin.sessionId),
      payload: { entries: [{ categoryId: dz, externalRoomType: 'DBL' },
                           { categoryId: ez, externalRoomType: 'DBL' }] } })
    expect(r.statusCode).toBe(422)
  })

  it('zeigt das Kanalprotokoll, neuester Eintrag zuerst', async () => {
    const ref = await adapter()
    const c = await owner.query<{ id: number }>(
      `SELECT id FROM channel_connection WHERE public_ref = $1`, [ref])
    await owner.query(
      `INSERT INTO channel_sync_log (property_id, connection_id, kind, mode, status, items,
                                     started_at, finished_at)
       VALUES ($1,$2,'full','shadow','ok',365, now() - interval '2 minutes',
               now() - interval '2 minutes'),
              ($1,$2,'availability','shadow','ok',3, now(), now())`,
      [fx.propertyId, c.rows[0]!.id])
    const r = await app.inject({
      method: 'GET', url: `${basis()}/${ref}/log`, headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    const { entries } = JSON.parse(r.body) as { entries: Array<{ kind: string; items: number }> }
    expect(entries.map(e => [e.kind, e.items])).toEqual([['availability', 3], ['full', 365]])

    const zuViel = await app.inject({
      method: 'GET', url: `${basis()}/${ref}/log?limit=500`, headers: auth(admin.sessionId) })
    expect(zuViel.statusCode).toBe(422)
  })

  it('legt einen Adapter still, danach ist er weg und ein neuer moeglich', async () => {
    const ref = await adapter()
    const r = await app.inject({
      method: 'POST', url: `${basis()}/${ref}/disable`, headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    expect(await liste()).toEqual([])
    expect((await anlegen()).statusCode).toBe(201)
  })
})
