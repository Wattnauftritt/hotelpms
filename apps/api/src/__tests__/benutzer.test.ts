import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Benutzer und Rollen.
 *
 * Die Mandantengrenze ist hier **von Hand** gezogen: `app_user`, `role` und
 * `user_property_role` haben keine Zeilenrichtlinie, weil ein Benutzer
 * keinem Haus gehoert, sondern Rollen in Haeusern hat. Genau deshalb steht
 * hier ein Test, der aus einem zweiten Account heraus nachsieht -- eine
 * vergessene Bedingung waere hier eine Benutzerliste des ganzen Systems,
 * und sie faellt beim Hinsehen nicht auf.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let chefId: number

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
  await makeCategory(owner, fx.propertyId)
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  chefId = u.userId
  auth = { cookie: `hp_session=${u.sessionId}` }
})

async function refOf(userId: number): Promise<string> {
  const r = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM app_user WHERE id = $1`, [userId])
  return r.rows[0]!.public_ref
}

describe('Benutzer eines Hauses', () => {
  it('liefert Rollen und Rechte in einem Aufruf', async () => {
    await makeUser(owner,
      { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })

    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/users` })
    expect(r.statusCode).toBe(200)
    const users = r.json().users
    expect(users).toHaveLength(2)

    const rez = users.find((u: { email: string }) => u.email === 'rez@test.de')
    expect(rez.roles.map((x: { key: string }) => x.key)).toEqual(['reception'])
    // Die Rechte kommen mit, damit die Oberflaeche sie zeigen kann, statt
    // sie aus dem Rollennamen zu erraten.
    expect(rez.permissions).toContain('reservation:write')
    expect(rez.permissions).not.toContain('report:revenue')
  })

  /**
   * Der Fehler, den dieser Test verhindert: `app_user` hat keine
   * Zeilenrichtlinie. Eine Abfrage ohne Bedingung auf `property_id`
   * lieferte die Benutzer **aller** Betriebe -- mit Namen und Adresse, und
   * ohne dass irgendwo ein Fehler auftauchte.
   */
  it('zeigt keine Benutzer fremder Haeuser', async () => {
    const fremd = await makeProperty(owner, { code: 'FREMD', name: 'Fremdhotel' })
    await makeUser(owner,
      { email: 'fremd@test.de', propertyId: fremd.propertyId, roleKey: 'hotel_director' })

    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/users` })
    expect(r.json().users.map((u: { email: string }) => u.email))
      .not.toContain('fremd@test.de')

    // Und das fremde Haus selbst ist ohnehin nicht erreichbar.
    const quer = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fremd.propertyId}/users` })
    expect(quer.statusCode).toBe(403)
  })

  it('bleibt der Rezeption verschlossen', async () => {
    const u = await makeUser(owner,
      { email: 'rez2@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const r = await app.inject({ method: 'GET',
      headers: { cookie: `hp_session=${u.sessionId}` },
      url: `/v1/properties/${fx.propertyId}/users` })
    expect(r.statusCode).toBe(403)
  })
})

describe('Rollenkatalog', () => {
  it('liefert die Rechte je Rolle, nicht nur den Namen', async () => {
    const r = await app.inject({ method: 'GET', headers: auth, url: '/v1/roles' })
    expect(r.statusCode).toBe(200)
    const rollen = r.json().roles
    const rezeption = rollen.find((x: { key: string }) => x.key === 'reception')
    expect(rezeption.permissions).toContain('reservation:write')
    expect(rezeption.isSystem).toBe(true)
    // Nur Rollen auf Hausebene: eine Accountrolle laesst sich einem Haus
    // nicht zuweisen, und sie hier anzubieten waere eine Falle.
    for (const rolle of rollen) expect(rolle.level).toBe('property')
  })
})

describe('Rollen festlegen', () => {
  it('ersetzt den Satz Rollen und laesst ihn sich leeren', async () => {
    const u = await makeUser(owner,
      { email: 'neu@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const ref = await refOf(u.userId)

    const gesetzt = await app.inject({ method: 'PUT', headers: auth,
      url: `/v1/properties/${fx.propertyId}/users/${ref}/roles`,
      payload: { roleKeys: ['housekeeping', 'maintenance'] } })
    expect(gesetzt.statusCode).toBe(200)
    expect(gesetzt.json().roleKeys.sort()).toEqual(['housekeeping', 'maintenance'])

    const nachher = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/users` })
    const neu = nachher.json().users.find((x: { email: string }) => x.email === 'neu@test.de')
    expect(neu.roles.map((x: { key: string }) => x.key).sort())
      .toEqual(['housekeeping', 'maintenance'])

    // Leer heisst: keine Rolle mehr in diesem Haus. Der Benutzer
    // verschwindet damit aus der Liste, ohne geloescht zu werden.
    const geleert = await app.inject({ method: 'PUT', headers: auth,
      url: `/v1/properties/${fx.propertyId}/users/${ref}/roles`,
      payload: { roleKeys: [] } })
    expect(geleert.statusCode).toBe(200)
    const leer = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/users` })
    expect(leer.json().users.map((x: { email: string }) => x.email))
      .not.toContain('neu@test.de')
  })

  /**
   * Ohne diese Bedingung waere die Route der Weg, einer beliebigen Kennung
   * eines fremden Betriebs eine Rolle im eigenen Haus zu geben -- und
   * zugleich ein Mittel, fremde Kennungen zu erraten.
   */
  it('nimmt keinen Benutzer an, der nicht zum Account gehoert', async () => {
    const fremd = await makeProperty(owner, { code: 'FREMD2' })
    const f = await makeUser(owner,
      { email: 'fremd2@test.de', propertyId: fremd.propertyId, roleKey: 'reception' })
    const r = await app.inject({ method: 'PUT', headers: auth,
      url: `/v1/properties/${fx.propertyId}/users/${await refOf(f.userId)}/roles`,
      payload: { roleKeys: ['reception'] } })
    expect(r.statusCode).toBe(404)
  })

  it('weist eine unbekannte Rolle ab', async () => {
    const u = await makeUser(owner,
      { email: 'x@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const r = await app.inject({ method: 'PUT', headers: auth,
      url: `/v1/properties/${fx.propertyId}/users/${await refOf(u.userId)}/roles`,
      payload: { roleKeys: ['grossadmiral'] } })
    expect(r.statusCode).toBe(422)
  })

  it('weist eine Accountrolle ab, die kein Haus kennt', async () => {
    const u = await makeUser(owner,
      { email: 'y@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const r = await app.inject({ method: 'PUT', headers: auth,
      url: `/v1/properties/${fx.propertyId}/users/${await refOf(u.userId)}/roles`,
      payload: { roleKeys: ['accounting'] } })
    expect(r.statusCode).toBe(422)
  })

  /**
   * Wer sich selbst das Verwaltungsrecht nimmt, sperrt sich aus, und es
   * gibt keinen zweiten Knopf, mit dem er zurueckkaeme.
   */
  it('laesst niemanden sich selbst aussperren', async () => {
    const selbst = await app.inject({ method: 'PUT', headers: auth,
      url: `/v1/properties/${fx.propertyId}/users/${await refOf(chefId)}/roles`,
      payload: { roleKeys: ['housekeeping'] } })
    expect(selbst.statusCode).toBe(409)

    // Eine andere Rolle mit demselben Recht ist dagegen in Ordnung.
    const erlaubt = await app.inject({ method: 'PUT', headers: auth,
      url: `/v1/properties/${fx.propertyId}/users/${await refOf(chefId)}/roles`,
      payload: { roleKeys: ['hotel_director'] } })
    expect(erlaubt.statusCode).toBe(200)
  })

  it('verlangt eine Liste, nicht irgendetwas', async () => {
    const r = await app.inject({ method: 'PUT', headers: auth,
      url: `/v1/properties/${fx.propertyId}/users/${await refOf(chefId)}/roles`,
      payload: { roleKeys: 'reception' } })
    expect(r.statusCode).toBe(422)
  })
})
