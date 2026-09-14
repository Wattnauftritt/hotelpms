import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Die Grundlage des Belegungsplans.
 *
 * Der Plan ist das Hauptwerkzeug der Rezeption: dort wird gebucht,
 * verschoben, verlaengert und notiert. Geprueft wird hier, dass die API
 * das traegt -- und dass sie ein Zimmer nicht vergibt, das es in diesem
 * Haus gar nicht gibt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let zimmer: number[]
let auth: Record<string, string>

const VON = '2026-10-01'
const BIS = '2026-10-04'

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
  fx = await makeProperty(owner)
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  await makeResources(owner, fx.propertyId, catId, 4)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const r = await owner.query<{ id: number }>(
    `SELECT id FROM resource WHERE property_id = $1 ORDER BY code`, [fx.propertyId])
  zimmer = r.rows.map(x => x.id)
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

let schluessel = 0
const buchen = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...auth, 'idempotency-key': `k-${++schluessel}` },
    payload: { propertyId: fx.propertyId, categoryId: catId,
               arrival: VON, departure: BIS, ...payload } })
const patch = (url: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url, headers: auth, payload })
const get = (url: string) => app.inject({ method: 'GET', url, headers: auth })

describe('Buchen mit Zimmer', () => {
  it('legt die Reservierung gleich im gewaehlten Zimmer an', async () => {
    const r = await buchen({ resourceId: zimmer[0] })
    expect(r.statusCode, r.body).toBe(201)
    const ref = JSON.parse(r.body).reservationRef as string

    // Ein Aufruf, nicht zwei: zwischen Buchen und Zuweisen laege sonst ein
    // Fenster, in dem jemand anders dasselbe Zimmer belegt.
    const d = await get(`/v1/reservations/${ref}`)
    expect(JSON.parse(d.body).resourceId).toBe(zimmer[0])
  })

  it('weist ein bereits belegtes Zimmer ab, obwohl die Gruppe noch frei ist', async () => {
    expect((await buchen({ resourceId: zimmer[0] })).statusCode).toBe(201)

    // Der Bestandszaehler rechnet je Gruppe: drei Zimmer sind noch frei.
    // Trotzdem darf dieses eine nicht zweimal vergeben werden.
    const zweite = await buchen({ resourceId: zimmer[0] })
    expect(zweite.statusCode).toBe(409)
    expect(JSON.parse(zweite.body).detail).toMatch(/bereits belegt/)
  })

  it('bindet keinen Bestand, wenn das Zimmer abgelehnt wird', async () => {
    await buchen({ resourceId: zimmer[0] })
    const vorher = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
      [fx.propertyId, catId, VON])

    await buchen({ resourceId: zimmer[0] })   // scheitert

    const nachher = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
      [fx.propertyId, catId, VON])
    // Ganz oder gar nicht: eine abgewiesene Buchung darf nichts hinterlassen.
    expect(nachher.rows[0]!.sold).toBe(vorher.rows[0]!.sold)
  })

  it('weist ein Zimmer ab, das ausser Betrieb ist', async () => {
    await owner.query(
      `INSERT INTO maintenance_block (property_id, resource_id, from_date, to_date, kind, reason)
       VALUES ($1,$2,$3::date,$4::date,'out_of_order','Wasserschaden')`,
      [fx.propertyId, zimmer[0], VON, BIS])

    const r = await buchen({ resourceId: zimmer[0] })
    expect(r.statusCode).toBe(409)
    expect(JSON.parse(r.body).detail).toMatch(/ausser Betrieb/)
  })
})

describe('Zimmer eines fremden Hauses', () => {
  /**
   * Der Fall, den CLAUDE.md unter "Bei mehreren Haeusern im Account reicht
   * die Zeilenrichtlinie nicht" beschreibt.
   *
   * Wichtig ist die Besetzung: der handelnde Benutzer hat Zugriff auf
   * **beide** Haeuser. Nur dann steht das fremde Zimmer ueberhaupt in
   * seinem Mandantenkontext, und nur dann traegt die Zeilenrichtlinie
   * nicht mehr. Ein Benutzer mit nur einem Haus ist schon durch sie
   * geschuetzt -- was leicht dazu verfuehrt, die Pruefung fuer ueberfluessig
   * zu halten.
   *
   * Ohne sie haengt das Zimmer aus Haus B an einer Reservierung in Haus A,
   * und der Belegungsplan von Haus A zeigt sie danach gar nicht mehr an,
   * weil das Zimmer dort nicht vorkommt.
   */
  let fremdesZimmer: number
  let beideHaeuser: Record<string, string>

  beforeEach(async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name) VALUES ($1,'HAUS2','Zweites Haus')
       RETURNING id`, [fx.accountId])
    const p2 = zweites.rows[0]!.id
    const c2 = await makeCategory(owner, p2, { code: 'EZ' })
    await makeResources(owner, p2, c2, 2)
    const r = await owner.query<{ id: number }>(
      `SELECT id FROM resource WHERE property_id = $1 LIMIT 1`, [p2])
    fremdesZimmer = r.rows[0]!.id

    // Dieselbe Person fuehrt beide Haeuser -- in einer Kette der Normalfall.
    const u = await makeUser(owner,
      { email: 'kette@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL`,
      [u.userId, p2])
    beideHaeuser = { cookie: `hp_session=${u.sessionId}` }
  })

  it('laesst sich nicht mitbuchen', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/bookings',
      headers: { ...beideHaeuser, 'idempotency-key': 'kette-1' },
      payload: { propertyId: fx.propertyId, categoryId: catId,
                 arrival: VON, departure: BIS, resourceId: fremdesZimmer } })
    expect(r.statusCode).toBe(404)
  })

  it('laesst sich nicht nachtraeglich zuweisen', async () => {
    const b = await app.inject({ method: 'POST', url: '/v1/bookings',
      headers: { ...beideHaeuser, 'idempotency-key': 'kette-2' },
      payload: { propertyId: fx.propertyId, categoryId: catId,
                 arrival: VON, departure: BIS } })
    const ref = JSON.parse(b.body).reservationRef as string

    const r = await app.inject({ method: 'POST', headers: beideHaeuser,
      url: `/v1/reservations/${ref}/assign-unit`, payload: { resourceId: fremdesZimmer } })
    expect(r.statusCode).toBe(404)

    // Und die Reservierung bleibt unveraendert ohne Zimmer.
    const d = await app.inject({ method: 'GET', headers: beideHaeuser,
      url: `/v1/reservations/${ref}` })
    expect(JSON.parse(d.body).resourceId).toBeNull()
  })

  it('laesst ein stillgelegtes Zimmer nicht zu', async () => {
    await owner.query(`UPDATE resource SET active = false WHERE id = $1`, [zimmer[0]])
    const r = await buchen({ resourceId: zimmer[0] })
    expect(r.statusCode).toBe(409)
    expect(JSON.parse(r.body).detail).toMatch(/stillgelegt/)
  })
})

describe('Reservierung ansehen', () => {
  it('liefert in einem Aufruf, was der Plan beim Anklicken braucht', async () => {
    const g = await owner.query<{ id: number }>(
      `INSERT INTO guest (account_id, last_name, first_name, email)
       VALUES ($1,'Beispiel','Anna','anna@gast.test') RETURNING id`, [fx.accountId])
    const ref = JSON.parse((await buchen({
      guestId: g.rows[0]!.id, resourceId: zimmer[1], notes: 'Spaetanreise' })).body)
      .reservationRef as string

    const r = await get(`/v1/reservations/${ref}`)
    expect(r.statusCode, r.body).toBe(200)
    const d = JSON.parse(r.body)

    expect(d.reservationRef).toBe(ref)
    expect(d.status).toBe('Confirmed')
    expect(d.arrival).toBe(VON)
    expect(d.departure).toBe(BIS)
    expect(d.guestName).toBe('Anna Beispiel')
    expect(d.categoryCode).toBe('DZ')
    expect(d.resourceId).toBe(zimmer[1])
    expect(d.roomCode).toBeTruthy()
    expect(d.notes).toBe('Spaetanreise')
    expect(d.folioRef).toBeTruthy()
    // Drei Naechte, nicht vier Tage.
    expect(d.nights).toHaveLength(3)
    expect(d.occupants).toHaveLength(1)
  })

  it('gibt die laufende id nicht nach aussen', async () => {
    const ref = JSON.parse((await buchen({})).body).reservationRef as string
    const d = JSON.parse((await get(`/v1/reservations/${ref}`)).body)
    // Nach aussen geht die oeffentliche Referenz (C1, Dokument 13).
    expect(d.id).toBeUndefined()
  })

  it('zeigt die Reservierung eines fremden Hauses nicht', async () => {
    const fremd = await makeProperty(owner)
    const c = await makeCategory(owner, fremd.propertyId, { code: 'DZ' })
    const res = await owner.query<{ public_ref: string }>(
      `INSERT INTO booking (property_id, source) VALUES ($1,'direct') RETURNING id`,
      [fremd.propertyId])
    const b = res.rows[0] as unknown as { id: number }
    const r2 = await owner.query<{ public_ref: string }>(
      `INSERT INTO reservation (property_id, booking_id, category_id, arrival, departure, status)
       VALUES ($1,$2,$3,'2026-10-01'::date,'2026-10-02'::date,'Confirmed')
       RETURNING public_ref`, [fremd.propertyId, b.id, c])

    expect((await get(`/v1/reservations/${r2.rows[0]!.public_ref}`)).statusCode).toBe(404)
  })
})

describe('Notiz', () => {
  it('laesst sich nachtraeglich setzen, aendern und loeschen', async () => {
    const ref = JSON.parse((await buchen({})).body).reservationRef as string

    expect((await patch(`/v1/reservations/${ref}`, { notes: 'Hochzeitstag' })).statusCode).toBe(200)
    expect(JSON.parse((await get(`/v1/reservations/${ref}`)).body).notes).toBe('Hochzeitstag')

    await patch(`/v1/reservations/${ref}`, { notes: 'Hochzeitstag, Sekt aufs Zimmer' })
    expect(JSON.parse((await get(`/v1/reservations/${ref}`)).body).notes)
      .toBe('Hochzeitstag, Sekt aufs Zimmer')

    // Leer heisst weg, nicht leerer Text.
    await patch(`/v1/reservations/${ref}`, { notes: '' })
    expect(JSON.parse((await get(`/v1/reservations/${ref}`)).body).notes).toBeNull()
  })

  it('steht am Balken im Belegungsplan', async () => {
    const ref = JSON.parse((await buchen({ resourceId: zimmer[0] })).body)
      .reservationRef as string
    await patch(`/v1/reservations/${ref}`, { notes: 'Spaetanreise 23 Uhr' })

    const plan = await get(
      `/v1/properties/${fx.propertyId}/tape-chart?from=${VON}&to=2026-10-10`)
    const r = (JSON.parse(plan.body) as {
      reservations: Array<{ public_ref: string; notes: string | null }> }).reservations
    // Eine Notiz, die man erst nach zwei Klicks sieht, wird nicht geschrieben.
    expect(r.find(x => x.public_ref === ref)?.notes).toBe('Spaetanreise 23 Uhr')
  })

  it('begrenzt die Laenge, statt einen Roman anzunehmen', async () => {
    const ref = JSON.parse((await buchen({})).body).reservationRef as string
    const r = await patch(`/v1/reservations/${ref}`, { notes: 'x'.repeat(2001) })
    expect(r.statusCode).toBe(422)
  })

  it('rechnet nicht neu und beruehrt keinen Bestand', async () => {
    const ref = JSON.parse((await buchen({})).body).reservationRef as string
    const vorher = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
      [fx.propertyId, catId, VON])

    await patch(`/v1/reservations/${ref}`, { notes: 'nur Text' })

    const nachher = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
      [fx.propertyId, catId, VON])
    // Ein Tippfehler in der Notiz darf nicht am vollen Haus scheitern.
    expect(nachher.rows[0]!.sold).toBe(vorher.rows[0]!.sold)
  })
})
