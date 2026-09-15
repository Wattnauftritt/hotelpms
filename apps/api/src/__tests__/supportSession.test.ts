import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { SUPPORT_MAX_STUNDEN } from '../platform/support.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let support: { userId: number; sessionId: string }
let inhaber: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(15) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  await makeCategory(owner, fx.propertyId)
  await owner.query(
    `SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
    [fx.propertyId])
  support = await makeUser(owner,
    { email: 'support@wir.de', platformRoleKey: 'platform_support',
      isPlatformStaff: true })
  inhaber = await makeUser(owner,
    { email: 'inhaber@kunde.de', accountId: fx.accountId, roleKey: 'owner' })
})

const anfragen = (body: Record<string, unknown>, session = support.sessionId) =>
  app.inject({ method: 'POST', url: '/v1/platform/support-sessions',
    headers: auth(session), payload: { accountId: fx.accountId, ...body } })

const freigeben = (id: number, session = inhaber.sessionId) =>
  app.inject({ method: 'POST', url: `/v1/support-sessions/${id}/grant`,
    headers: auth(session) })

const beenden = (id: number, session = inhaber.sessionId) =>
  app.inject({ method: 'POST', url: `/v1/support-sessions/${id}/revoke`,
    headers: auth(session) })

/** Eine beliebige Fachroute, an der sich Lesen zeigt. */
const belegung = (session: string) =>
  app.inject({ method: 'GET', headers: auth(session),
    url: `/v1/properties/${fx.propertyId}/availability?from=2026-10-01&to=2026-10-05` })

describe('Anfragen', () => {
  it('legt die Sitzung ohne Wirkung an und unterrichtet den Kunden', async () => {
    const r = await anfragen({ reason: 'Rechnung 2026-000123 stimmt nicht' })
    expect(r.statusCode).toBe(201)
    const s = r.json() as { id: number; state: string; grantedAt: string | null }
    // Angefragt ist nicht freigegeben. Genau das ist der ganze Mechanismus.
    expect(s.state).toBe('pending')
    expect(s.grantedAt).toBeNull()

    // Und sie wirkt auch nicht: der Support sieht weiterhin nichts.
    expect((await belegung(support.sessionId)).statusCode).toBe(403)

    const post = await owner.query<{ kind: string; to_email: string; body_text: string }>(
      `SELECT kind, to_email, body_text FROM platform_email`)
    expect(post.rows).toHaveLength(1)
    expect(post.rows[0]!.kind).toBe('support_request')
    expect(post.rows[0]!.to_email).toBe('inhaber@kunde.de')
    // Der Anlass steht in der Mail: der Kunde entscheidet danach.
    expect(post.rows[0]!.body_text).toContain('Rechnung 2026-000123')
  })

  it('unterrichtet jeden, der freigeben darf', async () => {
    // An einem Haus ist der Inhaber im Urlaub; die Anfrage soll nicht bis zu
    // seiner Rueckkehr liegen bleiben.
    await makeUser(owner,
      { email: 'zweiter@kunde.de', accountId: fx.accountId, roleKey: 'owner' })
    await anfragen({ reason: 'Fehlersuche' })
    const post = await owner.query<{ to_email: string }>(
      `SELECT to_email FROM platform_email ORDER BY to_email`)
    expect(post.rows.map(z => z.to_email))
      .toEqual(['inhaber@kunde.de', 'zweiter@kunde.de'])
  })

  it('weist eine Anfrage ohne Anlass ab', async () => {
    // Ohne Anlass kann der Kunde nicht entscheiden, und die Einwilligung
    // waere keine.
    expect((await anfragen({ reason: '   ' })).statusCode).toBe(422)
    expect((await owner.query(`SELECT 1 FROM support_session`)).rowCount).toBe(0)
  })

  it('weist einen Account ohne Freigabeberechtigten ab', async () => {
    const leer = await owner.query<{ id: number }>(
      `INSERT INTO account (name) VALUES ('Ohne Inhaber') RETURNING id`)
    const r = await app.inject({
      method: 'POST', url: '/v1/platform/support-sessions',
      headers: auth(support.sessionId),
      payload: { accountId: leer.rows[0]!.id, reason: 'x' } })
    // Eine Anfrage, die niemand sehen kann, ist keine Anfrage.
    expect(r.statusCode).toBe(422)
  })

  it('begrenzt die Laufzeit', async () => {
    expect((await anfragen({ reason: 'x', hours: SUPPORT_MAX_STUNDEN + 1 })).statusCode)
      .toBe(422)
    expect((await anfragen({ reason: 'x', hours: 0 })).statusCode).toBe(422)
    expect((await anfragen({ reason: 'x', hours: SUPPORT_MAX_STUNDEN })).statusCode)
      .toBe(201)
  })

  it('laesst den Kunden selbst keine Sitzung anfragen', async () => {
    expect((await anfragen({ reason: 'x' }, inhaber.sessionId)).statusCode).toBe(403)
  })
})

describe('Freigeben', () => {
  it('macht die Sitzung wirksam -- lesend', async () => {
    const s = (await anfragen({ reason: 'Fehlersuche' })).json() as { id: number }
    expect((await belegung(support.sessionId)).statusCode).toBe(403)

    const g = await freigeben(s.id)
    expect(g.statusCode).toBe(200)
    expect((g.json() as { state: string }).state).toBe('active')

    // Jetzt sieht der Support die Daten -- und vorher nicht.
    const nach = await belegung(support.sessionId)
    expect(nach.statusCode).toBe(200)
  })

  it('gibt lesend keine Schreibrechte', async () => {
    const s = (await anfragen({ reason: 'Fehlersuche', level: 'read' }))
      .json() as { id: number }
    await freigeben(s.id)

    // Lesen geht.
    expect((await belegung(support.sessionId)).statusCode).toBe(200)
    // Schreiben nicht. Die Stufe steht am Zugriff, nicht am guten Willen.
    const schreiben = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/blocks`,
      headers: auth(support.sessionId),
      payload: { categoryId: 1, from: '2026-10-01', to: '2026-10-02', rooms: 1 } })
    expect(schreiben.statusCode).toBe(403)
  })

  it('haelt die Stufe fest, auch gegen die Datenbank', async () => {
    const s = (await anfragen({ reason: 'x', level: 'read' })).json() as { id: number }
    // Die Stufe nachtraeglich anzuheben ist genau der Fehler, der im
    // Protokoll nicht auffiele: dort stehen die Handlungen, nicht die
    // Rechte, unter denen sie geschahen.
    await expect(owner.query(
      `UPDATE support_session SET level = 'write' WHERE id = $1`, [s.id]))
      .rejects.toThrow(/Stufe, Anlass und Beteiligte/)
  })

  it('laesst die Frist nicht verlaengern', async () => {
    const s = (await anfragen({ reason: 'x', hours: 1 })).json() as { id: number }
    await expect(owner.query(
      `UPDATE support_session SET expires_at = now() + interval '30 days' WHERE id = $1`,
      [s.id])).rejects.toThrow(/nicht verlaengern/)
  })

  it('nimmt eine zweite Freigabe nicht an', async () => {
    const s = (await anfragen({ reason: 'x' })).json() as { id: number }
    expect((await freigeben(s.id)).statusCode).toBe(200)
    expect((await freigeben(s.id)).statusCode).toBe(409)
  })

  it('laesst einen fremden Account nicht freigeben', async () => {
    const s = (await anfragen({ reason: 'x' })).json() as { id: number }
    const fremd = await makeProperty(owner, { code: 'FREMD' })
    const fremderInhaber = await makeUser(owner,
      { email: 'fremd@woanders.de', accountId: fremd.accountId, roleKey: 'owner' })

    const r = await freigeben(s.id, fremderInhaber.sessionId)
    // Nicht 403 gegen 404 unterscheiden waere hier egal -- aber freigeben
    // darf er auf keinen Fall.
    expect(r.statusCode).toBe(422)
    expect((await belegung(support.sessionId)).statusCode).toBe(403)
  })

  it('laesst den Support seine eigene Anfrage nicht freigeben', async () => {
    const s = (await anfragen({ reason: 'x' })).json() as { id: number }
    // Das waere die stille Uebernahme, die dieser ganze Mechanismus
    // verhindern soll.
    expect((await freigeben(s.id, support.sessionId)).statusCode).toBe(403)
    expect((await belegung(support.sessionId)).statusCode).toBe(403)
  })
})

describe('Schreibende Stufe', () => {
  it('erlaubt Aendern, aber nicht die Rechte anderer', async () => {
    const s = (await anfragen({ reason: 'Korrektur auf Bitte des Kunden',
      level: 'write' })).json() as { id: number; permissions: string[] }
    await freigeben(s.id)

    expect((await belegung(support.sessionId)).statusCode).toBe(200)

    /*
     * Die beiden, an denen alles haengt: user:manage und
     * integration:manage wuerden erlauben, sich einen Benutzer oder einen
     * API-Client anzulegen. Beides ueberlebt die Sitzung -- und damit waere
     * die Befristung, also der ganze Mechanismus, umgangen.
     */
    expect(s.permissions).not.toContain('user:manage')
    expect(s.permissions).not.toContain('integration:manage')
    // Ausweisdaten (§ 30 BMG) und das Anstossen einer DSGVO-Loeschung
    // gehoeren dem Verantwortlichen, nicht dem Auftragsverarbeiter.
    expect(s.permissions).not.toContain('guest:read_identity')
    expect(s.permissions).not.toContain('guest:export')
    // Eine Rechnung traegt die Steuernummer des Hauses, nicht unsere.
    expect(s.permissions).not.toContain('invoice:issue')
    expect(s.permissions).not.toContain('report:export')
  })
})

describe('Beenden', () => {
  it('nimmt den Zugriff sofort wieder weg', async () => {
    const s = (await anfragen({ reason: 'x' })).json() as { id: number }
    await freigeben(s.id)
    expect((await belegung(support.sessionId)).statusCode).toBe(200)

    const r = await beenden(s.id)
    expect(r.statusCode).toBe(200)
    expect((r.json() as { state: string }).state).toBe('revoked')
    // Der Widerruf der Einwilligung muss so einfach wirken wie die
    // Erteilung (Art. 7 Abs. 3 DSGVO) -- also sofort.
    expect((await belegung(support.sessionId)).statusCode).toBe(403)
  })

  it('laesst auch eine noch offene Anfrage abraeumen', async () => {
    const s = (await anfragen({ reason: 'x' })).json() as { id: number }
    // Der Kunde soll nein sagen koennen, nicht nur schweigen.
    expect((await beenden(s.id)).statusCode).toBe(200)
    expect((await freigeben(s.id)).statusCode).toBe(409)
  })

  it('laesst eine widerrufene Sitzung nicht wiederbeleben', async () => {
    const s = (await anfragen({ reason: 'x' })).json() as { id: number }
    await freigeben(s.id)
    await beenden(s.id)
    await expect(owner.query(
      `UPDATE support_session SET revoked_at = NULL WHERE id = $1`, [s.id]))
      .rejects.toThrow(/wiederbeleben/)
  })
})

describe('Ablauf', () => {
  it('endet von selbst', async () => {
    const s = (await anfragen({ reason: 'x', hours: 1 })).json() as { id: number }
    await freigeben(s.id)
    expect((await belegung(support.sessionId)).statusCode).toBe(200)

    /*
     * Die Uhr vorstellen, indem die ganze Sitzung zurueckdatiert wird: eine
     * vor zwei Stunden angefragte Sitzung mit einer Stunde Laufzeit. Nur die
     * Frist zu ziehen genuegt nicht -- support_session_window besteht
     * darauf, dass eine Sitzung nach ihrer Anfrage ablaeuft, und das ist
     * richtig so.
     */
    await owner.query(
      `UPDATE support_session
          SET requested_at = now() - interval '2 hours',
              granted_at   = now() - interval '2 hours',
              expires_at   = now() - interval '1 hour'
        WHERE id = $1`, [s.id])
    // Eine Sitzung ohne Frist waere keine Sitzung, sondern ein Zugang.
    expect((await belegung(support.sessionId)).statusCode).toBe(403)
  })
})

describe('Was der Kunde sieht', () => {
  it('listet die Sitzungen des eigenen Accounts samt Anlass und Rechten', async () => {
    const s = (await anfragen({ reason: 'Rechnung stimmt nicht' })).json() as { id: number }
    const r = await app.inject({ method: 'GET', url: '/v1/support-sessions',
      headers: auth(inhaber.sessionId) })
    expect(r.statusCode).toBe(200)
    const liste = (r.json() as { sessions: Array<Record<string, unknown>> }).sessions
    expect(liste).toHaveLength(1)
    expect(liste[0]!.id).toBe(s.id)
    expect(liste[0]!.reason).toBe('Rechnung stimmt nicht')
    expect(liste[0]!.staffName).toBe('support@wir.de')
    // Damit der Kunde beim Freigeben sieht, was er freigibt.
    expect(liste[0]!.permissions).toContain('reservation:read')
  })

  it('zeigt keinem fremden Account die Sitzung', async () => {
    await anfragen({ reason: 'x' })
    const fremd = await makeProperty(owner, { code: 'FREMD' })
    const fremderInhaber = await makeUser(owner,
      { email: 'fremd@woanders.de', accountId: fremd.accountId, roleKey: 'owner' })
    const r = await app.inject({ method: 'GET', url: '/v1/support-sessions',
      headers: auth(fremderInhaber.sessionId) })
    expect((r.json() as { sessions: unknown[] }).sessions).toHaveLength(0)
  })

  it('haelt im Protokoll fest, unter welcher Sitzung gehandelt wurde', async () => {
    const s = (await anfragen({ reason: 'x' })).json() as { id: number }
    await freigeben(s.id)
    await belegung(support.sessionId)

    // Die Freigabe selbst steht im Protokoll, mit dem Benutzer, der sie
    // erteilt hat. Ohne das waere im Streitfall nicht zu zeigen, dass der
    // Kunde zugestimmt hat.
    const log = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE table_name = 'support_session'`)
    expect(Number(log.rows[0]!.n)).toBeGreaterThan(0)
  })
})
