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
      currentCommit: string; rollbackTargets: { commit: string }[] }
    expect(d.currentCommit).toBe('bbbbbbb2')
    expect(d.rollbackTargets.map(z => z.commit)).toEqual(['aaaaaaa1'])
  })

  it('nennt denselben Stand nicht zweimal', async () => {
    // Derselbe Stand kann mehrfach ausgerollt worden sein -- als Liste zum
    // Anklicken ist er trotzdem einer.
    await gelaufen('aaaaaaa1')
    await gelaufen('bbbbbbb2')
    await gelaufen('aaaaaaa1')
    await gelaufen('ccccccc3')
    const d = (await liste()).json() as { rollbackTargets: { commit: string }[] }
    expect(d.rollbackTargets.map(z => z.commit)).toEqual(['aaaaaaa1', 'bbbbbbb2'])
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

/**
 * Die Platte ist die Wahrheit (Migration 0041).
 *
 * Das Panel bot "kein frueherer Stand" an, waehrend auf der Maschine drei
 * gebaute Staende lagen: einer von Hand ausgerollt, einer nach umgelegtem
 * Symlink am Neustart gescheitert. Die Liste kannte nur gegluecke Laeufe.
 * Jetzt traegt der Agent bei jedem Tick ein, was unter releases/ liegt.
 */
describe('Zurueckrollen auf das, was auf der Platte liegt', () => {
  async function aufPlatte(commit: string, laeuft = false): Promise<void> {
    await owner.query(
      `INSERT INTO release (commit, present, is_current) VALUES ($1, true, $2)`,
      [commit, laeuft])
  }
  const liste = () =>
    app.inject({ method: 'GET', url: '/v1/platform/deployments',
      headers: auth(betrieb.sessionId) })
  const rollback = (commit: string) =>
    app.inject({ method: 'POST', url: '/v1/platform/deployments/rollback',
      headers: auth(betrieb.sessionId), payload: { commit } })

  it('bietet gebaute Staende an, auch ohne geglueckten Lauf', async () => {
    // Von Hand ausgerollt, dann zweimal am Neustart gescheitert: keine
    // einzige 'done'-Zeile -- und trotzdem drei Verzeichnisse mit .fertig.
    await aufPlatte('aa000001')
    await aufPlatte('bb000002')
    await aufPlatte('cc000003', true)
    await owner.query(
      `INSERT INTO deploy_request (target_ref, status, finished_at, commit_after)
       VALUES ('produktion','failed', now(), 'bb000002')`)
    const d = (await liste()).json() as { currentCommit: string
      rollbackTargets: { commit: string }[] }
    expect(d.currentCommit).toBe('cc000003')
    expect(d.rollbackTargets.map(z => z.commit).sort()).toEqual(['aa000001', 'bb000002'])
    expect((await rollback('aa000001')).statusCode).toBe(202)
  })

  it('bietet einen weggeraeumten Stand nicht mehr an', async () => {
    await aufPlatte('cc000003', true)
    await owner.query(
      `INSERT INTO release (commit, present) VALUES ('dd000004', false)`)
    const d = (await liste()).json() as { rollbackTargets: unknown[] }
    expect(d.rollbackTargets).toEqual([])
    expect((await rollback('dd000004')).statusCode).toBe(422)
  })

  /*
   * Vier Hashes ohne Zeit sagten nicht, welcher der von gestern Mittag war
   * (Migration 0042). Der Agent meldet die Aenderungszeit von .fertig mit;
   * das Panel zeigt sie und ordnet danach -- den juengsten zuerst.
   */
  it('nennt zu jedem Stand die Bauzeit und ordnet danach', async () => {
    await owner.query(
      `INSERT INTO release (commit, present, is_current, built_at) VALUES
         ('aa000001', true, false, '2026-09-01T10:00:00Z'),
         ('bb000002', true, false, '2026-09-18T12:00:00Z'),
         ('cc000003', true, true,  '2026-09-19T12:02:00Z'),
         ('dd000004', true, false, NULL)`)
    const d = (await liste()).json() as {
      currentCommit: string; currentBuiltAt: string | null
      rollbackTargets: { commit: string; builtAt: string | null }[] }
    expect(d.currentCommit).toBe('cc000003')
    expect(new Date(d.currentBuiltAt!).toISOString()).toBe('2026-09-19T12:02:00.000Z')
    // Juengster Bau zuerst, der ohne gemeldete Zeit zuletzt -- der Agent
    // von vor 0042 hat ihn eingetragen, und er liegt trotzdem da.
    expect(d.rollbackTargets.map(z => z.commit)).toEqual(['bb000002', 'aa000001', 'dd000004'])
    expect(new Date(d.rollbackTargets[0]!.builtAt!).toISOString())
      .toBe('2026-09-18T12:00:00.000Z')
    expect(d.rollbackTargets[2]!.builtAt).toBeNull()
  })

  it('nimmt, solange der Agent nichts eingetragen hat, die Geschichte -- samt Vorgaenger', async () => {
    // Der Stand VOR einem gegluecken Lauf liegt noch da: deploy.sh raeumt
    // nie den laufenden weg, und der vorige war es gerade noch.
    await owner.query(
      `INSERT INTO deploy_request (target_ref, status, finished_at, commit_before, commit_after)
       VALUES ('produktion','done', now(), 'ee000005', 'ff000006')`)
    const d = (await liste()).json() as { currentCommit: string; currentBuiltAt: string | null
      rollbackTargets: { commit: string; builtAt: string | null }[] }
    expect(d.currentCommit).toBe('ff000006')
    // Die Geschichte kennt nur das Ende des Laufs, der den Stand gebaut
    // hat; der Vorgaenger bekommt keine Zeit, statt einer falschen.
    expect(d.currentBuiltAt).not.toBeNull()
    expect(d.rollbackTargets).toEqual([{ commit: 'ee000005', builtAt: null }])
  })
})
