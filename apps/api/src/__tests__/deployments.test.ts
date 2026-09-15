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

describe('Zurueckrollen', () => {
  /** Einen geglueckten Lauf mit gegebenem Stand hinterlassen. */
  async function gelaufen(commit: string): Promise<void> {
    await owner.query(
      `INSERT INTO deploy_request (target_ref, status, finished_at, commit_after)
       VALUES ('produktion','done', now(), $1)`, [commit])
  }

  const rollback = (commit: string, session = betrieb.sessionId) =>
    app.inject({ method: 'POST', url: '/v1/platform/deployments/rollback',
      headers: auth(session), payload: { commit } })

  it('reiht einen Rollback auf einen frueheren Stand ein', async () => {
    await gelaufen('aaaaaaa1')
    await gelaufen('bbbbbbb2')

    const r = await rollback('aaaaaaa1')
    expect(r.statusCode).toBe(202)
    const d = r.json() as { kind: string; targetRef: string; status: string }
    // Eigene Art, damit der ausfuehrende Dienst nicht am Wert raten muss, ob
    // er bauen soll -- Raten waere hier die schlechteste Moeglichkeit.
    expect(d.kind).toBe('rollback')
    expect(d.targetRef).toBe('aaaaaaa1')
    expect(d.status).toBe('pending')
  })

  it('nimmt nur Staende an, die schon einmal gelaufen sind', async () => {
    await gelaufen('aaaaaaa1')
    // Ein beliebiger Commit waere kein Zurueckrollen, sondern ein
    // unbemerktes Ausrollen ohne Freigabe.
    const r = await rollback('cccccccc')
    expect(r.statusCode).toBe(422)
    expect((await owner.query(
      `SELECT 1 FROM deploy_request WHERE kind = 'rollback'`)).rowCount).toBe(0)
  })

  it('weist einen Stand ab, der gar kein Commit sein kann', async () => {
    await gelaufen('aaaaaaa1')
    expect((await rollback('../../etc/passwd')).statusCode).toBe(422)
    expect((await rollback('produktion')).statusCode).toBe(422)
  })

  it('weist den laufenden Stand ab', async () => {
    await gelaufen('aaaaaaa1')
    await gelaufen('bbbbbbb2')
    // Sonst startete es die Dienste ohne jeden Gewinn neu -- mitten im
    // Betrieb.
    expect((await rollback('bbbbbbb2')).statusCode).toBe(409)
  })

  it('laesst keinen Rollback neben einem laufenden Vorgang zu', async () => {
    await gelaufen('aaaaaaa1')
    await gelaufen('bbbbbbb2')
    await anfordern()
    expect((await rollback('aaaaaaa1')).statusCode).toBe(409)
  })

  it('bietet frueher gelaufene Staende an, ohne den laufenden', async () => {
    await gelaufen('aaaaaaa1')
    await gelaufen('bbbbbbb2')
    const d = (await liste()).json() as {
      currentCommit: string; rollbackTargets: string[] }
    expect(d.currentCommit).toBe('bbbbbbb2')
    expect(d.rollbackTargets).toEqual(['aaaaaaa1'])
  })

  it('nennt denselben Stand nicht zweimal', async () => {
    // Derselbe Stand kann mehrfach ausgerollt worden sein -- als Liste zum
    // Anklicken ist er trotzdem einer.
    await gelaufen('aaaaaaa1')
    await gelaufen('bbbbbbb2')
    await gelaufen('aaaaaaa1')
    await gelaufen('ccccccc3')
    const d = (await liste()).json() as { rollbackTargets: string[] }
    expect(d.rollbackTargets).toEqual(['aaaaaaa1', 'bbbbbbb2'])
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
    expect((await app.inject({ method: 'POST',
      url: '/v1/platform/deployments/rollback', payload: { commit: 'aaaaaaa1' } }))
      .statusCode).toBe(401)
  })

  it('laesst einen Kunden auch nicht zurueckrollen', async () => {
    const inhaber = await makeUser(owner,
      { email: 'inhaber2@kunde.de', accountId: fx.accountId, roleKey: 'owner' })
    expect((await app.inject({ method: 'POST',
      url: '/v1/platform/deployments/rollback',
      headers: auth(inhaber.sessionId), payload: { commit: 'aaaaaaa1' } }))
      .statusCode).toBe(403)
  })
})
