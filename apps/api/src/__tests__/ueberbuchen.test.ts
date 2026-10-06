import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/*
 * Bestaetigte Ueberbuchung und die Personenzahl einer bestehenden Buchung
 * (Migration 0093, Sven 06.10.2026).
 *
 * Der Fall dahinter: eine Zimmergruppe mit einem einzigen Zimmer (FZ). Die
 * Buchung darin wandert in die Ablage, und in die Luecke soll eine neue.
 * Der Zaehler sagt "ausgebucht", die Rezeption weiss es besser.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let fz: number
let fzZimmer: number
let auth: Record<string, string>

const VON = '2026-11-10'
const BIS = '2026-11-13'

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
  fz = await makeCategory(owner, fx.propertyId, { code: 'FZ', name: 'Familienzimmer' })
  fzZimmer = (await makeResources(owner, fx.propertyId, fz, 1, 'F'))[0]!
  await owner.query(`SELECT inventory_materialize($1,'2026-10-01'::date,'2027-01-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

let schluessel = 0
const buchen = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...auth, 'idempotency-key': `ueber-${++schluessel}` },
    payload: { propertyId: fx.propertyId, categoryId: fz,
               arrival: VON, departure: BIS, ...payload } })
const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: auth, payload })
const patch = (url: string, payload: unknown) =>
  app.inject({ method: 'PATCH', url, headers: auth, payload })

async function bestand(categoryId: number, date: string): Promise<number> {
  const r = await owner.query<{ sold: number }>(
    `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2 AND date=$3`,
    [fx.propertyId, categoryId, date])
  return r.rows[0]!.sold
}

async function refVon(reservationId: number): Promise<string> {
  const r = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [reservationId])
  return r.rows[0]!.public_ref
}

describe('Zimmergruppe ueberbuchen', () => {
  it('fragt bei voller Gruppe nach und bucht nach der Bestaetigung', async () => {
    // Die bisherige Buchung im einzigen FZ, dann in die Ablage.
    const alt = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: fz,
      resourceId: fzZimmer, arrival: VON, departure: BIS })
    const ab = await post(`/v1/reservations/${await refVon(alt.reservationId)}/assign-unit`,
      { resourceId: null })
    expect(ab.statusCode, ab.body).toBe(200)

    // Ohne Bestaetigung: wie bisher ausgebucht.
    const nein = await buchen({ resourceId: fzZimmer })
    expect(nein.statusCode).toBe(409)
    expect(JSON.parse(nein.body).type).toBe('urn:staygrid:sold_out')
    expect(await bestand(fz, VON)).toBe(1)

    // Mit Bestaetigung: angelegt, im leeren Zimmer, die Gruppe zaehlt zwei.
    const ja = await buchen({ resourceId: fzZimmer, allowOverbooking: true })
    expect(ja.statusCode, ja.body).toBe(201)
    expect(await bestand(fz, VON)).toBe(2)
    expect(await bestand(0, VON)).toBe(2)   // die Haussumme zaehlt mit
  })

  it('gilt nur fuer die eine Anfrage', async () => {
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: fz,
      arrival: VON, departure: BIS })
    expect((await buchen({ allowOverbooking: true })).statusCode).toBe(201)
    // Die Einstellung ist transaktionslokal; die naechste Anfrage auf
    // derselben Verbindung bekommt wieder die harte Grenze.
    for (let i = 0; i < 5; i++) {
      expect((await buchen({})).statusCode).toBe(409)
    }
    expect(await bestand(fz, VON)).toBe(2)
  })

  it('weist eine Angabe ab, die kein Wahrheitswert ist', async () => {
    const r = await buchen({ allowOverbooking: 'ja' })
    expect(r.statusCode).toBe(422)
  })

  it('verlaengert in die volle Gruppe erst nach der Bestaetigung', async () => {
    const eigene = await makeReservation(owner, { propertyId: fx.propertyId,
      categoryId: fz, arrival: VON, departure: BIS })
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: fz,
      arrival: BIS, departure: '2026-11-15' })
    const ref = await refVon(eigene.reservationId)

    const nein = await post(`/v1/reservations/${ref}/change-stay`,
      { departure: '2026-11-14' })
    expect(nein.statusCode).toBe(409)

    // Die Vorschau warnt, statt zu scheitern, und rechnet den Preis.
    const v = await post(`/v1/reservations/${ref}/change-stay/preview`,
      { departure: '2026-11-14' })
    expect(v.statusCode, v.body).toBe(200)
    expect(JSON.parse(v.body)).toMatchObject({ overbooking: true, departure: '2026-11-14' })
    expect(await bestand(fz, BIS)).toBe(1)   // die Vorschau speichert nichts

    const ja = await post(`/v1/reservations/${ref}/change-stay`,
      { departure: '2026-11-14', allowOverbooking: true })
    expect(ja.statusCode, ja.body).toBe(200)
    expect(await bestand(fz, BIS)).toBe(2)
  })

  it('meldet in der Vorschau keine Ueberbuchung, wo Platz ist', async () => {
    const eigene = await makeReservation(owner, { propertyId: fx.propertyId,
      categoryId: fz, arrival: VON, departure: BIS })
    const v = await post(
      `/v1/reservations/${await refVon(eigene.reservationId)}/change-stay/preview`,
      { departure: '2026-11-14' })
    expect(v.statusCode, v.body).toBe(200)
    expect(JSON.parse(v.body).overbooking).toBe(false)
  })
})

describe('Personenzahl einer bestehenden Buchung', () => {
  async function reservierung(status?: 'Confirmed' | 'InHouse'): Promise<string> {
    const r = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: fz,
      arrival: VON, departure: BIS, status,
      resourceId: status === 'InHouse' ? fzZimmer : undefined })
    return refVon(r.reservationId)
  }

  async function personen(ref: string) {
    const r = await owner.query<{ guest_count: number | null; adults: number | null
                                  children: number | null }>(
      `SELECT guest_count, adults, children FROM reservation WHERE public_ref = $1`, [ref])
    return r.rows[0]!
  }

  it('aendert Erwachsene und Kinder', async () => {
    const ref = await reservierung()
    const r = await patch(`/v1/reservations/${ref}`, { adults: 2, children: 1 })
    expect(r.statusCode, r.body).toBe(200)
    expect(await personen(ref)).toEqual({ guest_count: 3, adults: 2, children: 1 })

    // Und zurueck auf eine reine Gesamtzahl.
    const g = await patch(`/v1/reservations/${ref}`, { guestCount: 1 })
    expect(g.statusCode, g.body).toBe(200)
    expect(await personen(ref)).toEqual({ guest_count: 1, adults: null, children: null })
  })

  it('bewegt dabei keinen Bestand', async () => {
    const ref = await reservierung()
    await patch(`/v1/reservations/${ref}`, { adults: 4 })
    expect(await bestand(fz, VON)).toBe(1)
  })

  it('geht auch im Haus', async () => {
    const ref = await reservierung('InHouse')
    const r = await patch(`/v1/reservations/${ref}`, { adults: 3 })
    expect(r.statusCode, r.body).toBe(200)
    expect((await personen(ref)).guest_count).toBe(3)
  })

  it('nicht an einer stornierten Buchung', async () => {
    const ref = await reservierung()
    expect((await post(`/v1/reservations/${ref}/cancel`, {})).statusCode).toBe(200)
    const r = await patch(`/v1/reservations/${ref}`, { adults: 2 })
    expect(r.statusCode).toBe(409)
  })

  it('prueft wie beim Anlegen', async () => {
    const ref = await reservierung()
    expect((await patch(`/v1/reservations/${ref}`, { children: 2 })).statusCode).toBe(422)
    expect((await patch(`/v1/reservations/${ref}`, { adults: 0 })).statusCode).toBe(422)
    expect((await patch(`/v1/reservations/${ref}`,
      { adults: 2, children: 1, guestCount: 4 })).statusCode).toBe(422)
  })

  it('steht in der Reservierung', async () => {
    const ref = await reservierung()
    await patch(`/v1/reservations/${ref}`, { adults: 2, children: 2 })
    const r = await app.inject({ method: 'GET', url: `/v1/reservations/${ref}`,
      headers: auth })
    expect(JSON.parse(r.body)).toMatchObject({ guestCount: 4, adults: 2, children: 2 })
  })
})
