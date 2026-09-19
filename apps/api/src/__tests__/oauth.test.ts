import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { registeredRoutes } from '../platform/routes.js'
import { limiters } from '../platform/rateLimit.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, never>

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
  // Der Tokenendpunkt liegt unter der engen Grenze; viele Ausgaben in einem
  // Lauf kaemen sonst gemeinsam daran.
  limiters.reset()
  fx = await makeProperty(owner)
  const cat = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, cat, 3)
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [admin.userId, fx.accountId])
})

interface Zugang { clientId: string; clientSecret: string }

async function zugang(
  opts: { scopes?: string[]; propertyIds?: number[] } = {}
): Promise<Zugang> {
  const r = await app.inject({
    method: 'POST', url: '/v1/oauth-clients', headers: auth(admin.sessionId),
    payload: { name: 'Channel Manager', scopes: opts.scopes ?? ['housekeeping:read'],
               propertyIds: opts.propertyIds } })
  expect(r.statusCode).toBe(201)
  return json(r) as unknown as Zugang
}

/** Formularkodiert, wie RFC 6749 es vorschreibt. */
function tokenAnfrage(felder: Record<string, string>, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: new URLSearchParams(felder).toString() })
}

async function token(z: Zugang, scope?: string): Promise<string> {
  const r = await tokenAnfrage({
    grant_type: 'client_credentials', client_id: z.clientId, client_secret: z.clientSecret,
    ...(scope === undefined ? {} : { scope }) })
  expect(r.statusCode).toBe(200)
  return (json(r) as unknown as { access_token: string }).access_token
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

describe('Tokenausgabe', () => {
  it('gibt gegen Kennung und Geheimnis ein Token aus', async () => {
    const z = await zugang({ scopes: ['housekeeping:read', 'reservation:read'] })
    const r = await tokenAnfrage({
      grant_type: 'client_credentials', client_id: z.clientId, client_secret: z.clientSecret })

    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    const t = json(r) as unknown as
      { access_token: string; token_type: string; expires_in: number; scope: string }
    expect(t.token_type).toBe('Bearer')
    expect(t.expires_in).toBe(3600)
    expect(t.scope.split(' ').sort()).toEqual(['housekeeping:read', 'reservation:read'])

    // In der Datenbank liegt nur der Hash, nie das Token selbst.
    const gespeichert = await owner.query<{ token_hash: Buffer }>(
      `SELECT token_hash FROM oauth_access_token`)
    expect(gespeichert.rowCount).toBe(1)
    expect(gespeichert.rows[0]!.token_hash.toString('utf8')).not.toContain(t.access_token)
  })

  it('nimmt die Zugangsdaten auch aus der Basic-Kopfzeile', async () => {
    const z = await zugang()
    const basic = Buffer.from(`${z.clientId}:${z.clientSecret}`).toString('base64')
    const r = await tokenAnfrage({ grant_type: 'client_credentials' },
      { authorization: `Basic ${basic}` })
    expect(r.statusCode).toBe(200)
  })

  it('antwortet auf ein falsches Geheimnis nach RFC 6749, nicht als Problem', async () => {
    const z = await zugang()
    const r = await tokenAnfrage({
      grant_type: 'client_credentials', client_id: z.clientId, client_secret: 'falsch' })

    expect(r.statusCode).toBe(401)
    const f = json(r) as unknown as { error: string; error_description: string }
    expect(f.error).toBe('invalid_client')
    expect(f.error_description.length).toBeGreaterThan(0)
    // Kein Problem-Dokument: eine fremde OAuth-Bibliothek erwartet dieses Format.
    expect(r.body).not.toContain('urn:staygrid')
  })

  it('unterscheidet unbekannte Kennung nicht von falschem Geheimnis', async () => {
    const z = await zugang()
    const falschesGeheimnis = await tokenAnfrage({
      grant_type: 'client_credentials', client_id: z.clientId, client_secret: 'falsch' })
    const unbekannt = await tokenAnfrage({
      grant_type: 'client_credentials', client_id: 'GIBTESNICHT', client_secret: 'falsch' })

    expect(unbekannt.statusCode).toBe(falschesGeheimnis.statusCode)
    expect(json(unbekannt).error).toBe(json(falschesGeheimnis).error)
  })

  it('kennt nur client_credentials', async () => {
    const z = await zugang()
    const r = await tokenAnfrage({
      grant_type: 'authorization_code', client_id: z.clientId, client_secret: z.clientSecret })
    expect(r.statusCode).toBe(400)
    expect(json(r).error).toBe('unsupported_grant_type')
  })

  it('gibt weniger aus, wenn weniger angefragt wird', async () => {
    const z = await zugang({ scopes: ['housekeeping:read', 'reservation:read'] })
    const r = await tokenAnfrage({
      grant_type: 'client_credentials', client_id: z.clientId,
      client_secret: z.clientSecret, scope: 'housekeeping:read' })
    expect((json(r) as unknown as { scope: string }).scope).toBe('housekeeping:read')
  })

  it('gibt gar nichts aus, wenn mehr angefragt wird als vereinbart', async () => {
    const z = await zugang({ scopes: ['housekeeping:read'] })
    const r = await tokenAnfrage({
      grant_type: 'client_credentials', client_id: z.clientId,
      client_secret: z.clientSecret, scope: 'housekeeping:read folio:post' })
    expect(r.statusCode).toBe(400)
    expect(json(r).error).toBe('invalid_scope')
    expect(await anzahlToken()).toBe(0)
  })
})

async function anzahlToken(): Promise<number> {
  const r = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM oauth_access_token`)
  return r.rows[0]!.n
}

describe('Ein Token erreicht genau seine Zugriffsbereiche', () => {
  it('laesst durch, was im Zugriffsbereich liegt', async () => {
    const z = await zugang({ scopes: ['housekeeping:read'] })
    const t = await token(z)

    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/housekeeping?date=2026-10-01`,
      headers: bearer(t) })
    expect(r.statusCode).toBe(200)
  })

  it('weist ab, was ausserhalb liegt', async () => {
    const z = await zugang({ scopes: ['housekeeping:read'] })
    const t = await token(z)

    const r = await app.inject({
      method: 'PUT', url: '/v1/rates/bulk', headers: bearer(t),
      payload: { propertyId: fx.propertyId, ratePlanId: 1, from: '2026-10-01',
                 to: '2026-10-02', priceCent: [1000] } })
    expect(r.statusCode).toBe(403)
  })

  /**
   * Die Abnahme der Aufgabe: der generische Berechtigungstest, aber ueber den
   * Tokenweg statt ueber die Sitzung. Er laeuft ueber **alle** registrierten
   * Routen, damit eine neue Route nicht versehentlich fuer jedes Token offen
   * steht.
   */
  it('laeuft ueber die gesamte Routenliste', async () => {
    const z = await zugang({ scopes: ['housekeeping:read'] })
    const t = await token(z)

    for (const r of registeredRoutes()) {
      if (r.permission === null) continue
      if (r.permission === 'housekeeping:read') continue
      const url = r.url.replace(/:(\w+)/g, '1')
      const antwort = await app.inject({
        method: r.method, url, headers: bearer(t), payload: {} })
      expect([401, 403], `${r.method} ${url} liess ein fremdes Token durch`)
        .toContain(antwort.statusCode)
    }
  })

  it('weist ein unbekanntes Token ab wie gar keines', async () => {
    const ohne = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/housekeeping?date=2026-10-01` })
    const falsch = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/housekeeping?date=2026-10-01`,
      headers: bearer('erfunden') })
    expect(ohne.statusCode).toBe(401)
    expect(falsch.statusCode).toBe(401)
  })

  it('laesst ein abgelaufenes Token nicht mehr durch', async () => {
    const z = await zugang()
    const t = await token(z)
    await owner.query(`UPDATE oauth_access_token SET expires_at = now() - interval '1 minute'`)

    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/housekeeping?date=2026-10-01`,
      headers: bearer(t) })
    expect(r.statusCode).toBe(401)
  })
})

describe('Zugriffsbereich auf Haeuser', () => {
  /**
   * Der Grund, warum ein Token **keine** accountweiten Berechtigungen
   * bekommt: sie wirkten sonst auf alle Haeuser des Accounts, und die
   * Einschraenkung des Clients waere wirkungslos.
   */
  it('erreicht das zweite Haus desselben Accounts nicht', async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name) VALUES ($1,'ZWEI','Zweites')
       RETURNING id`, [fx.accountId])
    const z = await zugang({ scopes: ['housekeeping:read'], propertyIds: [fx.propertyId] })
    const t = await token(z)

    const eigenes = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/housekeeping?date=2026-10-01`,
      headers: bearer(t) })
    expect(eigenes.statusCode).toBe(200)

    const fremdes = await app.inject({
      method: 'GET',
      url: `/v1/properties/${zweites.rows[0]!.id}/housekeeping?date=2026-10-01`,
      headers: bearer(t) })
    expect(fremdes.statusCode).toBe(403)
  })

  it('erreicht ohne Einschraenkung alle Haeuser des Accounts', async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name) VALUES ($1,'ZWEI','Zweites')
       RETURNING id`, [fx.accountId])
    const t = await token(await zugang({ scopes: ['housekeeping:read'] }))

    const r = await app.inject({
      method: 'GET',
      url: `/v1/properties/${zweites.rows[0]!.id}/housekeeping?date=2026-10-01`,
      headers: bearer(t) })
    expect(r.statusCode).toBe(200)
  })

  it('erreicht kein Haus eines fremden Accounts', async () => {
    const fremd = await makeProperty(owner, { code: 'FREMD' })
    const t = await token(await zugang({ scopes: ['housekeeping:read'] }))

    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fremd.propertyId}/housekeeping?date=2026-10-01`,
      headers: bearer(t) })
    expect(r.statusCode).toBe(403)
  })
})

describe('Maschinenzugang verwalten', () => {
  it('gibt das Geheimnis genau einmal heraus', async () => {
    const z = await zugang()
    const liste = await app.inject({
      method: 'GET', url: '/v1/oauth-clients', headers: auth(admin.sessionId) })
    expect(liste.body).not.toContain(z.clientSecret)

    const clients = (json(liste) as unknown as
      { clients: Array<{ clientId: string; activeTokens: number }> }).clients
    expect(clients).toHaveLength(1)
    expect(clients[0]!.clientId).toBe(z.clientId)
  })

  it('zaehlt die gueltigen Token mit', async () => {
    const z = await zugang()
    await token(z)
    const liste = await app.inject({
      method: 'GET', url: '/v1/oauth-clients', headers: auth(admin.sessionId) })
    expect((json(liste) as unknown as { clients: Array<{ activeTokens: number }> })
      .clients[0]!.activeTokens).toBe(1)
  })

  it('entwertet beim Sperren auch die schon ausgegebenen Token', async () => {
    const z = await zugang()
    const t = await token(z)

    const sperre = await app.inject({
      method: 'POST', url: `/v1/oauth-clients/${z.clientId}/revoke`,
      headers: auth(admin.sessionId) })
    expect(sperre.statusCode).toBe(200)
    expect(json(sperre)).toMatchObject({ status: 'disabled', revokedTokens: 1 })

    const danach = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/housekeeping?date=2026-10-01`,
      headers: bearer(t) })
    expect(danach.statusCode).toBe(401)

    // Und ein neues Token gibt es auch nicht mehr.
    const neu = await tokenAnfrage({
      grant_type: 'client_credentials', client_id: z.clientId, client_secret: z.clientSecret })
    expect(neu.statusCode).toBe(401)
  })

  it('nimmt keine Plattformrechte als Zugriffsbereich', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(admin.sessionId),
      payload: { name: 'Zu viel', scopes: ['reservation:read', 'platform:accounts'] } })
    expect(r.statusCode).toBe(422)
    expect(r.body).toContain('platform:accounts')
  })

  it('nimmt keinen erfundenen Zugriffsbereich', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(admin.sessionId),
      payload: { name: 'Erfunden', scopes: ['reservation:fliegen'] } })
    expect(r.statusCode).toBe(422)
  })

  it('weist ein Haus ab, das dem Account nicht gehoert', async () => {
    const fremd = await makeProperty(owner, { code: 'FREMD' })
    const r = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(admin.sessionId),
      payload: { name: 'Fremd', scopes: ['reservation:read'],
                 propertyIds: [fremd.propertyId] } })
    expect(r.statusCode).toBe(404)
  })

  it('sieht die Zugaenge eines fremden Accounts nicht', async () => {
    const fremd = await makeProperty(owner, { code: 'ANDERS' })
    await owner.query(
      `INSERT INTO oauth_client (account_id, name, secret_hash, scopes)
       VALUES ($1,'Fremd','x','{}')`, [fremd.accountId])

    const liste = await app.inject({
      method: 'GET', url: '/v1/oauth-clients', headers: auth(admin.sessionId) })
    expect((json(liste) as unknown as { clients: unknown[] }).clients).toHaveLength(0)
  })
})
