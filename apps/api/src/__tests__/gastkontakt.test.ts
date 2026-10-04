import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, makeGuest, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Kontaktdaten aus einem Umsystem (Migration 0083).
 *
 * Geprueft wird vor allem die Rangfolge: ein Abgleich im Umsystem irrt, und
 * was Rezeption oder Gast eingetragen haben, darf er nie ueberschreiben --
 * seine eigenen Werte dagegen muss er korrigieren und zurueckziehen koennen.
 * Dazu die Hausgrenze, weil die Route keine Property entgegennimmt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let katId: number
let nachbar: number
let nachbarKat: number
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

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
  const zweites = await owner.query<{ id: number }>(
    `INSERT INTO property (account_id, code, name, address_line1, postal_code,
                           city, country, tax_number)
     VALUES ($1,'NACHBAR','Nachbarhaus','Hafenstr. 2','25813','Husum','DE',
             '21/815/00124') RETURNING id`, [fx.accountId])
  nachbar = zweites.rows[0]!.id
  nachbarKat = await makeCategory(owner, nachbar)
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [admin.userId, fx.accountId])
})

async function maschine(scopes: string[], propertyIds: number[]): Promise<Record<string, string>> {
  const z = await app.inject({
    method: 'POST', url: '/v1/oauth-clients', headers: auth(admin.sessionId),
    payload: { name: 'Adminpanel', scopes, propertyIds } })
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

/** Eine Reservierung mit Hauptgast, wie die Rezeption sie anlegt: nur ein Name. */
async function reservierung(propertyId = fx.propertyId, kat = katId) {
  const gast = await makeGuest(owner, fx.accountId, { lastName: 'Petersen' })
  // Von Hand angelegt: keine Anschrift, keine Mail.
  await owner.query(
    `UPDATE guest SET address_line1 = NULL, postal_code = NULL, city = NULL,
                      country = NULL WHERE id = $1`, [gast.id])
  const r = await makeReservation(owner, { propertyId, categoryId: kat,
    arrival: '2026-10-10', departure: '2026-10-12',
    reserveInventory: false, withFolio: false })
  const ref = await owner.query<{ public_ref: string }>(
    `UPDATE reservation SET primary_guest_id = $2 WHERE id = $1 RETURNING public_ref`,
    [r.reservationId, gast.id])
  return { ...r, gastId: gast.id, gastRef: gast.publicRef, ref: ref.rows[0]!.public_ref }
}

const QUELLE = { system: 'roomcloud', reference: 'RC-4711', matchConfidence: 0.6, manual: false }

const senden = (headers: Record<string, string>, ref: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/v1/reservations/${ref}/guest-contact`, headers,
               payload: { source: QUELLE, ...payload } })

async function gast(id: number) {
  const { rows } = await owner.query<{
    email: string | null; phone: string | null; language: string
    address_line1: string | null; city: string | null; country: string | null
    contact_origin: Record<string, { client: string; system: string; reference: string }> }>(
    `SELECT email, phone, language, address_line1, city, country, contact_origin
       FROM guest WHERE id = $1`, [id])
  return rows[0]!
}

describe('Nachtragen', () => {
  it('fuellt leere Felder und merkt sich, woher sie kommen', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    const a = await senden(m, r.ref, {
      email: 'jan@example.org', phone: '+49 4721 1234', language: 'EN',
      address: { line1: 'Deichweg 4', postalCode: '27472', city: 'Cuxhaven', country: 'de' } })
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json()).toEqual({ reservationRef: r.ref, guestRef: r.gastRef, fields: {
      email: { result: 'applied' }, phone: { result: 'applied' },
      language: { result: 'applied' }, address: { result: 'applied' } } })

    const g = await gast(r.gastId)
    expect(g).toMatchObject({ email: 'jan@example.org', phone: '+49 4721 1234',
                              language: 'en', address_line1: 'Deichweg 4',
                              city: 'Cuxhaven', country: 'DE' })
    expect(Object.keys(g.contact_origin).sort()).toEqual(['address', 'email', 'language', 'phone'])
    expect(g.contact_origin.email).toMatchObject({ system: 'roomcloud', reference: 'RC-4711' })
    expect(g.contact_origin.email!.client).toMatch(/^client:/)

    // Derselbe Aufruf noch einmal aendert nichts.
    const b = await senden(m, r.ref, { email: 'jan@example.org' })
    expect(b.json<{ fields: unknown }>().fields).toEqual({ email: { result: 'unchanged' } })
  })

  it('laesst stehen, was die Rezeption eingetragen hat', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await app.inject({ method: 'PATCH', url: `/v1/guests/${r.gastRef}`,
      headers: auth(admin.sessionId), payload: { email: 'tresen@example.org', language: 'da' } })

    const a = await senden(m, r.ref, { email: 'quelle@example.org', language: 'en',
                                       phone: '0170 1' })
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json<{ fields: unknown }>().fields).toEqual({
      email: { result: 'kept_existing', reason: 'set_otherwise' },
      language: { result: 'kept_existing', reason: 'set_otherwise' },
      phone: { result: 'applied' } })
    const g = await gast(r.gastId)
    expect(g.email).toBe('tresen@example.org')
    expect(g.language).toBe('da')

    // Zurueckziehen kann es nur, was es selbst gesetzt hat.
    const b = await senden(m, r.ref, { email: null })
    expect(b.json<{ fields: unknown }>().fields)
      .toEqual({ email: { result: 'kept_existing', reason: 'set_otherwise' } })
    expect((await gast(r.gastId)).email).toBe('tresen@example.org')
  })

  it('ersetzt und zieht den eigenen Wert nach einer korrigierten Zuordnung zurueck', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await senden(m, r.ref, { email: 'falsch@example.org',
      address: { line1: 'Fremdweg 1', postalCode: '12345', city: 'Irgendwo', country: 'DE' } })

    const a = await senden(m, r.ref, { email: 'richtig@example.org', address: null })
    expect(a.json<{ fields: unknown }>().fields).toEqual({
      email: { result: 'applied' }, address: { result: 'withdrawn' } })
    const g = await gast(r.gastId)
    expect(g.email).toBe('richtig@example.org')
    expect(g.address_line1).toBeNull()
    expect(g.country).toBeNull()
    expect(Object.keys(g.contact_origin)).toEqual(['email'])
  })

  it('gibt den Wert ab, sobald ihn jemand anderes aendert', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await senden(m, r.ref, { email: 'quelle@example.org', phone: '0170 1' })
    // Die Rezeption korrigiert die Mail; das Telefon bleibt das des Umsystems.
    await app.inject({ method: 'PATCH', url: `/v1/guests/${r.gastRef}`,
      headers: auth(admin.sessionId), payload: { email: 'tresen@example.org' } })
    expect(Object.keys((await gast(r.gastId)).contact_origin)).toEqual(['phone'])

    const a = await senden(m, r.ref, { email: 'quelle2@example.org', phone: '0170 2' })
    expect(a.json<{ fields: unknown }>().fields).toEqual({
      email: { result: 'kept_existing', reason: 'set_otherwise' },
      phone: { result: 'applied' } })
    expect((await gast(r.gastId)).email).toBe('tresen@example.org')
  })

  it('ein anderes Umsystem gilt als fremd', async () => {
    const erstes = await maschine(['guest:contact_write'], [fx.propertyId])
    const zweites = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await senden(erstes, r.ref, { email: 'eins@example.org' })
    const a = await senden(zweites, r.ref, { email: 'zwei@example.org' })
    expect(a.json<{ fields: unknown }>().fields)
      .toEqual({ email: { result: 'kept_existing', reason: 'set_otherwise' } })
  })
})

describe('Sperren', () => {
  it('zieht einen Link an die korrigierte Adresse zurueck, damit neu eingeladen wird', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await senden(m, r.ref, { email: 'falsch@example.org' })
    await owner.query(
      `INSERT INTO checkin_token (property_id, reservation_id, token_hash, channel, expires_on)
       VALUES ($1,$2,'h-1','mail','2026-10-12')`, [fx.propertyId, r.reservationId])

    const a = await senden(m, r.ref, { email: 'richtig@example.org', phone: '0170 1' })
    expect(a.json<{ fields: unknown }>().fields).toEqual({
      email: { result: 'applied', checkinLinkRevoked: true },
      phone: { result: 'applied' } })
    expect((await gast(r.gastId)).email).toBe('richtig@example.org')
    const t = await owner.query<{ revoked: boolean; revoke_reason: string | null }>(
      `SELECT revoked_at IS NOT NULL AS revoked, revoke_reason FROM checkin_token
        WHERE reservation_id = $1`, [r.reservationId])
    expect(t.rows).toEqual([{ revoked: true, revoke_reason: 'contact_changed' }])

    // Ohne offenen Link wird nichts zurueckgezogen.
    const b = await senden(m, r.ref, { email: 'noch-richtiger@example.org' })
    expect(b.json<{ fields: unknown }>().fields).toEqual({ email: { result: 'applied' } })
  })

  it('zieht den Link auch zurueck, wenn die Adresse ganz zurueckgenommen wird', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await senden(m, r.ref, { email: 'falsch@example.org' })
    await owner.query(
      `INSERT INTO checkin_token (property_id, reservation_id, token_hash, channel, expires_on)
       VALUES ($1,$2,'h-2','mail','2026-10-12')`, [fx.propertyId, r.reservationId])
    const a = await senden(m, r.ref, { email: null })
    expect(a.json<{ fields: unknown }>().fields)
      .toEqual({ email: { result: 'withdrawn', checkinLinkRevoked: true } })
  })

  it('laesst den Link einer fremden Adresse stehen', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await app.inject({ method: 'PATCH', url: `/v1/guests/${r.gastRef}`,
      headers: auth(admin.sessionId), payload: { email: 'tresen@example.org' } })
    await owner.query(
      `INSERT INTO checkin_token (property_id, reservation_id, token_hash, channel, expires_on)
       VALUES ($1,$2,'h-3','mail','2026-10-12')`, [fx.propertyId, r.reservationId])
    const a = await senden(m, r.ref, { email: 'quelle@example.org' })
    expect(a.json<{ fields: unknown }>().fields)
      .toEqual({ email: { result: 'kept_existing', reason: 'set_otherwise' } })
    const t = await owner.query<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked FROM checkin_token WHERE reservation_id = $1`,
      [r.reservationId])
    expect(t.rows[0]!.revoked).toBe(false)
  })

  it('aendert nichts mehr, wenn der Meldeschein erfasst ist', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await senden(m, r.ref, { phone: '0170 1' })
    await owner.query(
      `INSERT INTO registration (property_id, reservation_id, guest_id, arrival,
                                 planned_departure, is_foreign, destroy_after)
       VALUES ($1,$2,$3,'2026-10-10','2026-10-12',false,'2027-10-12')`,
      [fx.propertyId, r.reservationId, r.gastId])

    const a = await senden(m, r.ref, { email: 'quelle@example.org', phone: null })
    expect(a.json<{ fields: unknown }>().fields).toEqual({
      email: { result: 'kept_existing', reason: 'registration_recorded' },
      phone: { result: 'kept_existing', reason: 'registration_recorded' } })
    const g = await gast(r.gastId)
    expect(g.email).toBeNull()
    expect(g.phone).toBe('0170 1')
  })

  it('belebt kein anonymisiertes Profil und haelt dort keine Herkunft', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await senden(m, r.ref, { email: 'quelle@example.org', language: 'en' })
    await owner.query(`UPDATE guest SET status = 'anonymized', email = NULL WHERE id = $1`,
      [r.gastId])
    expect((await gast(r.gastId)).contact_origin).toEqual({})

    const a = await senden(m, r.ref, { email: 'quelle@example.org' })
    expect(a.statusCode).toBe(409)
  })
})

describe('Loeschantrag', () => {
  it('nimmt die Herkunft weg und traegt nichts mehr nach', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await senden(m, r.ref, { email: 'quelle@example.org',
      address: { line1: 'Deichweg 4', postalCode: '27472', city: 'Cuxhaven', country: 'DE' } })
    // Wie guest_erase_partial: Mail weg, Anschrift bleibt fuer den Nachweis.
    await owner.query(
      `UPDATE guest SET email = NULL, erasure_requested_at = now() WHERE id = $1`, [r.gastId])
    const g = await gast(r.gastId)
    expect(g.address_line1).toBe('Deichweg 4')
    expect(g.contact_origin).toEqual({})

    const a = await senden(m, r.ref, { email: 'quelle@example.org' })
    expect(a.statusCode).toBe(409)
    expect((await gast(r.gastId)).email).toBeNull()
  })
})

describe('Meldeschein aus dem Umsystem', () => {
  const VERMERK = { system: 'adminpanel', invitationSentAt: '2026-10-03T16:00:00+02:00',
                    completedAt: null, submittedVia: null }

  it('nimmt den Vermerk ohne Kontaktfelder und ohne Quelle an', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT',
      url: `/v1/reservations/${r.ref}/guest-contact`, headers: m, payload })

    const a = await put({ registration: VERMERK })
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json()).toEqual({ reservationRef: r.ref, guestRef: null,
                               fields: { registration: { result: 'applied' } } })
    const v = await owner.query<{ invitation_sent_at: Date; completed_at: Date | null }>(
      `SELECT invitation_sent_at, completed_at FROM reservation_external_registration
        WHERE reservation_id = $1`, [r.reservationId])
    expect(v.rows[0]!.invitation_sent_at.toISOString()).toBe('2026-10-03T14:00:00.000Z')

    expect((await put({ registration: VERMERK })).json<{ fields: unknown }>().fields)
      .toEqual({ registration: { result: 'unchanged' } })
    const erfasst = await put({ registration: { ...VERMERK,
      completedAt: '2026-10-03T18:12:00Z', submittedVia: 'link' } })
    expect(erfasst.json<{ fields: unknown }>().fields)
      .toEqual({ registration: { result: 'applied' } })
    expect((await put({ registration: null })).json<{ fields: unknown }>().fields)
      .toEqual({ registration: { result: 'withdrawn' } })
    expect((await put({ registration: null })).json<{ fields: unknown }>().fields)
      .toEqual({ registration: { result: 'unchanged' } })
  })

  it('zeigt einen dort erfassten Meldeschein in der Anreiseliste nicht als fehlend', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await owner.query(`UPDATE reservation SET arrival = '2026-10-01' WHERE id = $1`,
      [r.reservationId])
    const zeile = async () => {
      const d = await app.inject({ method: 'GET', headers: auth(admin.sessionId),
        url: `/v1/properties/${fx.propertyId}/daily-sheet?date=2026-10-01` })
      expect(d.statusCode, d.body).toBe(200)
      return d.json<{ arrivals: Array<{ reservationRef: string; registered: boolean }> }>()
        .arrivals.find(x => x.reservationRef === r.ref)!
    }
    expect((await zeile()).registered).toBe(false)
    // Nur eingeladen ist noch nicht erfasst.
    await senden(m, r.ref, { registration: VERMERK })
    expect((await zeile()).registered).toBe(false)
    await senden(m, r.ref, { registration: { ...VERMERK, completedAt: '2026-10-01T09:00:00Z',
                                             submittedVia: 'reception' } })
    expect((await zeile()).registered).toBe(true)
  })

  it('weist einen Zeitpunkt ohne Zone und einen unbekannten Weg ab', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    const a = await senden(m, r.ref, { registration: { ...VERMERK,
      invitationSentAt: '2026-10-03T14:00:00' } })
    expect(a.statusCode).toBe(422)
    const b = await senden(m, r.ref, { registration: { ...VERMERK, submittedVia: 'fax' } })
    expect(b.statusCode).toBe(422)
    const c = await senden(m, r.ref, { registration: { invitationSentAt: null } })
    expect(c.statusCode).toBe(422)
  })
})

describe('Zugang', () => {
  it('verlangt das eigene Recht, guest:read genuegt nicht', async () => {
    const m = await maschine(['guest:read', 'reservation:read'], [fx.propertyId])
    const r = await reservierung()
    const a = await senden(m, r.ref, { email: 'quelle@example.org' })
    expect(a.statusCode).toBe(403)
  })

  it('erreicht mit einem Zugang fuer ein Haus die Reservierung im anderen nicht', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung(nachbar, nachbarKat)
    const a = await senden(m, r.ref, { email: 'quelle@example.org' })
    // Die Zeilenrichtlinie der Reservierung kennt das Haus schon; die
    // Pruefung in der Route ist die zweite Tuer, falls sie es einmal nicht tut.
    expect([403, 404]).toContain(a.statusCode)
    expect((await gast(r.gastId)).email).toBeNull()
  })

  it('weist Unfertiges ab', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    const leer = await senden(m, r.ref, {})
    expect(leer.statusCode).toBe(422)
    const mail = await senden(m, r.ref, { email: 'kein name' })
    expect(mail.statusCode).toBe(422)
    const halb = await senden(m, r.ref, { address: { city: 'Cuxhaven' } })
    expect(halb.statusCode).toBe(422)
    const ohneQuelle = await app.inject({ method: 'PUT',
      url: `/v1/reservations/${r.ref}/guest-contact`, headers: m,
      payload: { email: 'quelle@example.org' } })
    expect(ohneQuelle.statusCode).toBe(422)
    const unbekannt = await senden(m, 'GIBTESNICHT', { email: 'quelle@example.org' })
    expect(unbekannt.statusCode).toBe(404)
  })
})
