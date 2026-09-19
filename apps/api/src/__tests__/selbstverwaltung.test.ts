import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { loadPrincipal } from '../platform/auth.js'

/**
 * Der Kunde verwaltet sein Personal selbst.
 *
 * Geprueft wird vor allem die Grenze: so autark wie moeglich, so
 * eingeschraenkt wie noetig. Eine Hoteldirektion legt Rezeption an und
 * sperrt sie -- aber nicht den Inhaber. Der Inhaber vergibt Betriebsrollen
 * -- aber nicht so, dass niemand mehr uebrig ist, der den Betrieb
 * verwaltet. Und eine Sperre bei dem einen Kunden nimmt dem anderen nichts.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let direktion: { userId: number; sessionId: string }
let inhaber: { userId: number; sessionId: string }
let rezeption: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

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
  fx = await makeProperty(owner, { name: 'Wattenblick' })
  direktion = await makeUser(owner, { email: 'direktion@kunde.de',
    propertyId: fx.propertyId, roleKey: 'hotel_director' })
  inhaber = await makeUser(owner, { email: 'inhaber@kunde.de',
    accountId: fx.accountId, roleKey: 'owner' })
  rezeption = await makeUser(owner, { email: 'rezeption@kunde.de',
    propertyId: fx.propertyId, roleKey: 'reception' })
})

const ref = async (userId: number): Promise<string> =>
  (await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM app_user WHERE id = $1`, [userId])).rows[0]!.public_ref

const post = (url: string, session: string, payload?: unknown) =>
  app.inject({ method: 'POST', url: `/v1/properties/${fx.propertyId}${url}`,
    headers: auth(session), payload })
const liste = (session: string) =>
  app.inject({ method: 'GET', url: `/v1/properties/${fx.propertyId}/users`,
    headers: auth(session) })

describe('Einladen', () => {
  it('legt einen Benutzer mit Hausrollen an und laedt ihn ein', async () => {
    const r = await post('/users', direktion.sessionId, { email: 'neu@kunde.de',
      displayName: 'Neue Rezeption', roleKeys: ['reception'] })
    expect(r.statusCode).toBe(201)
    const u = await owner.query<{ id: number; status: string; password_hash: string | null }>(
      `SELECT id, status, password_hash FROM app_user WHERE email = 'neu@kunde.de'`)
    expect(u.rows[0]!.status).toBe('invited')
    // Kein Kennwort: das setzt die Person selbst ueber den Link.
    expect(u.rows[0]!.password_hash).toBeNull()
    const t = await owner.query(`SELECT 1 FROM auth_token WHERE user_id = $1 AND kind = 'invite'`,
      [u.rows[0]!.id])
    expect(t.rowCount).toBe(1)
    // Und sie steht in der Liste, mit ihrer Rolle.
    const d = (await liste(direktion.sessionId)).json() as
      { users: Array<{ email: string; roles: Array<{ key: string }> }> }
    expect(d.users.find(x => x.email === 'neu@kunde.de')?.roles.map(x => x.key))
      .toEqual(['reception'])
  })

  it('weist eine vergebene Adresse ab, ohne zu verraten, wem sie gehoert', async () => {
    const fremd = await makeProperty(owner, { name: 'Anderer', code: 'AND' })
    await makeUser(owner, { email: 'jemand@anderswo.de',
      propertyId: fremd.propertyId, roleKey: 'reception' })
    const eigen = await post('/users', direktion.sessionId, { email: 'rezeption@kunde.de',
      displayName: 'X', roleKeys: ['reception'] })
    const anders = await post('/users', direktion.sessionId, { email: 'jemand@anderswo.de',
      displayName: 'X', roleKeys: ['reception'] })
    expect(eigen.statusCode).toBe(409)
    expect(anders.statusCode).toBe(409)
    // Derselbe Satz fuer beide Faelle. Unterschiede verrieten, wer Kunde ist.
    expect((eigen.json() as { code: string }).code)
      .toBe((anders.json() as { code: string }).code)
  })

  it('verlangt mindestens eine Rolle und nur Hausrollen', async () => {
    expect((await post('/users', direktion.sessionId, { email: 'a@kunde.de',
      displayName: 'A', roleKeys: [] })).statusCode).toBe(422)
    // Eine Betriebsrolle ueber die Hausroute: der Weg, auf dem die Direktion
    // sich einen zweiten Inhaber baut.
    expect((await post('/users', direktion.sessionId, { email: 'b@kunde.de',
      displayName: 'B', roleKeys: ['owner'] })).statusCode).toBe(422)
  })

  it('bleibt der Rezeption verschlossen', async () => {
    expect((await post('/users', rezeption.sessionId, { email: 'c@kunde.de',
      displayName: 'C', roleKeys: ['reception'] })).statusCode).toBe(403)
  })
})

describe('Sperren bei diesem Betrieb', () => {
  it('nimmt den Zugriff, laesst die Rollen stehen und beendet Sitzungen', async () => {
    const r = await post(`/users/${await ref(rezeption.userId)}/block`, direktion.sessionId)
    expect(r.statusCode).toBe(200)
    expect((r.json() as { sessionsRevoked: number }).sessionsRevoked).toBe(1)

    const p = await loadPrincipal(pool, rezeption.userId)
    expect([...p.permissionsByProperty.keys()]).toEqual([])
    const rollen = await owner.query(
      `SELECT 1 FROM user_property_role WHERE user_id = $1`, [rezeption.userId])
    expect(rollen.rowCount).toBe(1)
    // Die Liste zeigt es.
    const d = (await liste(direktion.sessionId)).json() as
      { users: Array<{ email: string; blocked: boolean }> }
    expect(d.users.find(x => x.email === 'rezeption@kunde.de')?.blocked).toBe(true)
  })

  it('gibt mit dem Entsperren alles zurueck', async () => {
    const r = await ref(rezeption.userId)
    await post(`/users/${r}/block`, direktion.sessionId)
    await post(`/users/${r}/unblock`, direktion.sessionId)
    const p = await loadPrincipal(pool, rezeption.userId)
    expect([...p.permissionsByProperty.keys()]).toEqual([fx.propertyId])
  })

  it('nimmt einem anderen Kunden nichts weg', async () => {
    /*
     * Die Aushilfe in zwei Betrieben: der eine sperrt, der andere merkt
     * nichts. Das ist der Grund, warum die Sperre am Paar haengt und nicht
     * an app_user.status.
     */
    const fremd = await makeProperty(owner, { name: 'Anderer', code: 'AND' })
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'reception' AND account_id IS NULL`,
      [rezeption.userId, fremd.propertyId])
    await post(`/users/${await ref(rezeption.userId)}/block`, direktion.sessionId)
    const p = await loadPrincipal(pool, rezeption.userId)
    expect([...p.permissionsByProperty.keys()]).toEqual([fremd.propertyId])
    const u = await owner.query<{ status: string }>(
      `SELECT status FROM app_user WHERE id = $1`, [rezeption.userId])
    expect(u.rows[0]!.status).toBe('active')
  })

  it('laesst die Direktion den Inhaber nicht sperren', async () => {
    // Sonst sperrt die Leitung eines Hauses den, dem der Betrieb gehoert.
    const r = await post(`/users/${await ref(inhaber.userId)}/block`, direktion.sessionId)
    expect(r.statusCode).toBe(403)
  })

  it('laesst niemanden sich selbst sperren', async () => {
    const r = await post(`/users/${await ref(direktion.userId)}/block`, direktion.sessionId)
    expect(r.statusCode).toBe(409)
  })

  /*
   * Die Sperre "letzter Verwalter" ist ueber diese Route fuer einen
   * Verwalter als Aufrufer nicht erreichbar: er selbst ist der andere, und
   * sich selbst sperrt er nicht. Wer ohne settings:account kommt, scheitert
   * frueher an der Betriebsrolle des Ziels (403). Sie steht in der Route
   * fuer den Tag, an dem eine dritte Ebene dazukommt -- geprueft wird hier,
   * dass sie da ist, nicht ein Umweg, der so tut, als gaebe es die schon.
   */
  it('haelt die Sperre fuer den letzten Verwalter bereit', async () => {
    const fs = await import('node:fs')
    const quelle = fs.readFileSync(new URL('../routes/userAdmin.ts', import.meta.url), 'utf8')
    expect(quelle).toContain('nichtDenLetztenVerwalter')
    expect(quelle).toMatch(/user\.lastAccountAdmin/)
  })
})

describe('Entfernen', () => {
  it('nimmt alle Rollen im Betrieb und legt einen Zugang ohne Betrieb still', async () => {
    const r = await app.inject({ method: 'DELETE',
      url: `/v1/properties/${fx.propertyId}/users/${await ref(rezeption.userId)}`,
      headers: auth(direktion.sessionId) })
    expect(r.statusCode).toBe(200)
    const rollen = await owner.query(
      `SELECT 1 FROM user_property_role WHERE user_id = $1`, [rezeption.userId])
    expect(rollen.rowCount).toBe(0)
    // Der Benutzer bleibt (das Protokoll verweist auf ihn), aber still.
    const u = await owner.query<{ status: string }>(
      `SELECT status FROM app_user WHERE id = $1`, [rezeption.userId])
    expect(u.rows[0]!.status).toBe('disabled')
    expect((await liste(direktion.sessionId)).json<{ users: Array<{ email: string }> }>()
      .users.map(x => x.email)).not.toContain('rezeption@kunde.de')
  })

  it('laesst einen Benutzer mit anderem Betrieb aktiv', async () => {
    const fremd = await makeProperty(owner, { name: 'Anderer', code: 'AND' })
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'reception' AND account_id IS NULL`,
      [rezeption.userId, fremd.propertyId])
    await app.inject({ method: 'DELETE',
      url: `/v1/properties/${fx.propertyId}/users/${await ref(rezeption.userId)}`,
      headers: auth(direktion.sessionId) })
    const u = await owner.query<{ status: string }>(
      `SELECT status FROM app_user WHERE id = $1`, [rezeption.userId])
    expect(u.rows[0]!.status).toBe('active')
    const p = await loadPrincipal(pool, rezeption.userId)
    expect([...p.permissionsByProperty.keys()]).toEqual([fremd.propertyId])
  })

  it('laesst die Direktion den Inhaber nicht entfernen', async () => {
    const r = await app.inject({ method: 'DELETE',
      url: `/v1/properties/${fx.propertyId}/users/${await ref(inhaber.userId)}`,
      headers: auth(direktion.sessionId) })
    expect(r.statusCode).toBe(403)
  })
})

describe('Betriebsrollen', () => {
  const setzen = (userRef: string, roleKeys: string[], session: string) =>
    app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/users/${userRef}/account-roles`,
      headers: auth(session), payload: { roleKeys } })

  it('vergibt der Inhaber, nicht die Direktion', async () => {
    const r = await ref(rezeption.userId)
    expect((await setzen(r, ['accounting'], direktion.sessionId)).statusCode).toBe(403)
    expect((await setzen(r, ['accounting'], inhaber.sessionId)).statusCode).toBe(200)
    const p = await loadPrincipal(pool, rezeption.userId)
    expect(p.accountPermissions.has('report:export')).toBe(true)
  })

  it('nimmt keine Hausrolle als Betriebsrolle', async () => {
    expect((await setzen(await ref(rezeption.userId), ['reception'], inhaber.sessionId))
      .statusCode).toBe(422)
  })

  it('laesst den Inhaber sich nicht selbst das Verwaltungsrecht nehmen', async () => {
    expect((await setzen(await ref(inhaber.userId), ['accounting'], inhaber.sessionId))
      .statusCode).toBe(409)
  })

  it('laesst den letzten Verwalter nicht herabstufen', async () => {
    const zweiter = await makeUser(owner, { email: 'inhaber2@kunde.de',
      accountId: fx.accountId, roleKey: 'owner' })
    // zweiter stuft inhaber herab: geht, zweiter bleibt.
    expect((await setzen(await ref(inhaber.userId), [], zweiter.sessionId)).statusCode).toBe(200)
    // inhaber hat kein settings:account mehr und darf gar nicht mehr.
    expect((await setzen(await ref(zweiter.userId), [], inhaber.sessionId)).statusCode).toBe(403)
  })

  it('liefert die Betriebsrollen mit ihren Rechten', async () => {
    const r = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/account-roles`, headers: auth(inhaber.sessionId) })
    expect(r.statusCode).toBe(200)
    const d = r.json() as { roles: Array<{ key: string; level: string }> }
    expect(d.roles.every(x => x.level === 'account')).toBe(true)
    expect(d.roles.map(x => x.key)).toContain('owner')
    expect((await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/account-roles`,
      headers: auth(direktion.sessionId) })).statusCode).toBe(403)
  })
})

describe('Die kleinen Handgriffe', () => {
  it('schickt einen Link, entsperrt und benennt um', async () => {
    const r = await ref(rezeption.userId)
    await owner.query(
      `UPDATE app_user SET failed_login_count = 5, locked_until = now() + interval '20 min'
        WHERE id = $1`, [rezeption.userId])
    const vorher = (await liste(direktion.sessionId)).json() as
      { users: Array<{ email: string; lockedUntil: string | null }> }
    expect(vorher.users.find(x => x.email === 'rezeption@kunde.de')?.lockedUntil).not.toBeNull()

    expect((await post(`/users/${r}/unlock`, direktion.sessionId)).statusCode).toBe(200)
    const link = await post(`/users/${r}/access-link`, direktion.sessionId)
    expect(link.statusCode).toBe(202)
    expect((link.json() as { kind: string }).kind).toBe('password_reset')
    expect(link.body).not.toMatch(/token|http/i)

    const name = await app.inject({ method: 'PATCH',
      url: `/v1/properties/${fx.propertyId}/users/${r}`,
      headers: auth(direktion.sessionId), payload: { displayName: 'Frau Rezeption' } })
    expect(name.statusCode).toBe(200)
    const u = await owner.query<{ display_name: string; locked_until: string | null }>(
      `SELECT display_name, locked_until FROM app_user WHERE id = $1`, [rezeption.userId])
    expect(u.rows[0]!.display_name).toBe('Frau Rezeption')
    expect(u.rows[0]!.locked_until).toBeNull()
  })

  it('schickt einem Gesperrten keinen Link', async () => {
    const r = await ref(rezeption.userId)
    await post(`/users/${r}/block`, direktion.sessionId)
    expect((await post(`/users/${r}/access-link`, direktion.sessionId)).statusCode).toBe(409)
  })

  it('kennt in der Liste den eigenen Eintrag', async () => {
    const d = (await liste(direktion.sessionId)).json() as
      { users: Array<{ email: string; isSelf: boolean; accountRoles: unknown[] }> }
    expect(d.users.find(x => x.email === 'direktion@kunde.de')?.isSelf).toBe(true)
    expect(d.users.find(x => x.email === 'rezeption@kunde.de')?.isSelf).toBe(false)
    // Der Inhaber steht in der Liste, obwohl er im Haus keine Hausrolle hat.
    expect(d.users.find(x => x.email === 'inhaber@kunde.de')?.accountRoles).toHaveLength(1)
  })
})
