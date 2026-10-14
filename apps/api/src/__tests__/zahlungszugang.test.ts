import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { loadConfig } from '../platform/config.js'
import { stripeZugangQuelle } from '../platform/payments/zugang.js'

/**
 * Der Stripe-Zugang der Plattform im Adminpanel (Migration 0168).
 *
 * Geprueft wird, was ein Betreiber ohne Terminal braucht: der Wert gilt
 * nach dem Speichern sofort, die Geheimnisse kommen nirgends wieder heraus
 * -- nicht aus der Antwort, nicht aus der Zeile, nicht aus dem Protokoll --
 * und nur die Plattformverwaltung kommt heran.
 */

// Zusammengesetzt, damit der Geheimnis-Scanner von GitHub die Attrappe
// nicht fuer einen echten Schluessel haelt und den Push abweist.
const KEY = ['sk', 'live', 'attrappeNurFuerTestsUvWx'].join('_')
const WHSEC = ['whsec', 'attrappeNurFuerTests1234'].join('_')
const CLIENT = 'ca_TestPlattform1234567'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let admin: string
let abrechnung: string
let support: string
let direktion: string

const auth = (s: string) => ({ cookie: `hp_session=${s}` })
const lesen = (s: string) =>
  app.inject({ method: 'GET', url: '/v1/platform/payment-provider', headers: auth(s) })
const speichern = (s: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: '/v1/platform/payment-provider', headers: auth(s), payload })

interface Sicht {
  connectClientId: { value: string | null; source: string | null }
  secretKey: { hint: string | null; source: string | null }
  webhookSecret: { set: boolean; source: string | null }
  ready: boolean
  webhookUrl: string
}

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  // Ohne Umgebungswerte: genau die Lage, fuer die das Panel gebaut ist.
  delete process.env.STRIPE_SECRET_KEY
  delete process.env.STRIPE_WEBHOOK_SECRET
  delete process.env.STRIPE_CONNECT_CLIENT_ID
  const built = await buildServer({ pool: appPool(10) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

beforeEach(async () => {
  await truncateAll()
  await owner.query('DELETE FROM platform_payment_provider')
  fx = await makeProperty(owner)
  admin = (await makeUser(owner, { email: 'admin@wir.de',
    platformRoleKey: 'platform_admin', isPlatformStaff: true })).sessionId
  abrechnung = (await makeUser(owner, { email: 'abrechnung@wir.de',
    platformRoleKey: 'platform_billing', isPlatformStaff: true })).sessionId
  support = (await makeUser(owner, { email: 'support@wir.de',
    platformRoleKey: 'platform_support', isPlatformStaff: true })).sessionId
  direktion = (await makeUser(owner, { email: 'chef@hotel.de',
    propertyId: fx.propertyId, roleKey: 'hotel_director' })).sessionId
  // Der Zwischenspeicher der Routen lebt ueber Tests hinweg; ein Lesen
  // leert ihn, damit kein Test den Zugang des vorigen sieht.
  await lesen(admin)
})

describe('Zugriff', () => {
  it('nur Plattformverwaltung und Abrechnung', async () => {
    expect((await lesen(admin)).statusCode).toBe(200)
    expect((await lesen(abrechnung)).statusCode).toBe(200)
    expect((await lesen(support)).statusCode).toBe(403)
    expect((await lesen(direktion)).statusCode).toBe(403)
    expect((await speichern(support, { connectClientId: CLIENT })).statusCode).toBe(403)
    expect((await speichern(direktion, { connectClientId: CLIENT })).statusCode).toBe(403)
  })
})

describe('Eintragen', () => {
  it('ohne Eintrag: nicht bereit, nichts gesetzt', async () => {
    const d = (await lesen(admin)).json() as Sicht
    expect(d.ready).toBe(false)
    expect(d.connectClientId.source).toBeNull()
    expect(d.secretKey.source).toBeNull()
    expect(d.webhookSecret.set).toBe(false)
    expect(d.webhookUrl).toMatch(/\/v1\/payments\/stripe\/webhook$/)
  })

  it('weist vertauschte oder fremde Werte ab', async () => {
    // Der haeufigste Fehler: der oeffentliche Schluessel statt des geheimen.
    const r = await speichern(admin, { secretKey: 'pk_live_51AbCdEfGhIjKlMn',
                                       webhookSecret: KEY, connectClientId: 'acct_123' })
    expect(r.statusCode).toBe(422)
    const body = JSON.stringify(r.json())
    expect(body).toContain('secretKey')
    expect(body).toContain('webhookSecret')
    expect(body).toContain('connectClientId')
    const z = await owner.query('SELECT 1 FROM platform_payment_provider')
    expect(z.rowCount).toBe(0)
  })

  it('gilt sofort, ohne Neustart, und gibt die Geheimnisse nicht wieder heraus', async () => {
    const vorher = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/payment-account`, headers: auth(direktion) })
    expect((vorher.json() as { configured: boolean }).configured).toBe(false)

    const r = await speichern(admin, { connectClientId: CLIENT, secretKey: KEY,
                                       webhookSecret: WHSEC })
    expect(r.statusCode).toBe(200)

    const sicht = await lesen(admin)
    const d = sicht.json() as Sicht
    expect(d.ready).toBe(true)
    expect(d.connectClientId).toEqual({ value: CLIENT, source: 'panel' })
    expect(d.secretKey).toEqual({ hint: 'sk_live_…UvWx', source: 'panel' })
    expect(d.webhookSecret).toEqual({ set: true, source: 'panel' })
    expect(sicht.body).not.toContain(KEY)
    expect(sicht.body).not.toContain(WHSEC)

    // Das Haus sieht den Zugang mit der naechsten Anfrage.
    const nachher = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/payment-account`, headers: auth(direktion) })
    expect((nachher.json() as { configured: boolean }).configured).toBe(true)

    // Weder in der Zeile noch im Protokoll im Klartext.
    const zeile = await owner.query<{ t: string }>(
      `SELECT row_to_json(p)::text AS t FROM platform_payment_provider p`)
    expect(zeile.rows[0]!.t).not.toContain(KEY.slice(8))
    expect(zeile.rows[0]!.t).not.toContain(WHSEC.slice(6))
    const protokoll = await owner.query<{ t: string }>(
      `SELECT row_to_json(a)::text AS t FROM audit_log a
        WHERE table_name = 'platform_payment_provider'`)
    expect(protokoll.rowCount).toBeGreaterThan(0)
    for (const p of protokoll.rows) {
      expect(p.t).not.toContain('secret_key_enc":"')
      expect(p.t).not.toContain(KEY.slice(8))
    }
  })

  it('ein leeres Feld laesst den Wert stehen, null entfernt ihn', async () => {
    await speichern(admin, { connectClientId: CLIENT, secretKey: KEY })
    await speichern(admin, { connectClientId: '', webhookSecret: WHSEC })
    let d = (await lesen(admin)).json() as Sicht
    expect(d.connectClientId.value).toBe(CLIENT)
    expect(d.secretKey.source).toBe('panel')
    expect(d.ready).toBe(true)

    await speichern(admin, { secretKey: null })
    d = (await lesen(admin)).json() as Sicht
    expect(d.secretKey).toEqual({ hint: null, source: null })
    expect(d.ready).toBe(false)
  })

  it('die Umgebungsdatei geht vor', async () => {
    await speichern(admin, { connectClientId: CLIENT, secretKey: KEY, webhookSecret: WHSEC })
    const config = { ...loadConfig(), stripeConnectClientId: 'ca_AusDerUmgebung123',
                     stripeWebhookSecret: null, stripeSecretKey: null }
    const z = await stripeZugangQuelle(config).laden(pool)
    expect(z.connectClientId).toBe('ca_AusDerUmgebung123')
    expect(z.webhookSecret).toBe(WHSEC)
    expect(z.stripe).not.toBeNull()
  })

  it('ein Chiffrat unter anderem Schluessel gilt als nicht eingetragen', async () => {
    await speichern(admin, { secretKey: KEY, webhookSecret: WHSEC })
    const config = { ...loadConfig(), idDocumentKey: 'ein-ganz-anderer-schluessel-0123456789' }
    const z = await stripeZugangQuelle(config).laden(pool)
    expect(z.stripe).toBeNull()
    expect(z.webhookSecret).toBeNull()
  })
})
