import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { loadPrincipal } from '../platform/auth.js'

/**
 * Das Adminpanel.
 *
 * **Was hier wirklich geprueft wird**, ist nicht, ob eine Liste zurueckkommt,
 * sondern ob sie ueberhaupt zurueckkommen *kann*: Plattformpersonal hat ohne
 * freigegebene Support-Sitzung einen leeren Mandantenkontext, und `account`
 * traegt eine erzwungene Zeilenrichtlinie. Eine Abfrage ohne
 * SECURITY-DEFINER-Funktion kaeme hier **still leer** zurueck -- kein Fehler,
 * keine Meldung, nur nichts. Genau so sind die Befunde in den Migrationen
 * 0014, 0018 und 0032 entstanden.
 *
 * Und die Gegenrichtung: ein Hotelbenutzer darf durch dieselben Funktionen
 * nichts sehen, auch wenn er die Route erreicht.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let admin: { userId: number; sessionId: string }
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
  admin = await makeUser(owner, { email: 'admin@wir.de',
    platformRoleKey: 'platform_admin', isPlatformStaff: true })
  rezeption = await makeUser(owner, { email: 'rezeption@kunde.de',
    propertyId: fx.propertyId, roleKey: 'reception' })
})

const kunden = (session: string) =>
  app.inject({ method: 'GET', url: '/v1/platform/accounts', headers: auth(session) })

const kunde = (id: number, session: string) =>
  app.inject({ method: 'GET', url: `/v1/platform/accounts/${id}`, headers: auth(session) })

const zustand = (id: number, status: string, session: string) =>
  app.inject({ method: 'POST', url: `/v1/platform/accounts/${id}/status`,
    headers: auth(session), payload: { status } })

const personal = (session: string) =>
  app.inject({ method: 'GET', url: '/v1/platform/staff', headers: auth(session) })

describe('Kundenliste', () => {
  it('kommt trotz leerem Mandantenkontext an', async () => {
    const r = await kunden(admin.sessionId)
    expect(r.statusCode).toBe(200)
    const d = r.json() as { accounts: Array<{ name: string; properties: number }> }
    expect(d.accounts).toHaveLength(1)
    expect(d.accounts[0]!.name).toBe('Wattenblick')
  })

  it('zaehlt Haeuser und Benutzer als Zahlen, nicht als Zeichenketten', async () => {
    // `count(*)` kommt als bigint aus dem Treiber. Ungewandelt steht in der
    // Oberflaeche "1" neben 1, und jede Rechnung damit ergibt Unsinn.
    const d = (await kunden(admin.sessionId)).json() as
      { accounts: Array<{ properties: number; users: number }> }
    expect(d.accounts[0]!.properties).toBe(1)
    expect(d.accounts[0]!.users).toBe(1)
  })

  it('bleibt einem Hotelbenutzer verschlossen', async () => {
    const r = await kunden(rezeption.sessionId)
    expect(r.statusCode).toBe(403)
  })

  it('nennt Haeuser und Benutzer des Kunden', async () => {
    const d = (await kunde(fx.accountId, admin.sessionId)).json() as {
      properties: Array<{ code: string; isTraining: boolean; rooms: number }>
      users: Array<{ email: string; roles: string | null }>
    }
    expect(d.properties[0]!.code).toBe('TEST')
    expect(d.properties[0]!.isTraining).toBe(false)
    expect(d.users.map(u => u.email)).toContain('rezeption@kunde.de')
    expect(d.users[0]!.roles).toContain('Rezeption')
  })

  it('gibt kein Kennwort und kein Geheimnis heraus', async () => {
    // Ein Adminpanel ist kein Zugang zu Zugangsdaten. Wer hier etwas
    // hinzufuegt, faellt ueber diesen Test.
    const roh = (await kunde(fx.accountId, admin.sessionId)).body
    expect(roh).not.toMatch(/password|totp|pin_hash|secret/i)
  })

  it('kennt einen Kunden nicht, den es nicht gibt', async () => {
    const r = await kunde(999_999, admin.sessionId)
    expect(r.statusCode).toBe(404)
  })
})

describe('Sperren', () => {
  it('nimmt dem Kunden den Zugriff, ohne seine Daten anzufassen', async () => {
    const r = await zustand(fx.accountId, 'suspended', admin.sessionId)
    expect(r.statusCode).toBe(200)
    expect((r.json() as { previous: string }).previous).toBe('active')

    /*
     * Der Kern der Sache. Bis Migration 0038 gab es die Spalte seit 0002 und
     * las sie niemand -- gesperrt haette also gar nichts gesperrt.
     */
    const p = await loadPrincipal(pool, rezeption.userId)
    expect(p.accountIds).toEqual([])
    expect([...p.permissionsByProperty.keys()]).toEqual([])

    // Die Daten bleiben: Aufbewahrungsfristen laufen weiter, und Loeschen
    // heisst in diesem System ohnehin anonymisieren.
    const haeuser = await owner.query(`SELECT 1 FROM property WHERE account_id = $1`,
      [fx.accountId])
    expect(haeuser.rowCount).toBe(1)
  })

  it('gibt den Zugriff mit dem Entsperren zurueck', async () => {
    await zustand(fx.accountId, 'suspended', admin.sessionId)
    await zustand(fx.accountId, 'active', admin.sessionId)
    const p = await loadPrincipal(pool, rezeption.userId)
    expect(p.accountIds).toEqual([fx.accountId])
  })

  it('sperrt auch die Account-Rolle, nicht nur die Haeuser', async () => {
    /*
     * Eine Account-Rolle bringt ihren Account im Aufbau des Principals
     * direkt mit, ohne Umweg ueber ein Haus. Ohne `user_account_scope`
     * bliebe die Sperre genau hier auf halbem Weg stehen.
     */
    const inhaber = await makeUser(owner, { email: 'inhaber@kunde.de',
      accountId: fx.accountId, roleKey: 'owner' })
    expect((await loadPrincipal(pool, inhaber.userId)).accountIds)
      .toEqual([fx.accountId])

    await zustand(fx.accountId, 'suspended', admin.sessionId)
    const p = await loadPrincipal(pool, inhaber.userId)
    expect(p.accountIds).toEqual([])
    expect(p.accountPermissions.size).toBe(0)
  })

  it('laesst den Support weiter herein', async () => {
    /*
     * Wer gesperrt ist, ist meist gerade der, dem geholfen werden muss. Eine
     * Sperre, die auch den Support aussperrt, macht aus einer offenen
     * Rechnung einen Totalausfall.
     */
    await zustand(fx.accountId, 'suspended', admin.sessionId)
    const r = await owner.query(`SELECT 1 FROM account_active_properties($1)`,
      [fx.accountId])
    expect(r.rowCount).toBe(1)
  })

  it('sagt dem gesperrten Kunden, warum er nichts sieht', async () => {
    /*
     * Er meldet sich weiterhin an -- gesperrt ist der Account, nicht der
     * Benutzer. Ohne diese Unterscheidung laese er "diesem Benutzer ist kein
     * Haus zugeordnet", und der Anruf am Montagmorgen ginge ins Leere.
     */
    await zustand(fx.accountId, 'suspended', admin.sessionId)
    const r = await app.inject({ method: 'GET', url: '/v1/auth/me',
      headers: auth(rezeption.sessionId) })
    const d = r.json() as { accountSuspended: boolean; properties: unknown[] }
    expect(d.properties).toEqual([])
    expect(d.accountSuspended).toBe(true)
  })

  it('haelt "kein Haus" und "gesperrt" auseinander', async () => {
    const ohneHaus = await makeUser(owner, { email: 'neu@kunde.de' })
    const d = (await app.inject({ method: 'GET', url: '/v1/auth/me',
      headers: auth(ohneHaus.sessionId) })).json() as { accountSuspended: boolean }
    expect(d.accountSuspended).toBe(false)
  })

  it('weist einen unbekannten Zustand ab', async () => {
    const r = await zustand(fx.accountId, 'geloescht', admin.sessionId)
    expect(r.statusCode).toBe(422)
  })

  it('bleibt einem Hotelbenutzer verschlossen', async () => {
    const r = await zustand(fx.accountId, 'suspended', rezeption.sessionId)
    expect(r.statusCode).toBe(403)
    const a = await owner.query<{ status: string }>(
      `SELECT status FROM account WHERE id = $1`, [fx.accountId])
    expect(a.rows[0]!.status).toBe('active')
  })
})

describe('Plattformbenutzer', () => {
  const anlegen = (payload: Record<string, unknown>, session = admin.sessionId) =>
    app.inject({ method: 'POST', url: '/v1/platform/staff',
      headers: auth(session), payload })

  it('legt an und laedt ein, statt ein Kennwort zu vergeben', async () => {
    const r = await anlegen({ email: 'neu@wir.de', displayName: 'Neue Kollegin',
      roleKey: 'platform_support' })
    expect(r.statusCode).toBe(201)

    const u = await owner.query<{ status: string; password_hash: string | null }>(
      `SELECT status, password_hash FROM app_user WHERE email = 'neu@wir.de'`)
    expect(u.rows[0]!.status).toBe('invited')
    // Kein Kennwort: eines, das durch einen Chat gegangen ist, ist ab dem
    // ersten Tag kompromittiert.
    expect(u.rows[0]!.password_hash).toBeNull()
    const t = await owner.query(
      `SELECT 1 FROM auth_token t JOIN app_user u ON u.id = t.user_id
        WHERE u.email = 'neu@wir.de' AND t.kind = 'invite'`)
    expect(t.rowCount).toBe(1)
  })

  it('erhoeht keinen vorhandenen Benutzer', async () => {
    // Dieselbe Regel wie im Skript db:plattformbenutzer: ein Tippfehler in
    // der Adresse genuegte sonst, um einem Hotelier Vollzugriff zu geben.
    const r = await anlegen({ email: 'rezeption@kunde.de', displayName: 'X',
      roleKey: 'platform_admin' })
    expect(r.statusCode).toBe(409)
    const u = await owner.query<{ is_platform_staff: boolean }>(
      `SELECT is_platform_staff FROM app_user WHERE email = 'rezeption@kunde.de'`)
    expect(u.rows[0]!.is_platform_staff).toBe(false)
  })

  it('nimmt nur Plattformrollen', async () => {
    const r = await anlegen({ email: 'neu2@wir.de', displayName: 'X',
      roleKey: 'hotel_director' })
    expect(r.statusCode).toBe(422)
  })

  it('bleibt dem Support verschlossen, der nur Sitzungen anfragen darf', async () => {
    // platform:staff haengt allein an platform_admin: wer Kunden betreut,
    // muss nicht auch Kollegen mit Vollzugriff anlegen duerfen.
    const s = await makeUser(owner, { email: 'support@wir.de',
      platformRoleKey: 'platform_support', isPlatformStaff: true })
    expect((await anlegen({ email: 'x@wir.de', displayName: 'X',
      roleKey: 'platform_ops' }, s.sessionId)).statusCode).toBe(403)
    expect((await personal(s.sessionId)).statusCode).toBe(403)
  })

  it('zaehlt das Personal mit Rolle auf', async () => {
    const d = (await personal(admin.sessionId)).json() as
      { staff: Array<{ email: string; roleKey: string }> }
    expect(d.staff.map(s => s.email)).toEqual(['admin@wir.de'])
    expect(d.staff[0]!.roleKey).toBe('platform_admin')
  })

  it('legt den eigenen Zugang nicht still', async () => {
    const r = await app.inject({ method: 'POST',
      url: `/v1/platform/staff/${admin.userId}/status`,
      headers: auth(admin.sessionId), payload: { status: 'disabled' } })
    expect(r.statusCode).toBe(409)
  })

  it('laesst den letzten aktiven Admin stehen', async () => {
    const zweiter = await makeUser(owner, { email: 'admin2@wir.de',
      platformRoleKey: 'platform_admin', isPlatformStaff: true })
    // Solange zwei da sind, geht es.
    const erst = await app.inject({ method: 'POST',
      url: `/v1/platform/staff/${zweiter.userId}/status`,
      headers: auth(admin.sessionId), payload: { status: 'disabled' } })
    expect(erst.statusCode).toBe(200)

    // Jetzt ist `admin` der letzte -- und der stillzulegende waere es auch,
    // wenn ihn jemand anderes stilllegte.
    const dritter = await makeUser(owner, { email: 'admin3@wir.de',
      platformRoleKey: 'platform_admin', isPlatformStaff: true })
    const raus = await app.inject({ method: 'POST',
      url: `/v1/platform/staff/${admin.userId}/status`,
      headers: auth(dritter.sessionId), payload: { status: 'disabled' } })
    expect(raus.statusCode).toBe(200)
    const letzte = await app.inject({ method: 'POST',
      url: `/v1/platform/staff/${dritter.userId}/status`,
      headers: auth(dritter.sessionId), payload: { status: 'disabled' } })
    // Der eigene Zugang faellt schon an der ersten Sperre: 409.
    expect(letzte.statusCode).toBe(409)
  })

  it('nimmt einem stillgelegten Plattformbenutzer die Rechte', async () => {
    const zweiter = await makeUser(owner, { email: 'ops@wir.de',
      platformRoleKey: 'platform_ops', isPlatformStaff: true })
    await owner.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`,
      [zweiter.userId])
    // Der Waechter in der Datenbank prueft den Zustand mit. Ohne das waere
    // Stilllegen eine Empfehlung: die Rollenzeile bleibt ja stehen.
    const p = await loadPrincipal(pool, zweiter.userId)
    expect(p.platformPermissions.size).toBe(0)
  })
})

describe('Betriebszustand', () => {
  it('nennt je Kunde Zahlen, keine Inhalte', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/platform/health',
      headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    const d = r.json() as { accounts: Array<{ accountName: string; emailsPending: number }> }
    expect(d.accounts[0]!.accountName).toBe('Wattenblick')
    expect(d.accounts[0]!.emailsPending).toBe(0)
    // Kein Betreff, kein Empfaenger, kein Rumpf: eine Gastpost traegt Namen
    // und Anschrift, ein Webhook den Rumpf einer Buchung.
    expect(r.body).not.toMatch(/subject|to_email|payload|body/i)
  })

  it('bleibt einem Hotelbenutzer verschlossen', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/platform/health',
      headers: auth(rezeption.sessionId) })
    expect(r.statusCode).toBe(403)
  })
})
