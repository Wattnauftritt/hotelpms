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
 * Das eigene Konto: Kennwort und Mailadresse selbst aendern.
 *
 * **Was hier wirklich geprueft wird.** Nicht, ob ein Feld gespeichert wird,
 * sondern die zwei Stellen, an denen diese beiden Handlungen gefaehrlich
 * sind:
 *
 *   1. Eine Sitzung allein darf nicht genuegen. An einer Rezeption steht ein
 *      Rechner, an dem jemand kurz aufsteht -- wer die Sitzung vorfindet,
 *      koennte sonst in zwei Klicks das Konto uebernehmen. Und die
 *      allgemeine Ratenbegrenzung greift hier **nicht**, weil die Anfrage
 *      angemeldet ist (H4, Dokument 25). Also zaehlt die Route selbst.
 *
 *   2. Die Mailadresse **ist** die Anmeldung. Wer sie auf einen Tippfehler
 *      setzt, kommt nicht mehr herein und auch nicht mehr an eine
 *      Ruecksetzung. Deshalb wird sie bestaetigt, nicht gesetzt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let userId: number
let auth: Record<string, string>

const ALT = 'das-alte-kennwort-ist-lang'
const NEU = 'das-neue-kennwort-ist-auch-lang'

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
  fx = await makeProperty(owner)
  const u = await makeUser(owner,
    { email: 'rezeption@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  userId = u.userId
  await owner.query(`UPDATE app_user SET password_hash = $2 WHERE id = $1`,
    [userId, await hashPassword(ALT)])
  auth = { cookie: `hp_session=${u.sessionId}` }
})

const kennwortAendern = (body: unknown, headers = auth) =>
  app.inject({ method: 'POST', url: '/v1/auth/password', headers, payload: body })
const mailAendern = (body: unknown, headers = auth) =>
  app.inject({ method: 'POST', url: '/v1/auth/email', headers, payload: body })
const mailBestaetigen = (token: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/email/confirm', payload: { token } })
const anmelden = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } })

async function tokenAusPost(): Promise<string> {
  const r = await owner.query<{ body_text: string }>(
    `SELECT body_text FROM platform_email WHERE kind = 'email_change'
      ORDER BY id DESC LIMIT 1`)
  const treffer = /token=([A-Za-z0-9_-]+)/.exec(r.rows[0]?.body_text ?? '')
  if (treffer === null) throw new Error('Kein Token in der eingereihten Nachricht')
  return treffer[1]!
}

describe('Eigenes Kennwort aendern', () => {
  it('aendert es und laesst die Anmeldung mit dem neuen zu', async () => {
    const r = await kennwortAendern({ currentPassword: ALT, newPassword: NEU })
    expect(r.statusCode, r.body).toBe(200)
    expect((await anmelden('rezeption@test.de', NEU)).statusCode).toBe(200)
    expect((await anmelden('rezeption@test.de', ALT)).statusCode).toBe(401)
  })

  it('verlangt das aktuelle Kennwort, nicht nur die Sitzung', async () => {
    const r = await kennwortAendern({ currentPassword: 'falsch-aber-lang',
                                      newPassword: NEU })
    expect(r.statusCode).toBe(401)
    // Und das alte gilt weiter.
    expect((await anmelden('rezeption@test.de', ALT)).statusCode).toBe(200)
  })

  it('zaehlt den Fehlversuch selbst, weil die Ratenbegrenzung hier nicht greift', async () => {
    /*
     * Der Kern dieses Tests. Die allgemeine Grenze laesst angemeldete
     * Anfragen durch -- genau daran ist `workstation-switch` schon einmal
     * gescheitert. Ohne eigenen Zaehler liesse sich hier ein Kennwort in
     * Ruhe durchprobieren.
     */
    await kennwortAendern({ currentPassword: 'falsch-aber-lang', newPassword: NEU })
    const f = await owner.query<{ failed_count: number }>(
      `SELECT failed_count FROM login_failure WHERE user_id = $1`, [userId])
    expect(f.rows[0]?.failed_count).toBe(1)
  })

  it('weist eine gesperrte Sitzung ab, statt weiterprobieren zu lassen', async () => {
    // Waere das erlaubt, liesse sich die Sperre der Anmeldung umgehen,
    // indem man in einer noch offenen Sitzung weitermacht.
    await owner.query(
      `UPDATE app_user SET locked_until = now() + interval '10 minutes'
        WHERE id = $1`, [userId])
    const r = await kennwortAendern({ currentPassword: ALT, newPassword: NEU })
    expect(r.statusCode).toBe(401)
    expect(JSON.parse(r.body).code).toBe('auth.tooManyAttempts')
  })

  it('nimmt dasselbe Kennwort nicht als Aenderung an', async () => {
    // Sonst glaubt der Benutzer, er habe es geaendert -- und seine anderen
    // Sitzungen fliegen dabei trotzdem heraus.
    const r = await kennwortAendern({ currentPassword: ALT, newPassword: ALT })
    expect(r.statusCode).toBe(422)
  })

  it('beendet die anderen Sitzungen und laesst die eigene bestehen', async () => {
    /*
     * Wer sein Kennwort aendert, tut das oft genug, weil jemand anderes es
     * kennt. Dann nuetzt das neue nichts, solange die fremde Sitzung
     * weiterlaeuft. Die eigene stehen zu lassen ist der Unterschied zur
     * Ruecksetzung: hier sitzt der Benutzer davor und will weiterarbeiten.
     */
    const zweite = await app.inject({ method: 'POST', url: '/v1/auth/login',
      payload: { email: 'rezeption@test.de', password: ALT } })
    const zweitesCookie = /hp_session=([^;]+)/.exec(
      zweite.headers['set-cookie'] as string)![1]!

    await kennwortAendern({ currentPassword: ALT, newPassword: NEU })

    const eigene = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth })
    expect(eigene.statusCode).toBe(200)
    const fremde = await app.inject({ method: 'GET', url: '/v1/auth/me',
      headers: { cookie: `hp_session=${zweitesCookie}` } })
    expect(fremde.statusCode).toBe(401)
  })

  it('bleibt ohne Sitzung verschlossen', async () => {
    const r = await kennwortAendern({ currentPassword: ALT, newPassword: NEU }, {})
    expect(r.statusCode).toBe(401)
  })
})

describe('Eigene Mailadresse aendern', () => {
  it('aendert nichts, bevor der Link geklickt ist', async () => {
    const r = await mailAendern({ currentPassword: ALT, newEmail: 'neu@test.de' })
    expect(r.statusCode, r.body).toBe(202)

    // Die Anmeldung laeuft weiter ueber die alte Adresse.
    expect((await anmelden('rezeption@test.de', ALT)).statusCode).toBe(200)
    expect((await anmelden('neu@test.de', ALT)).statusCode).toBe(401)
  })

  it('schickt den Link an die neue und einen Hinweis an die alte Adresse', async () => {
    await mailAendern({ currentPassword: ALT, newEmail: 'neu@test.de' })
    const post = await owner.query<{ kind: string; to_email: string; body_text: string }>(
      `SELECT kind, to_email, body_text FROM platform_email ORDER BY id`)
    const link = post.rows.find(z => z.kind === 'email_change')
    const hinweis = post.rows.find(z => z.kind === 'email_change_notice')

    expect(link?.to_email).toBe('neu@test.de')
    expect(hinweis?.to_email).toBe('rezeption@test.de')

    /*
     * Der Hinweis traegt **keinen** Link. Eine Nachricht ueber eine
     * Aenderung, die man nicht veranlasst hat, mit einem Knopf darin, ist
     * die Bauform jeder Phishing-Mail -- und sie erzieht den Empfaenger
     * dazu, genau so etwas anzuklicken.
     */
    expect(hinweis?.body_text).not.toContain('token=')
    // Und er nennt die neue Adresse nur angedeutet: haette ein Fremder die
    // Aenderung angestossen, stuende sonst dessen Adresse im Postfach des
    // Opfers.
    expect(hinweis?.body_text).not.toContain('neu@test.de')
    expect(hinweis?.body_text).toContain('@test.de')
  })

  it('aendert sie, sobald der Link eingeloest ist', async () => {
    await mailAendern({ currentPassword: ALT, newEmail: 'neu@test.de' })
    const r = await mailBestaetigen(await tokenAusPost())
    expect(r.statusCode, r.body).toBe(200)

    expect((await anmelden('neu@test.de', ALT)).statusCode).toBe(200)
    expect((await anmelden('rezeption@test.de', ALT)).statusCode).toBe(401)
  })

  it('laesst denselben Link kein zweites Mal gelten', async () => {
    await mailAendern({ currentPassword: ALT, newEmail: 'neu@test.de' })
    const token = await tokenAusPost()
    expect((await mailBestaetigen(token)).statusCode).toBe(200)
    expect((await mailBestaetigen(token)).statusCode).toBe(422)
  })

  it('entwertet einen aelteren Antrag, wenn ein neuer gestellt wird', async () => {
    /*
     * Sonst laegen nach drei Versuchen drei gueltige Links im Postfach,
     * jeder auf eine andere Adresse -- und welcher zuletzt geklickt wird,
     * entscheidet der Zufall.
     */
    await mailAendern({ currentPassword: ALT, newEmail: 'erste@test.de' })
    const alterLink = await tokenAusPost()
    await mailAendern({ currentPassword: ALT, newEmail: 'zweite@test.de' })

    expect((await mailBestaetigen(alterLink)).statusCode).toBe(422)
    expect((await mailBestaetigen(await tokenAusPost())).statusCode).toBe(200)
    const u = await owner.query<{ email: string }>(
      `SELECT email FROM app_user WHERE id = $1`, [userId])
    expect(u.rows[0]!.email).toBe('zweite@test.de')
  })

  it('verlangt das aktuelle Kennwort', async () => {
    const r = await mailAendern({ currentPassword: 'falsch-aber-lang',
                                  newEmail: 'neu@test.de' })
    expect(r.statusCode).toBe(401)
    const post = await owner.query(`SELECT 1 FROM platform_email`)
    expect(post.rows).toHaveLength(0)
  })

  it('weist eine Adresse ab, die schon zu einem anderen Zugang gehoert', async () => {
    await makeUser(owner,
      { email: 'kollege@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const r = await mailAendern({ currentPassword: ALT, newEmail: 'kollege@test.de' })
    expect(r.statusCode).toBe(409)
  })

  it('weist eine Adresse ab, die zwischen Antrag und Klick vergeben wurde', async () => {
    // Zwischen beidem liegt bis zu ein Tag. Ohne diese Pruefung schluege
    // stattdessen der eindeutige Index zu, und der Benutzer saehe einen
    // Datenbankfehler.
    await mailAendern({ currentPassword: ALT, newEmail: 'neu@test.de' })
    const token = await tokenAusPost()
    await makeUser(owner,
      { email: 'neu@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    expect((await mailBestaetigen(token)).statusCode).toBe(409)
  })

  it('weist eine unbrauchbare Adresse ab', async () => {
    const r = await mailAendern({ currentPassword: ALT, newEmail: 'kein-at-zeichen' })
    expect(r.statusCode).toBe(422)
  })

  it('nimmt die eigene Adresse nicht als Aenderung an', async () => {
    const r = await mailAendern({ currentPassword: ALT, newEmail: 'Rezeption@TEST.de' })
    expect(r.statusCode).toBe(422)
  })

  it('haelt die Sitzungen nach der Bestaetigung offen', async () => {
    // Anders als beim Kennwort ist hier nichts kompromittiert -- wer
    // bestaetigt hat, sass an beiden Enden. Jemanden mitten im Check-in
    // hinauszuwerfen waere Schaden ohne Gegenwert.
    await mailAendern({ currentPassword: ALT, newEmail: 'neu@test.de' })
    await mailBestaetigen(await tokenAusPost())
    const r = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth })
    expect(r.statusCode).toBe(200)
  })
})
