import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeGuest, makeReservation, type Fixture }
  from '@hotelpms/testing'
import { withTransaction, type Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/*
 * Die Befunde M1, M4 und M5 aus dem Sicherheitsaudit vom 11.10.2026
 * (security/audit-2026-10-11.md). Jeder abgewiesene Fall hier lief vor der
 * Behebung durch; daneben steht jeweils die Gegenprobe, dass der erlaubte
 * Weg offen bleibt -- eine Sperre, die auch das Richtige abweist, waere nur
 * ein anderer Fehler.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const VON = '2026-11-02'
const BIS = '2026-11-05'
let lauf = 0
const idem = () => ({ 'idempotency-key': `fremd-${++lauf}-${Math.random()}` })

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

async function zweitesHaus(accountId: number, code = 'ZWEI'): Promise<number> {
  const r = await owner.query<{ id: string }>(
    `INSERT INTO property (account_id, code, name, address_line1, postal_code, city, country)
     VALUES ($1, $2, 'Zweites Haus', 'x', '1', 'y', 'DE') RETURNING id`, [accountId, code])
  return Number(r.rows[0]!.id)
}

/** Ein Haus, das buchen kann: Gruppe, Zimmer, Bestand. */
async function buchbar(propertyId: number): Promise<number> {
  const cat = await makeCategory(owner, propertyId, { code: 'DZ' })
  await makeResources(owner, propertyId, cat, 3)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
    [propertyId])
  return cat
}

async function ratenplan(propertyId: number, categoryId: number, code = 'BAR'): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `INSERT INTO rate_plan (property_id, category_id, code, name)
     VALUES ($1,$2,$3,$3) RETURNING id`, [propertyId, categoryId, code])
  return r.rows[0]!.id
}

/** Personal ohne Mailadresse (Migration 0105): der Zugangslink geht an den Aufrufer. */
async function ohneMail(userId: number, username: string): Promise<string> {
  const r = await owner.query<{ public_ref: string }>(
    `UPDATE app_user SET email = NULL, username = $2 WHERE id = $1 RETURNING public_ref`,
    [userId, username])
  return r.rows[0]!.public_ref
}

describe('M1: Direktion eines Hauses fasst nur Personal ihrer Häuser an', () => {
  it('übernimmt die Leitung des Nachbarhauses weder per Link noch sperrt sie sie', async () => {
    const a = await makeProperty(owner)
    const b = await zweitesHaus(a.accountId)
    await makeUser(owner, { email: 'inhaber@k.de', accountId: a.accountId, roleKey: 'owner' })
    const dirA = await makeUser(owner, {
      email: 'dir-a@k.de', propertyId: a.propertyId, roleKey: 'hotel_director' })
    const leitungB = await makeUser(owner, {
      email: 'leitung-b@k.de', propertyId: b, roleKey: 'hotel_director' })
    await ohneMail(leitungB.userId, 'leitung.b')

    // Schritt 1 des Angriffs bleibt moeglich und ist harmlos: die Kollegin
    // aus dem Nachbarhaus bekommt Rollen in A. Er liefert die Kennung.
    const einladen = await app.inject({
      method: 'POST', url: `/v1/properties/${a.propertyId}/users`,
      headers: auth(dirA.sessionId),
      payload: { username: 'leitung.b', displayName: 'Leitung B', roleKeys: ['reception'] } })
    expect(einladen.statusCode, einladen.body).toBe(200)
    const ref = (JSON.parse(einladen.body) as { userRef: string }).userRef

    const link = await app.inject({
      method: 'POST', url: `/v1/properties/${a.propertyId}/users/${ref}/access-link`,
      headers: auth(dirA.sessionId), payload: { delivery: 'link' } })
    expect(link.statusCode, link.body).toBe(403)
    expect((JSON.parse(link.body) as { code: string }).code)
      .toBe('user.rolesOutsideYourProperties')
    expect(link.body).not.toContain('token')

    const sperre = await app.inject({
      method: 'POST', url: `/v1/properties/${a.propertyId}/users/${ref}/block`,
      headers: auth(dirA.sessionId) })
    expect(sperre.statusCode).toBe(403)
    const entfernen = await app.inject({
      method: 'DELETE', url: `/v1/properties/${a.propertyId}/users/${ref}`,
      headers: auth(dirA.sessionId) })
    expect(entfernen.statusCode).toBe(403)
    const umbenennen = await app.inject({
      method: 'PATCH', url: `/v1/properties/${a.propertyId}/users/${ref}`,
      headers: auth(dirA.sessionId), payload: { displayName: 'Uebernommen' } })
    expect(umbenennen.statusCode).toBe(403)

    const blocks = await owner.query(`SELECT 1 FROM account_user_block WHERE user_id = $1`,
      [leitungB.userId])
    expect(blocks.rowCount).toBe(0)
    const tokens = await owner.query(`SELECT 1 FROM auth_token WHERE user_id = $1`,
      [leitungB.userId])
    expect(tokens.rowCount).toBe(0)
  })

  it('Gegenprobe: eigenes Personal per Link, Nachbarhaus durch den Inhaber', async () => {
    const a = await makeProperty(owner)
    const b = await zweitesHaus(a.accountId)
    const inhaber = await makeUser(owner, {
      email: 'inhaber@k.de', accountId: a.accountId, roleKey: 'owner' })
    const dirA = await makeUser(owner, {
      email: 'dir-a@k.de', propertyId: a.propertyId, roleKey: 'hotel_director' })
    const aushilfe = await makeUser(owner, {
      email: 'aushilfe@k.de', propertyId: a.propertyId, roleKey: 'reception' })
    const refAushilfe = await ohneMail(aushilfe.userId, 'aushilfe.a')
    const leitungB = await makeUser(owner, {
      email: 'leitung-b@k.de', propertyId: b, roleKey: 'hotel_director' })
    await rolleImHaus(leitungB.userId, a.propertyId, 'reception')
    const refB = await ohneMail(leitungB.userId, 'leitung.b')

    const link = await app.inject({
      method: 'POST', url: `/v1/properties/${a.propertyId}/users/${refAushilfe}/access-link`,
      headers: auth(dirA.sessionId), payload: { delivery: 'link' } })
    expect(link.statusCode, link.body).toBe(200)
    const sperre = await app.inject({
      method: 'POST', url: `/v1/properties/${a.propertyId}/users/${refAushilfe}/block`,
      headers: auth(dirA.sessionId) })
    expect(sperre.statusCode, sperre.body).toBe(200)

    // Wer den ganzen Betrieb verwaltet, darf auch die Leitung von B sperren.
    const durchInhaber = await app.inject({
      method: 'POST', url: `/v1/properties/${a.propertyId}/users/${refB}/block`,
      headers: auth(inhaber.sessionId) })
    expect(durchInhaber.statusCode, durchInhaber.body).toBe(200)
  })

  it('Aushilfe bei zwei Kunden: sperren ja, Link in fremde Hand nein', async () => {
    const a = await makeProperty(owner, { name: 'Kunde A', code: 'AAA' })
    const b = await makeProperty(owner, { name: 'Kunde B', code: 'BBB' })
    const inhaber = await makeUser(owner, {
      email: 'inhaber@a.de', accountId: a.accountId, roleKey: 'owner' })
    const dirA = await makeUser(owner, {
      email: 'dir-a@a.de', propertyId: a.propertyId, roleKey: 'hotel_director' })
    const aushilfe = await makeUser(owner, {
      email: 'aushilfe@x.de', propertyId: a.propertyId, roleKey: 'reception' })
    await rolleImHaus(aushilfe.userId, b.propertyId, 'hotel_director')
    const ref = await ohneMail(aushilfe.userId, 'aushilfe.x')

    // Wer den Link haette, waere auch bei Kunde B Direktion -- das
    // entscheidet in A niemand, auch der Inhaber nicht.
    for (const s of [dirA, inhaber]) {
      const link = await app.inject({
        method: 'POST', url: `/v1/properties/${a.propertyId}/users/${ref}/access-link`,
        headers: auth(s.sessionId), payload: { delivery: 'link' } })
      expect(link.statusCode, link.body).toBe(403)
    }
    // Sperren wirkt nur bei A (Migration 0040) und bleibt der Direktion.
    const sperre = await app.inject({
      method: 'POST', url: `/v1/properties/${a.propertyId}/users/${ref}/block`,
      headers: auth(dirA.sessionId) })
    expect(sperre.statusCode, sperre.body).toBe(200)
  })
})

describe('M4: fremde Kennungen aus dem Rumpf', () => {
  it('hängt keinen Gast eines anderen Kunden an eine Buchung, ohne Existenz-Orakel', async () => {
    const a = await makeProperty(owner, { name: 'Kunde A', code: 'AAA' })
    const b = await makeProperty(owner, { name: 'Kunde B', code: 'BBB' })
    const cat = await buchbar(a.propertyId)
    const dir = await makeUser(owner, {
      email: 'dir@a.de', propertyId: a.propertyId, roleKey: 'hotel_director' })
    const fremd = await makeGuest(owner, b.accountId, { lastName: 'Fremd' })
    const eigen = await makeGuest(owner, a.accountId, { lastName: 'Eigen' })
    const buchen = (extra: Record<string, unknown>) => app.inject({
      method: 'POST', url: '/v1/bookings', headers: { ...auth(dir.sessionId), ...idem() },
      payload: { propertyId: a.propertyId, categoryId: cat, arrival: VON, departure: BIS,
                 ...extra } })

    const mitFremdem = await buchen({ guestId: fremd.id })
    expect(mitFremdem.statusCode, mitFremdem.body).toBe(404)
    const alsMitreisender = await buchen({ occupants: [{ guestId: fremd.id }] })
    expect(alsMitreisender.statusCode).toBe(404)
    const gibtEsNicht = await buchen({ guestId: 987654321 })
    expect(gibtEsNicht.statusCode).toBe(404)
    // Dieselbe Antwort fuer fremd und unbekannt.
    const ohne = (body: string) => {
      const p = JSON.parse(body) as Record<string, unknown>
      delete p.instance; delete p.requestId; delete p.traceId
      return p
    }
    expect(ohne(mitFremdem.body)).toEqual(ohne(gibtEsNicht.body))

    const angehaengt = await owner.query(
      `SELECT 1 FROM reservation WHERE primary_guest_id = $1
       UNION ALL SELECT 1 FROM reservation_occupant WHERE guest_id = $1`, [fremd.id])
    expect(angehaengt.rowCount).toBe(0)

    const richtig = await buchen({ guestId: eigen.id })
    expect(richtig.statusCode, richtig.body).toBe(201)
  })

  it('nimmt keinen Ratenplan des Nachbarhauses, beim Buchen und beim Verlegen', async () => {
    const a = await makeProperty(owner)
    const b = await zweitesHaus(a.accountId)
    const catA = await buchbar(a.propertyId)
    const catB = await makeCategory(owner, b, { code: 'DZ' })
    const planA = await ratenplan(a.propertyId, catA)
    const planB = await ratenplan(b, catB, 'TEUER')
    const dir = await makeUser(owner, { email: 'inhaber@k.de', accountId: a.accountId,
                                        roleKey: 'owner' })
    const buchen = (ratePlanId: number) => app.inject({
      method: 'POST', url: '/v1/bookings', headers: { ...auth(dir.sessionId), ...idem() },
      payload: { propertyId: a.propertyId, categoryId: catA, arrival: VON, departure: BIS,
                 ratePlanId } })

    const fremd = await buchen(planB)
    expect(fremd.statusCode, fremd.body).toBe(404)
    expect((JSON.parse(fremd.body) as { code: string }).code).toBe('error.notFound')

    const eigen = await buchen(planA)
    expect(eigen.statusCode, eigen.body).toBe(201)
    const ref = (JSON.parse(eigen.body) as { reservationRef: string }).reservationRef

    const verlegen = await app.inject({
      method: 'POST', url: `/v1/reservations/${ref}/change-stay`,
      headers: auth(dir.sessionId), payload: { departure: '2026-11-06', ratePlanId: planB } })
    expect(verlegen.statusCode, verlegen.body).toBe(404)
    const plan = await owner.query<{ rate_plan_id: number }>(
      `SELECT rate_plan_id FROM reservation WHERE public_ref = $1`, [ref])
    expect(Number(plan.rows[0]!.rate_plan_id)).toBe(planA)

    const richtig = await app.inject({
      method: 'POST', url: `/v1/reservations/${ref}/change-stay`,
      headers: auth(dir.sessionId), payload: { departure: '2026-11-06', ratePlanId: planA } })
    expect(richtig.statusCode, richtig.body).toBe(200)
  })

  it('Kontingent: kein fremder Ratenplan, keine fremde Firma', async () => {
    const a = await makeProperty(owner, { name: 'Kunde A', code: 'AAA' })
    const b = await makeProperty(owner, { name: 'Kunde B', code: 'BBB' })
    const catA = await buchbar(a.propertyId)
    const catB = await makeCategory(owner, b.propertyId, { code: 'DZ' })
    const planB = await ratenplan(b.propertyId, catB)
    const planA = await ratenplan(a.propertyId, catA)
    const firmaB = await owner.query<{ id: number }>(
      `INSERT INTO company (account_id, name) VALUES ($1, 'Fremd GmbH') RETURNING id`,
      [b.accountId])
    const dir = await makeUser(owner, {
      email: 'dir@a.de', propertyId: a.propertyId, roleKey: 'hotel_director' })
    const anlegen = (extra: Record<string, unknown>) => app.inject({
      method: 'POST', url: `/v1/properties/${a.propertyId}/blocks`,
      headers: auth(dir.sessionId),
      payload: { name: 'Gruppe', categoryId: catA, fromDate: VON, toDate: BIS, quantity: 1,
                 ...extra } })

    expect((await anlegen({ ratePlanId: planB })).statusCode).toBe(404)
    expect((await anlegen({ companyId: firmaB.rows[0]!.id })).statusCode).toBe(404)
    const n = await owner.query(`SELECT 1 FROM availability_block`)
    expect(n.rowCount).toBe(0)

    const richtig = await anlegen({ ratePlanId: planA })
    expect(richtig.statusCode, richtig.body).toBe(201)
  })

  it('Leistung: kein Artikel aus einem anderen Haus', async () => {
    const a = await makeProperty(owner)
    const b = await zweitesHaus(a.accountId)
    const cat = await buchbar(a.propertyId)
    const res = await makeReservation(owner, {
      propertyId: a.propertyId, categoryId: cat, arrival: VON, departure: BIS })
    const folio = await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM folio WHERE id = $1`, [res.folioId])
    const artikel = async (propertyId: number) => (await owner.query<{ id: number }>(
      `INSERT INTO product (property_id, code, name, price_cent)
       VALUES ($1, 'FR', 'Fruehstueck', 1500) RETURNING id`, [propertyId])).rows[0]!.id
    const fremd = await artikel(b)
    const eigen = await artikel(a.propertyId)
    const dir = await makeUser(owner, {
      email: 'dir@a.de', propertyId: a.propertyId, roleKey: 'hotel_director' })
    const buchen = (productId: number) => app.inject({
      method: 'POST', url: `/v1/folios/${folio.rows[0]!.public_ref}/charges`,
      headers: { ...auth(dir.sessionId), ...idem() },
      payload: { description: 'Fruehstueck', netCent: 1402, taxRateBp: 700, productId } })

    const falsch = await buchen(fremd)
    expect(falsch.statusCode, falsch.body).toBe(404)
    const n = await owner.query(`SELECT 1 FROM charge WHERE folio_id = $1`, [res.folioId])
    expect(n.rowCount).toBe(0)
    expect((await buchen(eigen)).statusCode).toBe(201)
  })

  it('Channel Manager: keine Gastkennung eines anderen Kunden', async () => {
    const a = await makeProperty(owner, { name: 'Kunde A', code: 'AAA' })
    const b = await makeProperty(owner, { name: 'Kunde B', code: 'BBB' })
    await buchbar(a.propertyId)
    const dir = await makeUser(owner, {
      email: 'dir@a.de', propertyId: a.propertyId, roleKey: 'hotel_director' })
    const verbindung = await app.inject({
      method: 'POST', url: `/v1/properties/${a.propertyId}/channel-connections`,
      headers: auth(dir.sessionId), payload: { provider: 'adminpanel', name: 'RC' } })
    expect(verbindung.statusCode, verbindung.body).toBe(201)
    const token = (JSON.parse(verbindung.body) as { token: string }).token
    const fremd = await makeGuest(owner, b.accountId)
    const eigen = await makeGuest(owner, a.accountId)
    const buchen = (externalReference: string, guestId: number) => app.inject({
      method: 'POST', url: '/v1/channel/ari/bookings',
      headers: { authorization: `Bearer ${token}` },
      payload: { externalReference, categoryCode: 'DZ', arrival: VON, departure: BIS,
                 guestId } })

    const falsch = await buchen('RC-1', fremd.id)
    expect(falsch.statusCode, falsch.body).toBe(404)
    const n = await owner.query(`SELECT 1 FROM booking WHERE external_reference = 'RC-1'`)
    expect(n.rowCount).toBe(0)
    const richtig = await buchen('RC-2', eigen.id)
    expect(richtig.statusCode, richtig.body).toBe(201)
  })

  it('guest_document_purge: ein fremder Aufenthalt schiebt die Ausweisfrist nicht', async () => {
    const a = await makeProperty(owner, { name: 'Kunde A', code: 'AAA' })
    const b = await makeProperty(owner, { name: 'Kunde B', code: 'BBB' })
    const catA = await buchbar(a.propertyId)
    const catB = await buchbar(b.propertyId)
    const gast = await owner.query<{ id: number }>(
      `INSERT INTO guest (account_id, last_name, id_document_type,
                          id_document_number_enc, id_document_key_version)
       VALUES ($1,'Petersen','passport','\\x0102'::bytea,1) RETURNING id`, [b.accountId])
    const g = gast.rows[0]!.id
    // Der eigene Aufenthalt bei B liegt lange zurueck.
    const alt = await makeReservation(owner, { propertyId: b.propertyId, categoryId: catB,
      arrival: '2024-05-01', departure: '2024-05-04', reserveInventory: false })
    // Eine Zeile, wie sie die Fremdschluesselpruefung bisher durchliess:
    // Kunde A haengt Bs Gast an eine eigene Reservierung in der Zukunft.
    const fremd = await makeReservation(owner, { propertyId: a.propertyId, categoryId: catA,
      arrival: VON, departure: BIS })
    await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = ANY($1)`,
      [[alt.reservationId, fremd.reservationId], g])

    const laufen = (fx: Fixture) => withTransaction(pool,
      { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null },
      async c => (await c.query<{ n: number }>(`SELECT guest_document_purge() AS n`)).rows[0]!.n)

    expect(await laufen(b)).toBe(1)
    const r = await owner.query<{ da: boolean }>(
      `SELECT id_document_number_enc IS NOT NULL AS da FROM guest WHERE id = $1`, [g])
    expect(r.rows[0]!.da).toBe(false)
  })

  it('Gegenprobe: ein eigener späterer Aufenthalt hält die Ausweisnummer weiter', async () => {
    const b = await makeProperty(owner)
    const b2 = await zweitesHaus(b.accountId)
    const catB2 = await buchbar(b2)
    const gast = await owner.query<{ id: number }>(
      `INSERT INTO guest (account_id, last_name, id_document_type,
                          id_document_number_enc, id_document_key_version)
       VALUES ($1,'Petersen','passport','\\x0102'::bytea,1) RETURNING id`, [b.accountId])
    const res = await makeReservation(owner, { propertyId: b2, categoryId: catB2,
      arrival: VON, departure: BIS })
    await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
      [res.reservationId, gast.rows[0]!.id])

    const n = await withTransaction(pool,
      { accountIds: [b.accountId], propertyIds: [b.propertyId], userId: null },
      async c => (await c.query<{ n: number }>(`SELECT guest_document_purge() AS n`)).rows[0]!.n)
    expect(n).toBe(0)
  })
})

describe('M5: Kontaktdaten im Reservierungsdetail nur mit guest:read', () => {
  it('Revenue sieht die Buchung, nicht Mailadresse und Telefon', async () => {
    const fx = await makeProperty(owner)
    const cat = await buchbar(fx.propertyId)
    const g = await makeGuest(owner, fx.accountId, { lastName: 'Petersen' })
    await owner.query(`UPDATE guest SET email = 'jan@petersen.de', phone = '0461 1234'
                        WHERE id = $1`, [g.id])
    const res = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: cat, arrival: VON, departure: BIS })
    await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
      [res.reservationId, g.id])
    const ref = (await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM reservation WHERE id = $1`, [res.reservationId])).rows[0]!.public_ref

    const revenue = await makeUser(owner, {
      email: 'revenue@k.de', accountId: fx.accountId, roleKey: 'revenue' })
    const dir = await makeUser(owner, {
      email: 'dir@k.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
    const lesen = async (sessionId: string) => {
      const r = await app.inject({
        method: 'GET', url: `/v1/reservations/${ref}`, headers: auth(sessionId) })
      expect(r.statusCode, r.body).toBe(200)
      return JSON.parse(r.body) as Record<string, unknown>
    }

    const ohneRecht = await lesen(revenue.sessionId)
    expect(ohneRecht.guestEmail).toBeNull()
    expect(ohneRecht.guestPhone).toBeNull()
    expect(ohneRecht.stayPhone).toBeNull()
    expect(ohneRecht.guestName).toBe('Jan Petersen')

    const mitRecht = await lesen(dir.sessionId)
    expect(mitRecht.guestEmail).toBe('jan@petersen.de')
    expect(mitRecht.guestPhone).toBe('0461 1234')
  })
})
