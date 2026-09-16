import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { hashPassword } from '../routes/auth.js'
import { limiters } from '../platform/rateLimit.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture

const KENNWORT = 'ein-ordentlich-langes-kennwort'

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
  // Diese Datei erzeugt absichtlich viele Fehlanmeldungen. Ohne Ruecksetzen
  // liefe sie in die Ratenbegrenzung, die hier nicht geprueft wird.
  limiters.reset()
})

async function benutzerMitKennwort(email = 'rezeption@test.de'): Promise<number> {
  const u = await makeUser(owner,
    { email, propertyId: fx.propertyId, roleKey: 'reception' })
  await owner.query(`UPDATE app_user SET password_hash = $2 WHERE id = $1`,
    [u.userId, await hashPassword(KENNWORT)])
  return u.userId
}

const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } })

function cookieAus(r: { headers: Record<string, unknown> }): string {
  const raw = r.headers['set-cookie']
  const erste = Array.isArray(raw) ? raw[0]! : String(raw)
  return erste.split(';')[0]!
}

describe('Anmeldung', () => {
  it('setzt eine Sitzung im Cookie und erlaubt danach den Zugriff', async () => {
    await benutzerMitKennwort()
    const r = await login('rezeption@test.de', KENNWORT)
    expect(r.statusCode).toBe(200)

    const gesetzt = String(
      Array.isArray(r.headers['set-cookie'])
        ? r.headers['set-cookie'][0] : r.headers['set-cookie'])
    // Nicht aus JavaScript lesbar, und nicht ueber fremde Herkuenfte
    // mitgeschickt. Beides zusammen macht den Diebstahl schwer.
    expect(gesetzt).toContain('HttpOnly')
    expect(gesetzt.toLowerCase()).toContain('samesite=lax')

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me',
      headers: { cookie: cookieAus(r) } })
    expect(me.statusCode).toBe(200)
    const ich = JSON.parse(me.body) as
      { email: string; properties: Array<{ id: number; permissions: string[] }> }
    expect(ich.email).toBe('rezeption@test.de')
    expect(ich.properties[0]!.id).toBe(fx.propertyId)
    expect(ich.properties[0]!.permissions).toContain('reservation:write')
  })

  it('antwortet bei falschem Kennwort und unbekannter Adresse gleich', async () => {
    await benutzerMitKennwort()
    const falsch = await login('rezeption@test.de', 'daneben')
    const unbekannt = await login('gibtesnicht@test.de', KENNWORT)
    expect(falsch.statusCode).toBe(401)
    expect(unbekannt.statusCode).toBe(401)
    // Dieselbe Meldung: wer unterscheidet, verraet die Benutzerliste.
    expect(JSON.parse(falsch.body).detail).toBe(JSON.parse(unbekannt.body).detail)
  })

  it('laesst einen eingeladenen, aber noch nicht aktiven Benutzer nicht herein', async () => {
    const id = await benutzerMitKennwort()
    await owner.query(`UPDATE app_user SET status = 'invited' WHERE id = $1`, [id])
    expect((await login('rezeption@test.de', KENNWORT)).statusCode).toBe(401)
  })

  it('sperrt nach zehn Fehlversuchen', async () => {
    await benutzerMitKennwort()
    for (let i = 0; i < 10; i++) await login('rezeption@test.de', 'daneben')

    const gesperrt = await login('rezeption@test.de', KENNWORT)
    expect(gesperrt.statusCode).toBe(401)
    // Auch mit richtigem Kennwort: die Sperre gilt.
    expect(JSON.parse(gesperrt.body).detail).toContain('Fehlversuche')

    const bis = await owner.query<{ locked_until: string | null }>(
      `SELECT locked_until::text FROM app_user WHERE lower(email) = 'rezeption@test.de'`)
    expect(bis.rows[0]!.locked_until).not.toBeNull()
  })

  it('setzt den Zaehler nach erfolgreicher Anmeldung zurueck', async () => {
    await benutzerMitKennwort()
    await login('rezeption@test.de', 'daneben')
    await login('rezeption@test.de', 'daneben')
    await login('rezeption@test.de', KENNWORT)
    const z = await owner.query<{ failed_login_count: number }>(
      `SELECT failed_login_count FROM app_user WHERE lower(email) = 'rezeption@test.de'`)
    expect(z.rows[0]!.failed_login_count).toBe(0)
  })

  it('zieht die Sitzung beim Abmelden zurueck statt sie zu loeschen', async () => {
    await benutzerMitKennwort()
    const an = await login('rezeption@test.de', KENNWORT)
    const cookie = cookieAus(an)

    const ab = await app.inject({ method: 'POST', url: '/v1/auth/logout',
      headers: { cookie } })
    expect(ab.statusCode).toBe(200)

    const danach = await app.inject({ method: 'GET', url: '/v1/auth/me',
      headers: { cookie } })
    expect(danach.statusCode).toBe(401)

    // Die Zeile bleibt als Spur, wann die Sitzung bestand und wann sie endete.
    const kennung = cookie.split('=')[1]!
    const s = await owner.query<{ revoked_at: string | null }>(
      `SELECT revoked_at::text FROM user_session WHERE id = $1`, [kennung])
    expect(s.rowCount).toBe(1)
    expect(s.rows[0]!.revoked_at).not.toBeNull()
  })

  it('braucht fuer den Arbeitsplatzwechsel eine bestehende Sitzung', async () => {
    const w = await app.inject({ method: 'POST', url: '/v1/auth/workstation-switch',
      payload: { email: 'nacht@test.de', pin: '4711' } })
    expect(w.statusCode).toBe(401)
  })
})

/**
 * Der Arbeitsplatz-PIN.
 *
 * Am geteilten Rezeptionsrechner wechselt er die handelnde Person, ohne dass
 * sich jemand neu anmeldet -- damit im Protokoll steht, wer wirklich gebucht
 * hat. Die Pruefungen hier sind keine Formalitaeten: der PIN ist kurz, und
 * die Ratenbegrenzung greift auf dieser Route nicht, weil sie angemeldete
 * Anfragen ausnimmt.
 */
describe('Arbeitsplatz-PIN', () => {
  /** Setzt den PIN so, wie es die Route tut -- ueber Kennwort und Route. */
  async function pinSetzen(cookie: string, pin: string | null) {
    return app.inject({ method: 'POST', url: '/v1/auth/workstation-pin',
      headers: { cookie }, payload: { password: KENNWORT, pin } })
  }

  /** Zwei Personen am selben Haus, beide mit Kennwort und PIN. */
  async function arbeitsplatz(): Promise<{ cookie: string }> {
    await benutzerMitKennwort('tag@test.de')
    const nacht = await makeUser(owner,
      { email: 'nacht@test.de', propertyId: fx.propertyId, roleKey: 'night_audit' })
    await owner.query(`UPDATE app_user SET password_hash = $2 WHERE id = $1`,
      [nacht.userId, await hashPassword(KENNWORT)])

    const nachtCookie = cookieAus(await login('nacht@test.de', KENNWORT))
    expect((await pinSetzen(nachtCookie, '4711')).statusCode).toBe(200)

    const cookie = cookieAus(await login('tag@test.de', KENNWORT))
    expect((await pinSetzen(cookie, '1234')).statusCode).toBe(200)
    return { cookie }
  }

  const wechseln = (cookie: string, email: string, pin: string) =>
    app.inject({ method: 'POST', url: '/v1/auth/workstation-switch',
      headers: { cookie }, payload: { email, pin } })

  it('wechselt die handelnde Person ueber den PIN', async () => {
    const { cookie } = await arbeitsplatz()

    const w = await wechseln(cookie, 'nacht@test.de', '4711')
    expect(w.statusCode, w.body).toBe(200)

    // Dieselbe Sitzung, andere handelnde Person und andere Berechtigungen.
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })
    const ich = JSON.parse(me.body) as
      { email: string; workstationSwitched: boolean
        properties: Array<{ permissions: string[] }> }
    expect(ich.email).toBe('nacht@test.de')
    expect(ich.properties[0]!.permissions).toContain('nightaudit:run')
    // Ein Wechsel, den man nicht sieht, wird vergessen -- und dann bucht
    // eine Stunde lang jemand unter fremdem Namen.
    expect(ich.workstationSwitched).toBe(true)
  })

  it('laesst denselben Weg wieder zurueck', async () => {
    const { cookie } = await arbeitsplatz()
    await wechseln(cookie, 'nacht@test.de', '4711')

    expect((await wechseln(cookie, 'tag@test.de', '1234')).statusCode).toBe(200)
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })
    expect(JSON.parse(me.body).email).toBe('tag@test.de')
    expect(JSON.parse(me.body).workstationSwitched).toBe(false)
  })

  it('weist einen falschen PIN ab', async () => {
    const { cookie } = await arbeitsplatz()
    expect((await wechseln(cookie, 'nacht@test.de', '0000')).statusCode).toBe(401)
  })

  /**
   * Die Ratenbegrenzung nimmt angemeldete Anfragen aus, und diese Route
   * traegt immer ein gueltiges Sitzungscookie. Ohne eigenen Zaehler liesse
   * sich ein vierstelliger PIN in Sekunden durchprobieren.
   */
  it('sperrt nach fuenf Fehlversuchen, auch mit gueltiger Sitzung', async () => {
    const { cookie } = await arbeitsplatz()
    for (let i = 0; i < 5; i++) {
      expect((await wechseln(cookie, 'nacht@test.de', '0000')).statusCode).toBe(401)
    }
    // Jetzt zaehlt auch der richtige PIN nicht mehr.
    const r = await wechseln(cookie, 'nacht@test.de', '4711')
    expect(r.statusCode).toBe(401)
    expect(r.body).toMatch(/Fehlversuche|attempts/)
  })

  it('setzt den Zaehler nach einem gelungenen Wechsel zurueck', async () => {
    const { cookie } = await arbeitsplatz()
    await wechseln(cookie, 'nacht@test.de', '0000')
    await wechseln(cookie, 'nacht@test.de', '0000')
    expect((await wechseln(cookie, 'nacht@test.de', '4711')).statusCode).toBe(200)

    const z = await owner.query<{ n: number }>(
      `SELECT workstation_pin_failed_count AS n FROM app_user
        WHERE lower(email) = 'nacht@test.de'`)
    expect(z.rows[0]!.n).toBe(0)
  })

  /**
   * Vorher genuegten Adresse und PIN irgendeines Benutzers der ganzen
   * Datenbank. Damit waere dies ein Weg von einem Kunden zum naechsten
   * gewesen -- die Zeilenrichtlinie schuetzt hier nicht, weil die Abfrage
   * ohne Mandantenkontext laeuft.
   */
  it('wechselt nicht zu jemandem aus einem fremden Haus', async () => {
    const { cookie } = await arbeitsplatz()
    const fremd = await makeProperty(owner, { name: 'Fremdes Haus', code: 'FRD' })
    const fremder = await makeUser(owner,
      { email: 'fremd@test.de', propertyId: fremd.propertyId, roleKey: 'reception' })
    await owner.query(`UPDATE app_user SET workstation_pin_hash = $2 WHERE id = $1`,
      [fremder.userId, await hashPassword('4711')])

    const w = await wechseln(cookie, 'fremd@test.de', '4711')
    expect(w.statusCode).toBe(401)

    // Und der Fehlversuch geht nicht auf sein Konto: sonst waere das ein
    // Weg, einen beliebigen Fremden auszusperren.
    const z = await owner.query<{ n: number }>(
      `SELECT workstation_pin_failed_count AS n FROM app_user WHERE id = $1`,
      [fremder.userId])
    expect(z.rows[0]!.n).toBe(0)
  })

  it('wechselt nicht, wenn die angemeldete Person selbst keinen PIN hat', async () => {
    await benutzerMitKennwort('tag@test.de')
    const nacht = await makeUser(owner,
      { email: 'nacht@test.de', propertyId: fx.propertyId, roleKey: 'night_audit' })
    await owner.query(`UPDATE app_user SET workstation_pin_hash = $2 WHERE id = $1`,
      [nacht.userId, await hashPassword('4711')])
    const cookie = cookieAus(await login('tag@test.de', KENNWORT))

    // Sonst kaeme sie nach dem Wechsel nicht in ihre eigene Sitzung zurueck.
    const w = await wechseln(cookie, 'nacht@test.de', '4711')
    expect(w.statusCode).toBe(422)
  })

  describe('Den eigenen PIN setzen', () => {
    it('verlangt das eigene Kennwort', async () => {
      await benutzerMitKennwort()
      const cookie = cookieAus(await login('rezeption@test.de', KENNWORT))

      const r = await app.inject({ method: 'POST', url: '/v1/auth/workstation-pin',
        headers: { cookie }, payload: { password: 'falsch-aber-lang-genug', pin: '1234' } })
      expect(r.statusCode).toBe(401)

      const z = await owner.query<{ gesetzt: boolean }>(
        `SELECT workstation_pin_hash IS NOT NULL AS gesetzt FROM app_user
          WHERE lower(email) = 'rezeption@test.de'`)
      expect(z.rows[0]!.gesetzt).toBe(false)
    })

    it('nimmt nur Ziffern und nur in der erlaubten Laenge', async () => {
      await benutzerMitKennwort()
      const cookie = cookieAus(await login('rezeption@test.de', KENNWORT))

      expect((await pinSetzen(cookie, '12a4')).statusCode).toBe(422)
      expect((await pinSetzen(cookie, '123')).statusCode).toBe(422)
      expect((await pinSetzen(cookie, '1234567890123')).statusCode).toBe(422)
      expect((await pinSetzen(cookie, '1234')).statusCode).toBe(200)
    })

    it('meldet ihn in /v1/auth/me und nimmt ihn wieder zurueck', async () => {
      await benutzerMitKennwort()
      const cookie = cookieAus(await login('rezeption@test.de', KENNWORT))
      const me = () => app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } })

      expect(JSON.parse((await me()).body).workstationPinSet).toBe(false)
      await pinSetzen(cookie, '1234')
      expect(JSON.parse((await me()).body).workstationPinSet).toBe(true)
      await pinSetzen(cookie, null)
      expect(JSON.parse((await me()).body).workstationPinSet).toBe(false)
    })

    it('braucht eine Anmeldung', async () => {
      const r = await app.inject({ method: 'POST', url: '/v1/auth/workstation-pin',
        payload: { password: KENNWORT, pin: '1234' } })
      expect(r.statusCode).toBe(401)
    })
  })
})

/**
 * Abmelden ohne Sitzung.
 *
 * Das Zurueckziehen selbst prueft schon der Test oben. Was dort fehlt, ist
 * der zweite Klick: an einem geteilten Rezeptionsrechner passiert genau das,
 * und ein Fehler waere dort unverstaendlich -- das Ziel ist ja erreicht.
 */
describe('Abmelden ohne Sitzung', () => {
  it('vertraegt einen Aufruf ohne Cookie', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/auth/logout' })).statusCode)
      .toBe(200)
  })

  it('vertraegt einen zweiten Klick', async () => {
    await benutzerMitKennwort()
    const cookie = cookieAus(await login('rezeption@test.de', KENNWORT))
    const ab = () => app.inject({ method: 'POST', url: '/v1/auth/logout',
      headers: { cookie } })
    expect((await ab()).statusCode).toBe(200)
    expect((await ab()).statusCode).toBe(200)
  })
})
