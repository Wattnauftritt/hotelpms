import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Hausnotiz am Gastprofil.
 *
 * Die Route gab es, eine Maske nicht -- und das Profil zeigte die Notizen
 * gar nicht, nur die Auskunft nach Art. 15. Jetzt stehen sie im Profil, im
 * selben Aufruf, und nur die der Haeuser, die der Aufrufer sieht.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let rezeption: Record<string, string>

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

beforeEach(async () => {
  await truncateAll()
  limiters.reset()
  fx = await makeProperty(owner)
  const u = await makeUser(owner,
    { email: 'rezeption@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  rezeption = { cookie: `hp_session=${u.sessionId}` }
})

const notiz = (guestRef: string, note: unknown, headers = rezeption,
               propertyId = fx.propertyId) =>
  app.inject({ method: 'POST', url: `/v1/guests/${guestRef}/notes`, headers,
    payload: { propertyId, note } })

describe('Hausnotiz anlegen', () => {
  it('steht danach im Profil, mit Haus und Verfasser', async () => {
    const g = await makeGuest(owner, fx.accountId)
    const r = await notiz(g.publicRef, '  Ebenerdiges Zimmer  ')
    expect(r.statusCode, r.body).toBe(201)
    // Der Hinweis gegen Gesundheitsdaten geht mit der Antwort hinaus.
    expect(JSON.parse(r.body).hinweisKey).toBe('hint.noteNoHealthData')

    const p = await app.inject({ method: 'GET', url: `/v1/guests/${g.publicRef}`,
      headers: rezeption })
    const notes = JSON.parse(p.body).notes as Array<Record<string, unknown>>
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ note: 'Ebenerdiges Zimmer', property: 'Testhotel',
                                     propertyId: fx.propertyId,
                                     createdBy: 'rezeption@test.de' })
  })

  it('weist eine leere und eine zu lange Notiz ab', async () => {
    const g = await makeGuest(owner, fx.accountId)
    expect((await notiz(g.publicRef, '   ')).statusCode).toBe(422)
    expect((await notiz(g.publicRef, 'x'.repeat(501))).statusCode).toBe(422)
    expect((await notiz(g.publicRef, 42)).statusCode).toBe(422)
  })

  it('haengt an ein anonymisiertes Profil nichts mehr an', async () => {
    const g = await makeGuest(owner, fx.accountId)
    await owner.query(`UPDATE guest SET status = 'anonymized' WHERE id = $1`, [g.id])
    const r = await notiz(g.publicRef, 'Allergie')
    expect(r.statusCode).toBe(409)
    const n = await owner.query(`SELECT 1 FROM guest_property_note`)
    expect(n.rowCount).toBe(0)
  })

  it('braucht guest:write', async () => {
    const g = await makeGuest(owner, fx.accountId)
    const hk = await makeUser(owner,
      { email: 'hk@test.de', propertyId: fx.propertyId, roleKey: 'housekeeping' })
    const r = await notiz(g.publicRef, 'Ebenerdig', { cookie: `hp_session=${hk.sessionId}` })
    expect(r.statusCode).toBe(403)
  })

  /**
   * Was ein Haus notiert, bleibt bei diesem Haus (Migration 0008). Ein
   * Benutzer, der das zweite Haus des Accounts nicht sieht, sieht dessen
   * Notiz auch im gemeinsamen Gastprofil nicht.
   */
  it('zeigt die Notiz eines anderen Hauses nicht', async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name) VALUES ($1,'ZWEI','Zweites')
       RETURNING id`, [fx.accountId])
    const g = await makeGuest(owner, fx.accountId)
    await owner.query(
      `INSERT INTO guest_property_note (property_id, guest_id, note) VALUES ($1,$2,'Fremd')`,
      [zweites.rows[0]!.id, g.id])
    expect((await notiz(g.publicRef, 'Eigen')).statusCode).toBe(201)

    const p = await app.inject({ method: 'GET', url: `/v1/guests/${g.publicRef}`,
      headers: rezeption })
    const notes = JSON.parse(p.body).notes as Array<{ note: string }>
    expect(notes.map(n => n.note)).toEqual(['Eigen'])

    // Und schreiben darf sie dort auch nicht.
    expect((await notiz(g.publicRef, 'Quer', rezeption, zweites.rows[0]!.id)).statusCode)
      .toBe(403)
  })
})
