import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeGuest, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Die Reservierungsliste mit Aenderungscursor (Migration 0075) und die
 * Personen getrennt nach Erwachsenen und Kindern (0076).
 *
 * Der Kern ist die Zusage des Cursors: **keine Aenderung geht verloren**,
 * auch nicht die an einem Nachtpreis, am Namen des Gastes oder durch eine
 * Transaktion, die laenger braucht als die naechste.
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
  await makeResources(owner, fx.propertyId, catId, 6)
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
const buchen = async (payload: Record<string, unknown> = {}) => {
  const r = await app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...auth, 'idempotency-key': `l-${++schluessel}` },
    payload: { propertyId: fx.propertyId, categoryId: catId,
               arrival: VON, departure: BIS, ...payload } })
  return r
}
const buchenOk = async (payload: Record<string, unknown> = {}): Promise<string> => {
  const r = await buchen(payload)
  expect(r.statusCode, r.body).toBe(201)
  return (JSON.parse(r.body) as { reservationRef: string }).reservationRef
}

interface Zeile { reservationRef: string; [k: string]: unknown }
interface Liste { reservations: Zeile[]; nextCursor: string; hasMore: boolean }

const liste = async (query = '', headers = auth): Promise<Liste> => {
  const r = await app.inject({ method: 'GET',
    url: `/v1/properties/${fx.propertyId}/reservations${query}`, headers })
  expect(r.statusCode, r.body).toBe(200)
  return JSON.parse(r.body) as Liste
}
const seit = (cursor: string, extra = '') => liste(`?changedSince=${cursor}${extra}`)
const refs = (l: Liste) => l.reservations.map(z => z.reservationRef).sort()

describe('Vollabzug', () => {
  it('liefert die Felder, die ein Abgleich braucht', async () => {
    const gast = await makeGuest(owner, fx.accountId, { lastName: 'Petersen', firstName: 'Jan' })
    await owner.query(`UPDATE guest SET email = 'jan@example.org' WHERE id = $1`, [gast.id])
    const ref = await buchenOk({ resourceId: zimmer[0], guestRef: gast.publicRef,
                                 adults: 2, children: 1, priceCent: 9000,
                                 externalReference: 'RC-1', notes: 'spaet' })

    const l = await liste()
    expect(l.hasMore).toBe(false)
    expect(l.reservations).toHaveLength(1)
    const z = l.reservations[0]!
    expect(z).toMatchObject({
      reservationRef: ref, externalReference: 'RC-1', status: 'Confirmed',
      statusGroup: 'active', arrival: VON, departure: BIS, lastNight: '2026-10-03',
      categoryCode: 'DZ', guestName: 'Jan Petersen', guestAnonymized: false,
      adults: 2, children: 1, guestCount: 3, totalCent: 27000, currency: 'EUR',
      notes: 'spaet', canceledAt: null })
    expect(typeof z.bookingRef).toBe('string')
    expect(z.roomCode).not.toBeNull()
    // Die Mailadresse nur auf ausdrueckliche Anforderung.
    expect(z).not.toHaveProperty('guestEmail')
    // Der Cursor bleibt drinnen.
    expect(z).not.toHaveProperty('xid')

    const mitMail = await liste('?include=guestEmail')
    expect(mitMail.reservations[0]!.guestEmail).toBe('jan@example.org')
  })

  it('blaettert ohne Doppel und ohne Luecke', async () => {
    const alle = [await buchenOk(), await buchenOk(), await buchenOk(),
                  await buchenOk(), await buchenOk()]
    const gesehen: string[] = []
    let l = await liste('?limit=2')
    gesehen.push(...l.reservations.map(z => z.reservationRef))
    let runden = 0
    while (l.hasMore && runden++ < 10) {
      expect(l.reservations).toHaveLength(2)
      l = await seit(l.nextCursor, '&limit=2')
      gesehen.push(...l.reservations.map(z => z.reservationRef))
    }
    expect(gesehen.sort()).toEqual([...alle].sort())
  })

  it('filtert nach Zustand und Aufenthalt', async () => {
    const frueh = await buchenOk({ arrival: '2026-10-01', departure: '2026-10-03' })
    const spaet = await buchenOk({ arrival: '2026-10-10', departure: '2026-10-12' })
    const storno = await buchenOk({ arrival: '2026-10-10', departure: '2026-10-11' })
    await owner.query(
      `UPDATE reservation SET status = 'Canceled', canceled_at = now() WHERE public_ref = $1`,
      [storno])

    expect(refs(await liste('?status=canceled'))).toEqual([storno])
    expect(refs(await liste('?status=active'))).toEqual([frueh, spaet].sort())
    const c = (await liste('?status=canceled')).reservations[0]!
    expect(c.statusGroup).toBe('canceled')
    expect(c.canceledAt).not.toBeNull()

    // Ueberlappung: die Abreise am 03. heisst, die letzte Nacht ist der 02.
    expect(refs(await liste('?stayFrom=2026-10-03&stayTo=2026-10-09'))).toEqual([])
    expect(refs(await liste('?stayFrom=2026-10-02&stayTo=2026-10-02'))).toEqual([frueh])
    expect(refs(await liste('?stayFrom=2026-10-11&status=active'))).toEqual([spaet])
  })
})

describe('Aenderungscursor', () => {
  it('meldet nichts, solange sich nichts aendert', async () => {
    await buchenOk()
    const voll = await liste()
    const leer = await seit(voll.nextCursor)
    expect(leer.reservations).toEqual([])
    expect(leer.hasMore).toBe(false)
  })

  it('zaehlt jede Art von Aenderung, die in der Liste steht', async () => {
    const gast = await makeGuest(owner, fx.accountId)
    const ref = await buchenOk({ guestRef: gast.publicRef })
    const resId = (await owner.query<{ id: number; booking_id: number }>(
      `SELECT id, booking_id FROM reservation WHERE public_ref = $1`, [ref])).rows[0]!
    let cursor = (await liste()).nextCursor

    const kommtWieder = async (was: string) => {
      const l = await seit(cursor)
      expect(refs(l), was).toEqual([ref])
      cursor = l.nextCursor
    }

    // Notiz ueber die Route.
    const p = await app.inject({ method: 'PATCH', url: `/v1/reservations/${ref}`,
      headers: auth, payload: { notes: 'Fruehstueck aufs Zimmer' } })
    expect(p.statusCode, p.body).toBe(200)
    await kommtWieder('Notiz')

    // Nachtpreis: `updated_at` der Reservierung bleibt dabei stehen.
    await owner.query(
      `UPDATE reservation_night SET price_cent = price_cent + 100
        WHERE reservation_id = $1 AND date = $2`, [resId.id, VON])
    await kommtWieder('Nachtpreis')

    // Mitreisender.
    await owner.query(
      `INSERT INTO reservation_occupant (property_id, reservation_id, age_at_arrival)
       VALUES ($1,$2,7)`, [fx.propertyId, resId.id])
    await kommtWieder('Mitreisender')

    // Kanalnummer an der Buchung.
    await owner.query(`UPDATE booking SET external_reference = 'RC-9' WHERE id = $1`,
      [resId.booking_id])
    await kommtWieder('Buchung')

    // Namenskorrektur am Gast.
    await owner.query(`UPDATE guest SET last_name = 'Peters' WHERE id = $1`, [gast.id])
    await kommtWieder('Gastname')

    // Der Nachtlauf bucht die Nacht -- das ist keine Aenderung, die das
    // Adminpanel sieht, und kaeme sonst jede Nacht fuer das ganze Haus.
    await owner.query(`UPDATE reservation_night SET posted = true WHERE reservation_id = $1`,
      [resId.id])
    // Eine Telefonnummer steht nicht in der Liste.
    await owner.query(`UPDATE guest SET phone = '0471 1' WHERE id = $1`, [gast.id])
    expect((await seit(cursor)).reservations).toEqual([])
  })

  it('liefert eine Anonymisierung als Zeile ohne Namen', async () => {
    const gast = await makeGuest(owner, fx.accountId)
    const ref = await buchenOk({ guestRef: gast.publicRef })
    // Ein offener Aufenthalt blockiert die Loeschung; storniert geht es.
    await owner.query(
      `UPDATE reservation SET status = 'Canceled', canceled_at = now() WHERE public_ref = $1`,
      [ref])
    const cursor = (await liste()).nextCursor

    const a = await app.inject({ method: 'POST', url: `/v1/guests/${gast.publicRef}/anonymize`,
      headers: auth })
    expect(a.statusCode, a.body).toBe(200)
    expect(JSON.parse(a.body).status).toBe('anonymized')

    const l = await seit(cursor)
    expect(refs(l)).toEqual([ref])
    expect(l.reservations[0]).toMatchObject({ guestName: null, guestAnonymized: true })
  })

  it('verliert keine Aenderung einer Transaktion, die spaeter committet', async () => {
    /*
     * Der Fall, an dem ein Zeitstempel oder eine Sequenz scheitert: A
     * schreibt zuerst und committet zuletzt. B ist laengst sichtbar, als A
     * fertig wird. Wer B ausliefert und sich die Stelle merkt, darf A danach
     * nicht verpassen.
     */
    const a = await buchenOk()
    const b = await buchenOk()
    const cursor = (await liste()).nextCursor

    const langsam = await owner.connect()
    try {
      await langsam.query('BEGIN')
      await langsam.query(`UPDATE reservation SET notes = 'A' WHERE public_ref = $1`, [a])

      const p = await app.inject({ method: 'PATCH', url: `/v1/reservations/${b}`,
        headers: auth, payload: { notes: 'B' } })
      expect(p.statusCode, p.body).toBe(200)

      // B ist committet, aber A laeuft noch und liegt davor: B wartet.
      const waehrend = await seit(cursor)
      expect(waehrend.reservations).toEqual([])

      await langsam.query('COMMIT')
      const danach = await seit(waehrend.nextCursor)
      expect(refs(danach)).toEqual([a, b].sort())
    } finally {
      langsam.release()
    }
  })
})

describe('Eingaben und Rechte', () => {
  it('weist einen fremden Cursor, unbekannte Felder und zu grosse Seiten ab', async () => {
    const get = (q: string) => app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/reservations${q}`, headers: auth })
    expect((await get('?changedSince=gestern')).statusCode).toBe(422)
    expect((await get('?include=phone')).statusCode).toBe(422)
    expect((await get('?limit=1001')).statusCode).toBe(422)
    expect((await get('?status=offen')).statusCode).toBe(422)
    expect((await get('?stayFrom=2026-10-05&stayTo=2026-10-01')).statusCode).toBe(422)
  })

  it('gibt die Mailadresse nur mit guest:read heraus', async () => {
    // Revenue liest Reservierungen fuer die Auslastung, aber keine Gaeste.
    const rev = await makeUser(owner,
      { email: 'rev@test.de', propertyId: fx.propertyId, roleKey: 'revenue' })
    const h = { cookie: `hp_session=${rev.sessionId}` }
    await buchenOk()
    expect((await liste('', h)).reservations).toHaveLength(1)
    const r = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/reservations?include=guestEmail`, headers: h })
    expect(r.statusCode).toBe(403)
  })
})

describe('Erwachsene und Kinder', () => {
  const personen = async (ref: string) => (await owner.query(
    `SELECT guest_count, adults, children FROM reservation WHERE public_ref = $1`,
    [ref])).rows[0]

  it('bildet die Gesamtzahl aus Erwachsenen und Kindern', async () => {
    expect(await personen(await buchenOk({ adults: 2, children: 2 })))
      .toEqual({ guest_count: 4, adults: 2, children: 2 })
    expect(await personen(await buchenOk({ adults: 1 })))
      .toEqual({ guest_count: 1, adults: 1, children: null })
    // Wer nur die Summe kennt, setzt nur sie; die Aufteilung bleibt offen.
    expect(await personen(await buchenOk({ guestCount: 3 })))
      .toEqual({ guest_count: 3, adults: null, children: null })
    // Beides zugleich geht, wenn es dasselbe meint.
    expect(await personen(await buchenOk({ guestCount: 3, adults: 2, children: 1 })))
      .toEqual({ guest_count: 3, adults: 2, children: 1 })
  })

  it('weist Widersprueche ab, statt eine Zahl zu raten', async () => {
    expect((await buchen({ guestCount: 4, adults: 2, children: 1 })).statusCode).toBe(422)
    expect((await buchen({ children: 2 })).statusCode).toBe(422)
    expect((await buchen({ adults: 0 })).statusCode).toBe(422)
    expect((await buchen({ adults: 2, children: -1 })).statusCode).toBe(422)
  })

  it('steht im Einzelabruf und in der Buchung', async () => {
    const ref = await buchenOk({ adults: 2, children: 1 })
    const d = await app.inject({ method: 'GET', url: `/v1/reservations/${ref}`, headers: auth })
    expect(JSON.parse(d.body)).toMatchObject({ guestCount: 3, adults: 2, children: 1 })
    const bookingRef = (JSON.parse(d.body) as { bookingRef: string }).bookingRef
    const b = await app.inject({ method: 'GET', url: `/v1/bookings/${bookingRef}`, headers: auth })
    expect(JSON.parse(b.body).rooms[0]).toMatchObject({ adults: 2, children: 1 })
  })
})
