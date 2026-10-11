import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser }
  from '@hotelpms/testing'
import { serializeLogError, type Pool } from '@hotelpms/db'
import { hashToken, isPlatformDomain } from '@hotelpms/domain'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { hashPassword } from '../routes/auth.js'
import { limiters } from '../platform/rateLimit.js'
import { needSecret, isSecureTransport, platformDomainsOf } from '../platform/config.js'

/*
 * Die niedrigen Befunde aus dem Sicherheitsaudit vom 11.10.2026 (Bericht in
 * den Projektdateien, security/audit-2026-10-11.md). Jeder Fall hier lief
 * vor der Behebung anders aus.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(5) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })
beforeEach(async () => { await truncateAll(); limiters.reset() })

async function pinSetzen(userId: number, pin: string): Promise<void> {
  await owner.query(
    `UPDATE app_user SET workstation_pin_hash = $2, workstation_pin_set_at = now()
      WHERE id = $1`, [userId, await hashPassword(pin)])
}

async function zaehler(userId: number): Promise<{ n: number; gesperrt: boolean }> {
  const r = await owner.query<{ n: number; gesperrt: boolean }>(
    `SELECT workstation_pin_failed_count AS n,
            workstation_pin_locked_until IS NOT NULL AS gesperrt
       FROM app_user WHERE id = $1`, [userId])
  return r.rows[0]!
}

const wechseln = (sessionId: string, email: string, pin: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/workstation-switch',
               headers: auth(sessionId), payload: { email, pin } })

describe('N2: Arbeitsplatz-PIN', () => {
  /**
   * Vorher zaehlte jeder falsche PIN, auch von einem Angemeldeten eines
   * ganz anderen Kunden. Der konnte so den Personenwechsel eines Fremden
   * sperren, dessen Adresse er kannte -- ohne je wechseln zu koennen.
   */
  it('zaehlt keinen Fehlversuch aus einem fremden Haus', async () => {
    const A = await makeProperty(owner, { name: 'Haus A', code: 'AAA' })
    const B = await makeProperty(owner, { name: 'Haus B', code: 'BBB' })
    const angreifer = await makeUser(owner,
      { email: 'a@a.de', propertyId: A.propertyId, roleKey: 'reception' })
    const opfer = await makeUser(owner,
      { email: 'opfer@b.de', propertyId: B.propertyId, roleKey: 'reception' })
    await pinSetzen(angreifer.userId, '1111')
    await pinSetzen(opfer.userId, '4711')

    for (let i = 0; i < 7; i++) {
      const r = await wechseln(angreifer.sessionId, 'opfer@b.de', '0000')
      expect(r.statusCode).toBe(401)
      // Dieselbe Meldung wie bei einem falschen PIN im eigenen Haus.
      expect(JSON.parse(r.body).code).toBe('auth.badPin')
    }
    expect(await zaehler(opfer.userId)).toEqual({ n: 0, gesperrt: false })

    // Und das Opfer wechselt in seinem eigenen Haus ungehindert.
    const kollege = await makeUser(owner,
      { email: 'kollege@b.de', propertyId: B.propertyId, roleKey: 'reception' })
    await pinSetzen(kollege.userId, '2222')
    expect((await wechseln(kollege.sessionId, 'opfer@b.de', '4711')).statusCode).toBe(200)
  })

  /**
   * Der Zaehler blieb nach der Sperre bei fuenf stehen. Danach sperrte schon
   * der naechste Tippfehler wieder eine Viertelstunde. Jetzt faellt er mit
   * der Sperre auf null, und nach ihrem Ablauf gilt die volle Logik wieder.
   */
  it('setzt den Zaehler mit der Sperre zurueck', async () => {
    const A = await makeProperty(owner, { name: 'Haus A', code: 'AAA' })
    const tag = await makeUser(owner,
      { email: 'tag@a.de', propertyId: A.propertyId, roleKey: 'reception' })
    const nacht = await makeUser(owner,
      { email: 'nacht@a.de', propertyId: A.propertyId, roleKey: 'reception' })
    await pinSetzen(tag.userId, '1111')
    await pinSetzen(nacht.userId, '4711')

    for (let i = 0; i < 4; i++) await wechseln(tag.sessionId, 'nacht@a.de', '0000')
    expect(await zaehler(nacht.userId)).toEqual({ n: 4, gesperrt: false })
    await wechseln(tag.sessionId, 'nacht@a.de', '0000')
    expect(await zaehler(nacht.userId)).toEqual({ n: 0, gesperrt: true })

    // Waehrend der Sperre hilft auch der richtige PIN nicht.
    expect((await wechseln(tag.sessionId, 'nacht@a.de', '4711')).statusCode).toBe(401)

    // Die Viertelstunde ist um.
    await owner.query(
      `UPDATE app_user SET workstation_pin_locked_until = now() - interval '1 minute'
        WHERE id = $1`, [nacht.userId])

    // Ein Tippfehler sperrt jetzt nicht sofort wieder.
    const r = await wechseln(tag.sessionId, 'nacht@a.de', '0000')
    expect(r.statusCode).toBe(401)
    expect(await zaehler(nacht.userId)).toEqual({ n: 1, gesperrt: false })
    expect((await wechseln(tag.sessionId, 'nacht@a.de', '4711')).statusCode).toBe(200)
    expect(await zaehler(nacht.userId)).toEqual({ n: 0, gesperrt: false })
  })
})

describe('N4: payment_link_scope nur bei aktivem Account und Haus', () => {
  async function link(propertyId: number, token: string): Promise<void> {
    const f = await owner.query<{ id: number }>(
      `INSERT INTO folio (property_id, kind) VALUES ($1, 'house') RETURNING id`,
      [propertyId])
    await owner.query(
      `INSERT INTO payment_link (property_id, folio_id, token_hash, amount_cent, valid_until)
       VALUES ($1, $2, $3, 5000, current_date + 30)`,
      [propertyId, f.rows[0]!.id, hashToken(token)])
  }
  // Als Anwendungsrolle und ohne Kontext, wie die Zahlungsseite des Gastes.
  const scope = async (token: string) => (await pool.query(
    `SELECT property_id FROM payment_link_scope($1)`, [hashToken(token)])).rowCount

  it('loest bei aktivem Haus auf, bei gesperrtem Account oder stillgelegtem Haus nicht', async () => {
    const A = await makeProperty(owner, { name: 'Haus A', code: 'AAA' })
    await link(A.propertyId, 'token-a')
    expect(await scope('token-a')).toBe(1)

    await owner.query(`UPDATE account SET status = 'suspended' WHERE id = $1`, [A.accountId])
    expect(await scope('token-a')).toBe(0)

    await owner.query(`UPDATE account SET status = 'active' WHERE id = $1`, [A.accountId])
    await owner.query(`UPDATE property SET status = 'archived' WHERE id = $1`, [A.propertyId])
    expect(await scope('token-a')).toBe(0)
  })

  it('setzt pg_temp ans Ende des Suchpfads', async () => {
    const r = await owner.query<{ proconfig: string[] }>(
      `SELECT proconfig FROM pg_proc WHERE proname = 'payment_link_scope'`)
    expect(r.rows[0]!.proconfig).toContain('search_path=public, pg_temp')
  })
})

describe('N5: Plattformdomains sind keine eigene Absenderdomain', () => {
  const plattform = platformDomainsOf('mail.staygrid.cloud', 'info@staygrid.cloud')

  it('erkennt die Domain und alles darunter, an der Punktgrenze', () => {
    for (const d of ['staygrid.cloud', 'mail.staygrid.cloud', 'x.mail.staygrid.cloud',
                     'MAIL.StayGrid.Cloud.', 'post@mail.staygrid.cloud']) {
      expect(isPlatformDomain(d, plattform), d).toBe(true)
    }
    for (const d of ['nichtstaygrid.cloud', 'staygrid.cloud.example', 'wattenblick.de', '']) {
      expect(isPlatformDomain(d, plattform), d).toBe(false)
    }
    // Eine selbst betriebene Installation mit eigener Relay-Domain sperrt
    // auch diese, und die Produktdomain bleibt gesperrt.
    const eigen = platformDomainsOf('mail.example.org', 'ops@example.org')
    expect(isPlatformDomain('mail.example.org', eigen)).toBe(true)
    expect(isPlatformDomain('example.org', eigen)).toBe(true)
    expect(isPlatformDomain('staygrid.cloud', eigen)).toBe(true)
  })

  it('weist den Antrag ab', async () => {
    const A = await makeProperty(owner, { name: 'Haus A', code: 'AAA' })
    const chef = await makeUser(owner,
      { email: 'chef@a.de', propertyId: A.propertyId, roleKey: 'hotel_director' })
    for (const domain of ['mail.staygrid.cloud', 'staygrid.cloud', 'rechnung@x.staygrid.cloud']) {
      const r = await app.inject({
        method: 'POST', url: `/v1/properties/${A.propertyId}/email-domain`,
        headers: auth(chef.sessionId), payload: { mode: 'own', domain } })
      expect(r.statusCode, domain).toBe(422)
      expect(JSON.parse(r.body).code).toBe('domain.platformDomain')
    }
    const n = await owner.query(`SELECT 1 FROM property_email_domain`)
    expect(n.rowCount).toBe(0)
  })

  /**
   * Ein Antrag von vor dieser Pruefung kann noch offen stehen. Die Freigabe
   * weist ihn ab, bevor der Anbieter gefragt wird -- ohne eingerichteten
   * Anbieter kaeme sonst `providerNotConfigured`.
   */
  it('weist die Freigabe eines alten Antrags ab', async () => {
    const A = await makeProperty(owner, { name: 'Haus A', code: 'AAA' })
    await owner.query(
      `INSERT INTO property_email_domain (property_id, mode, domain, status)
       VALUES ($1, 'own', 'mail.staygrid.cloud', 'requested')`, [A.propertyId])
    const admin = await makeUser(owner,
      { email: 'admin@wir.de', platformRoleKey: 'platform_admin', isPlatformStaff: true })
    const r = await app.inject({
      method: 'POST', url: `/v1/platform/email-domains/${A.propertyId}/approve`,
      headers: auth(admin.sessionId), payload: {} })
    expect(r.statusCode, r.body).toBe(422)
    expect(JSON.parse(r.body).code).toBe('domain.platformDomain')
    const s = await owner.query<{ status: string }>(
      `SELECT status FROM property_email_domain WHERE property_id = $1`, [A.propertyId])
    expect(s.rows[0]!.status).toBe('requested')
  })
})

describe('N6: Secure-Cookie haengt an der oeffentlichen Adresse', () => {
  it('gilt bei https auch mit NODE_ENV=development', () => {
    expect(isSecureTransport('development', 'https://app.staygrid.cloud')).toBe(true)
    expect(isSecureTransport('production', 'http://localhost:5173')).toBe(true)
    expect(isSecureTransport('development', 'http://localhost:5173')).toBe(false)
    expect(isSecureTransport('test', 'http://localhost:5173')).toBe(false)
  })
})

describe('N7: Beispielgeheimnisse in Produktion', () => {
  const NAME = 'SICHERHEITSAUDIT_TEST_GEHEIMNIS'
  const mit = (wert: string, f: () => void) => {
    process.env[NAME] = wert
    try { f() } finally { delete process.env[NAME] }
  }

  it('weist den Wert aus .env.example in Produktion ab', () => {
    mit('entwicklung-nur-bitte-in-produktion-ersetzen-0002', () => {
      expect(() => needSecret(NAME, 'production')).toThrow(/Beispielwert/)
      // Entwicklung und Test brauchen genau diese Werte.
      expect(needSecret(NAME, 'development')).toMatch(/^entwicklung-/)
      expect(needSecret(NAME, 'test')).toMatch(/^entwicklung-/)
    })
    mit('Entwicklung-nur-bitte-in-produktion-ersetzen-0002', () => {
      expect(() => needSecret(NAME, 'production')).toThrow(/Beispielwert/)
    })
  })

  it('laesst ein eigenes Geheimnis durch und prueft weiter die Laenge', () => {
    mit('x'.repeat(48), () => {
      expect(needSecret(NAME, 'production')).toBe('x'.repeat(48))
    })
    mit('kurz', () => {
      expect(() => needSecret(NAME, 'production')).toThrow(/kuerzer/)
    })
  })
})

describe('N10: Datenbankfehler ohne Zeileninhalt im Protokoll', () => {
  it('laesst detail, where und hint eines echten pg-Fehlers weg', async () => {
    const fehler: Error = await owner.query(
      `DO $$ BEGIN
         RAISE EXCEPTION 'Bedingung verletzt' USING
           ERRCODE = '23514', DETAIL = 'Failing row contains (17, Petersen)',
           HINT = 'Petersen';
       END $$`).then(() => new Error('kein Fehler'), (e: Error) => e)
    // Das Original traegt die Zeile, sonst prueft der Test nichts.
    expect((fehler as { detail?: string }).detail).toContain('Petersen')
    expect((fehler as { where?: string }).where).toBeDefined()

    const s = serializeLogError(fehler) as Record<string, unknown>
    expect(s.message).toBe('Bedingung verletzt')
    expect(s.code).toBe('23514')
    expect(s.stack).toEqual(expect.any(String))
    for (const feld of ['detail', 'where', 'hint']) expect(s).not.toHaveProperty(feld)
    expect(JSON.stringify(s)).not.toContain('Petersen')
  })

  it('prueft auch eine eingewickelte Ursache und fremde Felder', () => {
    const innen = Object.assign(new Error('innen'),
      { detail: 'Petersen', parameters: ['Petersen'], constraint: 'guest_chk' })
    const aussen = Object.assign(new Error('aussen', { cause: innen }),
      { query: 'INSERT ... Petersen', values: ['Petersen'] })
    const s = serializeLogError(aussen) as Record<string, unknown>
    expect(JSON.stringify(s)).not.toContain('Petersen')
    expect((s.cause as Record<string, unknown>).constraint).toBe('guest_chk')
    // Alles, was kein Error ist, geht unveraendert durch.
    expect(serializeLogError('text' as unknown as Error)).toBe('text')
  })
})
