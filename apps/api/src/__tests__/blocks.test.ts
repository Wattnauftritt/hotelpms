import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, never>

const VON = '2026-11-02'
const BIS = '2026-11-05'          // drei Naechte
const ZIMMER = 5

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
  catId = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, catId, ZIMMER)
  await owner.query(`SELECT inventory_materialize($1,'2026-10-01'::date,'2027-03-01'::date)`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, '2026-10-01')
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [admin.userId, fx.accountId])
})

/** Zaehlerstand der ersten Nacht, je Kategorie und fuer das ganze Haus. */
async function zaehler(date = VON): Promise<{ sold: number; blocked: number
                                              hausSold: number; hausBlocked: number }> {
  const r = await owner.query<{ category_id: number; sold: number; blocked: number }>(
    `SELECT category_id, sold, blocked FROM inventory_day
      WHERE property_id = $1 AND date = $2::date ORDER BY category_id`,
    [fx.propertyId, date])
  const haus = r.rows.find(z => Number(z.category_id) === 0)!
  const kat = r.rows.find(z => Number(z.category_id) === catId)!
  return { sold: kat.sold, blocked: kat.blocked,
           hausSold: haus.sold, hausBlocked: haus.blocked }
}

async function kontingent(
  opts: { quantity?: number; releaseDate?: string; ratePlanId?: number } = {}
): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: `/v1/properties/${fx.propertyId}/blocks`,
    headers: auth(admin.sessionId),
    payload: { name: 'Reisegruppe Nordsee', categoryId: catId,
               fromDate: VON, toDate: BIS, quantity: opts.quantity ?? 3,
               releaseDate: opts.releaseDate, ratePlanId: opts.ratePlanId } })
  expect(r.statusCode).toBe(201)
  return (json(r) as unknown as { blockRef: string }).blockRef
}

function abruf(blockRef: string | undefined, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST', url: '/v1/bookings',
    headers: { ...auth(admin.sessionId), 'idempotency-key': `k-${Math.random()}` },
    payload: { propertyId: fx.propertyId, categoryId: catId,
               arrival: VON, departure: BIS, blockRef, ...extra } })
}

async function blockStand(): Promise<{ quantity: number; picked_up: number; status: string }> {
  const r = await owner.query<{ quantity: number; picked_up: number; status: string }>(
    `SELECT quantity, picked_up, status FROM availability_block WHERE property_id = $1`,
    [fx.propertyId])
  return r.rows[0]!
}

describe('Kontingent anlegen', () => {
  it('bindet die Menge und nimmt sie dem freien Verkauf', async () => {
    expect(await zaehler()).toMatchObject({ sold: 0, blocked: 0 })
    await kontingent({ quantity: 3 })

    const z = await zaehler()
    expect(z.blocked).toBe(3)
    expect(z.sold).toBe(0)
    // Die Haussumme zaehlt mit, sonst entstuende ueber Kategorien hinweg
    // eine Ueberbuchung auf Hausebene.
    expect(z.hausBlocked).toBe(3)
  })

  it('legt kein Kontingent an, fuer das die Kapazitaet nicht reicht', async () => {
    const r = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/blocks`,
      headers: auth(admin.sessionId),
      payload: { name: 'Zu gross', categoryId: catId, fromDate: VON, toDate: BIS,
                 quantity: ZIMMER + 1 } })
    expect(r.statusCode).toBe(409)

    // Und es bleibt nichts halb Gebundenes zurueck.
    expect(await zaehler()).toMatchObject({ blocked: 0 })
    const uebrig = await owner.query(`SELECT 1 FROM availability_block`)
    expect(uebrig.rowCount).toBe(0)
  })

  it('weist eine Zimmergruppe eines fremden Hauses ab', async () => {
    const fremd = await makeProperty(owner, { code: 'FREMD' })
    const fremdeKat = await makeCategory(owner, fremd.propertyId)
    const r = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/blocks`,
      headers: auth(admin.sessionId),
      payload: { name: 'Fremd', categoryId: fremdeKat, fromDate: VON, toDate: BIS,
                 quantity: 1 } })
    expect(r.statusCode).toBe(404)
  })
})

describe('Abruf', () => {
  it('verschiebt einen Platz von gehalten nach verkauft', async () => {
    const ref = await kontingent({ quantity: 3 })
    const r = await abruf(ref)
    expect(r.statusCode).toBe(201)

    const z = await zaehler()
    // Der Kern: die Summe bleibt gleich, nur die Spalte wechselt. Wuerde der
    // Abruf zusaetzlich binden, waeren es 3 + 1 = 4.
    expect(z.blocked).toBe(2)
    expect(z.sold).toBe(1)
    expect(z.blocked + z.sold).toBe(3)
    expect(await blockStand()).toMatchObject({ picked_up: 1, quantity: 3 })
  })

  /**
   * Der eigentliche Grund, warum beim Abruf erst freigegeben und dann
   * gebunden wird: im vollen Haus haelt das Kontingent den Platz bereits.
   * In der umgekehrten Reihenfolge scheiterte der Abruf an der eigenen
   * Gruppe.
   */
  it('gelingt auch, wenn das Haus vollstaendig ausgelastet ist', async () => {
    const ref = await kontingent({ quantity: ZIMMER })
    expect(await zaehler()).toMatchObject({ blocked: ZIMMER, sold: 0 })

    const r = await abruf(ref)
    expect(r.statusCode).toBe(201)
    expect(await zaehler()).toMatchObject({ blocked: ZIMMER - 1, sold: 1 })

    // Frei buchen geht jetzt nicht mehr: das Haus ist voll.
    const frei = await abruf(undefined)
    expect(frei.statusCode).toBe(409)
  })

  it('laesst nicht mehr abrufen als vereinbart', async () => {
    const ref = await kontingent({ quantity: 1 })
    expect((await abruf(ref)).statusCode).toBe(201)

    const zweiter = await abruf(ref)
    expect(zweiter.statusCode).toBe(409)
    expect(zweiter.body).toContain('vollstaendig abgerufen')
    expect(await blockStand()).toMatchObject({ picked_up: 1 })
  })

  it('besteht auf dem Zeitraum des Kontingents', async () => {
    const ref = await kontingent()
    const r = await abruf(ref, { departure: '2026-11-04' })
    expect(r.statusCode).toBe(422)
    expect(await blockStand()).toMatchObject({ picked_up: 0 })
  })

  it('uebernimmt den Ratenplan des Kontingents', async () => {
    const plan = await owner.query<{ id: number }>(
      `INSERT INTO rate_plan (property_id, category_id, code, name)
       VALUES ($1,$2,'GRUPPE','Gruppenrate') RETURNING id`, [fx.propertyId, catId])
    const ref = await kontingent({ ratePlanId: plan.rows[0]!.id })
    const r = await abruf(ref)
    expect(r.statusCode).toBe(201)

    const res = await owner.query<{ rate_plan_id: number }>(
      `SELECT rate_plan_id FROM reservation WHERE property_id = $1`, [fx.propertyId])
    expect(Number(res.rows[0]!.rate_plan_id)).toBe(plan.rows[0]!.id)
  })

  it('weist ein Kontingent eines fremden Hauses ab', async () => {
    const fremd = await makeProperty(owner, { code: 'FREMD' })
    const fremdeKat = await makeCategory(owner, fremd.propertyId)
    const b = await owner.query<{ public_ref: string }>(
      `INSERT INTO availability_block
         (property_id, name, category_id, from_date, to_date, quantity)
       VALUES ($1,'Fremd',$2,$3::date,$4::date,2) RETURNING public_ref`,
      [fremd.propertyId, fremdeKat, VON, BIS])

    const r = await abruf(b.rows[0]!.public_ref)
    expect(r.statusCode).toBe(404)
  })
})

describe('Storno eines Abrufs', () => {
  /**
   * Ohne diese Rueckgabe verloere eine Gruppe bei jedem Storno ein Zimmer an
   * Laufkundschaft und stuende am Anreisetag mit zu wenigen da.
   */
  it('gibt den Platz an die Gruppe zurueck, nicht in den freien Verkauf', async () => {
    const ref = await kontingent({ quantity: 3 })
    const r = await abruf(ref)
    const reservationRef = (json(r) as unknown as { reservationRef: string }).reservationRef
    expect(await zaehler()).toMatchObject({ blocked: 2, sold: 1 })

    const storno = await app.inject({
      method: 'POST', url: `/v1/reservations/${reservationRef}/cancel`,
      headers: auth(admin.sessionId), payload: { propertyId: fx.propertyId } })
    expect(storno.statusCode).toBe(200)

    expect(await zaehler()).toMatchObject({ blocked: 3, sold: 0 })
    expect(await blockStand()).toMatchObject({ picked_up: 0 })
  })

  it('gibt frei, wenn das Kontingent schon aufgeloest ist', async () => {
    const ref = await kontingent({ quantity: 3 })
    const r = await abruf(ref)
    const reservationRef = (json(r) as unknown as { reservationRef: string }).reservationRef

    await app.inject({ method: 'POST', url: `/v1/blocks/${ref}/release`,
                       headers: auth(admin.sessionId) })
    expect(await zaehler()).toMatchObject({ blocked: 0, sold: 1 })

    await app.inject({
      method: 'POST', url: `/v1/reservations/${reservationRef}/cancel`,
      headers: auth(admin.sessionId), payload: { propertyId: fx.propertyId } })

    // Nichts mehr zu halten: der Platz geht in den freien Verkauf.
    expect(await zaehler()).toMatchObject({ blocked: 0, sold: 0 })
  })

  it('laesst einen Abruf nicht verschieben', async () => {
    const ref = await kontingent()
    const r = await abruf(ref)
    const reservationRef = (json(r) as unknown as { reservationRef: string }).reservationRef

    const aenderung = await app.inject({
      method: 'POST', url: `/v1/reservations/${reservationRef}/change-stay`,
      headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, departure: '2026-11-06' } })
    expect(aenderung.statusCode).toBe(409)
  })
})

describe('Freigabe', () => {
  it('gibt nur den nicht abgerufenen Rest frei', async () => {
    const ref = await kontingent({ quantity: 3 })
    await abruf(ref)
    expect(await zaehler()).toMatchObject({ blocked: 2, sold: 1 })

    const r = await app.inject({
      method: 'POST', url: `/v1/blocks/${ref}/release`, headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    expect(json(r)).toMatchObject({ released: 2, pickedUp: 1, status: 'released' })

    // Der Abruf bleibt verkauft, nur der Rest ist wieder frei.
    expect(await zaehler()).toMatchObject({ blocked: 0, sold: 1 })
    expect(await blockStand()).toMatchObject({ status: 'released' })
  })

  it('gibt nicht zweimal frei', async () => {
    const ref = await kontingent()
    await app.inject({ method: 'POST', url: `/v1/blocks/${ref}/release`,
                       headers: auth(admin.sessionId) })
    const zweite = await app.inject({ method: 'POST', url: `/v1/blocks/${ref}/release`,
                                      headers: auth(admin.sessionId) })
    expect(zweite.statusCode).toBe(409)
    expect(await zaehler()).toMatchObject({ blocked: 0 })
  })

  it('ist danach nicht mehr abrufbar', async () => {
    const ref = await kontingent()
    await app.inject({ method: 'POST', url: `/v1/blocks/${ref}/release`,
                       headers: auth(admin.sessionId) })
    const r = await abruf(ref)
    expect(r.statusCode).toBe(409)
  })
})

describe('Liste', () => {
  it('liefert Kontingente mit Abrufstand und Abrufen in einer Anfrage', async () => {
    const ref = await kontingent({ quantity: 3 })
    const gast = await owner.query<{ id: number }>(
      `INSERT INTO guest (account_id, last_name, first_name) VALUES ($1,'Jansen','Ute')
       RETURNING id`, [fx.accountId])
    await abruf(ref, { guestId: gast.rows[0]!.id })

    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/blocks`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    const liste = (json(r) as unknown as {
      blocks: Array<{ blockRef: string; name: string; quantity: number; pickedUp: number
                      remaining: number; categoryName: string
                      pickups: Array<{ reservationRef: string; guest: string }> }>
    }).blocks
    expect(liste).toHaveLength(1)
    expect(liste[0]).toMatchObject({ blockRef: ref, quantity: 3, pickedUp: 1, remaining: 2 })
    expect(liste[0]!.pickups).toHaveLength(1)
    expect(liste[0]!.pickups[0]!.guest).toBe('Jansen, Ute')
  })

  it('zeigt die Kontingente eines fremden Hauses nicht', async () => {
    const fremd = await makeProperty(owner, { code: 'FREMD' })
    const fremdeKat = await makeCategory(owner, fremd.propertyId)
    await owner.query(
      `INSERT INTO availability_block
         (property_id, name, category_id, from_date, to_date, quantity)
       VALUES ($1,'Fremd',$2,$3::date,$4::date,2)`,
      [fremd.propertyId, fremdeKat, VON, BIS])

    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/blocks`,
      headers: auth(admin.sessionId) })
    expect((json(r) as unknown as { blocks: unknown[] }).blocks).toHaveLength(0)
  })
})
