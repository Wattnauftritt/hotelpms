import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { hashToken } from '@hotelpms/domain'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { hashPassword } from '../routes/auth.js'
import { limiters } from '../platform/rateLimit.js'

/*
 * H2 und M3 aus dem Sicherheitsaudit vom 19.10.2026 (Bericht in den
 * Projektdateien, security/audit-2026-10-19.md): beides am Personenwechsel
 * per Arbeitsplatz-PIN. Jeder Fall hier lief vor der Behebung anders aus.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture

const KENNWORT = 'ein-ordentlich-langes-kennwort'
const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  // Genug Verbindungen, dass parallele Anfragen wirklich gleichzeitig laufen.
  const built = await buildServer({ pool: appPool(20) })
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
})

async function person(email: string, pin: string, roleKey = 'reception') {
  const u = await makeUser(owner, { email, propertyId: fx.propertyId, roleKey })
  await owner.query(
    `UPDATE app_user SET password_hash = $2, workstation_pin_hash = $3,
                         workstation_pin_set_at = now()
      WHERE id = $1`, [u.userId, await hashPassword(KENNWORT), await hashPassword(pin)])
  return u
}

const wechseln = (sessionId: string, email: string, pin: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/workstation-switch',
               headers: auth(sessionId), payload: { email, pin } })

async function ich(sessionId: string): Promise<{ status: number; email?: string }> {
  const r = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(sessionId) })
  return { status: r.statusCode,
           email: r.statusCode === 200 ? (r.json() as { email: string }).email : undefined }
}

describe('H2: PIN-Sperre unter parallelen Anfragen', () => {
  /**
   * Vorher pruefte die Route die Sperre in JavaScript, rechnete Argon2 und
   * zaehlte erst danach; gleichzeitige Anfragen kamen alle an der Sperre
   * vorbei. Nachgestellt: 6 Wellen zu 41 Anfragen, 205 davon ausgewertet.
   */
  it('wertet je Sperrfenster hoechstens fuenf Versuche aus, auch parallel', async () => {
    const tresen = await person('tag@test.de', '1111')
    const direktion = await person('direktion@test.de', '4711', 'hotel_director')

    let ausgewertet = 0
    for (let welle = 0; welle < 3; welle++) {
      const antworten = await Promise.all(Array.from({ length: 41 }, (_, i) =>
        wechseln(tresen.sessionId, 'direktion@test.de', String(1000 + welle * 41 + i))))
      for (const r of antworten) {
        expect(r.statusCode).toBe(401)
        const code = (r.json() as { code: string }).code
        expect(['auth.badPin', 'auth.tooManyAttempts']).toContain(code)
        if (code === 'auth.badPin') ausgewertet++
      }
    }
    expect(ausgewertet).toBeLessThanOrEqual(5)

    // Die Sperre steht noch: kein spaeter Fehlversuch hat sie aufgehoben.
    const z = await owner.query<{ gesperrt: boolean }>(
      `SELECT workstation_pin_locked_until > now() AS gesperrt
         FROM app_user WHERE id = $1`, [direktion.userId])
    expect(z.rows[0]!.gesperrt).toBe(true)
    const richtig = await wechseln(tresen.sessionId, 'direktion@test.de', '4711')
    expect((richtig.json() as { code: string }).code).toBe('auth.tooManyAttempts')
    expect((await ich(tresen.sessionId)).email).toBe('tag@test.de')
  })

  it('laesst den richtigen PIN unter den ersten fuenf durch und setzt zurueck', async () => {
    const tresen = await person('tag@test.de', '1111')
    const nacht = await person('nacht@test.de', '4711')
    for (let i = 0; i < 4; i++) await wechseln(tresen.sessionId, 'nacht@test.de', '0000')
    expect((await wechseln(tresen.sessionId, 'nacht@test.de', '4711')).statusCode).toBe(200)
    const z = await owner.query<{ n: number; gesperrt: boolean }>(
      `SELECT workstation_pin_failed_count AS n,
              workstation_pin_locked_until IS NOT NULL AS gesperrt
         FROM app_user WHERE id = $1`, [nacht.userId])
    expect(z.rows[0]).toEqual({ n: 0, gesperrt: false })
  })
})

describe('M3: Personenwechsel endet mit den Sitzungen des Gewechselten', () => {
  /** Tresensitzung von `tag`, per PIN auf `nacht` gewechselt. */
  async function gewechselt() {
    const tresen = await person('tag@test.de', '1111')
    const nacht = await person('nacht@test.de', '4711')
    expect((await wechseln(tresen.sessionId, 'nacht@test.de', '4711')).statusCode).toBe(200)
    expect((await ich(tresen.sessionId)).email).toBe('nacht@test.de')
    return { tresen, nacht }
  }

  it('Kennwortwechsel beendet den Wechsel, die Tresensitzung gehoert wieder dem Inhaber', async () => {
    const { tresen, nacht } = await gewechselt()
    const r = await app.inject({ method: 'POST', url: '/v1/auth/password',
      headers: auth(nacht.sessionId),
      payload: { currentPassword: KENNWORT, newPassword: 'ein-ganz-neues-kennwort-2026' } })
    expect(r.statusCode, r.body).toBe(200)
    expect(await ich(tresen.sessionId)).toEqual({ status: 200, email: 'tag@test.de' })
  })

  it('Kennwortwechsel aus der gewechselten Sitzung selbst laesst sie stehen', async () => {
    const { tresen } = await gewechselt()
    const r = await app.inject({ method: 'POST', url: '/v1/auth/password',
      headers: auth(tresen.sessionId),
      payload: { currentPassword: KENNWORT, newPassword: 'ein-ganz-neues-kennwort-2026' } })
    expect(r.statusCode, r.body).toBe(200)
    expect((await ich(tresen.sessionId)).email).toBe('nacht@test.de')
  })

  it('Kennwortruecksetzung beendet den Wechsel', async () => {
    const { tresen, nacht } = await gewechselt()
    await owner.query(
      `INSERT INTO auth_token (user_id, kind, token_hash, expires_at)
       VALUES ($1, 'password_reset', $2, now() + interval '1 hour')`,
      [nacht.userId, hashToken('ruecksetz-token')])
    const r = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm',
      payload: { token: 'ruecksetz-token', password: 'ein-ganz-neues-kennwort-2026' } })
    expect(r.statusCode, r.body).toBe(200)
    expect((await ich(tresen.sessionId)).email).toBe('tag@test.de')
  })

  it('ein neuer PIN beendet den Wechsel', async () => {
    const { tresen, nacht } = await gewechselt()
    const r = await app.inject({ method: 'POST', url: '/v1/auth/workstation-pin',
      headers: auth(nacht.sessionId), payload: { password: KENNWORT, pin: '9876' } })
    expect(r.statusCode, r.body).toBe(200)
    expect((await ich(tresen.sessionId)).email).toBe('tag@test.de')
  })

  it('Sperren im Betrieb beendet den Wechsel', async () => {
    const { tresen, nacht } = await gewechselt()
    const direktion = await makeUser(owner, { email: 'direktion@test.de',
      propertyId: fx.propertyId, roleKey: 'hotel_director' })
    const ref = (await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM app_user WHERE id = $1`, [nacht.userId])).rows[0]!.public_ref
    const r = await app.inject({ method: 'POST',
      url: `/v1/properties/${fx.propertyId}/users/${ref}/block`,
      headers: auth(direktion.sessionId) })
    expect(r.statusCode, r.body).toBe(200)
    expect((await ich(tresen.sessionId)).email).toBe('tag@test.de')
  })

  it('Stilllegen durch die Plattform beendet auch die eigene, gewechselte Tresensitzung', async () => {
    const admin = await makeUser(owner, { email: 'admin@wir.de',
      platformRoleKey: 'platform_admin', isPlatformStaff: true })
    // Ein Plattformmitarbeiter mit Hausrolle, dessen Tresensitzung auf einen
    // Kollegen gewechselt ist. Der Status allein haelt sie nicht an.
    const tresen = await makeUser(owner, { email: 'ops@wir.de', propertyId: fx.propertyId,
      roleKey: 'reception', isPlatformStaff: true })
    await owner.query(`UPDATE app_user SET workstation_pin_hash = $2 WHERE id = $1`,
      [tresen.userId, await hashPassword('1111')])
    await person('nacht@test.de', '4711')
    expect((await wechseln(tresen.sessionId, 'nacht@test.de', '4711')).statusCode).toBe(200)

    const r = await app.inject({ method: 'POST',
      url: `/v1/platform/staff/${tresen.userId}/status`,
      headers: auth(admin.sessionId), payload: { status: 'disabled' } })
    expect(r.statusCode, r.body).toBe(200)
    expect((await ich(tresen.sessionId)).status).toBe(401)
  })
})
