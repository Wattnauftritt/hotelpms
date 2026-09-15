import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let betrieb: { userId: number; sessionId: string }

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
  fx = await makeProperty(owner)
  betrieb = await makeUser(owner,
    { email: 'betrieb@wir.de', platformRoleKey: 'platform_ops', isPlatformStaff: true })
})

const anfordern = (session = betrieb.sessionId) =>
  app.inject({ method: 'POST', url: '/v1/platform/deployments',
    headers: auth(session) })

const liste = (session = betrieb.sessionId) =>
  app.inject({ method: 'GET', url: '/v1/platform/deployments', headers: auth(session) })

describe('Ausrollen anfordern', () => {
  it('schreibt eine Zeile und rollt selbst nichts aus', async () => {
    const r = await anfordern()
    expect(r.statusCode).toBe(202)
    const d = r.json() as { status: string; targetRef: string; requestedBy: string }
    // Angefordert, nicht ausgefuehrt: die API laeuft unter
    // NoNewPrivileges und koennte es gar nicht.
    expect(d.status).toBe('pending')
    // Der Marker, nicht main. Was ausgerollt wird, entscheidet nicht dieser
    // Knopf, sondern wer den Tag verschiebt.
    expect(d.targetRef).toBe('produktion')
    expect(d.requestedBy).toBe('betrieb@wir.de')

    const z = await owner.query<{ status: string; started_at: string | null }>(
      `SELECT status, started_at FROM deploy_request`)
    expect(z.rows).toHaveLength(1)
    expect(z.rows[0]!.started_at).toBeNull()
  })

  it('laesst keine zweite Anforderung neben einer offenen zu', async () => {
    expect((await anfordern()).statusCode).toBe(202)
    // Zwei gleichzeitige Laeufe zoegen sich im selben Verzeichnis die
    // Dateien weg, und heraus kaeme ein halber Stand.
    const zweite = await anfordern()
    expect(zweite.statusCode).toBe(409)
    expect((await owner.query(`SELECT 1 FROM deploy_request`)).rowCount).toBe(1)
  })

  it('laesst nach einem abgeschlossenen Lauf wieder anfordern', async () => {
    await anfordern()
    await owner.query(
      `UPDATE deploy_request SET status='done', finished_at=now(),
              commit_after='abc123'`)
    expect((await anfordern()).statusCode).toBe(202)
  })

  it('gibt auch einem gescheiterten Lauf den Weg frei', async () => {
    await anfordern()
    await owner.query(`UPDATE deploy_request SET status='failed', finished_at=now()`)
    // Sonst blockierte ein einziger Fehlschlag den Knopf fuer immer.
    expect((await anfordern()).statusCode).toBe(202)
  })
})

describe('Was gerade laeuft', () => {
  it('meldet den Stand des letzten geglueckten Laufs', async () => {
    await anfordern()
    await owner.query(
      `UPDATE deploy_request SET status='done', finished_at=now(),
              commit_before='alt', commit_after='neu'`)

    const r = await liste()
    expect(r.statusCode).toBe(200)
    const d = r.json() as { currentCommit: string | null
                            deployments: Array<Record<string, unknown>> }
    expect(d.currentCommit).toBe('neu')
    expect(d.deployments).toHaveLength(1)
  })

  it('meldet nichts, solange kein Lauf geglueckt ist', async () => {
    await anfordern()
    await owner.query(`UPDATE deploy_request SET status='failed', finished_at=now()`)
    // Ein gescheiterter Lauf hat nichts auf die Maschine gebracht. Seinen
    // Commit als laufend zu melden waere eine Luege im ruhigsten Moment.
    expect((await liste()).json()).toMatchObject({ currentCommit: null })
  })

  it('zeigt einen Lauf von Hand ohne Benutzer', async () => {
    // Auf der Maschine gibt es keinen angemeldeten Benutzer. Die Zeile
    // gehoert trotzdem in die Liste, sonst zeigt sie einen Stand, den ein
    // Handlauf laengst ueberholt hat.
    await owner.query(
      `INSERT INTO deploy_request (target_ref, status, finished_at, commit_after)
       VALUES ('produktion','done', now(), 'vonhand')`)
    const d = (await liste()).json() as {
      currentCommit: string | null; deployments: Array<{ requestedBy: string | null }> }
    expect(d.currentCommit).toBe('vonhand')
    expect(d.deployments[0]!.requestedBy).toBeNull()
  })
})

describe('Wer darf das', () => {
  it('weist einen Kunden ab, auch den Inhaber', async () => {
    const inhaber = await makeUser(owner,
      { email: 'inhaber@kunde.de', accountId: fx.accountId, roleKey: 'owner' })
    expect((await anfordern(inhaber.sessionId)).statusCode).toBe(403)
    expect((await liste(inhaber.sessionId)).statusCode).toBe(403)
    expect((await owner.query(`SELECT 1 FROM deploy_request`)).rowCount).toBe(0)
  })

  it('weist Plattformpersonal ohne platform:operations ab', async () => {
    const abrechnung = await makeUser(owner,
      { email: 'abrechnung@wir.de', platformRoleKey: 'platform_billing',
        isPlatformStaff: true })
    expect((await anfordern(abrechnung.sessionId)).statusCode).toBe(403)
  })

  it('weist einen Aufruf ohne Anmeldung ab', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/platform/deployments' }))
      .statusCode).toBe(401)
  })
})
