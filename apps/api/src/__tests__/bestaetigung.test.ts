import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { BESTAETIGUNG_FEHLT, SECURITY_EVENT_KINDS } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { hashPassword } from '../routes/auth.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Kritische Handlungen verlangen eine frische Bestaetigung und hinterlassen
 * ein Sicherheitsereignis samt Hinweis an die Leitung (Migration 0208,
 * Bedrohungsanalyse 23.10.2026, T3 und E3).
 *
 * Der Angriff dahinter: eine geliehene oder gestohlene Sitzung. Sie kann
 * buchen und auschecken wie bisher -- aber die IBAN tauschen, eine
 * Hintertuer anlegen oder die Gaestedatei ziehen kann sie nur noch mit dem
 * Kennwort, und jeder in der Leitung erfaehrt davon.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let direktion: { userId: number; sessionId: string }
const KENNWORT = 'richtig-langes-kennwort'

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
  fx = await makeProperty(owner, { name: 'Wattenblick' })
  direktion = await makeUser(owner, { email: 'direktion@kunde.de',
    propertyId: fx.propertyId, roleKey: 'hotel_director', confirmed: false })
  await owner.query('UPDATE app_user SET password_hash = $2 WHERE id = $1',
    [direktion.userId, await hashPassword(KENNWORT)])
})

const iban = (session: string, wert: string, phone = '+49 4721 1234') =>
  app.inject({ method: 'PUT', url: `/v1/properties/${fx.propertyId}/invoice-settings`,
    headers: auth(session), payload: { contact: { iban: wert, phone } } })

const bestaetigen = (session: string, password: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/confirm', headers: auth(session),
    payload: { password } })

describe('Bestaetigung', () => {
  it('weist eine neue IBAN ohne Bestaetigung ab, eine Telefonnummer nicht', async () => {
    const r = await iban(direktion.sessionId, 'DE89370400440532013000')
    expect(r.statusCode).toBe(403)
    expect(r.json().type).toBe(BESTAETIGUNG_FEHLT)
    const leer = await owner.query('SELECT bank_iban FROM property WHERE id = $1', [fx.propertyId])
    expect(leer.rows[0]!.bank_iban).toBeNull()

    // Nur die Telefonnummer: Alltag, ohne Huerde.
    const t = await app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/invoice-settings`,
      headers: auth(direktion.sessionId), payload: { contact: { phone: '+49 4721 9' } } })
    expect(t.statusCode).toBe(200)
  })

  it('nimmt nach dem Kennwort an, haelt das Ereignis fest und sagt der Leitung Bescheid', async () => {
    const falsch = await bestaetigen(direktion.sessionId, 'falsch-falsch-falsch')
    expect(falsch.statusCode).toBe(401)
    expect((await iban(direktion.sessionId, 'DE89370400440532013000')).statusCode).toBe(403)

    const ok = await bestaetigen(direktion.sessionId, KENNWORT)
    expect(ok.statusCode).toBe(200)
    expect(Date.parse(ok.json().confirmedUntil)).toBeGreaterThan(Date.now())
    const stand = await app.inject({ method: 'GET', url: '/v1/auth/confirm',
      headers: auth(direktion.sessionId) })
    expect(stand.json().confirmed).toBe(true)

    expect((await iban(direktion.sessionId, 'DE89370400440532013000')).statusCode).toBe(200)

    const e = await owner.query<{ kind: string; actor_kind: string; actor_user_id: number
                                  origin: string | null; detail: Record<string, unknown> }>(
      `SELECT kind, actor_kind, actor_user_id, host(origin) AS origin, detail
         FROM security_event WHERE account_id = $1 AND kind <> 'confirmation_failed'`,
      [fx.accountId])
    expect(e.rows).toHaveLength(1)
    expect(e.rows[0]).toMatchObject({ kind: 'bank_details_changed', actor_kind: 'user',
                                      actor_user_id: direktion.userId })
    // Volle Adresse (Svens Entscheidung), die IBAN aber nur gekuerzt.
    expect(e.rows[0]!.origin).not.toBeNull()
    expect(JSON.stringify(e.rows[0]!.detail)).not.toContain('0532013000')
    expect(e.rows[0]!.detail.ibanNew).toBe('…3000')

    const post = await owner.query<{ kind: string; to_email: string; body_text: string }>(
      `SELECT kind, to_email, body_text FROM platform_email
        WHERE kind IN ('security_notice', 'security_alert') ORDER BY kind`)
    // Zwei Meldungen an uns (der Fehlversuch, dann die IBAN), ein Hinweis
    // an die Leitung -- der Fehlversuch weckt sie nicht.
    expect(post.rows.map(r => r.kind)).toEqual(['security_alert', 'security_alert',
                                                'security_notice'])
    const hinweis = post.rows.find(r => r.kind === 'security_notice')!
    expect(hinweis.to_email).toBe('direktion@kunde.de')
    // Ohne Link: eine Nachricht ueber etwas, das man nicht veranlasst hat,
    // mit einem Knopf darin, ist die Bauform jeder Phishing-Mail.
    expect(hinweis.body_text).not.toMatch(/https?:\/\//)
    expect(hinweis.body_text).toContain('…3000')
  })

  it('gilt fuenf Minuten und nur fuer die Person, die bestaetigt hat', async () => {
    expect((await bestaetigen(direktion.sessionId, KENNWORT)).statusCode).toBe(200)
    await owner.query(
      `UPDATE user_session SET confirmed_at = now() - interval '6 minutes' WHERE id = $1`,
      [direktion.sessionId])
    expect((await iban(direktion.sessionId, 'DE89370400440532013000')).statusCode).toBe(403)

    // Nach einem PIN-Wechsel handelt jemand anderes in derselben Sitzung;
    // die Bestaetigung des Vorgaengers traegt nicht hinueber.
    const kollege = await makeUser(owner, { email: 'kollege@kunde.de',
      propertyId: fx.propertyId, roleKey: 'hotel_director' })
    await owner.query(
      `UPDATE user_session SET confirmed_at = now(), confirmed_user_id = $2 WHERE id = $1`,
      [direktion.sessionId, kollege.userId])
    expect((await iban(direktion.sessionId, 'DE89370400440532013000')).statusCode).toBe(403)
  })

  it('verlangt sie auch fuer Webhook, Mandantenexport und Leitungsrolle', async () => {
    const ziel = await app.inject({ method: 'POST', url: '/v1/webhook-subscriptions',
      headers: auth(direktion.sessionId), payload: { url: 'https://example.com/hook' } })
    expect(ziel.statusCode).toBe(403)
    expect(ziel.json().type).toBe(BESTAETIGUNG_FEHLT)

    const rezeption = await makeUser(owner, { email: 'rezeption@kunde.de',
      propertyId: fx.propertyId, roleKey: 'reception' })
    const ref = (await owner.query<{ public_ref: string }>(
      'SELECT public_ref FROM app_user WHERE id = $1', [rezeption.userId])).rows[0]!.public_ref
    const rolle = (keys: string[]) => app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/users/${ref}/roles`,
      headers: auth(direktion.sessionId), payload: { roleKeys: keys } })
    // Eine Hausrolle ohne Leitungsrechte: Alltag.
    expect((await rolle(['reception', 'housekeeping'])).statusCode).toBe(200)
    // Direktion: nur mit Kennwort.
    expect((await rolle(['hotel_director'])).statusCode).toBe(403)

    expect((await bestaetigen(direktion.sessionId, KENNWORT)).statusCode).toBe(200)
    expect((await rolle(['hotel_director'])).statusCode).toBe(200)
    const e = await owner.query<{ detail: { permissions: string[] } }>(
      `SELECT detail FROM security_event WHERE kind = 'role_granted'`)
    expect(e.rows[0]!.detail.permissions).toContain('user:manage')
  })
})

describe('Sicherheitsereignis', () => {
  it('haelt ein falsches Kennwort in gueltiger Sitzung fest, ohne die Leitung zu wecken', async () => {
    expect((await bestaetigen(direktion.sessionId, 'falsch-falsch-falsch')).statusCode).toBe(401)
    const e = await owner.query<{ kind: string }>('SELECT kind FROM security_event')
    expect(e.rows.map(r => r.kind)).toEqual(['confirmation_failed'])
    const post = await owner.query<{ kind: string }>(
      `SELECT kind FROM platform_email WHERE kind LIKE 'security_%'`)
    expect(post.rows.map(r => r.kind)).toEqual(['security_alert'])
  })

  it('zeigt der Hausleitung die Ereignisse ihres Hauses mit voller Adresse, der Rezeption nicht', async () => {
    expect((await bestaetigen(direktion.sessionId, KENNWORT)).statusCode).toBe(200)
    expect((await iban(direktion.sessionId, 'DE89370400440532013000')).statusCode).toBe(200)
    const fremd = await makeProperty(owner, { name: 'Anderswo' })
    await owner.query(
      `INSERT INTO security_event (account_id, kind, actor_kind) VALUES ($1, 'export', 'system')`,
      [fremd.accountId])

    const r = await app.inject({ method: 'GET', url: '/v1/security-events',
      headers: auth(direktion.sessionId) })
    expect(r.statusCode).toBe(200)
    const events = r.json().events as Array<{ kind: string; origin: string | null }>
    expect(events.map(x => x.kind)).toEqual(['bank_details_changed'])
    expect(events[0]!.origin).toMatch(/^[0-9a-f.:]+$/)

    const rezeption = await makeUser(owner, { email: 'rezeption@kunde.de',
      propertyId: fx.propertyId, roleKey: 'reception' })
    expect((await app.inject({ method: 'GET', url: '/v1/security-events',
      headers: auth(rezeption.sessionId) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/v1/platform/security-events',
      headers: auth(direktion.sessionId) })).statusCode).toBe(403)
  })

  it('ist fuer die Anwendung unveraenderlich', async () => {
    await owner.query(
      `INSERT INTO security_event (account_id, kind, actor_kind) VALUES ($1, 'export', 'system')`,
      [fx.accountId])
    const c = await pool.connect()
    try {
      await expect(c.query('UPDATE security_event SET kind = $1', ['export']))
        .rejects.toThrow(/permission denied/)
      await expect(c.query('DELETE FROM security_event')).rejects.toThrow(/permission denied/)
      await expect(c.query(
        `INSERT INTO security_event (account_id, kind, actor_kind) VALUES (NULL, 'export', 'system')`))
        .rejects.toThrow(/permission denied/)
    } finally { c.release() }
  })

  it('kuerzt die Adresse nach 180 Tagen auf das Netz', async () => {
    await owner.query(
      `INSERT INTO security_event (account_id, kind, actor_kind, origin, created_at)
       VALUES ($1, 'export', 'system', '203.0.113.77', now() - interval '181 days'),
              ($1, 'export', 'system', '2001:db8:1:2::5', now() - interval '181 days'),
              ($1, 'export', 'system', '198.51.100.9', now())`, [fx.accountId])
    const c = await pool.connect()
    try { await c.query('SELECT security_event_prune()') } finally { c.release() }
    const r = await owner.query<{ o: string; t: boolean }>(
      `SELECT origin::text AS o, origin_truncated AS t FROM security_event ORDER BY id`)
    expect(r.rows.map(x => x.o)).toEqual(['203.0.113.0/24', '2001:db8:1::/48', '198.51.100.9/32'])
    expect(r.rows.map(x => x.t)).toEqual([true, true, false])
  })

  it('kennt dieselben Arten wie die Datenbank', async () => {
    const r = await owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'security_event'::regclass AND conname = 'security_event_kind_check'`)
    const inDb = [...r.rows[0]!.def.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort()
    expect(inDb).toEqual([...SECURITY_EVENT_KINDS].sort())
  })
})
