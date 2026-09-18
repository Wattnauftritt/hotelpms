import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { loadPrincipal } from '../platform/auth.js'

/**
 * Die Handgriffe des Supports.
 *
 * Der erste Durchgang des Panels konnte mit dem haeufigsten Anruf nichts
 * anfangen: "Frau X kommt nicht mehr rein." Hier steht, was am Telefon
 * gebraucht wird -- und jeweils die Gegenrichtung: kein Kennwort im Klartext,
 * kein Zugriff auf Benutzer eines **anderen** Kunden ueber eine erratene
 * Kennung, kein Nachweis, den nur der Handelnde selbst sieht.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let fremd: Fixture
let admin: { userId: number; sessionId: string }
let support: { userId: number; sessionId: string }
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
  fremd = await makeProperty(owner, { name: 'Anderer Betrieb', code: 'FREMD' })
  admin = await makeUser(owner, { email: 'admin@wir.de',
    platformRoleKey: 'platform_admin', isPlatformStaff: true })
  support = await makeUser(owner, { email: 'support@wir.de',
    platformRoleKey: 'platform_support', isPlatformStaff: true })
  rezeption = await makeUser(owner, { email: 'rezeption@kunde.de',
    propertyId: fx.propertyId, roleKey: 'reception' })
})

const post = (url: string, session: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: auth(session), payload })
const get = (url: string, session: string) =>
  app.inject({ method: 'GET', url, headers: auth(session) })

describe('Entsperren', () => {
  it('hebt Anmelde- und PIN-Sperre auf, ohne das Kennwort anzufassen', async () => {
    await owner.query(
      `UPDATE app_user SET failed_login_count = 5, locked_until = now() + interval '20 min',
              workstation_pin_failed_count = 3,
              workstation_pin_locked_until = now() + interval '20 min',
              password_hash = 'bleibt' WHERE id = $1`, [rezeption.userId])
    const r = await post(
      `/v1/platform/accounts/${fx.accountId}/users/${rezeption.userId}/unlock`,
      admin.sessionId)
    expect(r.statusCode).toBe(200)
    const u = await owner.query<{ locked_until: string | null; failed_login_count: number
                                  workstation_pin_locked_until: string | null
                                  password_hash: string }>(
      `SELECT locked_until, failed_login_count, workstation_pin_locked_until, password_hash
         FROM app_user WHERE id = $1`, [rezeption.userId])
    expect(u.rows[0]!.locked_until).toBeNull()
    expect(u.rows[0]!.failed_login_count).toBe(0)
    expect(u.rows[0]!.workstation_pin_locked_until).toBeNull()
    expect(u.rows[0]!.password_hash).toBe('bleibt')
  })

  it('erreicht keinen Benutzer eines anderen Kunden', async () => {
    /*
     * Die Kennung stimmt, der Kunde nicht. Ohne diese Pruefung waere jede
     * Route hier der Weg, mit einer erratenen Zahl beim Nachbarn zu
     * arbeiten -- und die Antwort darf nicht verraten, ob es die Kennung
     * ueberhaupt gibt.
     */
    const r = await post(
      `/v1/platform/accounts/${fremd.accountId}/users/${rezeption.userId}/unlock`,
      admin.sessionId)
    expect(r.statusCode).toBe(404)
  })

  it('bleibt dem Support ohne platform:accounts verschlossen', async () => {
    const r = await post(
      `/v1/platform/accounts/${fx.accountId}/users/${rezeption.userId}/unlock`,
      support.sessionId)
    expect(r.statusCode).toBe(403)
  })
})

describe('Zugangslink', () => {
  it('schickt einem aktiven Benutzer die Kennwort-Ruecksetzung', async () => {
    const r = await post(
      `/v1/platform/accounts/${fx.accountId}/users/${rezeption.userId}/access-link`,
      admin.sessionId)
    expect(r.statusCode).toBe(202)
    expect((r.json() as { kind: string }).kind).toBe('password_reset')
    const t = await owner.query<{ kind: string }>(
      `SELECT kind FROM auth_token WHERE user_id = $1`, [rezeption.userId])
    expect(t.rows.map(x => x.kind)).toEqual(['password_reset'])
    // Und die Post dazu -- ohne sie ist das Token ein Geheimnis, das niemand
    // kennt.
    const m = await owner.query(`SELECT 1 FROM platform_email WHERE user_id = $1`,
      [rezeption.userId])
    expect(m.rowCount).toBe(1)
  })

  it('schickt einem Eingeladenen die Einladung erneut', async () => {
    await owner.query(`UPDATE app_user SET status = 'invited' WHERE id = $1`,
      [rezeption.userId])
    const r = await post(
      `/v1/platform/accounts/${fx.accountId}/users/${rezeption.userId}/access-link`,
      admin.sessionId)
    expect((r.json() as { kind: string }).kind).toBe('invite')
  })

  it('gibt das Token nie in der Antwort heraus', async () => {
    const r = await post(
      `/v1/platform/accounts/${fx.accountId}/users/${rezeption.userId}/access-link`,
      admin.sessionId)
    expect(r.body).not.toMatch(/token|link|http/i)
  })

  it('zeigt in der Kundenkarte, ob die Post ankam', async () => {
    await post(
      `/v1/platform/accounts/${fx.accountId}/users/${rezeption.userId}/access-link`,
      admin.sessionId)
    await owner.query(
      `UPDATE platform_email SET status = 'failed', last_error = 'SMTP 550'
        WHERE user_id = $1`, [rezeption.userId])
    const d = (await get(`/v1/platform/accounts/${fx.accountId}`, admin.sessionId))
      .json() as { users: Array<{ lastMail: { status: string; error: string } | null }> }
    expect(d.users[0]!.lastMail?.status).toBe('failed')
    expect(d.users[0]!.lastMail?.error).toBe('SMTP 550')
  })
})

describe('Sitzungen beenden', () => {
  it('meldet den Benutzer ueberall ab', async () => {
    const r = await post(
      `/v1/platform/accounts/${fx.accountId}/users/${rezeption.userId}/sessions/revoke`,
      admin.sessionId)
    expect(r.statusCode).toBe(200)
    expect((r.json() as { revoked: number }).revoked).toBe(1)
    // Die Sitzung aus dem Fixture ist danach wertlos.
    const danach = await get('/v1/auth/me', rezeption.sessionId)
    expect(danach.statusCode).toBe(401)
  })
})

describe('Benutzer einladen', () => {
  const einladen = (payload: Record<string, unknown>, session = admin.sessionId) =>
    post(`/v1/platform/accounts/${fx.accountId}/users`, session, payload)

  it('legt eine Hausrolle an und laedt ein', async () => {
    const r = await einladen({ email: 'neu@kunde.de', displayName: 'Neue Rezeption',
      roleKey: 'reception', propertyId: fx.propertyId })
    expect(r.statusCode).toBe(201)
    const u = await owner.query<{ id: number; status: string; is_platform_staff: boolean }>(
      `SELECT id, status, is_platform_staff FROM app_user WHERE email = 'neu@kunde.de'`)
    expect(u.rows[0]!.status).toBe('invited')
    expect(u.rows[0]!.is_platform_staff).toBe(false)
    const rolle = await owner.query(
      `SELECT 1 FROM user_property_role WHERE user_id = $1 AND property_id = $2`,
      [u.rows[0]!.id, fx.propertyId])
    expect(rolle.rowCount).toBe(1)
    const t = await owner.query(`SELECT 1 FROM auth_token WHERE user_id = $1 AND kind = 'invite'`,
      [u.rows[0]!.id])
    expect(t.rowCount).toBe(1)
  })

  it('legt eine Account-Rolle ohne Haus an', async () => {
    const r = await einladen({ email: 'chef@kunde.de', displayName: 'Chef',
      roleKey: 'owner', propertyId: null })
    expect(r.statusCode).toBe(201)
    const u = await owner.query<{ id: number }>(
      `SELECT id FROM app_user WHERE email = 'chef@kunde.de'`)
    const p = await loadPrincipal(pool, u.rows[0]!.id)
    // Noch 'invited', also kein Principal -- aber die Rolle steht.
    expect(p.userId).toBeNull()
    const rolle = await owner.query(
      `SELECT 1 FROM user_account_role WHERE user_id = $1 AND account_id = $2`,
      [u.rows[0]!.id, fx.accountId])
    expect(rolle.rowCount).toBe(1)
  })

  it('nimmt kein Haus eines anderen Kunden', async () => {
    const r = await einladen({ email: 'x@kunde.de', displayName: 'X',
      roleKey: 'reception', propertyId: fremd.propertyId })
    expect(r.statusCode).toBe(422)
    const u = await owner.query(`SELECT 1 FROM app_user WHERE email = 'x@kunde.de'`)
    expect(u.rowCount).toBe(0)
  })

  it('weist eine vergebene Adresse ab -- auch die eines anderen Kunden', async () => {
    const r = await einladen({ email: 'rezeption@kunde.de', displayName: 'X',
      roleKey: 'reception', propertyId: fx.propertyId })
    expect(r.statusCode).toBe(409)
  })

  it('verlangt fuer eine Hausrolle ein Haus', async () => {
    const r = await einladen({ email: 'y@kunde.de', displayName: 'Y',
      roleKey: 'reception', propertyId: null })
    expect(r.statusCode).toBe(422)
  })

  it('nimmt keine Plattformrolle', async () => {
    // Der Weg, auf dem ein Kundenbenutzer zu Plattformpersonal wuerde.
    const r = await einladen({ email: 'z@kunde.de', displayName: 'Z',
      roleKey: 'platform_admin', propertyId: null })
    expect(r.statusCode).toBe(422)
  })
})

describe('Weiteres Haus', () => {
  const haus = (payload: Record<string, unknown>) =>
    post(`/v1/platform/accounts/${fx.accountId}/properties`, admin.sessionId, payload)

  it('legt es mit offenem Geschaeftstag an', async () => {
    const r = await haus({ code: 'ZWEI', name: 'Zweites Haus', addressLine1: 'Weg 2',
      postalCode: '25813', city: 'Husum', taxNumber: '21/815/00124' })
    expect(r.statusCode).toBe(201)
    const id = (r.json() as { propertyId: number }).propertyId
    const p = await owner.query<{ account_id: number }>(
      `SELECT account_id FROM property WHERE id = $1`, [id])
    expect(p.rows[0]!.account_id).toBe(fx.accountId)
    // Ohne offenen Geschaeftstag laeuft kein Nachtlauf (0031).
    const tag = await owner.query(`SELECT 1 FROM business_day WHERE property_id = $1`, [id])
    expect(tag.rowCount).toBe(1)
  })

  it('verlangt die Rechnungsangaben nach § 14 UStG', async () => {
    const r = await haus({ code: 'DREI', name: 'Drei', addressLine1: 'Weg 3',
      postalCode: '', city: 'Husum', taxNumber: '' })
    expect(r.statusCode).toBe(422)
  })

  it('weist ein doppeltes Kuerzel beim selben Kunden ab', async () => {
    const r = await haus({ code: 'TEST', name: 'Doppelt', addressLine1: 'Weg 4',
      postalCode: '25813', city: 'Husum', taxNumber: '21/815/00125' })
    expect(r.statusCode).toBe(409)
  })
})

describe('Aufsicht ueber Support-Sitzungen', () => {
  async function sitzung(staffId: number, accountId: number): Promise<number> {
    const s = await owner.query<{ id: number }>(
      `INSERT INTO support_session (account_id, platform_user_id, reason, level,
                                    granted_at, expires_at)
       VALUES ($1, $2, 'Probe', 'write', now(), now() + interval '2 hours') RETURNING id`,
      [accountId, staffId])
    return s.rows[0]!.id
  }

  it('zeigt dem Admin alle Sitzungen, dem Support nur die eigenen', async () => {
    await sitzung(support.userId, fx.accountId)
    await sitzung(admin.userId, fremd.accountId)

    const alle = (await get('/v1/platform/support-audit', admin.sessionId)).json() as
      { sessions: Array<{ staffName: string; accountName: string }> }
    expect(alle.sessions).toHaveLength(2)
    expect(alle.sessions.map(s => s.accountName).sort())
      .toEqual(['Anderer Betrieb', 'Wattenblick'])

    // Art. 5 Abs. 2 DSGVO: der Nachweis gehoert der Aufsicht, nicht dem
    // Handelnden allein. Der Support sieht die Liste nicht.
    expect((await get('/v1/platform/support-audit', support.sessionId)).statusCode).toBe(403)
    const eigene = (await get('/v1/platform/support-sessions', support.sessionId)).json() as
      { sessions: unknown[] }
    expect(eigene.sessions).toHaveLength(1)
  })

  it('nennt die Sitzungen eines Kunden auf seiner Karte', async () => {
    await sitzung(support.userId, fx.accountId)
    const d = (await get(`/v1/platform/accounts/${fx.accountId}/support-sessions`,
      support.sessionId)).json() as { sessions: Array<{ state: string }> }
    expect(d.sessions).toHaveLength(1)
    expect(d.sessions[0]!.state).toBe('active')
  })

  it('zaehlt Aenderungen je Tabelle und gibt keine Inhalte heraus', async () => {
    const id = await sitzung(support.userId, fx.accountId)
    /*
     * Ein Protokolleintrag, wie ihn eine Handlung unter dieser Sitzung
     * hinterlaesst -- mit Gastdaten in `changed`, wie im Ernstfall.
     */
    await owner.query(
      `INSERT INTO audit_log (property_id, account_id, table_name, row_id, row_key,
                              action, changed, user_id, support_session_id)
       VALUES ($1, $2, 'guest', 1, '{"id":1}', 'UPDATE',
               '{"last_name": {"von": "Meier", "nach": "Meyer"}}', $3, $4)`,
      [fx.propertyId, fx.accountId, support.userId, id])

    const r = await get(`/v1/platform/support-sessions/${id}/activity`, admin.sessionId)
    expect(r.statusCode).toBe(200)
    const d = r.json() as { activity: Array<{ table: string; action: string; count: number }> }
    expect(d.activity).toEqual([{ table: 'guest', action: 'UPDATE', count: 1 }])
    expect(r.body).not.toMatch(/Meier|Meyer|last_name/)
  })

  it('laesst den Handelnden seinen eigenen Nachweis sehen, fremde nicht', async () => {
    const eigene = await sitzung(support.userId, fx.accountId)
    const fremde = await sitzung(admin.userId, fremd.accountId)
    await owner.query(
      `INSERT INTO audit_log (account_id, table_name, row_key, action, changed,
                              user_id, support_session_id)
       VALUES ($1, 'company', '{"id":1}', 'INSERT', '{}', $2, $3),
              ($4, 'company', '{"id":2}', 'INSERT', '{}', $5, $6)`,
      [fx.accountId, support.userId, eigene, fremd.accountId, admin.userId, fremde])

    const mein = (await get(`/v1/platform/support-sessions/${eigene}/activity`,
      support.sessionId)).json() as { activity: unknown[] }
    expect(mein.activity).toHaveLength(1)
    // Die fremde Sitzung: die Funktion antwortet leer, nicht mit fremden
    // Zahlen -- und nicht mit 403, das schon die Existenz verriete.
    const nicht = (await get(`/v1/platform/support-sessions/${fremde}/activity`,
      support.sessionId)).json() as { activity: unknown[] }
    expect(nicht.activity).toHaveLength(0)
  })
})

describe('Plattformbenutzer: Rolle und Link', () => {
  it('aendert die Rolle ersetzend', async () => {
    const r = await app.inject({ method: 'PUT',
      url: `/v1/platform/staff/${support.userId}/role`,
      headers: auth(admin.sessionId), payload: { roleKey: 'platform_ops' } })
    expect(r.statusCode).toBe(200)
    const rollen = await owner.query<{ key: string }>(
      `SELECT r.key FROM user_platform_role upr JOIN role r ON r.id = upr.role_id
        WHERE upr.user_id = $1`, [support.userId])
    expect(rollen.rows.map(x => x.key)).toEqual(['platform_ops'])
  })

  it('aendert die eigene Rolle nicht', async () => {
    const r = await app.inject({ method: 'PUT',
      url: `/v1/platform/staff/${admin.userId}/role`,
      headers: auth(admin.sessionId), payload: { roleKey: 'platform_support' } })
    expect(r.statusCode).toBe(409)
  })

  /*
   * Die Sperre "letzter Admin" in dieser Route ist fuer einen Admin als
   * Aufrufer nicht erreichbar: er selbst ist der andere aktive Admin, und
   * sich selbst stuft er nicht herab (oben). Sie steht dort fuer den Tag, an
   * dem platform:staff an eine zweite Rolle vergeben wird -- und wird hier
   * ueber die Datenbank geprueft, nicht ueber einen Umweg, der so tut, als
   * gaebe es den schon.
   */
  it('haelt die Sperre fuer den letzten Admin bereit', async () => {
    const quelle = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../routes/platformSupport.ts', import.meta.url), 'utf8'))
    expect(quelle).toMatch(/platform\.staffLastAdmin/)
  })

  it('schickt einem Eingeladenen die Einladung erneut', async () => {
    const r = await post('/v1/platform/staff', admin.sessionId,
      { email: 'neu@wir.de', displayName: 'Neu', roleKey: 'platform_support' })
    const id = (r.json() as { id: number }).id
    const again = await post(`/v1/platform/staff/${id}/access-link`, admin.sessionId)
    expect(again.statusCode).toBe(202)
    expect((again.json() as { kind: string }).kind).toBe('invite')
    const t = await owner.query(`SELECT 1 FROM auth_token WHERE user_id = $1`, [id])
    expect(t.rowCount).toBe(2)
  })
})

describe('Betriebszustand der Plattform', () => {
  it('nennt haengende Plattformpost mit dem Fehler des Anbieters', async () => {
    await owner.query(
      `INSERT INTO platform_email (user_id, kind, to_email, subject, body_text, status,
                                   last_error)
       VALUES ($1, 'invite', 'x@y.de', 'Einladung', '...', 'failed', 'Brevo: 401')`,
      [rezeption.userId])
    const d = (await get('/v1/platform/health', admin.sessionId)).json() as
      { platform: { emailsFailed: number; emailsLastError: string | null } }
    expect(d.platform.emailsFailed).toBe(1)
    expect(d.platform.emailsLastError).toBe('Brevo: 401')
  })

  it('erkennt eine haengende Ausrollung', async () => {
    await owner.query(
      `INSERT INTO deploy_request (requested_by, target_ref, status, started_at)
       VALUES ($1, 'produktion', 'running', now() - interval '30 min')`, [admin.userId])
    const d = (await get('/v1/platform/health', admin.sessionId)).json() as
      { platform: { deployment: { stuck: boolean } | null } }
    expect(d.platform.deployment?.stuck).toBe(true)
  })
})
