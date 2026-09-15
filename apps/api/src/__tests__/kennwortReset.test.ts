import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { KENNWORT_MIN } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { hashPassword } from '../routes/auth.js'
import { limiters } from '../platform/rateLimit.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture

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
  fx = await makeProperty(owner)
  // Die Ruecksetzung steht auf der strengen Liste der Ratenbegrenzung.
  // Diese Datei fordert sie oft an; geprueft wird die Grenze anderswo.
  limiters.reset()
})

async function benutzer(email = 'rezeption@test.de', status = 'active'): Promise<number> {
  const u = await makeUser(owner,
    { email, propertyId: fx.propertyId, roleKey: 'reception' })
  await owner.query(
    `UPDATE app_user SET password_hash = $2, status = $3 WHERE id = $1`,
    [u.userId, await hashPassword(ALT), status])
  return u.userId
}

const anfordern = (email: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/password-reset', payload: { email } })

const einloesen = (token: string, password: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm',
    payload: { token, password } })

const anmelden = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } })

/**
 * Das Token aus der eingereihten Nachricht fischen.
 *
 * Genau so kommt der Benutzer auch dran -- ueber die Mail, nicht ueber die
 * Antwort der API. Dass der Test diesen Umweg gehen **muss**, ist selbst
 * schon eine Zusicherung.
 */
async function tokenAusPost(): Promise<string> {
  const r = await owner.query<{ body_text: string }>(
    `SELECT body_text FROM platform_email ORDER BY id DESC LIMIT 1`)
  const treffer = /token=([A-Za-z0-9_-]+)/.exec(r.rows[0]?.body_text ?? '')
  if (treffer === null) throw new Error('Kein Token in der eingereihten Nachricht')
  return treffer[1]!
}

describe('Kennwort vergessen: anfordern', () => {
  it('reiht eine Nachricht ein und legt ein Token als Hash ab', async () => {
    const id = await benutzer()
    const r = await anfordern('rezeption@test.de')
    expect(r.statusCode).toBe(202)

    const post = await owner.query<{ user_id: number; kind: string; to_email: string }>(
      `SELECT user_id, kind, to_email FROM platform_email`)
    expect(post.rows).toHaveLength(1)
    expect(post.rows[0]!.user_id).toBe(id)
    expect(post.rows[0]!.kind).toBe('password_reset')

    // Das Token selbst steht nirgends in der Datenbank -- nur sein Hash.
    // Wer eine Sicherung liest, bekommt damit keinen Zugang.
    const token = await tokenAusPost()
    const t = await owner.query<{ token_hash: string }>(`SELECT token_hash FROM auth_token`)
    expect(t.rows).toHaveLength(1)
    expect(t.rows[0]!.token_hash).not.toBe(token)
    expect(t.rows[0]!.token_hash).toHaveLength(64)
  })

  it('antwortet fuer eine unbekannte Adresse genauso', async () => {
    await benutzer()
    const r = await anfordern('gibtesnicht@test.de')
    // Ein anderer Statuscode waere ein Verzeichnis: wer wissen will, welche
    // Haeuser diese Software benutzen, tippt Adressen ein und liest die
    // Antwort.
    expect(r.statusCode).toBe(202)
    const post = await owner.query(`SELECT 1 FROM platform_email`)
    expect(post.rowCount).toBe(0)
  })

  it('schickt einem stillgelegten Zugang keinen Link', async () => {
    await benutzer('gesperrt@test.de', 'disabled')
    const r = await anfordern('gesperrt@test.de')
    expect(r.statusCode).toBe(202)
    // Sonst holte sich ein stillgelegter Benutzer seinen Zugang selbst
    // zurueck, und das Stilllegen waere wirkungslos.
    expect((await owner.query(`SELECT 1 FROM platform_email`)).rowCount).toBe(0)
    expect((await owner.query(`SELECT 1 FROM auth_token`)).rowCount).toBe(0)
  })
})

describe('Kennwort vergessen: einloesen', () => {
  it('setzt das Kennwort und laesst die Anmeldung damit zu', async () => {
    await benutzer()
    await anfordern('rezeption@test.de')
    const r = await einloesen(await tokenAusPost(), NEU)
    expect(r.statusCode).toBe(200)

    expect((await anmelden('rezeption@test.de', NEU)).statusCode).toBe(200)
    expect((await anmelden('rezeption@test.de', ALT)).statusCode).toBe(401)
  })

  it('nimmt dasselbe Token kein zweites Mal', async () => {
    await benutzer()
    await anfordern('rezeption@test.de')
    const token = await tokenAusPost()
    expect((await einloesen(token, NEU)).statusCode).toBe(200)

    const zweite = await einloesen(token, 'noch-ein-anderes-kennwort')
    expect(zweite.statusCode).toBe(422)
    // Und das erste Kennwort gilt weiter -- der zweite Versuch hat nichts
    // veraendert.
    expect((await anmelden('rezeption@test.de', NEU)).statusCode).toBe(200)
  })

  it('weist ein abgelaufenes Token ab', async () => {
    await benutzer()
    await anfordern('rezeption@test.de')
    const token = await tokenAusPost()
    // Beides zurueckdatieren, nicht nur die Frist: auth_token_window besteht
    // darauf, dass ein Token nach seiner Entstehung ablaeuft. Ein Token, das
    // vor zwei Stunden ausgestellt wurde, ist auch genau der echte Fall.
    await owner.query(
      `UPDATE auth_token SET created_at = now() - interval '2 hours',
                             expires_at = now() - interval '1 hour'`)

    expect((await einloesen(token, NEU)).statusCode).toBe(422)
    expect((await anmelden('rezeption@test.de', ALT)).statusCode).toBe(200)
  })

  it('weist ein zu kurzes Kennwort ab, ohne das Token zu verbrauchen', async () => {
    await benutzer()
    await anfordern('rezeption@test.de')
    const token = await tokenAusPost()

    const kurz = await einloesen(token, 'x'.repeat(KENNWORT_MIN - 1))
    expect(kurz.statusCode).toBe(422)
    // Der Benutzer vertippt sich; dafuer darf sein Link nicht verfallen.
    // Sonst muss er die Ruecksetzung neu anfordern, weil er zu kurz war.
    expect((await einloesen(token, NEU)).statusCode).toBe(200)
  })

  it('beendet alle laufenden Sitzungen', async () => {
    await benutzer()
    const angemeldet = await anmelden('rezeption@test.de', ALT)
    const cookie = String(
      Array.isArray(angemeldet.headers['set-cookie'])
        ? angemeldet.headers['set-cookie'][0] : angemeldet.headers['set-cookie'])
      .split(';')[0]!
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me',
      headers: { cookie } })).statusCode).toBe(200)

    await anfordern('rezeption@test.de')
    await einloesen(await tokenAusPost(), NEU)

    // Wer sein Kennwort zuruecksetzt, tut das oft genug, weil jemand anderes
    // es kennt. Dann nuetzt das neue nichts, solange die alte Sitzung laeuft.
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me',
      headers: { cookie } })).statusCode).toBe(401)
  })

  it('entwertet die uebrigen offenen Token desselben Benutzers', async () => {
    await benutzer()
    await anfordern('rezeption@test.de')
    const erstes = await tokenAusPost()
    await anfordern('rezeption@test.de')
    const zweites = await tokenAusPost()
    expect(erstes).not.toBe(zweites)

    expect((await einloesen(zweites, NEU)).statusCode).toBe(200)
    // Sonst laege nach drei Anforderungen dreimal ein gueltiger Zugang im
    // Postfach, und jeder davon oeffnet es.
    expect((await einloesen(erstes, 'wieder-ein-anderes-kennwort')).statusCode).toBe(422)
  })

  it('nimmt die Einladung an: invited wird active', async () => {
    const id = await benutzer('neu@test.de', 'invited')
    // Eine Einladung wird nicht ueber diese Route angefordert, sondern beim
    // Anlegen verschickt. Hier steht sie als Zeile in der Tabelle, wie sie
    // der Onboarding-Endpunkt hinterlaesst (Aufgabe 13b).
    await owner.query(
      `INSERT INTO auth_token (user_id, kind, token_hash, expires_at)
       VALUES ($1,'invite', encode(sha256('probe-token'::bytea),'hex'),
               now() + interval '7 days')`, [id])

    expect((await einloesen('probe-token', NEU)).statusCode).toBe(200)
    const u = await owner.query<{ status: string }>(
      `SELECT status FROM app_user WHERE id = $1`, [id])
    expect(u.rows[0]!.status).toBe('active')
    expect((await anmelden('neu@test.de', NEU)).statusCode).toBe(200)
  })

  it('hebt die Anmeldesperre auf', async () => {
    await benutzer()
    for (let i = 0; i < 10; i++) await anmelden('rezeption@test.de', 'falsch')
    expect((await anmelden('rezeption@test.de', ALT)).statusCode).toBe(401)

    await anfordern('rezeption@test.de')
    await einloesen(await tokenAusPost(), NEU)

    // Wer sich ausgesperrt hat, setzt deshalb sein Kennwort zurueck. Bliebe
    // die Sperre stehen, waere er es danach immer noch -- mit einem Kennwort,
    // das er gerade erst vergeben hat.
    expect((await anmelden('rezeption@test.de', NEU)).statusCode).toBe(200)
  })
})
