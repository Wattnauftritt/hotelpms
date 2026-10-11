import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, makeGuest, makeReservation, makeEmailDomain, makePaymentMethod }
  from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'
import { NUR_FUER_MASCHINEN } from '../routes/oauth.js'

/*
 * Die Rechteausweitungen aus dem Sicherheitsaudit vom 11.10.2026
 * (Bericht in den Projektdateien, security/audit-2026-10-11.md). Jeder Fall
 * hier lief vor der Behebung durch.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

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
beforeEach(async () => { await truncateAll(); limiters.reset() })

async function rolleImHaus(userId: number, propertyId: number, roleKey: string): Promise<void> {
  await owner.query(
    `INSERT INTO user_property_role (user_id, property_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = $3 AND account_id IS NULL`,
    [userId, propertyId, roleKey])
}

async function zweitesHaus(accountId: number): Promise<number> {
  const r = await owner.query<{ id: string }>(
    `INSERT INTO property (account_id, code, name, address_line1, postal_code, city, country)
     VALUES ($1, 'ZWEI', 'Zweites Haus', 'x', '1', 'y', 'DE') RETURNING id`, [accountId])
  return Number(r.rows[0]!.id)
}

async function refVon(userId: number): Promise<string> {
  const r = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM app_user WHERE id = $1`, [userId])
  return r.rows[0]!.public_ref
}

describe('K1: Account-Rechte gelten nur im eigenen Account', () => {
  it('Inhaber in A mit Hausrolle in B wird in B nicht Inhaber', async () => {
    const A = await makeProperty(owner, { name: 'Kunde A', code: 'AAA' })
    const B = await makeProperty(owner, { name: 'Kunde B', code: 'BBB' })
    await makeUser(owner, { email: 'inhaber-b@b.de', accountId: B.accountId, roleKey: 'owner' })
    const x = await makeUser(owner, { email: 'x@a.de', accountId: A.accountId, roleKey: 'owner' })
    await rolleImHaus(x.userId, B.propertyId, 'reception')
    const ref = await refVon(x.userId)

    const rollen = await app.inject({
      method: 'PUT', url: `/v1/properties/${B.propertyId}/users/${ref}/account-roles`,
      headers: auth(x.sessionId), payload: { roleKeys: ['owner'] } })
    expect(rollen.statusCode).toBe(403)
    const liste = await app.inject({
      method: 'GET', url: `/v1/properties/${B.propertyId}/users`, headers: auth(x.sessionId) })
    expect(liste.statusCode).toBe(403)
    const zugang = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(x.sessionId),
      payload: { name: 'y', scopes: ['guest:read'], accountId: B.accountId } })
    expect(zugang.statusCode).toBe(403)

    // Im eigenen Betrieb bleibt alles, wie es war.
    const eigene = await app.inject({
      method: 'GET', url: `/v1/properties/${A.propertyId}/users`, headers: auth(x.sessionId) })
    expect(eigene.statusCode).toBe(200)
    const me = JSON.parse((await app.inject({
      method: 'GET', url: '/v1/auth/me', headers: auth(x.sessionId) })).body) as {
        properties: { id: number; permissions: string[] }[] }
    const imHausA = me.properties.find(p => p.id === A.propertyId)!.permissions
    const imHausB = me.properties.find(p => p.id === B.propertyId)!.permissions
    expect(imHausA).toContain('settings:account')
    expect(imHausB).not.toContain('settings:account')
  })
})

describe('H1: die geprüfte Property ist die, die der Handler benutzt', () => {
  it('weist eine abweichende Angabe in Abfrage und Rumpf ab', async () => {
    const a = await makeProperty(owner)
    const b = await zweitesHaus(a.accountId)
    const u = await makeUser(owner, {
      email: 'leitung-a@test.de', propertyId: a.propertyId, roleKey: 'hotel_director' })
    await rolleImHaus(u.userId, b, 'reception')
    const csv = 'code;name;max_occupancy\r\nHACK;Eingeschleust;2\r\n'

    const umweg = await app.inject({
      method: 'POST', url: `/v1/imports/categories?propertyId=${a.propertyId}`,
      headers: auth(u.sessionId), payload: { propertyId: b, csv, commit: true } })
    expect(umweg.statusCode).toBe(403)
    const keineZahl = await app.inject({
      method: 'POST', url: '/v1/imports/categories?propertyId=x',
      headers: auth(u.sessionId), payload: { propertyId: b, csv, commit: true } })
    expect(keineZahl.statusCode).toBe(422)
    const r = await owner.query(`SELECT 1 FROM resource_category WHERE code = 'HACK'`)
    expect(r.rowCount).toBe(0)
  })
})

describe('H2: Maschinenzugänge reichen nicht weiter als ihr Anleger', () => {
  it('Hoteldirektion eines Hauses legt keinen Zugang für alle Häuser an', async () => {
    const fx = await makeProperty(owner)
    await zweitesHaus(fx.accountId)
    await makeUser(owner, { email: 'inhaber@k.de', accountId: fx.accountId, roleKey: 'owner' })
    const dir = await makeUser(owner, {
      email: 'dir@k.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })

    const alle = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(dir.sessionId),
      payload: { name: 'x', scopes: ['reservation:read'] } })
    expect(alle.statusCode).toBe(403)
    const zuViel = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(dir.sessionId),
      payload: { name: 'x', scopes: ['settings:account'], propertyIds: [fx.propertyId] } })
    expect(zuViel.statusCode).toBe(403)
    const eigenesHaus = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(dir.sessionId),
      payload: { name: 'x', scopes: ['reservation:read'], propertyIds: [fx.propertyId] } })
    expect(eigenesHaus.statusCode).toBe(201)

    const abo = await app.inject({
      method: 'POST', url: '/v1/webhook-subscriptions', headers: auth(dir.sessionId),
      payload: { url: 'https://example.org/hook', eventTypes: ['reservation.created'] } })
    expect(abo.statusCode).toBe(403)
  })

  it('der Inhaber legt weiter Zugänge für alle Häuser an, auch mit Maschinenrechten', async () => {
    const fx = await makeProperty(owner)
    const inhaber = await makeUser(owner, {
      email: 'inhaber@k.de', accountId: fx.accountId, roleKey: 'owner' })
    const r = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth(inhaber.sessionId),
      payload: { name: 'Adminpanel', scopes: ['reservation:read', 'cashbook:import'] } })
    expect(r.statusCode).toBe(201)
  })

  it('jedes Recht ohne Rolle ist als reines Maschinenrecht geführt', async () => {
    const r = await owner.query<{ key: string }>(
      `SELECT key FROM permission p
        WHERE NOT EXISTS (SELECT 1 FROM role_permission rp WHERE rp.permission_key = p.key)
          AND key NOT LIKE 'platform:%' AND key NOT LIKE 'terminal:%'`)
    for (const { key } of r.rows) expect(NUR_FUER_MASCHINEN.has(key), key).toBe(true)
  })
})

describe('H3: Zimmergruppe und Zimmer ändern nur mit dem Recht in ihrem Haus', () => {
  it('Rezeption in Haus B ändert dort keine Zimmergruppe', async () => {
    const a = await makeProperty(owner)
    const b = await zweitesHaus(a.accountId)
    const katB = await makeCategory(owner, b, { code: 'DZB' })
    const u = await makeUser(owner, {
      email: 'leitung-a@test.de', propertyId: a.propertyId, roleKey: 'hotel_director' })
    await rolleImHaus(u.userId, b, 'reception')

    const r = await app.inject({
      method: 'PATCH', url: `/v1/categories/${katB}`, headers: auth(u.sessionId),
      payload: { name: 'Umbenannt' } })
    expect(r.statusCode).toBe(403)
  })
})

describe('H4: Routen ohne Property prüfen das Recht im Haus des Datensatzes', () => {
  /*
   * Hoteldirektion in A, nur Reinigung in B, beide im selben Account. Die
   * Zeilenrichtlinie laesst B durch, weil dort eine Rolle besteht; das Recht
   * kommt aber nur aus A. Jeder Fall prueft beide Seiten -- 403 in B, Erfolg
   * in A --, sonst hielte der Test auch eine Route fest, die gar nichts mehr
   * erlaubt.
   */
  interface Haus { id: number; resRef: string; folioRef: string; reservationId: number }
  let A: Haus
  let B: Haus
  let accountId: number
  let h: { cookie: string }

  async function hausMitReservierung(propertyId: number, code: string): Promise<Haus> {
    const kat = await makeCategory(owner, propertyId, { code })
    const g = await makeGuest(owner, accountId, { lastName: `Gast${code}` })
    await owner.query(`UPDATE guest SET email = $2, language = 'de' WHERE id = $1`,
      [g.id, `gast-${code.toLowerCase()}@example.test`])
    const r = await makeReservation(owner, {
      propertyId, categoryId: kat, arrival: '2026-10-20', departure: '2026-10-22',
      reserveInventory: false })
    await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
      [r.reservationId, g.id])
    await owner.query(`UPDATE folio SET guest_id = $2 WHERE id = $1`, [r.folioId, g.id])
    const refs = await owner.query<{ res: string; folio: string }>(
      `SELECT r.public_ref AS res, f.public_ref AS folio
         FROM reservation r JOIN folio f ON f.reservation_id = r.id WHERE r.id = $1`,
      [r.reservationId])
    return { id: propertyId, resRef: refs.rows[0]!.res, folioRef: refs.rows[0]!.folio,
             reservationId: r.reservationId }
  }

  async function rechnungIn(haus: Haus, nummer: string): Promise<string> {
    const f = await owner.query<{ id: number }>(
      `SELECT id FROM folio WHERE public_ref = $1`, [haus.folioRef])
    const i = await owner.query<{ public_ref: string }>(
      `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date,
                            issuer_snapshot, recipient_snapshot, totals)
       VALUES ($1,$2,$3,current_date,current_date,'{}'::jsonb,'{}'::jsonb,
               '{"grossCent":22000}'::jsonb)
       RETURNING public_ref`, [haus.id, f.rows[0]!.id, nummer])
    return i.rows[0]!.public_ref
  }

  beforeEach(async () => {
    const a = await makeProperty(owner)
    accountId = a.accountId
    const b = await zweitesHaus(accountId)
    A = await hausMitReservierung(a.propertyId, 'DZA')
    B = await hausMitReservierung(b, 'DZB')
    const u = await makeUser(owner, {
      email: 'leitung-a@test.de', propertyId: A.id, roleKey: 'hotel_director' })
    await rolleImHaus(u.userId, B.id, 'housekeeping_staff')
    h = auth(u.sessionId)
  })

  it('Leistung auf das Folio buchen', async () => {
    const buchen = (folioRef: string, key: string) => app.inject({
      method: 'POST', url: `/v1/folios/${folioRef}/charges`,
      headers: { ...h, 'idempotency-key': key },
      payload: { description: 'Minibar', netCent: 1000, taxRateBp: 1900 } })
    expect((await buchen(B.folioRef, 'h4-b')).statusCode).toBe(403)
    const n = await owner.query(`SELECT 1 FROM charge WHERE property_id = $1`, [B.id])
    expect(n.rowCount).toBe(0)
    const a = await buchen(A.folioRef, 'h4-a')
    expect(a.statusCode, a.body).toBe(201)
  })

  it('Rechnung an den Gast schicken', async () => {
    await makeEmailDomain(owner, A.id, 'seeblick.test')
    const s = await app.inject({
      method: 'PUT', url: `/v1/properties/${A.id}/email-settings`, headers: h,
      payload: { fromName: 'Hotel A', fromEmail: 'post@seeblick.test', enabled: true } })
    expect(s.statusCode, s.body).toBe(200)

    const senden = (ref: string) => app.inject({
      method: 'POST', url: `/v1/invoices/${ref}/send`, headers: h, payload: {} })
    expect((await senden(await rechnungIn(B, '2026-B-0001'))).statusCode).toBe(403)
    const a = await senden(await rechnungIn(A, '2026-A-0001'))
    expect(a.statusCode, a.body).toBe(202)
  })

  it('Reservierung lesen und ändern', async () => {
    const lesen = (ref: string) => app.inject({
      method: 'GET', url: `/v1/reservations/${ref}`, headers: h })
    const aendern = (ref: string) => app.inject({
      method: 'PATCH', url: `/v1/reservations/${ref}`, headers: h,
      payload: { notes: 'Spaete Anreise' } })
    expect((await lesen(B.resRef)).statusCode).toBe(403)
    expect((await aendern(B.resRef)).statusCode).toBe(403)
    const n = await owner.query<{ notes: string | null }>(
      `SELECT notes FROM reservation WHERE id = $1`, [B.reservationId])
    expect(n.rows[0]!.notes).toBeNull()
    expect((await lesen(A.resRef)).statusCode).toBe(200)
    const a = await aendern(A.resRef)
    expect(a.statusCode, a.body).toBe(200)
  })

  it('Statuswechsel mit Haus A im Rumpf erreicht keine Reservierung in B', async () => {
    const stornieren = (ref: string) => app.inject({
      method: 'POST', url: `/v1/reservations/${ref}/cancel`, headers: h,
      payload: { propertyId: A.id } })
    expect((await stornieren(B.resRef)).statusCode).toBe(403)
    const n = await owner.query<{ status: string }>(
      `SELECT status::text FROM reservation WHERE id = $1`, [B.reservationId])
    expect(n.rows[0]!.status).toBe('Confirmed')
    const a = await stornieren(A.resRef)
    expect(a.statusCode, a.body).toBe(200)
  })

  it('Meldeschein-Formular', async () => {
    const formular = (ref: string) => app.inject({
      method: 'GET', url: `/v1/reservations/${ref}/registration-form`, headers: h })
    expect((await formular(B.resRef)).statusCode).toBe(403)
    const a = await formular(A.resRef)
    expect(a.statusCode, a.body).toBe(200)
  })

  it('Online-Check-in-Link', async () => {
    const link = (ref: string) => app.inject({
      method: 'POST', url: `/v1/reservations/${ref}/online-checkin/link`, headers: h })
    expect((await link(B.resRef)).statusCode).toBe(403)
    const t = await owner.query(
      `SELECT 1 FROM checkin_token WHERE reservation_id = $1`, [B.reservationId])
    expect(t.rowCount).toBe(0)
    const a = await link(A.resRef)
    expect(a.statusCode, a.body).toBe(201)
  })

  it('Rezeption in B ändert dort keine Zahlungsart', async () => {
    const u = await makeUser(owner, {
      email: 'leitung2-a@test.de', propertyId: A.id, roleKey: 'hotel_director' })
    await rolleImHaus(u.userId, B.id, 'reception')
    const pmB = await makePaymentMethod(owner, B.id, 'BAR')
    const pmA = await makePaymentMethod(owner, A.id, 'BAR')
    const aendern = (id: number) => app.inject({
      method: 'PATCH', url: `/v1/payment-methods/${id}`, headers: auth(u.sessionId),
      payload: { name: 'Umbenannt' } })
    expect((await aendern(pmB)).statusCode).toBe(403)
    expect((await aendern(pmA)).statusCode).toBe(200)
  })
})
