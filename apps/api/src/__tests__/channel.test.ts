import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
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
const FROM = '2026-10-01'
const TO = '2026-10-05'

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
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  await makeResources(owner, fx.propertyId, catId, 2)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
    [fx.propertyId])
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
})

async function makeConnection(): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: `/v1/properties/${fx.propertyId}/channel-connections`,
    headers: auth(admin.sessionId), payload: { provider: 'roomcloud', name: 'Roomcloud Test' } })
  expect(r.statusCode).toBe(201)
  return (JSON.parse(r.body) as { token: string }).token
}

const ari = (token: string, url: string) => app.inject({
  method: 'GET', url, headers: { authorization: `Bearer ${token}` } })

const book = (token: string, payload: unknown) => app.inject({
  method: 'POST', url: '/v1/channel/ari/bookings',
  headers: { authorization: `Bearer ${token}` }, payload })

describe('Verwaltung des Channel-Zugangs', () => {
  it('legt einen Zugang an und listet ihn', async () => {
    const token = await makeConnection()
    expect(token).toMatch(/^[0-9A-Za-z]+\.[\w-]+$/)

    const list = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/channel-connections`,
      headers: auth(admin.sessionId) })
    expect(list.statusCode).toBe(200)
    const { connections } = JSON.parse(list.body) as { connections: Array<{ status: string }> }
    expect(connections).toHaveLength(1)
    expect(connections[0]!.status).toBe('active')
  })

  it('sperrt einen Zugang, danach schlaegt die Anmeldung fehl', async () => {
    const token = await makeConnection()
    const ref = token.split('.')[0]!
    const disable = await app.inject({
      method: 'POST',
      url: `/v1/properties/${fx.propertyId}/channel-connections/${ref}/disable`,
      headers: auth(admin.sessionId) })
    expect(disable.statusCode).toBe(200)

    const res = await ari(token, `/v1/channel/ari/availability?from=${FROM}&to=${TO}`)
    expect(res.statusCode).toBe(401)
  })

  it('lehnt einen erfundenen oder falsch aufgebauten Token ab', async () => {
    await makeConnection()
    const kaputt = await ari('nicht.gueltig', `/v1/channel/ari/availability?from=${FROM}&to=${TO}`)
    expect(kaputt.statusCode).toBe(401)
    const ohnePunkt = await ari('ganzfalsch', `/v1/channel/ari/availability?from=${FROM}&to=${TO}`)
    expect(ohnePunkt.statusCode).toBe(401)
  })
})

describe('ARI ausgehend: Verfuegbarkeit', () => {
  it('liefert den Vollabgleich je Kategorie und Tag', async () => {
    const token = await makeConnection()
    const res = await ari(token, `/v1/channel/ari/availability?from=${FROM}&to=${TO}`)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { days: Array<{ categoryCode: string; capacity: number }> }
    expect(body.days.length).toBe(4)   // vier Naechte, eine Kategorie
    expect(body.days.every(d => d.categoryCode === 'DZ')).toBe(true)
    expect(body.days[0]!.capacity).toBe(2)
  })

  it('liefert bei "since" nur die seither geaenderten Tage', async () => {
    const token = await makeConnection()
    const marke = new Date().toISOString()

    // Eine Buchung veraendert genau die Tage ihres Aufenthalts.
    await book(token, {
      externalReference: 'RC-1', categoryCode: 'DZ', arrival: FROM, departure: '2026-10-02'
    })

    const voll = await ari(token, `/v1/channel/ari/availability?from=${FROM}&to=${TO}`)
    expect(JSON.parse(voll.body).days).toHaveLength(4)

    const delta = await ari(token,
      `/v1/channel/ari/availability?from=${FROM}&to=${TO}&since=${marke}`)
    expect(delta.statusCode).toBe(200)
    const { days } = JSON.parse(delta.body) as { days: Array<{ date: string; sold: number }> }
    expect(days).toHaveLength(1)
    expect(days[0]!.date).toBe(FROM)
    expect(days[0]!.sold).toBe(1)
  })

  it('sieht nur die eigene Property, nicht die eines fremden Zugangs', async () => {
    const tokenA = await makeConnection()
    const b = await makeProperty(owner, { code: 'B' })
    await makeCategory(owner, b.propertyId, { code: 'EZ' })
    await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
      [b.propertyId])

    const res = await ari(tokenA, `/v1/channel/ari/availability?from=${FROM}&to=${TO}`)
    const { days } = JSON.parse(res.body) as { days: Array<{ categoryCode: string }> }
    expect(days.every(d => d.categoryCode === 'DZ')).toBe(true)
  })
})

describe('ARI ausgehend: Preise und Restriktionen', () => {
  it('liefert Preise und Restriktionen, im Vollabgleich und als Aenderung', async () => {
    const token = await makeConnection()
    const rp = await owner.query<{ id: number }>(
      `INSERT INTO rate_plan (property_id, category_id, code, name)
       VALUES ($1,$2,'BAR','Bestpreis') RETURNING id`, [fx.propertyId, catId])
    const ratePlanId = rp.rows[0]!.id

    const voll = await ari(token, `/v1/channel/ari/rates?from=${FROM}&to=${TO}`)
    expect(voll.statusCode).toBe(200)
    // Der volle Zeitraum kommt zurueck, auch unbepreist: das ist der
    // Vollabgleich, nicht nur, was schon gepflegt ist.
    const vollCells = JSON.parse(voll.body).cells as Array<{ priceCent: number[] | null }>
    expect(vollCells).toHaveLength(4)
    expect(vollCells.every(c => c.priceCent === null)).toBe(true)

    const marke = new Date().toISOString()
    await owner.query(
      `INSERT INTO rate_day (property_id, rate_plan_id, date, price_cent)
       VALUES ($1,$2,$3::date,'{9000,12000}')`, [fx.propertyId, ratePlanId, FROM])
    await owner.query(
      `INSERT INTO restriction_day (property_id, rate_plan_id, date, min_los, closed_to_arrival)
       VALUES ($1,$2,$3::date,2,true)`, [fx.propertyId, ratePlanId, FROM])

    const nachPflege = await ari(token, `/v1/channel/ari/rates?from=${FROM}&to=${TO}`)
    const alle = JSON.parse(nachPflege.body).cells as Array<{
      date: string; priceCent: number[] | null; minLos: number | null; closedToArrival: boolean
    }>
    const tag = alle.find(c => c.date === FROM)!
    expect(tag.priceCent).toEqual([9000, 12000])
    expect(tag.minLos).toBe(2)
    expect(tag.closedToArrival).toBe(true)

    const delta = await ari(token, `/v1/channel/ari/rates?from=${FROM}&to=${TO}&since=${marke}`)
    const geaendert = JSON.parse(delta.body).cells as Array<{ date: string }>
    expect(geaendert.map(c => c.date)).toEqual([FROM])
  })
})

describe('ARI eingehend: Reservierungen', () => {
  it('bindet Kontingent ueber inventory_reserve, nicht per Direktzugriff', async () => {
    const token = await makeConnection()
    const res = await book(token, {
      externalReference: 'RC-100', categoryCode: 'DZ', arrival: FROM, departure: '2026-10-03'
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { status: string; bookingRef: string; nights: number }
    expect(body.status).toBe('created')
    expect(body.nights).toBe(2)

    const inv = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id = $1 AND category_id = $2 AND date = $3::date`,
      [fx.propertyId, catId, FROM])
    expect(inv.rows[0]!.sold).toBe(1)

    const booking = await owner.query(
      `SELECT source, channel_code, external_reference FROM booking WHERE property_id = $1`,
      [fx.propertyId])
    expect(booking.rows).toHaveLength(1)
    expect(booking.rows[0]).toMatchObject(
      { source: 'channel', channel_code: 'roomcloud', external_reference: 'RC-100' })
  })

  it('legt bei wiederholter Zustellung derselben externen Nummer nichts doppelt an', async () => {
    const token = await makeConnection()
    const payload = {
      externalReference: 'RC-200', categoryCode: 'DZ', arrival: FROM, departure: '2026-10-02'
    }
    const erst = await book(token, payload)
    expect(erst.statusCode).toBe(201)
    const erstBody = JSON.parse(erst.body) as { bookingRef: string; reservationRef: string }

    const zweit = await book(token, payload)
    expect(zweit.statusCode).toBe(200)
    const zweitBody = JSON.parse(zweit.body) as {
      status: string; bookingRef: string; reservationRef: string
    }
    expect(zweitBody.status).toBe('already_exists')
    expect(zweitBody.bookingRef).toBe(erstBody.bookingRef)
    expect(zweitBody.reservationRef).toBe(erstBody.reservationRef)

    const count = await owner.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM booking WHERE property_id = $1 AND external_reference = $2`,
      [fx.propertyId, 'RC-200'])
    expect(Number(count.rows[0]!.n)).toBe(1)

    // Die zweite Zustellung darf das Kontingent nicht ein zweites Mal binden:
    // reserviert, dann wegen der Dublette wieder freigegeben.
    const inv = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id = $1 AND category_id = $2 AND date = $3::date`,
      [fx.propertyId, catId, FROM])
    expect(inv.rows[0]!.sold).toBe(1)
  })

  it('legt bei gleichzeitiger doppelter Zustellung genau eine Buchung an', async () => {
    const token = await makeConnection()
    const payload = {
      externalReference: 'RC-300', categoryCode: 'DZ', arrival: FROM, departure: '2026-10-02'
    }
    const antworten = await Promise.all(
      Array.from({ length: 10 }, () => book(token, payload)))

    const erstellt = antworten.filter(r => r.statusCode === 201)
    const vorhanden = antworten.filter(r => r.statusCode === 200)
    expect(erstellt).toHaveLength(1)
    expect(vorhanden).toHaveLength(9)

    const refs = new Set(antworten.map(r => (JSON.parse(r.body) as { bookingRef: string }).bookingRef))
    expect(refs.size).toBe(1)

    const count = await owner.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM booking WHERE property_id = $1 AND external_reference = $2`,
      [fx.propertyId, 'RC-300'])
    expect(Number(count.rows[0]!.n)).toBe(1)

    const inv = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id = $1 AND category_id = $2 AND date = $3::date`,
      [fx.propertyId, catId, FROM])
    expect(inv.rows[0]!.sold).toBe(1)
  })

  it('meldet ausgebuchte Kategorien sauber statt mit einem rohen Datenbankfehler', async () => {
    const token = await makeConnection()
    // Kapazitaet ist 2; zwei Buchungen fuellen sie, die dritte muss scheitern.
    await book(token, { externalReference: 'A', categoryCode: 'DZ', arrival: FROM, departure: '2026-10-02' })
    await book(token, { externalReference: 'B', categoryCode: 'DZ', arrival: FROM, departure: '2026-10-02' })
    const res = await book(token,
      { externalReference: 'C', categoryCode: 'DZ', arrival: FROM, departure: '2026-10-02' })
    expect(res.statusCode).toBe(409)
  })

  it('weist eine unbekannte Kategorie zurueck', async () => {
    const token = await makeConnection()
    const res = await book(token,
      { externalReference: 'X', categoryCode: 'NICHT-DA', arrival: FROM, departure: '2026-10-02' })
    expect(res.statusCode).toBe(422)
  })

  it('legt den mitgesendeten Gast ohne Dublettenpruefung an', async () => {
    const token = await makeConnection()
    const res = await book(token, {
      externalReference: 'RC-400', categoryCode: 'DZ', arrival: FROM, departure: '2026-10-02',
      guest: { lastName: 'Petersen', firstName: 'Jan', email: 'jan@example.de' }
    })
    expect(res.statusCode).toBe(201)

    const guest = await owner.query(
      `SELECT g.last_name, g.first_name FROM guest g
         JOIN reservation r ON r.primary_guest_id = g.id
         JOIN booking b ON b.id = r.booking_id
        WHERE b.external_reference = 'RC-400'`)
    expect(guest.rows).toHaveLength(1)
    expect(guest.rows[0]).toMatchObject({ last_name: 'Petersen', first_name: 'Jan' })
  })

  it('lehnt eine Buchung ohne gueltigen Token ab', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/channel/ari/bookings',
      payload: { externalReference: 'X', categoryCode: 'DZ', arrival: FROM, departure: '2026-10-02' } })
    expect(res.statusCode).toBe(401)
  })
})
