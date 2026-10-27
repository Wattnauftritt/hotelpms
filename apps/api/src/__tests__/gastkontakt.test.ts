import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, makeGuest, makeReservation, makeResources,
         type Fixture } from '@hotelpms/testing'
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
      email: { result: 'applied', target: 'reservation', profile: { result: 'applied' } },
      phone: { result: 'applied' },
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
    expect(b.json<{ fields: unknown }>().fields).toEqual(
      { email: { result: 'unchanged', target: 'reservation', profile: { result: 'unchanged' } } })
  })

  it('laesst stehen, was die Rezeption eingetragen hat', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await app.inject({ method: 'PATCH', url: `/v1/guests/${r.gastRef}`,
      headers: auth(admin.sessionId), payload: { email: 'tresen@example.org', language: 'da' } })

    const a = await senden(m, r.ref, { email: 'quelle@example.org', language: 'en',
                                       phone: '0170 1' })
    expect(a.statusCode, a.body).toBe(200)
    // Im Profil bleibt die Adresse der Rezeption; an der Buchung steht die,
    // mit der sie kam (0214).
    expect(a.json<{ fields: unknown }>().fields).toEqual({
      email: { result: 'applied', target: 'reservation',
               profile: { result: 'kept_existing', reason: 'set_otherwise' } },
      language: { result: 'kept_existing', reason: 'set_otherwise' },
      phone: { result: 'applied' } })
    const g = await gast(r.gastId)
    expect(g.email).toBe('tresen@example.org')
    expect(g.language).toBe('da')

    // Zurueckziehen kann es im Profil nur, was es selbst gesetzt hat.
    const b = await senden(m, r.ref, { email: null })
    expect(b.json<{ fields: unknown }>().fields).toEqual({ email: { result: 'withdrawn', target: 'reservation',
      profile: { result: 'kept_existing', reason: 'set_otherwise' } } })
    expect((await gast(r.gastId)).email).toBe('tresen@example.org')
  })

  it('ersetzt und zieht den eigenen Wert nach einer korrigierten Zuordnung zurueck', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await senden(m, r.ref, { email: 'falsch@example.org',
      address: { line1: 'Fremdweg 1', postalCode: '12345', city: 'Irgendwo', country: 'DE' } })

    const a = await senden(m, r.ref, { email: 'richtig@example.org', address: null })
    expect(a.json<{ fields: unknown }>().fields).toEqual({
      email: { result: 'applied', target: 'reservation', profile: { result: 'applied' } },
      address: { result: 'withdrawn' } })
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
      email: { result: 'applied', target: 'reservation',
               profile: { result: 'kept_existing', reason: 'set_otherwise' } },
      phone: { result: 'applied' } })
    expect((await gast(r.gastId)).email).toBe('tresen@example.org')
  })

  it('vervollstaendigt eine Anschrift, die nur aus dem Land besteht', async () => {
    // So kommt ein Gast aus dem KWHotel-Import: Name und Land, sonst nichts.
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await owner.query(`UPDATE guest SET country = 'AT' WHERE id = $1`, [r.gastId])

    const a = await senden(m, r.ref, {
      address: { line1: 'Deichweg 4', postalCode: '27472', city: 'Cuxhaven', country: 'DE' } })
    expect(a.json<{ fields: unknown }>().fields).toEqual({ address: { result: 'applied' } })
    expect(await gast(r.gastId)).toMatchObject({ address_line1: 'Deichweg 4', country: 'DE' })
  })

  it('haelt leeren Text in Strasse, PLZ und Ort nicht fuer eine Anschrift', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await owner.query(
      `UPDATE guest SET address_line1 = '', postal_code = '', city = ' ', country = 'DE'
        WHERE id = $1`, [r.gastId])

    const a = await senden(m, r.ref, {
      address: { line1: 'Deichweg 4', postalCode: '27472', city: 'Cuxhaven' } })
    expect(a.json<{ fields: unknown }>().fields).toEqual({ address: { result: 'applied' } })
    expect(await gast(r.gastId)).toMatchObject({ address_line1: 'Deichweg 4', country: 'DE' })
  })

  it('laesst eine Strasse ohne Land stehen', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await owner.query(`UPDATE guest SET address_line1 = 'Tresenweg 1' WHERE id = $1`, [r.gastId])

    const a = await senden(m, r.ref, {
      address: { line1: 'Deichweg 4', postalCode: '27472', city: 'Cuxhaven', country: 'DE' } })
    expect(a.json<{ fields: unknown }>().fields)
      .toEqual({ address: { result: 'kept_existing', reason: 'set_otherwise' } })
    expect((await gast(r.gastId)).address_line1).toBe('Tresenweg 1')
  })

  it('traegt den Vornamen nach, wenn er fehlt, und laesst einen vorhandenen stehen', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await owner.query(`UPDATE guest SET first_name = NULL WHERE id = $1`, [r.gastId])

    const a = await senden(m, r.ref, { firstName: ' Jan ' })
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json<{ fields: unknown }>().fields).toEqual({ firstName: { result: 'applied' } })
    const vorname = async () => (await owner.query<{ first_name: string | null }>(
      `SELECT first_name FROM guest WHERE id = $1`, [r.gastId])).rows[0]!.first_name
    expect(await vorname()).toBe('Jan')

    // Die Rezeption korrigiert ihn; danach gehoert er ihr.
    await app.inject({ method: 'PATCH', url: `/v1/guests/${r.gastRef}`,
      headers: auth(admin.sessionId), payload: { firstName: 'Jens' } })
    const b = await senden(m, r.ref, { firstName: 'Jan' })
    expect(b.json<{ fields: unknown }>().fields)
      .toEqual({ firstName: { result: 'kept_existing', reason: 'set_otherwise' } })
    expect(await vorname()).toBe('Jens')
  })

  it('nimmt eine Anschrift ohne Land und behaelt das Land, das schon da ist', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await owner.query(`UPDATE guest SET country = 'AT' WHERE id = $1`, [r.gastId])

    const a = await senden(m, r.ref, {
      address: { line1: 'Deichweg 4', postalCode: '27472', city: 'Cuxhaven' } })
    expect(a.json<{ fields: unknown }>().fields).toEqual({ address: { result: 'applied' } })
    expect(await gast(r.gastId)).toMatchObject({ address_line1: 'Deichweg 4', country: 'AT' })

    // Ohne vorhandenes Land bleibt es leer; der Gast traegt es im Meldeschein ein.
    const r2 = await reservierung()
    const b = await senden(m, r2.ref, {
      address: { line1: 'Deichweg 4', postalCode: '27472', city: 'Cuxhaven', country: null } })
    expect(b.json<{ fields: unknown }>().fields).toEqual({ address: { result: 'applied' } })
    expect(await gast(r2.gastId)).toMatchObject({ city: 'Cuxhaven', country: null })

    // Derselbe Aufruf noch einmal schreibt nichts.
    const c = await senden(m, r.ref, {
      address: { line1: 'Deichweg 4', postalCode: '27472', city: 'Cuxhaven' } })
    expect(c.json<{ fields: unknown }>().fields).toEqual({ address: { result: 'unchanged' } })
  })

  it('ein anderes Umsystem gilt als fremd', async () => {
    const erstes = await maschine(['guest:contact_write'], [fx.propertyId])
    const zweites = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await senden(erstes, r.ref, { email: 'eins@example.org' })
    const a = await senden(zweites, r.ref, { email: 'zwei@example.org' })
    expect(a.json<{ fields: unknown }>().fields).toEqual({ email: { result: 'applied', target: 'reservation',
      profile: { result: 'kept_existing', reason: 'set_otherwise' } } })
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
      email: { result: 'applied', target: 'reservation', profile: { result: 'applied' },
               checkinLinkRevoked: true },
      phone: { result: 'applied' } })
    expect((await gast(r.gastId)).email).toBe('richtig@example.org')
    const t = await owner.query<{ revoked: boolean; revoke_reason: string | null }>(
      `SELECT revoked_at IS NOT NULL AS revoked, revoke_reason FROM checkin_token
        WHERE reservation_id = $1`, [r.reservationId])
    expect(t.rows).toEqual([{ revoked: true, revoke_reason: 'contact_changed' }])

    // Ohne offenen Link wird nichts zurueckgezogen.
    const b = await senden(m, r.ref, { email: 'noch-richtiger@example.org' })
    expect(b.json<{ fields: unknown }>().fields).toEqual(
      { email: { result: 'applied', target: 'reservation', profile: { result: 'applied' } } })
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
      .toEqual({ email: { result: 'withdrawn', target: 'reservation', profile: { result: 'withdrawn' },
                          checkinLinkRevoked: true } })
  })

  it('laesst den Link stehen, solange die Adresse fuer den Aufenthalt dieselbe bleibt', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await app.inject({ method: 'PATCH', url: `/v1/guests/${r.gastRef}`,
      headers: auth(admin.sessionId), payload: { email: 'tresen@example.org' } })
    await owner.query(
      `INSERT INTO checkin_token (property_id, reservation_id, token_hash, channel, expires_on)
       VALUES ($1,$2,'h-3','mail','2026-10-12')`, [fx.propertyId, r.reservationId])
    // Eine Weiterleitung aendert nichts: die private Adresse geht ihr vor.
    const a = await senden(m, r.ref, { email: 'x1@guest.booking.com' })
    expect(a.json<{ fields: unknown }>().fields)
      .toEqual({ email: { result: 'applied', target: 'reservation' } })
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
      email: { result: 'applied', target: 'reservation',
               profile: { result: 'kept_existing', reason: 'registration_recorded' } },
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

describe('Buchungskanal aus dem Umsystem', () => {
  const kanal = async (reservationId: number) => (await owner.query<{
    channel_code: string | null; channel_code_external: boolean }>(
    `SELECT b.channel_code, b.channel_code_external FROM booking b
       JOIN reservation r ON r.booking_id = b.id WHERE r.id = $1`, [reservationId])).rows[0]!

  it('traegt den Kanal ohne Quelle nach, ersetzt und zieht den eigenen zurueck', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    const put = (channelCode: string | null) => app.inject({ method: 'PUT',
      url: `/v1/reservations/${r.ref}/guest-contact`, headers: m, payload: { channelCode } })

    const a = await put('Booking.com')
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json()).toEqual({ reservationRef: r.ref, guestRef: null,
                               fields: { channelCode: { result: 'applied' } } })
    expect(await kanal(r.reservationId))
      .toEqual({ channel_code: 'Booking.com', channel_code_external: true })
    expect((await put('Booking.com')).json<{ fields: unknown }>().fields)
      .toEqual({ channelCode: { result: 'unchanged' } })
    // Ein korrigierter Abgleich darf seinen eigenen Wert ersetzen.
    expect((await put('Expedia')).json<{ fields: unknown }>().fields)
      .toEqual({ channelCode: { result: 'applied' } })
    expect((await put(null)).json<{ fields: unknown }>().fields)
      .toEqual({ channelCode: { result: 'withdrawn' } })
    expect(await kanal(r.reservationId))
      .toEqual({ channel_code: null, channel_code_external: false })
  })

  it('zeigt den Kanal der Rezeption im Tagesgeschaeft', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await senden(m, r.ref, { channelCode: '  Booking.com ' })
    const d = await app.inject({ method: 'GET', headers: auth(admin.sessionId),
      url: `/v1/properties/${fx.propertyId}/daily-sheet?date=2026-10-10` })
    expect(d.statusCode, d.body).toBe(200)
    const zeile = d.json<{ arrivals: Array<{ reservationRef: string; channelCode: string | null }> }>()
      .arrivals.find(x => x.reservationRef === r.ref)!
    expect(zeile.channelCode).toBe('Booking.com')
  })

  it('laesst einen Kanal stehen, den es nicht selbst gesetzt hat', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await owner.query(`UPDATE booking SET channel_code = 'Telefon' WHERE id = $1`, [r.bookingId])
    const a = await senden(m, r.ref, { channelCode: 'Booking.com' })
    expect(a.json<{ fields: unknown }>().fields)
      .toEqual({ channelCode: { result: 'kept_existing', reason: 'set_otherwise' } })
    expect((await senden(m, r.ref, { channelCode: null })).json<{ fields: unknown }>().fields)
      .toEqual({ channelCode: { result: 'unchanged' } })
    expect((await kanal(r.reservationId)).channel_code).toBe('Telefon')
  })

  it('fasst eine Buchung aus einem Channel-Zugang nicht an, auch wenn sie keinen Kanal nennt', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    const z = await owner.query<{ id: number }>(
      `INSERT INTO channel_connection (property_id, account_id, provider, name, token_hash)
       VALUES ($1,$2,'adminpanel','RoomCloud','x') RETURNING id`,
      [fx.propertyId, fx.accountId])
    await owner.query(`UPDATE booking SET channel_connection_id = $2 WHERE id = $1`,
      [r.bookingId, z.rows[0]!.id])
    expect((await senden(m, r.ref, { channelCode: 'Booking.com' })).json<{ fields: unknown }>()
      .fields).toEqual({ channelCode: { result: 'kept_existing', reason: 'set_otherwise' } })
    expect((await kanal(r.reservationId)).channel_code).toBeNull()
  })

  it('nimmt den Kanal schon beim Anlegen, und das Umsystem laesst ihn stehen', async () => {
    await makeResources(owner, fx.propertyId, katId, 1)
    await owner.query(`SELECT inventory_materialize($1,'2026-10-01'::date,'2026-11-01'::date)`,
      [fx.propertyId])
    const b = await app.inject({ method: 'POST', url: '/v1/bookings',
      headers: { ...auth(admin.sessionId), 'idempotency-key': 'kanal-1' },
      payload: { propertyId: fx.propertyId, categoryId: katId, arrival: '2026-10-10',
                 departure: '2026-10-12', channelCode: 'Expedia' } })
    expect(b.statusCode, b.body).toBe(201)
    const ref = b.json<{ reservationRef: string }>().reservationRef
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const k = await senden(m, ref, { channelCode: 'Booking.com' })
    expect(k.statusCode, k.body).toBe(200)
    expect(k.json<{ fields: unknown }>().fields)
      .toEqual({ channelCode: { result: 'kept_existing', reason: 'set_otherwise' } })
    const d = await app.inject({ method: 'GET', headers: auth(admin.sessionId),
      url: `/v1/reservations/${ref}` })
    expect(d.json<{ channelCode: string | null }>().channelCode).toBe('Expedia')
  })

  it('weist einen zu langen oder nicht textuellen Kanal ab', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    expect((await senden(m, r.ref, { channelCode: 'x'.repeat(51) })).statusCode).toBe(422)
    expect((await senden(m, r.ref, { channelCode: 42 })).statusCode).toBe(422)
  })
})

describe('Buchungsnummer beim Portal (0215)', () => {
  const nummer = async (bookingId: number) => (await owner.query<{
    channel_booking_number: string | null }>(
    `SELECT channel_booking_number FROM booking WHERE id = $1`, [bookingId]))
    .rows[0]!.channel_booking_number

  it('traegt die Nummer ohne Quelle nach, ersetzt sie und zieht sie zurueck', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    const a = await senden(m, r.ref, { channelBookingNumber: 4711223344 })
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json<{ fields: unknown }>().fields)
      .toEqual({ channelBookingNumber: { result: 'applied' } })
    expect(await nummer(r.bookingId)).toBe('4711223344')
    expect((await senden(m, r.ref, { channelBookingNumber: ' 4711223344 ' }))
      .json<{ fields: unknown }>().fields)
      .toEqual({ channelBookingNumber: { result: 'unchanged' } })
    // Anders als beim Kanal ersetzt das Umsystem auch eine Nummer, die von
    // woanders kam: es ist die einzige Quelle, die sie kennt.
    await owner.query(`UPDATE booking SET channel_booking_number = '1' WHERE id = $1`,
      [r.bookingId])
    expect((await senden(m, r.ref, { channelBookingNumber: '4711223344' }))
      .json<{ fields: unknown }>().fields)
      .toEqual({ channelBookingNumber: { result: 'applied' } })
    expect((await senden(m, r.ref, { channelBookingNumber: null }))
      .json<{ fields: unknown }>().fields)
      .toEqual({ channelBookingNumber: { result: 'withdrawn' } })
    expect(await nummer(r.bookingId)).toBeNull()
  })

  it('zeigt die Nummer an der Reservierung und in der Liste fuers Umsystem', async () => {
    const m = await maschine(['guest:contact_write', 'reservation:read'], [fx.propertyId])
    const r = await reservierung()
    await senden(m, r.ref, { channelBookingNumber: '4711223344' })
    const d = await app.inject({ method: 'GET', headers: auth(admin.sessionId),
      url: `/v1/reservations/${r.ref}` })
    expect(d.json<{ channelBookingNumber: string | null }>().channelBookingNumber)
      .toBe('4711223344')
    const l = await app.inject({ method: 'GET', headers: m,
      url: `/v1/properties/${fx.propertyId}/reservations` })
    expect(l.statusCode, l.body).toBe(200)
    expect(l.json<{ reservations: Array<{ reservationRef: string; channelBookingNumber: string | null }> }>()
      .reservations.find(x => x.reservationRef === r.ref)!.channelBookingNumber)
      .toBe('4711223344')
  })

  it('weist eine Nummer ab, die keine ist', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    for (const falsch of ['', ' ', 'a b', '<x>', 'x'.repeat(65), -1, 1.5, true]) {
      const a = await senden(m, r.ref, { channelBookingNumber: falsch })
      expect(a.statusCode, String(falsch)).toBe(422)
    }
  })
})

describe('Weiterleitungsadresse je Buchung (0214)', () => {
  const ALT = 'alt123@guest.booking.com'
  const NEU = 'neu456@guest.booking.com'

  /** Stammgast: die Rezeption haengt die neue Reservierung an sein Profil. */
  async function stammgast() {
    const erste = await reservierung()
    const zweite = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: katId,
      arrival: '2026-11-10', departure: '2026-11-12', reserveInventory: false, withFolio: false })
    const ref = await owner.query<{ public_ref: string }>(
      `UPDATE reservation SET primary_guest_id = $2 WHERE id = $1 RETURNING public_ref`,
      [zweite.reservationId, erste.gastId])
    return { erste, zweite: { id: zweite.reservationId, ref: ref.rows[0]!.public_ref } }
  }

  /** Im Kontext des Accounts, wie in der API: ohne ihn gibt es keine Antwort. */
  async function adresse(reservationId: number): Promise<string | null> {
    const c = await owner.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SELECT set_config('app.account_ids', $1, true)`, [String(fx.accountId)])
      const r = await c.query<{ a: string | null }>(
        `SELECT guest_mail_address(primary_guest_id, id) AS a FROM reservation WHERE id = $1`,
        [reservationId])
      await c.query('COMMIT')
      return r.rows[0]!.a
    } finally { c.release() }
  }

  const detail = async (ref: string) => (await app.inject({
    method: 'GET', url: `/v1/reservations/${ref}`, headers: auth(admin.sessionId) }))
    .json<{ guestEmail: string | null }>().guestEmail

  it('nimmt die neue Weiterleitung an die Buchung, auch wenn die alte im Profil steht', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const { erste, zweite } = await stammgast()
    // Stand vor 0214: die Weiterleitung vom ersten Aufenthalt im Profil.
    await owner.query(`UPDATE guest SET email = $2 WHERE id = $1`, [erste.gastId, ALT])

    const a = await senden(m, zweite.ref, { email: NEU })
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json<{ fields: unknown }>().fields)
      .toEqual({ email: { result: 'applied', target: 'reservation' } })
    // Das Profil bleibt, wie es ist, und am Stammgast: es geht nichts hinein.
    expect((await gast(erste.gastId)).email).toBe(ALT)
    const r = await owner.query<{ primary_guest_id: number; booking_email: string | null }>(
      `SELECT primary_guest_id, booking_email FROM reservation WHERE id = $1`, [zweite.id])
    expect(r.rows[0]).toEqual({ primary_guest_id: erste.gastId, booking_email: NEU })

    expect(await adresse(zweite.id)).toBe(NEU)
    expect(await detail(zweite.ref)).toBe(NEU)
    // Die alte Weiterleitung im geteilten Profil gilt fuer keine Buchung mehr:
    // ob sie vom ersten Aufenthalt stammt, weiss niemand.
    expect(await adresse(erste.reservationId)).toBeNull()

    expect((await senden(m, zweite.ref, { email: NEU.toUpperCase() }))
      .json<{ fields: unknown }>().fields)
      .toEqual({ email: { result: 'unchanged', target: 'reservation' } })
  })

  it('gilt fuer die Buchung, die sie meldet, und nicht fuer die naechste', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const { erste, zweite } = await stammgast()
    await senden(m, erste.ref, { email: ALT })
    await senden(m, zweite.ref, { email: NEU })
    expect(await adresse(erste.reservationId)).toBe(ALT)
    expect(await adresse(zweite.id)).toBe(NEU)
    expect((await gast(erste.gastId)).email).toBeNull()
  })

  it('eine echte Adresse im Profil geht vor', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await app.inject({ method: 'PATCH', url: `/v1/guests/${r.gastRef}`,
      headers: auth(admin.sessionId), payload: { email: 'jan@example.org' } })
    const a = await senden(m, r.ref, { email: NEU })
    expect(a.json<{ fields: unknown }>().fields)
      .toEqual({ email: { result: 'applied', target: 'reservation' } })
    expect(await adresse(r.reservationId)).toBe('jan@example.org')
  })

  it('nutzt eine Weiterleitung im Profil, solange es an keiner anderen Buchung haengt', async () => {
    const r = await reservierung()
    await owner.query(`UPDATE guest SET email = $2 WHERE id = $1`, [r.gastId, ALT])
    expect(await adresse(r.reservationId)).toBe(ALT)
  })

  it('zieht einen offenen Link zurueck, wenn eine neue Weiterleitung kommt', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const { erste, zweite } = await stammgast()
    await owner.query(`UPDATE guest SET email = $2 WHERE id = $1`, [erste.gastId, ALT])
    await owner.query(
      `INSERT INTO checkin_token (property_id, reservation_id, token_hash, channel, expires_on)
       VALUES ($1,$2,'h-w1','mail','2026-11-12')`, [fx.propertyId, zweite.id])
    const a = await senden(m, zweite.ref, { email: NEU })
    expect(a.json<{ fields: unknown }>().fields).toEqual({
      email: { result: 'applied', target: 'reservation', checkinLinkRevoked: true } })

    await owner.query(
      `INSERT INTO checkin_token (property_id, reservation_id, token_hash, channel, expires_on)
       VALUES ($1,$2,'h-w2','mail','2026-11-12')`, [fx.propertyId, zweite.id])
    const b = await senden(m, zweite.ref, { email: null })
    expect(b.json<{ fields: unknown }>().fields).toEqual({
      email: { result: 'withdrawn', target: 'reservation', checkinLinkRevoked: true } })
    const r = await owner.query<{ booking_email: string | null; primary_guest_id: number }>(
      `SELECT booking_email, primary_guest_id FROM reservation WHERE id = $1`, [zweite.id])
    // Zurueckgezogen, und der Stammgast bleibt an der Buchung.
    expect(r.rows[0]).toEqual({ booking_email: null, primary_guest_id: erste.gastId })
  })

  it('nimmt sie auch nach dem Meldeschein an', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await owner.query(
      `INSERT INTO registration (property_id, reservation_id, guest_id, arrival,
                                 planned_departure, is_foreign, destroy_after)
       VALUES ($1,$2,$3,'2026-10-10','2026-10-12',false,'2027-10-12')`,
      [fx.propertyId, r.reservationId, r.gastId])
    const a = await senden(m, r.ref, { email: NEU })
    expect(a.json<{ fields: unknown }>().fields)
      .toEqual({ email: { result: 'applied', target: 'reservation' } })
  })

  it('nimmt eine private Adresse aus der neuen Buchung vor die aus dem Profil', async () => {
    // Sven: neue Adresse aus neuer Buchung ueberschreibt die alte.
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const { erste, zweite } = await stammgast()
    await app.inject({ method: 'PATCH', url: `/v1/guests/${erste.gastRef}`,
      headers: auth(admin.sessionId), payload: { email: 'alt@example.org' } })
    const a = await senden(m, zweite.ref, { email: 'neu@example.org' })
    // Ins geteilte Profil geht sie nicht, und der Stammgast bleibt ungeteilt.
    expect(a.json<{ fields: unknown }>().fields)
      .toEqual({ email: { result: 'applied', target: 'reservation' } })
    expect(await adresse(zweite.id)).toBe('neu@example.org')
    expect(await adresse(erste.reservationId)).toBe('alt@example.org')
    expect((await gast(erste.gastId)).email).toBe('alt@example.org')
    const r = await owner.query<{ primary_guest_id: number }>(
      `SELECT primary_guest_id FROM reservation WHERE id = $1`, [zweite.id])
    expect(r.rows[0]!.primary_guest_id).toBe(erste.gastId)
  })

  it('wird mit dem Gast geloescht', async () => {
    const m = await maschine(['guest:contact_write'], [fx.propertyId])
    const r = await reservierung()
    await senden(m, r.ref, { email: NEU })
    await owner.query(`UPDATE reservation SET status = 'Canceled' WHERE id = $1`, [r.reservationId])
    const a = await app.inject({ method: 'POST', url: `/v1/guests/${r.gastRef}/anonymize`,
      headers: auth(admin.sessionId), payload: {} })
    expect(a.statusCode, a.body).toBeLessThan(300)
    const z = await owner.query<{ booking_email: string | null }>(
      `SELECT booking_email FROM reservation WHERE id = $1`, [r.reservationId])
    expect(z.rows[0]!.booking_email).toBeNull()
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
