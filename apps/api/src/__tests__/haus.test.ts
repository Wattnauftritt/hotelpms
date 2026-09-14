import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makePaymentMethod, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Wartung, Gastpost, Zahlungsarten und Stammdatenpflege.
 *
 * Geprueft wird, wo ein Fehler Zimmer oder Geld kostet: der Unterschied
 * zwischen Out of Order und Out of Service, das Stilllegen unter laufenden
 * Reservierungen, der Versand aus einem Uebungshaus und die
 * Unveraenderlichkeit einer benutzten Zahlungsart.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let categoryId: number
let rooms: number[]

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
  categoryId = await makeCategory(owner, fx.propertyId)
  rooms = await makeResources(owner, fx.propertyId, categoryId, 2)
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

describe('Wartungsmeldungen', () => {
  /**
   * Der Unterschied, um den es geht: Out of Order ist nicht verkaeuflich und
   * senkt die Kapazitaet, Out of Service bleibt im Verkauf. Wer beides
   * gleich behandelt, sperrt entweder ein verkaufbares Zimmer oder verkauft
   * eines, das nicht bezogen werden kann.
   */
  it('legt beide Arten von Sperrung an und unterscheidet sie', async () => {
    for (const [kind, room] of [['out_of_order', rooms[0]!],
                                ['out_of_service', rooms[1]!]] as const) {
      const r = await app.inject({ method: 'POST', url: '/v1/maintenance-tickets',
        headers: auth,
        payload: { propertyId: fx.propertyId, resourceId: room, title: `Schaden ${kind}`,
                   block: { from: '2026-10-01', to: '2026-10-03', kind } } })
      expect(r.statusCode).toBe(201)
    }

    const arten = await owner.query<{ kind: string }>(
      `SELECT kind FROM maintenance_block WHERE property_id = $1 ORDER BY kind`,
      [fx.propertyId])
    expect(arten.rows.map(x => x.kind)).toEqual(['out_of_order', 'out_of_service'])

    // Die Sperrung steht an der Meldung, nicht zwei Klicks entfernt.
    const liste = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/maintenance-tickets` })
    const tickets = liste.json().tickets
    expect(tickets).toHaveLength(2)
    for (const ticket of tickets) expect(ticket.blocks).toHaveLength(1)
  })

  it('weist eine Sperrung ohne Zimmer ab, statt sie still zu uebergehen', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/maintenance-tickets',
      headers: auth,
      payload: { propertyId: fx.propertyId, title: 'Aufzug',
                 block: { from: '2026-10-01', to: '2026-10-03' } } })
    expect(r.statusCode).toBe(422)
  })

  it('haelt die alte Kurzform am Leben', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/maintenance-tickets',
      headers: auth,
      payload: { propertyId: fx.propertyId, resourceId: rooms[0]!, title: 'Alt',
                 outOfOrder: { from: '2026-11-01', to: '2026-11-02' } } })
    expect(r.statusCode).toBe(201)
    const k = await owner.query<{ kind: string }>(
      `SELECT kind FROM maintenance_block WHERE property_id = $1`, [fx.propertyId])
    expect(k.rows[0]!.kind).toBe('out_of_order')
  })

  it('nimmt eine Meldung in Arbeit und erledigt sie', async () => {
    const angelegt = await app.inject({ method: 'POST', url: '/v1/maintenance-tickets',
      headers: auth,
      payload: { propertyId: fx.propertyId, resourceId: rooms[0]!, title: 'Duschkopf' } })
    const id = angelegt.json().ticketId

    const arbeit = await app.inject({ method: 'PATCH',
      url: `/v1/maintenance-tickets/${id}`, headers: auth,
      payload: { status: 'in_progress' } })
    expect(arbeit.json().status).toBe('in_progress')
    expect(arbeit.json().closedAt).toBeNull()

    const fertig = await app.inject({ method: 'PATCH',
      url: `/v1/maintenance-tickets/${id}`, headers: auth, payload: { status: 'done' } })
    expect(fertig.json().status).toBe('done')
    expect(fertig.json().closedAt).not.toBeNull()
    const zeitpunkt = fertig.json().closedAt

    // Ein zweites "erledigt" darf den Zeitpunkt nicht nach hinten schieben:
    // erledigt wurde es beim ersten Mal.
    const nochmal = await app.inject({ method: 'PATCH',
      url: `/v1/maintenance-tickets/${id}`, headers: auth, payload: { status: 'done' } })
    expect(nochmal.json().closedAt).toBe(zeitpunkt)

    // Wieder oeffnen loescht den Zeitpunkt: sonst stuende an einer offenen
    // Meldung, wann sie erledigt wurde.
    const auf = await app.inject({ method: 'PATCH',
      url: `/v1/maintenance-tickets/${id}`, headers: auth, payload: { status: 'open' } })
    expect(auf.json().closedAt).toBeNull()
  })

  it('nimmt keinen erfundenen Stand an', async () => {
    const angelegt = await app.inject({ method: 'POST', url: '/v1/maintenance-tickets',
      headers: auth, payload: { propertyId: fx.propertyId, title: 'X' } })
    const r = await app.inject({ method: 'PATCH',
      url: `/v1/maintenance-tickets/${angelegt.json().ticketId}`, headers: auth,
      payload: { status: 'erledigt' } })
    expect(r.statusCode).toBe(422)
  })

  /**
   * Die Sperrung bleibt, wenn die Meldung erledigt wird. Das waere bequem
   * und waere falsch: ob ein Zimmer wieder verkaeuflich ist, entscheidet,
   * wer hineingesehen hat -- nicht die Software.
   */
  it('hebt mit der Meldung keine Sperrung auf', async () => {
    const angelegt = await app.inject({ method: 'POST', url: '/v1/maintenance-tickets',
      headers: auth,
      payload: { propertyId: fx.propertyId, resourceId: rooms[0]!, title: 'Rohrbruch',
                 block: { from: '2026-10-01', to: '2026-10-05', kind: 'out_of_order' } } })
    await app.inject({ method: 'PATCH',
      url: `/v1/maintenance-tickets/${angelegt.json().ticketId}`, headers: auth,
      payload: { status: 'done' } })
    const n = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM maintenance_block WHERE property_id = $1`,
      [fx.propertyId])
    expect(n.rows[0]!.n).toBe('1')
  })
})

describe('Zahlungsarten', () => {
  it('legt an, aendert und legt still -- aber loescht nicht', async () => {
    const angelegt = await app.inject({ method: 'POST', headers: auth,
      url: `/v1/properties/${fx.propertyId}/payment-methods`,
      payload: { code: 'EC', name: 'EC-Karte' } })
    expect(angelegt.statusCode).toBe(201)
    const id = angelegt.json().paymentMethodId

    const geaendert = await app.inject({ method: 'PATCH', headers: auth,
      url: `/v1/payment-methods/${id}`, payload: { name: 'Girocard', sortOrder: 5 } })
    expect(geaendert.json().name).toBe('Girocard')
    expect(geaendert.json().sortOrder).toBe(5)

    const still = await app.inject({ method: 'PATCH', headers: auth,
      url: `/v1/payment-methods/${id}`, payload: { active: false } })
    expect(still.json().active).toBe(false)

    // Aus der Auswahl verschwunden, in der Geschichte geblieben.
    const auswahl = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/payment-methods` })
    expect(auswahl.json().paymentMethods.map((p: { code: string }) => p.code))
      .not.toContain('EC')
    const alle = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/payment-methods?includeInactive=true` })
    expect(alle.json().paymentMethods.map((p: { code: string }) => p.code))
      .toContain('EC')

    // Es gibt keinen Loeschweg. Verrechnungen haengen daran, und die sind
    // Haertegrad 1.
    const geloescht = await app.inject({ method: 'DELETE', headers: auth,
      url: `/v1/payment-methods/${id}` })
    expect(geloescht.statusCode).toBe(404)
  })

  it('weist ein doppeltes Kuerzel im selben Haus ab', async () => {
    await makePaymentMethod(owner, fx.propertyId, 'CASH')
    const r = await app.inject({ method: 'POST', headers: auth,
      url: `/v1/properties/${fx.propertyId}/payment-methods`,
      payload: { code: 'CASH', name: 'Bar' } })
    expect(r.statusCode).toBe(409)
  })

  it('laesst die Rezeption die Liste sehen, aber nicht pflegen', async () => {
    const u = await makeUser(owner,
      { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const rez = { cookie: `hp_session=${u.sessionId}` }
    const lesen = await app.inject({ method: 'GET', headers: rez,
      url: `/v1/properties/${fx.propertyId}/payment-methods` })
    expect(lesen.statusCode).toBe(200)
    const schreiben = await app.inject({ method: 'POST', headers: rez,
      url: `/v1/properties/${fx.propertyId}/payment-methods`,
      payload: { code: 'X', name: 'X' } })
    expect(schreiben.statusCode).toBe(403)
  })
})

describe('Absenderangaben Gastpost', () => {
  it('nennt einen nicht eingerichteten Stand, statt 404 zu antworten', async () => {
    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/email-settings` })
    expect(r.statusCode).toBe(200)
    expect(r.json().enabled).toBe(false)
    expect(r.json().updatedAt).toBeNull()
  })

  it('laesst ein Uebungshaus den Versand nicht einschalten', async () => {
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`,
      [fx.propertyId])
    const an = await app.inject({ method: 'PUT', headers: auth,
      url: `/v1/properties/${fx.propertyId}/email-settings`,
      payload: { fromName: 'Uebung', fromEmail: 'post@test.de', enabled: true } })
    expect(an.statusCode).toBe(422)

    // Ausgeschaltet darf ein Uebungshaus die Angaben trotzdem pflegen.
    const aus = await app.inject({ method: 'PUT', headers: auth,
      url: `/v1/properties/${fx.propertyId}/email-settings`,
      payload: { fromName: 'Uebung', fromEmail: 'post@test.de', enabled: false } })
    expect(aus.statusCode).toBe(200)
  })
})

describe('Stammdaten pflegen', () => {
  it('aendert alle Felder einer Zimmergruppe', async () => {
    const r = await app.inject({ method: 'PATCH', headers: auth,
      url: `/v1/categories/${categoryId}`,
      payload: { name: 'Komfortdoppelzimmer', description: 'Mit Balkon',
                 sortOrder: 30, overbookingLimit: 2 } })
    expect(r.statusCode).toBe(200)
    const nachher = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/categories` })
    const c = nachher.json().categories[0]
    expect(c.name).toBe('Komfortdoppelzimmer')
    expect(c.description).toBe('Mit Balkon')
    expect(c.sortOrder).toBe(30)
    expect(c.overbookingLimit).toBe(2)
  })

  it('setzt Etage und Merkmale am Zimmer', async () => {
    const r = await app.inject({ method: 'PATCH', headers: auth,
      url: `/v1/rooms/${rooms[0]!}`,
      payload: { floor: '2', attributes: ['balkon', 'barrierefrei'] } })
    expect(r.statusCode).toBe(200)
    expect(r.json().attributes).toEqual(['balkon', 'barrierefrei'])
    expect(r.json().floor).toBe('2')
  })

  it('zeigt stillgelegte Zimmer nur auf Verlangen', async () => {
    await app.inject({ method: 'PATCH', headers: auth,
      url: `/v1/rooms/${rooms[0]!}`, payload: { active: false } })
    const ohne = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/rooms` })
    expect(ohne.json().rooms).toHaveLength(1)
    const mit = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/rooms?includeInactive=true` })
    expect(mit.json().rooms).toHaveLength(2)
  })
})
