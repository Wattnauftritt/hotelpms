import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, makeGuest, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Geteilte Gastprofile aus dem KWHotel-Import (Migration 0107).
 *
 * Ein KWHotel-Gastsatz trug mehrere Menschen, der Import machte daraus ein
 * Profil, und ein Name, den das Adminpanel fuer einen Aufenthalt schickte,
 * stand in allen. Geprueft wird, dass Meldeschein und Gastkontakt jetzt
 * abtrennen statt ueberschreiben, und dass die Bereinigung des Bestands
 * erst rechnet und nur mit der gerechneten Zahl schreibt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let katId: number
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const HEUTE = '2026-10-07'

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
  katId = await makeCategory(owner, fx.propertyId)
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [admin.userId, fx.accountId])
  // Der Geschaeftstag, gegen den "laufend" und "naechster" gerechnet wird.
  await owner.query(
    `INSERT INTO business_day (property_id, date, status) VALUES ($1, $2, 'open')`,
    [fx.propertyId, HEUTE])
})

async function maschine(scopes: string[]): Promise<Record<string, string>> {
  const z = await app.inject({
    method: 'POST', url: '/v1/oauth-clients', headers: auth(admin.sessionId),
    payload: { name: 'Adminpanel', scopes, propertyIds: [fx.propertyId] } })
  expect(z.statusCode, z.body).toBe(201)
  const { clientId, clientSecret } = z.json<{ clientId: string; clientSecret: string }>()
  const t = await app.inject({
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'client_credentials',
                                   client_id: clientId, client_secret: clientSecret })
      .toString() })
  expect(t.statusCode, t.body).toBe(200)
  return { authorization: `Bearer ${t.json<{ access_token: string }>().access_token}` }
}

/** Ein KWHotel-Gastsatz: nur Nachname und Land, kein Vorname. */
async function kwGast(lastName = 'Petersen') {
  const g = await makeGuest(owner, fx.accountId, { lastName })
  await owner.query(
    `UPDATE guest SET first_name = NULL, address_line1 = NULL, postal_code = NULL,
                      city = NULL WHERE id = $1`, [g.id])
  return g
}

let nr = 0
/** Eine Reservierung aus dem KWHotel-Import an diesem Profil. */
async function aufenthalt(gastId: number, arrival: string, departure: string) {
  const r = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: katId,
    arrival, departure, reserveInventory: false, withFolio: true })
  const ref = await owner.query<{ public_ref: string }>(
    `UPDATE reservation SET primary_guest_id = $2, legacy_system = 'kwhotel',
                            legacy_reference = $3
      WHERE id = $1 RETURNING public_ref`,
    [r.reservationId, gastId, `KW-${++nr}`])
  await owner.query(
    `UPDATE folio SET guest_id = $2 WHERE reservation_id = $1`, [r.reservationId, gastId])
  return { id: r.reservationId, ref: ref.rows[0]!.public_ref }
}

async function hauptgast(reservationId: number) {
  const { rows } = await owner.query<{ id: string; first_name: string | null; last_name: string
                                       email: string | null; folio_gast: string | null }>(
    `SELECT g.id, g.first_name, g.last_name, g.email,
            (SELECT f.guest_id FROM folio f WHERE f.reservation_id = r.id LIMIT 1) AS folio_gast
       FROM reservation r JOIN guest g ON g.id = r.primary_guest_id
      WHERE r.id = $1`, [reservationId])
  return rows[0]!
}

const schein = (firstName: string, reference: string) => ({
  source: { system: 'adminpanel', reference },
  completedAt: '2026-10-01T08:15:00Z',
  guest: { lastName: 'Petersen', firstName, birthDate: '1980-05-17', nationality: 'DE' }
})

const scheinSenden = (h: Record<string, string>, ref: string, payload: unknown) =>
  app.inject({ method: 'PUT', url: `/v1/reservations/${ref}/registration`,
               headers: h, payload: payload as Record<string, unknown> })

const kontaktSenden = (h: Record<string, string>, ref: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/v1/reservations/${ref}/guest-contact`, headers: h,
               payload: { source: { system: 'adminpanel', reference: 'B-1' }, ...payload } })

describe('Meldeschein und Gastkontakt trennen ab', () => {
  it('ein Meldeschein schreibt in ein eigenes Profil, nicht in das geteilte', async () => {
    const m = await maschine(['registration:import'])
    const g = await kwGast()
    const frueher = await aufenthalt(g.id, '2026-09-01', '2026-09-03')
    const jetzt = await aufenthalt(g.id, '2026-10-08', '2026-10-10')

    const a = await scheinSenden(m, jetzt.ref, schein('Anna', 'GR-1'))
    expect(a.statusCode, a.body).toBe(201)

    const neu = await hauptgast(jetzt.id)
    expect(Number(neu.id)).not.toBe(g.id)
    expect(neu).toMatchObject({ first_name: 'Anna', last_name: 'Petersen' })
    expect(a.json<{ guestRef: string }>().guestRef).not.toBe(g.publicRef)
    // Folio und Meldeschein ziehen mit.
    expect(Number(neu.folio_gast)).toBe(Number(neu.id))
    const reg = await owner.query<{ guest_id: string }>(
      `SELECT guest_id FROM registration
        WHERE reservation_id = $1 AND group_registration_id IS NULL`, [jetzt.id])
    expect(Number(reg.rows[0]!.guest_id)).toBe(Number(neu.id))

    // Der fruehere Aufenthalt behaelt das alte Profil, ohne fremden Vornamen.
    expect(await hauptgast(frueher.id)).toMatchObject({ first_name: null })
    expect(Number((await hauptgast(frueher.id)).id)).toBe(g.id)
  })

  it('ein Profil, das nur an dieser Reservierung haengt, bleibt dasselbe', async () => {
    const m = await maschine(['registration:import'])
    const g = await kwGast()
    const r = await aufenthalt(g.id, '2026-10-08', '2026-10-10')
    const a = await scheinSenden(m, r.ref, schein('Anna', 'GR-1'))
    expect(a.statusCode, a.body).toBe(201)
    expect(Number((await hauptgast(r.id)).id)).toBe(g.id)
    expect(a.json<{ guestRef: string }>().guestRef).toBe(g.publicRef)
  })

  it('ein Gastkontakt mit Vornamen trennt ab', async () => {
    const m = await maschine(['guest:contact_write'])
    const g = await kwGast()
    const a1 = await aufenthalt(g.id, '2026-09-01', '2026-09-03')
    const a2 = await aufenthalt(g.id, '2026-10-08', '2026-10-10')

    const b = await kontaktSenden(m, a2.ref, { firstName: 'Jens', email: 'jens@example.org' })
    expect(b.statusCode, b.body).toBe(200)
    expect(b.json<{ fields: unknown }>().fields).toEqual({
      firstName: { result: 'applied' }, email: { result: 'applied' } })
    expect(await hauptgast(a2.id)).toMatchObject({ first_name: 'Jens', email: 'jens@example.org' })
    expect(await hauptgast(a1.id)).toMatchObject({ first_name: null, email: null })
    expect(Number((await hauptgast(a1.id)).id)).toBe(g.id)
  })
})

describe('Bereinigung des Bestands', () => {
  const probelauf = (q = '') => app.inject({ method: 'GET',
    url: `/v1/properties/${fx.propertyId}/guest-profiles/shared${q}`,
    headers: auth(admin.sessionId) })
  const ausfuehren = (payload: Record<string, unknown>) => app.inject({ method: 'POST',
    url: `/v1/properties/${fx.propertyId}/guest-profiles/shared/split`,
    headers: auth(admin.sessionId), payload })

  /**
   * Der Zustand vom 07.10.: drei Aufenthalte an einem Profil, zwei
   * Meldescheine, der spaetere hat den Namen des frueheren ueberschrieben.
   * Dazu ein zweites Profil ohne Schein, dessen Vorname vom Adminpanel kam.
   */
  async function bestand() {
    const g = await kwGast()
    const alt = await aufenthalt(g.id, '2026-09-01', '2026-09-03')
    const morgen = await aufenthalt(g.id, '2026-10-08', '2026-10-10')
    const spaeter = await aufenthalt(g.id, '2026-10-20', '2026-10-22')
    for (const [r, vorname, sek] of [[morgen, 'Anna', 1], [spaeter, 'Bodo', 2]] as const) {
      await owner.query(
        `INSERT INTO registration (property_id, reservation_id, guest_id, arrival,
                                   planned_departure, is_foreign, destroy_after, source,
                                   external_system, external_reference, created_at)
         SELECT property_id, id, primary_guest_id, arrival, departure, false,
                departure + 365, 'import', 'adminpanel', $2,
                now() + make_interval(secs => $3)
           FROM reservation WHERE id = $1`, [r.id, `GR-${vorname}`, sek])
    }
    await owner.query(`UPDATE guest SET first_name = 'Bodo' WHERE id = $1`, [g.id])

    const h = await kwGast('Meyer')
    const hVorher = await aufenthalt(h.id, '2026-08-01', '2026-08-05')
    const hMorgen = await aufenthalt(h.id, '2026-10-08', '2026-10-09')
    await owner.query(
      `UPDATE guest SET first_name = 'Falsch',
              contact_origin = jsonb_build_object('firstName',
                jsonb_build_object('client', 'x', 'system', 'adminpanel'))
        WHERE id = $1`, [h.id])
    return { g, alt, morgen, spaeter, h, hVorher, hMorgen }
  }

  it('rechnet im Probelauf und schreibt nichts', async () => {
    const b = await bestand()
    const p = await probelauf('?arrivalFrom=2026-10-08')
    expect(p.statusCode, p.body).toBe(200)
    const body = p.json<{ summary: unknown; registrationsToResend: unknown[]
                          arrivals: { reservations: Array<Record<string, unknown>> } }>()
    expect(body.summary).toEqual({ sharedProfiles: 2, newProfiles: 3, firstNamesCleared: 1,
                                   registrationsToResend: 1, skippedErasureRequested: 0 })
    expect(body.registrationsToResend).toEqual([expect.objectContaining({
      reservationRef: b.morgen.ref, system: 'adminpanel', reference: 'GR-Anna' })])

    const zeilen = body.arrivals.reservations
    expect(zeilen).toHaveLength(2)
    expect(zeilen.find(z => z.reservationRef === b.morgen.ref)).toMatchObject({
      nameNow: 'Bodo Petersen', nameAfter: 'Petersen', action: 'own_profile',
      registrationNeedsResend: true, sharedWith: 2 })
    expect(zeilen.find(z => z.reservationRef === b.hMorgen.ref)).toMatchObject({
      nameNow: 'Falsch Meyer', nameAfter: 'Meyer', action: 'keeps_profile',
      reason: 'next_stay' })

    // Nichts geschrieben.
    expect(Number((await hauptgast(b.morgen.id)).id)).toBe(b.g.id)
    expect((await hauptgast(b.hMorgen.id)).first_name).toBe('Falsch')
  })

  it('schreibt nur mit der Zahl aus dem Probelauf, dann wie berechnet', async () => {
    const b = await bestand()
    const falsch = await ausfuehren({ expectedNewProfiles: 2 })
    expect(falsch.statusCode).toBe(409)
    expect(Number((await hauptgast(b.morgen.id)).id)).toBe(b.g.id)

    const a = await ausfuehren({ expectedNewProfiles: 3 })
    expect(a.statusCode, a.body).toBe(200)

    // Der juengste Schein behaelt das Profil und seinen Namen.
    expect(await hauptgast(b.spaeter.id)).toMatchObject({ first_name: 'Bodo' })
    expect(Number((await hauptgast(b.spaeter.id)).id)).toBe(b.g.id)
    // Die anderen bekommen eigene Profile mit dem Nachnamen.
    for (const r of [b.alt, b.morgen, b.hVorher]) {
      const x = await hauptgast(r.id)
      expect(Number(x.id)).not.toBe(b.g.id)
      expect(Number(x.id)).not.toBe(b.h.id)
      expect(x.first_name).toBeNull()
      expect(Number(x.folio_gast)).toBe(Number(x.id))
    }
    // Der Vorname aus dem Adminpanel am behaltenen Profil ist weg.
    expect(await hauptgast(b.hMorgen.id)).toMatchObject({ first_name: null, last_name: 'Meyer' })

    // Ein zweiter Lauf findet nichts mehr.
    const p = await probelauf()
    expect(p.json<{ summary: { newProfiles: number } }>().summary.newProfiles).toBe(0)

    // Der erneut geschickte Schein traegt den Namen nach, der Schein bleibt.
    const m = await maschine(['registration:import'])
    const n = await scheinSenden(m, b.morgen.ref, schein('Anna', 'GR-Anna'))
    expect(n.statusCode, n.body).toBe(200)
    expect(n.json()).toMatchObject({ result: 'kept_existing', guest: 'restored' })
    expect(await hauptgast(b.morgen.id)).toMatchObject({ first_name: 'Anna' })
    expect(await hauptgast(b.spaeter.id)).toMatchObject({ first_name: 'Bodo' })
  })

  it('verlangt guest:write und begrenzt die Beispielliste', async () => {
    const m = await maschine(['registration:import'])
    const v = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/guest-profiles/shared`, headers: m })
    expect(v.statusCode).toBe(403)
    const lang = await probelauf('?arrivalFrom=2026-10-01&arrivalTo=2026-12-31')
    expect(lang.statusCode).toBe(422)
  })
})
