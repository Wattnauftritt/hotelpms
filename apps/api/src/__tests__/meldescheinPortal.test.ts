import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, makeReservation, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Meldeschein ueber den festen Link je Haus (Migration 0216).
 *
 * Gegen die echte Datenbank: die Seite ist anonym, und erst die Funktion
 * `checkin_portal_open` setzt den Kontext, unter dem die Zeilenrichtlinie
 * die Abgabe ueberhaupt schreiben laesst. Eine Attrappe saehe das nicht.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let chef: Record<string, string>
let chefUser: { userId: number; sessionId: string }
let ref: string

const HEUTE = '2026-10-01'
const ANREISE = '2026-10-03'
const ABREISE = '2026-10-06'

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
  await openBusinessDay(owner, fx.propertyId, HEUTE)
  chefUser = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [chefUser.userId, fx.accountId])
  chef = { cookie: `hp_session=${chefUser.sessionId}` }
  ref = (await owner.query<{ checkin_portal_ref: string }>(
    `SELECT checkin_portal_ref FROM property WHERE id = $1`, [fx.propertyId]))
    .rows[0]!.checkin_portal_ref
})

/** Eine bestaetigte Reservierung mit Hauptgast, wahlweise mit Portalnummer. */
async function reservierung(nummer: string | null, anreise = ANREISE): Promise<{
  id: number; ref: string; bookingId: number }> {
  const g = await owner.query<{ id: number }>(
    `INSERT INTO guest (account_id, last_name, first_name, language)
     VALUES ($1,'Petersen','Anna','de') RETURNING id`, [fx.accountId])
  const r = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: catId, arrival: anreise, departure: ABREISE,
    status: 'Confirmed', reserveInventory: false })
  await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
    [r.reservationId, g.rows[0]!.id])
  const z = (await owner.query<{ public_ref: string; booking_id: number }>(
    `SELECT public_ref, booking_id FROM reservation WHERE id = $1`, [r.reservationId])).rows[0]!
  if (nummer !== null) {
    await owner.query(`UPDATE booking SET channel_booking_number = $2 WHERE id = $1`,
      [z.booking_id, nummer])
  }
  return { id: r.reservationId, ref: z.public_ref, bookingId: z.booking_id }
}

function meldeschein(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bookingNumber: '4711223344', arrival: ANREISE,
    guest: { lastName: 'Jansen', firstName: 'Pieter', birthDate: '1975-02-01',
             nationality: 'NL', idDocumentType: 'passport', idDocumentNumber: 'NX12345P7',
             address: { line1: 'Herengracht 1', postalCode: '1015', city: 'Amsterdam',
                        country: 'NL' } },
    expectedArrival: 'gegen 16 Uhr',
    phone: '+31 6 12345678',
    confirmed: true,
    ...extra
  }
}

const abgeben = (payload: Record<string, unknown>, kennung = ref) =>
  app.inject({ method: 'POST', url: `/v1/meldeschein/${kennung}`, payload })

async function schein(reservationId: number): Promise<{ source: string } | undefined> {
  return (await owner.query<{ source: string }>(
    `SELECT source FROM registration WHERE reservation_id = $1`, [reservationId])).rows[0]
}

async function wartend(): Promise<Array<{
  booking_number: string; last_name: string; hold_reason: string | null; klartext: boolean }>> {
  return (await owner.query(
    `SELECT booking_number, last_name, hold_reason,
            position('Herengracht' in encode(payload_enc, 'escape')) > 0 AS klartext
       FROM checkin_portal_submission ORDER BY id`)).rows
}

describe('Formular', () => {
  it('zeigt, was das Haus jedem Gast zeigt, und nichts zu einer Buchung', async () => {
    const r = await app.inject({ method: 'GET',
      url: `/v1/meldeschein/${ref}/form?arrival=${ANREISE}` })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(Object.keys(r.json<object>()).sort()).toEqual(['digitalGuestCardOffered',
      'exemptionReasons', 'maxCompanions', 'propertyName', 'terms'])
  })

  it('kennt keine fremde oder falsch geformte Kennung', async () => {
    for (const k of ['ABCDEFGH23456789', 'nicht-gueltig']) {
      const r = await app.inject({ method: 'GET', url: `/v1/meldeschein/${k}/form` })
      expect(r.statusCode, k).toBe(404)
    }
  })

  it('steht als Link in der Einstellung des Hauses', async () => {
    const r = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/online-checkin-settings`, headers: chef })
    expect(r.json<{ portalLink: string }>().portalLink).toMatch(new RegExp(`/meldeschein/${ref}$`))
  })
})

describe('Abgabe', () => {
  it('ordnet sofort zu, wenn die Nummer schon bekannt ist', async () => {
    const r = await reservierung('4711223344')
    const a = await abgeben(meldeschein())
    expect(a.statusCode, a.body).toBe(201)
    expect(a.json()).toEqual({ state: 'received' })
    expect((await schein(r.id))?.source).toBe('online')
    expect(await wartend()).toEqual([])
  })

  it('antwortet ohne passende Buchung genauso und haelt den Schein verschluesselt', async () => {
    await reservierung('4711223344', '2026-10-04')
    const a = await abgeben(meldeschein())
    expect(a.statusCode, a.body).toBe(201)
    expect(a.json()).toEqual({ state: 'received' })
    // Der Anreisetag passt nicht: kein Zuordnen nach "ungefaehr".
    expect(await wartend()).toEqual([{ booking_number: '4711223344', last_name: 'Jansen',
                                       hold_reason: null, klartext: false }])
  })

  it('ordnet zu, sobald das Umsystem die Nummer meldet', async () => {
    const r = await reservierung(null)
    expect((await abgeben(meldeschein())).statusCode).toBe(201)
    expect(await wartend()).toHaveLength(1)

    const z = await app.inject({ method: 'POST', url: '/v1/oauth-clients', headers: chef,
      payload: { name: 'Adminpanel', scopes: ['guest:contact_write'],
                 propertyIds: [fx.propertyId] } })
    expect(z.statusCode, z.body).toBe(201)
    const { clientId, clientSecret } = z.json<{ clientId: string; clientSecret: string }>()
    const t = await app.inject({ method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'client_credentials',
                                     client_id: clientId, client_secret: clientSecret })
        .toString() })
    const maschine = { authorization: `Bearer ${t.json<{ access_token: string }>().access_token}` }
    const k = await app.inject({ method: 'PUT',
      url: `/v1/reservations/${r.ref}/guest-contact`, headers: maschine,
      payload: { channelBookingNumber: '4711223344' } })
    expect(k.statusCode, k.body).toBe(200)

    expect((await schein(r.id))?.source).toBe('online')
    expect(await wartend()).toEqual([])
    // Ins Profil wie ueber den Link aus der Mail.
    const g = await owner.query<{ last_name: string }>(
      `SELECT g.last_name FROM guest g JOIN reservation r ON r.primary_guest_id = g.id
        WHERE r.id = $1`, [r.id])
    expect(g.rows[0]!.last_name).toBe('Jansen')
  })

  it('laesst einen zweiten Schein zur selben Buchung liegen, mit Grund', async () => {
    const r = await reservierung('4711223344')
    expect((await abgeben(meldeschein())).statusCode).toBe(201)
    expect((await schein(r.id))?.source).toBe('online')
    const zweiter = await abgeben(meldeschein())
    expect(zweiter.statusCode).toBe(201)
    expect(zweiter.json()).toEqual({ state: 'received' })
    expect((await wartend()).map(w => w.hold_reason)).toEqual(['registered'])
  })

  it('nennt alle Fehler auf einmal, auch Nummer und Anreisetag', async () => {
    const a = await abgeben(meldeschein({ bookingNumber: '', arrival: '2030-01-01',
                                          phone: undefined }))
    expect(a.statusCode).toBe(422)
    const f = a.json<{ errors: Record<string, string[]> }>().errors
    expect(Object.keys(f)).toEqual(expect.arrayContaining(['bookingNumber', 'arrival', 'phone']))
    expect(await wartend()).toEqual([])
  })

  it('weist eine Ausweiskopie ab wie der Link aus der Mail', async () => {
    const a = await abgeben(meldeschein({ idDocumentImage: 'data:image/png;base64,AAAA' }))
    expect(a.statusCode).toBe(422)
    expect(await wartend()).toEqual([])
  })

  it('begrenzt wartende Scheine je Nummer', async () => {
    for (let i = 0; i < 5; i++) expect((await abgeben(meldeschein())).statusCode).toBe(201)
    expect((await abgeben(meldeschein())).statusCode).toBe(429)
    expect(await wartend()).toHaveLength(5)
  })

  it('begrenzt Abgaben je Herkunft', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await abgeben(meldeschein({ bookingNumber: `N${i}` }))).statusCode).toBe(201)
    }
    expect((await abgeben(meldeschein({ bookingNumber: 'N99' }))).statusCode).toBe(429)
    // Die Herkunft steht nur als Hash in der Datenbank.
    const h = await owner.query<{ origin_hash: string }>(
      `SELECT origin_hash FROM checkin_portal_origin`)
    expect(h.rows[0]!.origin_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
