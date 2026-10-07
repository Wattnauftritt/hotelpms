import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Personal ohne Mailadresse (Migration 0105, Baustein 1 der Personal-App).
 *
 * Geprueft wird, dass eine Reinigungskraft ohne Postfach eingeladen werden,
 * ihr Kennwort ueber einen weitergegebenen Link setzen und sich mit dem
 * Benutzernamen anmelden kann -- und vor allem die Grenze: den Link zum
 * Weitergeben gibt es nur, wo der Aufrufende den Zugang ohnehin vergibt.
 * Bei einem benutzten Zugang mit Adresse waere er der Weg, ihn zu
 * uebernehmen.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let direktion: { userId: number; sessionId: string }

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
  limiters.reset()
  fx = await makeProperty(owner, { name: 'Seerobbe' })
  direktion = await makeUser(owner, { email: 'direktion@kunde.de',
    propertyId: fx.propertyId, roleKey: 'hotel_director' })
})

const einladen = (payload: unknown, session = direktion.sessionId) =>
  app.inject({ method: 'POST', url: `/v1/properties/${fx.propertyId}/users`,
    headers: auth(session), payload })

const zugangslink = (userRef: string, payload?: unknown) =>
  app.inject({ method: 'POST',
    url: `/v1/properties/${fx.propertyId}/users/${userRef}/access-link`,
    headers: auth(direktion.sessionId), payload })

const tokenAus = (link: string): string => new URL(link).searchParams.get('token')!

describe('Einladen ohne Mailadresse', () => {
  it('legt den Zugang mit Benutzernamen an und gibt den Link zurueck, statt zu mailen', async () => {
    const r = await einladen({ username: 'Anna.K', displayName: 'Anna',
      roleKeys: ['housekeeping_staff'] })
    expect(r.statusCode).toBe(201)
    const b = r.json()
    expect(b.username).toBe('anna.k')
    expect(b.email).toBeNull()
    expect(b.delivery).toBe('link')
    expect(b.link).toMatch(/\/einladung\?token=/)
    expect(Date.parse(b.linkExpiresAt)).toBeGreaterThan(Date.now())

    const u = await owner.query<{ email: string | null; username: string; status: string }>(
      `SELECT email, username, status FROM app_user WHERE username = 'anna.k'`)
    expect(u.rows[0]).toEqual({ email: null, username: 'anna.k', status: 'invited' })
    // Keine Post: es gibt keine Adresse, an die sie gehen koennte.
    const post = await owner.query(`SELECT 1 FROM platform_email`)
    expect(post.rowCount).toBe(0)
  })

  it('weist eine Einladung ohne Adresse und ohne Benutzernamen ab', async () => {
    const r = await einladen({ displayName: 'Niemand', roleKeys: ['kitchen'] })
    expect(r.statusCode).toBe(422)
    expect(r.json().errorKeys.username).toContain('user.needsEmailOrUsername')
  })

  it('weist Mailversand ohne Mailadresse ab', async () => {
    const r = await einladen({ username: 'olga', displayName: 'Olga',
      roleKeys: ['kitchen'], delivery: 'email' })
    expect(r.statusCode).toBe(422)
    expect(r.json().errorKeys.delivery).toContain('user.noEmailForMail')
  })

  it('weist einen Benutzernamen in falscher Form ab', async () => {
    for (const username of ['ab', 'anna@k', 'Anna K', '-anna']) {
      const r = await einladen({ username, displayName: 'Anna', roleKeys: ['kitchen'] })
      expect(r.statusCode, username).toBe(422)
      expect(r.json().errorKeys.username, username).toContain('field.username')
    }
  })

  it('meldet einen Benutzernamen eines anderen Kunden als vergeben, ohne mehr zu verraten', async () => {
    const nachbar = await makeProperty(owner, { name: 'Nachbarhaus' })
    const chef = await makeUser(owner, { email: 'chef@nachbar.de',
      propertyId: nachbar.propertyId, roleKey: 'hotel_director' })
    const r1 = await app.inject({ method: 'POST', url: `/v1/properties/${nachbar.propertyId}/users`,
      headers: auth(chef.sessionId),
      payload: { username: 'olga', displayName: 'Olga', roleKeys: ['kitchen'] } })
    expect(r1.statusCode).toBe(201)

    const r2 = await einladen({ username: 'olga', displayName: 'Olga', roleKeys: ['kitchen'] })
    expect(r2.statusCode).toBe(409)
    expect(r2.json().code).toBe('user.usernameTaken')
  })

  it('gibt einer bekannten Kraft aus dem eigenen Betrieb die Rollen dazu', async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name, address_line1, postal_code, city, country)
       VALUES ($1, 'GH', 'Gaestehaus', 'Deich 2', '27472', 'Cuxhaven', 'DE')
       RETURNING id`, [fx.accountId])
    const r1 = await einladen({ username: 'olga', displayName: 'Olga', roleKeys: ['kitchen'] })
    expect(r1.statusCode).toBe(201)
    // Inhaberrecht, damit das zweite Haus fuer den Einladenden erreichbar ist.
    const inhaber = await makeUser(owner, { email: 'inhaber@kunde.de',
      accountId: fx.accountId, roleKey: 'owner' })
    const r2 = await app.inject({ method: 'POST',
      url: `/v1/properties/${zweites.rows[0]!.id}/users`, headers: auth(inhaber.sessionId),
      payload: { username: 'olga', displayName: 'Olga', roleKeys: ['housekeeping_staff'] } })
    expect(r2.statusCode).toBe(200)
    expect(r2.json().addedToProperty).toBe(true)
    // Eine Person, nicht zwei.
    const n = await owner.query(`SELECT 1 FROM app_user WHERE username = 'olga'`)
    expect(n.rowCount).toBe(1)
  })
})

describe('Link einloesen und mit Benutzernamen anmelden', () => {
  it('setzt das Kennwort ueber den Link und meldet mit dem Benutzernamen an', async () => {
    const r = await einladen({ username: 'anna.k', displayName: 'Anna',
      roleKeys: ['housekeeping_staff'] })
    const token = tokenAus(r.json().link)
    const setzen = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm',
      payload: { token, password: 'sicheres-Kennwort-42' } })
    expect(setzen.statusCode).toBe(200)

    // Gross geschrieben eingetippt: das Handy macht den ersten Buchstaben gross.
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login',
      payload: { login: 'Anna.K', password: 'sicheres-Kennwort-42' } })
    expect(login.statusCode).toBe(200)
    const cookie = login.cookies.find(c => c.name === 'hp_session')!.value

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(cookie) })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ username: 'anna.k', email: '', locale: null })
    const haus = me.json().properties.find((p: { id: number }) => p.id === fx.propertyId)
    expect(haus.permissions).toContain('staff:app')
    // Die Reinigung sieht nicht den ganzen Tagesplan des Hauses.
    expect(haus.permissions).not.toContain('housekeeping:read')
  })

  it('nimmt beim alten Feld `email` weiter die Mailadresse', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/auth/login',
      payload: { email: 'direktion@kunde.de', password: 'falsch-falsch-falsch' } })
    // Kein Kennwort gesetzt -- es geht um die Form der Anfrage, nicht ums Durchkommen.
    expect(r.statusCode).toBe(401)
    expect(r.json().code).toBe('auth.badCredentials')
  })
})

describe('Zugangslink zum Weitergeben', () => {
  const refVon = async (where: string): Promise<string> =>
    (await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM app_user WHERE ${where}`)).rows[0]!.public_ref

  it('gibt fuer einen Zugang ohne Adresse einen neuen Kennwort-Link heraus', async () => {
    await einladen({ username: 'anna.k', displayName: 'Anna', roleKeys: ['housekeeping_staff'] })
    await owner.query(`UPDATE app_user SET status = 'active' WHERE username = 'anna.k'`)
    const r = await zugangslink(await refVon(`username = 'anna.k'`))
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ kind: 'password_reset', delivery: 'link' })
    expect(r.json().link).toMatch(/\/kennwort\?token=/)
  })

  it('verweigert den Link fuer einen benutzten Zugang mit Mailadresse', async () => {
    const rezeption = await makeUser(owner, { email: 'rezeption@kunde.de',
      propertyId: fx.propertyId, roleKey: 'reception' })
    const r = await zugangslink(await refVon(`id = ${rezeption.userId}`), { delivery: 'link' })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('user.linkOnlyWithoutEmail')
    const t = await owner.query(`SELECT 1 FROM auth_token WHERE user_id = $1`,
      [rezeption.userId])
    expect(t.rowCount).toBe(0)
  })

  it('erlaubt den Link bei einer offenen Einladung mit Adresse', async () => {
    const r1 = await einladen({ email: 'neu@kunde.de', displayName: 'Neu',
      roleKeys: ['reception'] })
    expect(r1.statusCode).toBe(201)
    expect(r1.json().delivery).toBe('email')
    expect(r1.json().link).toBeUndefined()
    const r2 = await zugangslink(r1.json().userRef, { delivery: 'link' })
    expect(r2.statusCode).toBe(200)
    expect(r2.json().kind).toBe('invite')
  })

  it('schickt ohne Angabe weiter per Mail, wenn es eine Adresse gibt', async () => {
    const rezeption = await makeUser(owner, { email: 'rezeption@kunde.de',
      propertyId: fx.propertyId, roleKey: 'reception' })
    const r = await zugangslink(await refVon(`id = ${rezeption.userId}`))
    expect(r.statusCode).toBe(202)
    expect(r.json()).toMatchObject({ kind: 'password_reset', delivery: 'email' })
    expect(r.json().link).toBeUndefined()
  })
})

describe('Eigene Sprache', () => {
  it('haelt die Sprache am Benutzer fest und weist Unbekanntes ab', async () => {
    const gut = await app.inject({ method: 'PUT', url: '/v1/auth/locale',
      headers: auth(direktion.sessionId), payload: { locale: 'uk' } })
    expect(gut.statusCode).toBe(200)
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me',
      headers: auth(direktion.sessionId) })
    expect(me.json().locale).toBe('uk')

    const schlecht = await app.inject({ method: 'PUT', url: '/v1/auth/locale',
      headers: auth(direktion.sessionId), payload: { locale: 'fr' } })
    expect(schlecht.statusCode).toBe(422)

    const anonym = await app.inject({ method: 'PUT', url: '/v1/auth/locale',
      payload: { locale: 'de' } })
    expect(anonym.statusCode).toBe(401)
  })
})

describe('Protokoll', () => {
  it('schreibt den Benutzernamen nicht ins Protokoll', async () => {
    await einladen({ username: 'anna.k', displayName: 'Anna', roleKeys: ['kitchen'] })
    const a = await owner.query<{ changed: unknown }>(
      `SELECT changed FROM audit_log WHERE table_name = 'app_user'`)
    expect(a.rowCount).toBeGreaterThan(0)
    expect(JSON.stringify(a.rows)).not.toContain('anna.k')
  })
})
