import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { hashPassword } from '../routes/auth.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Sitzungen der eigenen App (Migration 0191, Plan app/plan.md).
 *
 * Festgehalten wird, was die App braucht und was der Browser dabei nicht
 * verliert: ein Token statt eines Cookies, dieselbe Sitzung dahinter, und
 * keine Sitzung, die auf dem jeweils anderen Weg traegt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture

const KENNWORT = 'ein-ordentlich-langes-kennwort'

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(6) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  limiters.reset()
  const u = await makeUser(owner,
    { email: 'rezeption@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  await owner.query(`UPDATE app_user SET password_hash = $2 WHERE id = $1`,
    [u.userId, await hashPassword(KENNWORT)])
})

async function appAnmelden(): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/login',
    payload: { login: 'rezeption@test.de', password: KENNWORT, client: 'app' } })
  expect(r.statusCode).toBe(200)
  // Kein Cookie: die App bekaeme es unter ihrer Herkunft ohnehin nicht.
  expect(r.headers['set-cookie']).toBeUndefined()
  const { token } = r.json() as { token: string }
  expect(token).toMatch(/^sga_[A-Za-z0-9_-]{43}$/)
  return token
}

const ich = (headers: Record<string, string>) =>
  app.inject({ method: 'GET', url: '/v1/auth/me', headers })

describe('Sitzung der App', () => {
  it('gibt ein Token aus, das als Bearer traegt', async () => {
    const token = await appAnmelden()
    const me = await ich({ authorization: `Bearer ${token}` })
    expect(me.statusCode).toBe(200)

    const zeile = await owner.query<{ client: string }>(
      `SELECT client FROM user_session WHERE id = $1`, [token])
    expect(zeile.rows[0]?.client).toBe('app')
  })

  it('bleibt laenger angemeldet als der Browser, aber nicht unbegrenzt', async () => {
    const token = await appAnmelden()
    const web = await app.inject({ method: 'POST', url: '/v1/auth/login',
      payload: { login: 'rezeption@test.de', password: KENNWORT } })
    const cookie = String(web.headers['set-cookie']).split(';')[0]!.split('=')[1]!
    const { rows } = await owner.query<{ id: string; idle: number; absolut: number }>(
      `SELECT id, extract(epoch FROM idle_window) / 86400 AS idle,
              round(extract(epoch FROM absolute_expires_at - created_at) / 86400) AS absolut
         FROM user_session WHERE id = ANY($1)`, [[token, cookie]])
    const je = Object.fromEntries(rows.map(r => [r.id, [Number(r.idle), Number(r.absolut)]]))
    expect(je[token]).toEqual([30, 180])
    expect(je[cookie]).toEqual([7, 30])
  })

  it('traegt nicht als Cookie, und eine Browsersitzung nicht als Token', async () => {
    const token = await appAnmelden()
    expect((await ich({ cookie: `hp_session=${token}` })).statusCode).toBe(401)

    const web = await app.inject({ method: 'POST', url: '/v1/auth/login',
      payload: { login: 'rezeption@test.de', password: KENNWORT } })
    const cookie = String(web.headers['set-cookie']).split(';')[0]!
    const id = cookie.slice('hp_session='.length)
    expect((await ich({ cookie })).statusCode).toBe(200)
    expect((await ich({ authorization: `Bearer ${id}` })).statusCode).toBe(401)
    // Auch mit vorgesetztem Anfang wird daraus kein App-Token.
    expect((await ich({ authorization: `Bearer sga_${id}` })).statusCode).toBe(401)
  })

  it('endet mit dem Abmelden', async () => {
    const token = await appAnmelden()
    const aus = await app.inject({ method: 'POST', url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${token}` }, payload: {} })
    expect(aus.statusCode).toBe(200)
    expect((await ich({ authorization: `Bearer ${token}` })).statusCode).toBe(401)
  })

  it('endet, wenn das Kennwort im Browser geaendert wird', async () => {
    const token = await appAnmelden()
    const web = await app.inject({ method: 'POST', url: '/v1/auth/login',
      payload: { login: 'rezeption@test.de', password: KENNWORT } })
    const cookie = String(web.headers['set-cookie']).split(';')[0]!
    const r = await app.inject({ method: 'POST', url: '/v1/auth/password',
      headers: { cookie },
      payload: { currentPassword: KENNWORT, newPassword: 'ein-anderes-langes-kennwort' } })
    expect(r.statusCode).toBe(200)
    expect((await ich({ authorization: `Bearer ${token}` })).statusCode).toBe(401)
    expect((await ich({ cookie })).statusCode).toBe(200)
  })
})

describe('CORS fuer die App', () => {
  it('beantwortet die Vorabfrage nur fuer die Herkuenfte von Capacitor', async () => {
    for (const origin of ['capacitor://localhost', 'https://localhost']) {
      const r = await app.inject({ method: 'OPTIONS', url: '/v1/auth/me',
        headers: { origin, 'access-control-request-method': 'GET',
                   'access-control-request-headers': 'authorization' } })
      expect(r.statusCode).toBe(204)
      expect(r.headers['access-control-allow-origin']).toBe(origin)
      expect(String(r.headers['access-control-allow-headers'])).toContain('authorization')
      // Nie mit Cookies ueber die Grenze.
      expect(r.headers['access-control-allow-credentials']).toBeUndefined()
    }

    const fremd = await app.inject({ method: 'GET', url: '/v1/auth/me',
      headers: { origin: 'https://boese.example' } })
    expect(fremd.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('legt die Kopfzeile auch an eine Antwort mit Token', async () => {
    const token = await appAnmelden()
    const r = await app.inject({ method: 'GET', url: '/v1/auth/me',
      headers: { origin: 'capacitor://localhost', authorization: `Bearer ${token}` } })
    expect(r.statusCode).toBe(200)
    expect(r.headers['access-control-allow-origin']).toBe('capacitor://localhost')
  })
})
