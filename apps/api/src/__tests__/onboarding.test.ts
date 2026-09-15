import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let plattform: string

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
  // Ein bestehender Kunde, damit sich zeigt, dass der neue nichts von ihm
  // sieht und er nichts vom neuen.
  fx = await makeProperty(owner)
  const u = await makeUser(owner,
    { email: 'plattform@hotelpms.test', platformRoleKey: 'platform_admin',
      isPlatformStaff: true })
  plattform = u.sessionId
  limiters.reset()
})

const VOLLSTAENDIG = {
  accountName: 'Seeblick Hotels GmbH',
  code: 'SEE',
  name: 'Hotel Seeblick',
  addressLine1: 'Hafenstr. 1',
  postalCode: '25813',
  city: 'Husum',
  taxNumber: '21/815/00123',
  userEmail: 'inhaber@seeblick.test',
  userName: 'Frau Meier'
}

function anlegen(body: Record<string, unknown>, session = plattform) {
  return app.inject({
    method: 'POST', url: '/v1/platform/accounts',
    headers: { cookie: `hp_session=${session}` },
    payload: body
  })
}

describe('Kunden anlegen', () => {
  it('legt Account, Haus und Inhaber an und lädt ihn ein', async () => {
    const r = await anlegen(VOLLSTAENDIG)
    expect(r.statusCode).toBe(201)
    const body = r.json() as { accountId: number; propertyId: number; userId: number }

    const p = await owner.query<{
      name: string; code: string; tax_number: string; account_id: number
      is_training: boolean; currency: string; country: string }>(
      `SELECT name, code, tax_number, account_id, is_training, currency, country
         FROM property WHERE id = $1`, [body.propertyId])
    expect(p.rows[0]!.name).toBe('Hotel Seeblick')
    expect(p.rows[0]!.tax_number).toBe('21/815/00123')
    expect(p.rows[0]!.account_id).toBe(body.accountId)
    expect(p.rows[0]!.is_training).toBe(false)

    // Inhaber, nicht Account-Admin: sonst fehlte ihm account:contract, und
    // der Kunde koennte seinen eigenen Vertrag nicht einsehen.
    const rolle = await owner.query<{ key: string }>(
      `SELECT r.key FROM user_account_role uar JOIN role r ON r.id = uar.role_id
        WHERE uar.user_id = $1`, [body.userId])
    expect(rolle.rows.map(z => z.key)).toEqual(['owner'])

    // Kein Kennwort, sondern eine Einladung. Ein Kennwort, das wir vergeben
    // und per Mail schicken, bliebe im Postfach stehen.
    const u = await owner.query<{ status: string; password_hash: string | null }>(
      `SELECT status, password_hash FROM app_user WHERE id = $1`, [body.userId])
    expect(u.rows[0]!.status).toBe('invited')
    expect(u.rows[0]!.password_hash).toBeNull()

    const t = await owner.query<{ kind: string; created_by: number | null }>(
      `SELECT kind, created_by FROM auth_token WHERE user_id = $1`, [body.userId])
    expect(t.rows[0]!.kind).toBe('invite')
    // Wer eingeladen hat, steht dabei -- bei einer Selbstruecksetzung nicht.
    expect(t.rows[0]!.created_by).not.toBeNull()

    const post = await owner.query<{ kind: string; to_email: string; body_text: string }>(
      `SELECT kind, to_email, body_text FROM platform_email WHERE user_id = $1`,
      [body.userId])
    expect(post.rows[0]!.kind).toBe('invite')
    expect(post.rows[0]!.to_email).toBe('inhaber@seeblick.test')
    expect(post.rows[0]!.body_text).toMatch(/token=/)

    // Das Token steht nicht in der Antwort: sie wird mitgelesen und
    // protokolliert, die Mail nicht.
    expect(JSON.stringify(body)).not.toMatch(/token/i)
  })

  it('öffnet einen Geschäftstag, sonst alarmiert der Worker täglich', async () => {
    const r = await anlegen(VOLLSTAENDIG)
    const { propertyId } = r.json() as { propertyId: number }

    // Ohne offenen Tag laeuft kein Nachtlauf, also wird keine Logis gebucht --
    // und bemerkt wird das vom Gast beim Check-out, nicht vom Betrieb.
    const bd = await owner.query<{ status: string }>(
      `SELECT status FROM business_day WHERE property_id = $1`, [propertyId])
    expect(bd.rows).toHaveLength(1)
    expect(bd.rows[0]!.status).toBe('open')
  })

  it('der eingeladene Inhaber kommt über den Link herein', async () => {
    const r = await anlegen(VOLLSTAENDIG)
    const { propertyId } = r.json() as { propertyId: number }

    const post = await owner.query<{ body_text: string }>(
      `SELECT body_text FROM platform_email ORDER BY id DESC LIMIT 1`)
    const token = /token=([A-Za-z0-9_-]+)/.exec(post.rows[0]!.body_text)![1]!

    const gesetzt = await app.inject({
      method: 'POST', url: '/v1/auth/password-reset/confirm',
      payload: { token, password: 'ein-ordentlich-langes-kennwort' } })
    expect(gesetzt.statusCode).toBe(200)

    const angemeldet = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: 'inhaber@seeblick.test',
                 password: 'ein-ordentlich-langes-kennwort' } })
    expect(angemeldet.statusCode).toBe(200)

    // Und er sieht genau sein eigenes Haus -- nicht das des anderen Kunden.
    const cookie = String(
      Array.isArray(angemeldet.headers['set-cookie'])
        ? angemeldet.headers['set-cookie'][0] : angemeldet.headers['set-cookie'])
      .split(';')[0]!
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me',
      headers: { cookie } })
    expect(me.statusCode).toBe(200)
    const sicht = JSON.stringify(me.json())
    expect(sicht).toContain(String(propertyId))
    expect(sicht).not.toContain(`"${fx.propertyId}"`)
  })

  it('besteht auf den Pflichtangaben nach § 14 UStG', async () => {
    const { taxNumber, ...ohne } = VOLLSTAENDIG
    expect(taxNumber).toBeTruthy()
    const r = await anlegen(ohne)
    expect(r.statusCode).toBe(422)

    // Alle vier Felder benannt, nicht nur das fehlende: es sind keine vier
    // unabhaengigen Angaben, sondern eine Bedingung.
    const fehler = (r.json() as { errors: Record<string, string[]> }).errors
    expect(Object.keys(fehler).sort())
      .toEqual(['addressLine1', 'city', 'postalCode', 'taxNumber'])

    // Nichts angelegt: ein halbes Haus waere schlimmer als keines.
    expect((await owner.query(`SELECT 1 FROM account WHERE name = $1`,
      [VOLLSTAENDIG.accountName])).rowCount).toBe(0)
  })

  it('weist eine schon vergebene Adresse ab, ohne etwas anzulegen', async () => {
    await anlegen(VOLLSTAENDIG)
    const vorher = await owner.query<{ n: string }>(`SELECT count(*) AS n FROM account`)

    const zweite = await anlegen({ ...VOLLSTAENDIG, code: 'SEE2',
      accountName: 'Andere GmbH' })
    expect(zweite.statusCode).toBe(409)

    const nachher = await owner.query<{ n: string }>(`SELECT count(*) AS n FROM account`)
    expect(nachher.rows[0]!.n).toBe(vorher.rows[0]!.n)
  })

  it('legt ein Übungshaus an, wenn darum gebeten wird', async () => {
    const r = await anlegen({ ...VOLLSTAENDIG, isTraining: true })
    const { propertyId } = r.json() as { propertyId: number }
    const p = await owner.query<{ is_training: boolean }>(
      `SELECT is_training FROM property WHERE id = $1`, [propertyId])
    expect(p.rows[0]!.is_training).toBe(true)
  })
})

describe('Wer darf das', () => {
  it('weist einen Kunden ab, auch den Inhaber eines Accounts', async () => {
    const kunde = await makeUser(owner,
      { email: 'inhaber@bestandskunde.test', accountId: fx.accountId, roleKey: 'owner' })
    const r = await anlegen(VOLLSTAENDIG, kunde.sessionId)
    // Der Inhaber hat jedes Recht ausser den Plattformrechten. Genau hier
    // zeigt sich der Unterschied.
    expect(r.statusCode).toBe(403)
    expect((await owner.query(`SELECT 1 FROM account WHERE name = $1`,
      [VOLLSTAENDIG.accountName])).rowCount).toBe(0)
  })

  it('weist Support ohne platform:accounts ab', async () => {
    const support = await makeUser(owner,
      { email: 'support@hotelpms.test', platformRoleKey: 'platform_support',
        isPlatformStaff: true })
    expect((await anlegen(VOLLSTAENDIG, support.sessionId)).statusCode).toBe(403)
  })

  it('weist einen Aufruf ohne Anmeldung ab', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/platform/accounts', payload: VOLLSTAENDIG })
    expect(r.statusCode).toBe(401)
  })

  it('account_provision selbst laesst sich aus einem Mandantenkontext nicht aufrufen', async () => {
    /*
     * Die Funktion umgeht die Zeilenrichtlinie vollstaendig. Das Recht an der
     * Route ist die eine Tuer; dies ist die zweite, und sie ist die, die
     * haelt, wenn die erste beim naechsten Umbau falsch verdrahtet wird.
     */
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.account_ids', $1, true)`, [String(fx.accountId)])
      await expect(client.query(
        `SELECT * FROM account_provision('X','X','X','A','1','O','DE','T',NULL,
           'Europe/Berlin','EUR',false,current_date,'x@test.de','X')`))
        .rejects.toThrow(/Mandantenkontext/)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
