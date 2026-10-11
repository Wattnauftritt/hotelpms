import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         countQueries, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import type { Principal } from '../platform/context.js'

/**
 * Die Anmeldung je Anfrage in einer Runde (Migration 0142).
 *
 * Performance-Audit 11.10.2026, Befund 8: vor jedem Handler liefen rund
 * zehn Anweisungen -- Sitzung, Benutzer, Rollen, Account- und Hausbereich,
 * geteiltes Personal, Support-Sitzung, last_seen_at --, und keine davon
 * stand im Abfragezaehler. Geprueft wird die Zahl **vor** dem Handler: die
 * Route hier liest nichts aus der Datenbank, also ist alles, was gezaehlt
 * wird, Anmeldung. Dass die Rechte dabei dieselben bleiben, pruefen die
 * Tests zu Anmeldung, Support-Sitzung, Arbeitsplatzwechsel und Sicherheits-
 * audit; hier steht nur, dass jeder dieser Wege eine Runde kostet.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture

interface Sicht {
  userId: number | null
  sessionUserId: number | null
  supportSessionId: number | null
  accountIds: number[]
  properties: Array<[number, string[]]>
}

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(4) })
  app = built.app
  pool = built.pool
  // An registerRoute vorbei und nur in diesem Server: eine Route, die
  // nichts liest, damit jede gezaehlte Anweisung zur Anmeldung gehoert.
  app.get('/test/principal', async (req): Promise<Sicht> => {
    const p = req.principal as Principal
    return {
      userId: p.userId, sessionUserId: p.sessionUserId,
      supportSessionId: p.supportSessionId, accountIds: p.accountIds,
      properties: [...p.permissionsByProperty].map(([id, s]) => [id, [...s].sort()])
    }
  })
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
})

async function mitSitzung(sessionId: string) {
  const { result, report } = await countQueries(pool, () => app.inject({
    method: 'GET', url: '/test/principal', headers: { cookie: `hp_session=${sessionId}` } }))
  expect(result.statusCode).toBe(200)
  return { sicht: result.json() as Sicht, report }
}

describe('Anmeldung je Anfrage', () => {
  it('kostet eine Anweisung vor dem Handler', async () => {
    const u = await makeUser(owner,
      { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const { sicht, report } = await mitSitzung(u.sessionId)
    expect(report.statements).toEqual(['SELECT * FROM session_principal($1)'])
    expect(sicht).toMatchObject({ userId: u.userId, sessionUserId: u.userId,
                                  supportSessionId: null, accountIds: [fx.accountId] })
    expect(sicht.properties).toHaveLength(1)
    expect(sicht.properties[0]![0]).toBe(fx.propertyId)
    expect(sicht.properties[0]![1]).toContain('reservation:write')
  })

  it('kostet auch beim Arbeitsplatzwechsel nur eine', async () => {
    const angemeldet = await makeUser(owner,
      { email: 'a@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const handelnd = await makeUser(owner,
      { email: 'b@test.de', propertyId: fx.propertyId, roleKey: 'housekeeping_staff' })
    await owner.query(`UPDATE user_session SET active_user_id = $2 WHERE id = $1`,
      [angemeldet.sessionId, handelnd.userId])
    const { sicht, report } = await mitSitzung(angemeldet.sessionId)
    expect(report.count).toBe(1)
    // Rechte der handelnden Person, Sitzung der angemeldeten.
    expect(sicht.userId).toBe(handelnd.userId)
    expect(sicht.sessionUserId).toBe(angemeldet.userId)
    expect(sicht.properties[0]![1]).not.toContain('reservation:write')
  })

  it('kostet auch fuer Plattformpersonal mit Support-Sitzung nur eine', async () => {
    const staff = await makeUser(owner,
      { email: 'support@staygrid.test', isPlatformStaff: true })
    const ohne = await mitSitzung(staff.sessionId)
    expect(ohne.report.count).toBe(1)
    expect(ohne.sicht).toMatchObject({ userId: staff.userId, accountIds: [],
                                       properties: [], supportSessionId: null })

    const s = await owner.query<{ id: number }>(
      `INSERT INTO support_session (account_id, platform_user_id, reason, granted_at,
                                    expires_at, level)
       VALUES ($1, $2, 'Test', now(), now() + interval '1 hour', 'read') RETURNING id`,
      [fx.accountId, staff.userId])
    const mit = await mitSitzung(staff.sessionId)
    expect(mit.report.count).toBe(1)
    expect(mit.sicht).toMatchObject({ supportSessionId: s.rows[0]!.id,
                                      accountIds: [fx.accountId] })
    expect(mit.sicht.properties.map(([id]) => id)).toEqual([fx.propertyId])
  })

  it('laesst widerrufene, abgelaufene Sitzungen und gesperrte Benutzer anonym', async () => {
    const u = await makeUser(owner,
      { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })

    await owner.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [u.userId])
    const gesperrt = await mitSitzung(u.sessionId)
    expect(gesperrt.report.count).toBe(1)
    expect(gesperrt.sicht.userId).toBeNull()
    expect(gesperrt.sicht.properties).toEqual([])
    await owner.query(`UPDATE app_user SET status = 'active' WHERE id = $1`, [u.userId])

    await owner.query(
      `UPDATE user_session SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [u.sessionId])
    expect((await mitSitzung(u.sessionId)).sicht.userId).toBeNull()

    await owner.query(
      `UPDATE user_session SET expires_at = now() + interval '1 hour', revoked_at = now()
        WHERE id = $1`, [u.sessionId])
    expect((await mitSitzung(u.sessionId)).sicht.userId).toBeNull()
  })

  it('schreibt last_seen_at hoechstens einmal je Minute', async () => {
    const u = await makeUser(owner,
      { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const zuletzt = async () => (await owner.query<{ t: Date }>(
      `SELECT last_seen_at AS t FROM user_session WHERE id = $1`, [u.sessionId])).rows[0]!.t

    await owner.query(
      `UPDATE user_session SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`,
      [u.sessionId])
    const vorher = await zuletzt()
    await mitSitzung(u.sessionId)
    const nachher = await zuletzt()
    expect(nachher.getTime()).toBeGreaterThan(vorher.getTime())

    await mitSitzung(u.sessionId)
    expect((await zuletzt()).getTime()).toBe(nachher.getTime())
  })
})
