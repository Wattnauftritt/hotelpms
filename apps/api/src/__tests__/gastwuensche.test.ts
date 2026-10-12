import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeGuest, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { FOLDER_ROOM_HEADER, FOLDER_SESSION_COOKIE, folderRefAusFragment,
         type GuestFolderCards, type GuestRequestCatalog } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'
import { OFFENE_WUENSCHE_MAX } from '../platform/gastwuensche.js'

/**
 * Wuensche und Extras aus der Gaestemappe (Migration 0149): Katalog mit
 * Preis, Bestellen nur mit Freischaltung, Eingang unter "Heute", Annehmen
 * mit Buchung aufs Folio und Ablehnen mit Grund.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: { userId: number; sessionId: string }
let kategorie: number
let zimmer: number[]
let refs: Map<number, string>
let steuer19: number

const HEUTE = '2026-10-12'
const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const p = (pfad: string) => `/v1/properties/${fx.propertyId}${pfad}`

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
  fx = await makeProperty(owner, { name: 'Seerobbe' })
  await openBusinessDay(owner, fx.propertyId, HEUTE)
  kategorie = await makeCategory(owner, fx.propertyId)
  zimmer = await makeResources(owner, fx.propertyId, kategorie, 2)
  chef = await makeUser(owner, { email: 'chef@kunde.de', propertyId: fx.propertyId,
    roleKey: 'hotel_director' })
  steuer19 = (await owner.query<{ id: number }>(
    `INSERT INTO tax_rule (property_id, code, name, kind, rate_bp, basis)
     VALUES ($1, 'U19', 'USt 19 %', 'vat', 1900, 'percent') RETURNING id::int`,
    [fx.propertyId])).rows[0]!.id
  await app.inject({ method: 'PUT', url: p('/guest-folder'), headers: auth(chef.sessionId),
    payload: { enabled: true, wifi: null } })
  const k = await app.inject({ method: 'GET', url: p('/guest-folder/cards'),
    headers: auth(chef.sessionId) })
  refs = new Map(k.json<GuestFolderCards>().rooms.map(r =>
    [r.resourceId, folderRefAusFragment(r.link.slice(r.link.indexOf('#')))!]))
})

async function aufenthalt(raum: number, lastName: string): Promise<number> {
  const g = await makeGuest(owner, fx.accountId, { lastName })
  const r = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
    arrival: '2026-10-10', departure: '2026-10-14', resourceId: raum,
    status: 'InHouse', reserveInventory: false })
  await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
    [r.reservationId, g.id])
  return r.reservationId
}

const eintrag = (name: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  name, handler: 'reception', maxQty: 2, price: null, onFolder: true, onTerminal: false,
  active: true, position: 0, ...extra })

async function katalog(...eintraege: Array<Record<string, unknown>>): Promise<GuestRequestCatalog> {
  let c: GuestRequestCatalog | null = null
  for (const e of eintraege) {
    const r = await app.inject({ method: 'POST', url: p('/guest-folder/request-items'),
      headers: auth(chef.sessionId), payload: e })
    expect(r.statusCode, r.body).toBe(201)
    c = r.json<GuestRequestCatalog>()
  }
  return c!
}

async function freischalten(raum: number, name: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/v1/mappe/unlock',
    headers: { [FOLDER_ROOM_HEADER]: refs.get(raum)! }, payload: { value: name } })
  expect(r.statusCode, r.body).toBe(200)
  return r.cookies.find(c => c.name === FOLDER_SESSION_COOKIE)!.value
}

const bestellen = (raum: number, payload: object, cookie?: string) => app.inject({
  method: 'POST', url: '/v1/mappe/requests',
  headers: { [FOLDER_ROOM_HEADER]: refs.get(raum)!,
             ...(cookie === undefined ? {} : { cookie: `${FOLDER_SESSION_COOKIE}=${cookie}` }) },
  payload })

const mappe = (raum: number, cookie: string) => app.inject({ method: 'GET', url: '/v1/mappe',
  headers: { [FOLDER_ROOM_HEADER]: refs.get(raum)!, cookie: `${FOLDER_SESSION_COOKIE}=${cookie}` } })

const heute = async () => (await app.inject({ method: 'GET', url: p('/daily-sheet'),
  headers: auth(chef.sessionId) })).json().guestRequests

describe('Wunschkatalog', () => {
  it('legt zu einem Preis den Artikel an und schaltet ihn ohne Preis ab', async () => {
    const c = await katalog(eintrag({ de: 'Sekt aufs Zimmer', en: 'Sparkling wine', xx: 'weg' },
      { price: { grossCent: 2400, taxRuleId: steuer19, revenueAccount: '8400' } }))
    expect(c.taxRules).toEqual([{ id: steuer19, name: 'USt 19 %', rateBp: 1900 }])
    const e = c.items[0]!
    // Unbekannte Sprachen fallen weg.
    expect(e.name).toEqual({ de: 'Sekt aufs Zimmer', en: 'Sparkling wine' })
    expect(e.price).toEqual({ grossCent: 2400, taxRuleId: steuer19, revenueAccount: '8400' })
    const art = await owner.query(`SELECT code, price_cent::int, charge_mode, active FROM product`)
    expect(art.rows).toEqual([{ code: expect.stringMatching(/^MAPPE-\d+$/), price_cent: 2400,
      charge_mode: 'once', active: true }])

    const ohne = await app.inject({ method: 'PUT',
      url: p(`/guest-folder/request-items/${e.itemRef}`), headers: auth(chef.sessionId),
      payload: eintrag({ de: 'Sekt aufs Zimmer' }) })
    expect(ohne.json<GuestRequestCatalog>().items[0]!.price).toBeNull()
    expect((await owner.query(`SELECT active FROM product`)).rows).toEqual([{ active: false }])

    // Derselbe Artikel kommt mit dem Preis zurueck.
    await app.inject({ method: 'PUT', url: p(`/guest-folder/request-items/${e.itemRef}`),
      headers: auth(chef.sessionId), payload: eintrag({ de: 'Sekt' },
        { price: { grossCent: 2600, taxRuleId: steuer19, revenueAccount: '8400' } }) })
    expect((await owner.query(`SELECT name, price_cent::int, active FROM product`)).rows)
      .toEqual([{ name: 'Sekt', price_cent: 2600, active: true }])
  })

  it('verlangt einen deutschen Namen und einen Steuersatz des Hauses', async () => {
    const ohneDe = await app.inject({ method: 'POST', url: p('/guest-folder/request-items'),
      headers: auth(chef.sessionId), payload: eintrag({ en: 'Pillow' }) })
    expect(ohneDe.statusCode).toBe(422)
    const andere = await makeProperty(owner, { name: 'Anker' })
    const fremd = (await owner.query<{ id: number }>(
      `INSERT INTO tax_rule (property_id, code, name, kind, rate_bp, basis)
       VALUES ($1, 'U19', 'USt', 'vat', 1900, 'percent') RETURNING id::int`,
      [andere.propertyId])).rows[0]!.id
    const r = await app.inject({ method: 'POST', url: p('/guest-folder/request-items'),
      headers: auth(chef.sessionId), payload: eintrag({ de: 'Sekt' },
        { price: { grossCent: 2400, taxRuleId: fremd, revenueAccount: '8400' } }) })
    expect(r.statusCode).toBe(422)
    expect(JSON.stringify(r.json())).toContain('guestRequest.taxRule')
  })
})

describe('Bestellen in der Mappe', () => {
  it('zeigt den Katalog erst nach dem Freischalten und nimmt nur Gueltiges an', async () => {
    const c = await katalog(eintrag({ de: 'Kopfkissen', da: 'Hovedpude' }),
      eintrag({ de: 'Lunchpaket' }, { maxQty: 4, position: 1,
        price: { grossCent: 950, taxRuleId: steuer19, revenueAccount: '8400' } }),
      eintrag({ de: 'Nur am Terminal' }, { onFolder: false, onTerminal: true, position: 2 }))
    const [kissen, lunch, terminal] = c.items
    await aufenthalt(zimmer[0]!, 'Petersen')

    expect((await bestellen(zimmer[0]!, { itemRef: kissen!.itemRef, qty: 1 })).statusCode)
      .toBe(403)
    const cookie = await freischalten(zimmer[0]!, 'Petersen')
    const m = (await mappe(zimmer[0]!, cookie)).json().stay.requests
    expect(m.items.map((i: { name: { de: string } }) => i.name.de))
      .toEqual(['Kopfkissen', 'Lunchpaket'])
    expect(m.items[1]).toMatchObject({ maxQty: 4, unitPriceCent: 950 })
    expect(m.mine).toEqual([])
    // Waehlbar sind die Tage, die die Schnittstelle auch annimmt.
    expect(m.days[0] > '2026-10-11' && m.days.at(-1) === '2026-10-14').toBe(true)

    // Zu viel, ein Eintrag nur fuers Terminal, ein Tag ausserhalb des Aufenthalts.
    expect((await bestellen(zimmer[0]!, { itemRef: kissen!.itemRef, qty: 3 }, cookie)).statusCode)
      .toBe(422)
    expect((await bestellen(zimmer[0]!, { itemRef: terminal!.itemRef, qty: 1 }, cookie))
      .statusCode).toBe(422)
    expect((await bestellen(zimmer[0]!,
      { itemRef: lunch!.itemRef, qty: 1, wantedFor: '2026-10-15' }, cookie)).statusCode).toBe(422)
    expect((await bestellen(zimmer[0]!,
      { itemRef: lunch!.itemRef, qty: 1, wantedFor: '2026-10-11' }, cookie)).statusCode).toBe(422)

    const ok = await bestellen(zimmer[0]!,
      { itemRef: lunch!.itemRef, qty: 2, wantedFor: '2026-10-14' }, cookie)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().mine).toEqual([expect.objectContaining({
      qty: 2, unitPriceCent: 950, wantedFor: '2026-10-14', status: 'open', declineReason: null })])

    // Die Rezeption sieht ihn unter "Heute", mit Zimmer und Name.
    expect(await heute()).toEqual([expect.objectContaining({
      roomCode: expect.any(String), lastName: 'Petersen', qty: 2, unitPriceCent: 950,
      source: 'folder', status: 'open' })])
  })

  it('haelt den Preis fest, den der Gast gesehen hat, und begrenzt die offenen', async () => {
    const c = await katalog(eintrag({ de: 'Sekt' }, { maxQty: 1,
      price: { grossCent: 2400, taxRuleId: steuer19, revenueAccount: '8400' } }))
    await aufenthalt(zimmer[0]!, 'Petersen')
    const cookie = await freischalten(zimmer[0]!, 'Petersen')
    await bestellen(zimmer[0]!, { itemRef: c.items[0]!.itemRef, qty: 1 }, cookie)
    await app.inject({ method: 'PUT', url: p(`/guest-folder/request-items/${c.items[0]!.itemRef}`),
      headers: auth(chef.sessionId), payload: eintrag({ de: 'Sekt' }, { maxQty: 1,
        price: { grossCent: 3000, taxRuleId: steuer19, revenueAccount: '8400' } }) })
    expect((await heute())[0].unitPriceCent).toBe(2400)

    for (let i = 1; i < OFFENE_WUENSCHE_MAX; i++) {
      await bestellen(zimmer[0]!, { itemRef: c.items[0]!.itemRef, qty: 1 }, cookie)
    }
    const zuviel = await bestellen(zimmer[0]!, { itemRef: c.items[0]!.itemRef, qty: 1 }, cookie)
    expect(zuviel.statusCode).toBe(409)
  })
})

describe('Bearbeiten an der Rezeption', () => {
  it('bucht ein angenommenes Extra brutto aufs Folio und lehnt mit Grund ab', async () => {
    const c = await katalog(eintrag({ de: 'Lunchpaket' }, { maxQty: 4,
      price: { grossCent: 950, taxRuleId: steuer19, revenueAccount: '8400' } }),
      eintrag({ de: 'Kopfkissen' }, { position: 1 }))
    const reservationId = await aufenthalt(zimmer[0]!, 'Petersen')
    const cookie = await freischalten(zimmer[0]!, 'Petersen')
    await bestellen(zimmer[0]!, { itemRef: c.items[0]!.itemRef, qty: 2 }, cookie)
    await bestellen(zimmer[0]!, { itemRef: c.items[1]!.itemRef, qty: 1 }, cookie)
    const [lunch, kissen] = await heute() as Array<{ requestRef: string }>

    const ja = await app.inject({ method: 'POST', url: `/v1/guest-requests/${lunch!.requestRef}/done`,
      headers: auth(chef.sessionId) })
    expect(ja.statusCode, ja.body).toBe(200)
    expect(ja.json()).toMatchObject({ status: 'done' })
    const b = await owner.query(
      `SELECT c.description, c.quantity, c.gross_cent::int, c.net_cent::int, c.tax_cent::int,
              c.tax_rate_bp, c.revenue_account, c.business_date::text,
              c.reservation_id::int, (q.charge_id = c.id) AS verknuepft
         FROM charge c JOIN guest_request q ON q.charge_id = c.id`)
    expect(b.rows).toEqual([{ description: 'Lunchpaket', quantity: 2, gross_cent: 1900,
      net_cent: 1597, tax_cent: 303, tax_rate_bp: 1900, revenue_account: '8400',
      business_date: HEUTE, reservation_id: reservationId, verknuepft: true }])
    // Zweimal annehmen bucht nicht zweimal.
    expect((await app.inject({ method: 'POST',
      url: `/v1/guest-requests/${lunch!.requestRef}/done`, headers: auth(chef.sessionId) }))
      .statusCode).toBe(409)

    const nein = await app.inject({ method: 'POST',
      url: `/v1/guest-requests/${kissen!.requestRef}/decline`, headers: auth(chef.sessionId),
      payload: { reason: 'unavailable' } })
    expect(nein.json()).toMatchObject({ status: 'declined', declineReason: 'unavailable' })
    expect(await heute()).toEqual([])

    // Der Gast sieht beides mit Stand; das Seitenfenster ebenso.
    const mine = (await mappe(zimmer[0]!, cookie)).json().stay.requests.mine
    expect(mine.map((w: { status: string }) => w.status).sort()).toEqual(['declined', 'done'])
    const res = await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM reservation WHERE id = $1`, [reservationId])
    const d = await app.inject({ method: 'GET',
      url: `/v1/reservations/${res.rows[0]!.public_ref}`, headers: auth(chef.sessionId) })
    expect(d.json().guestRequests).toHaveLength(2)
  })

  it('bucht nicht ohne offenes Folio und nicht fuer ein fremdes Haus', async () => {
    const c = await katalog(eintrag({ de: 'Sekt' }, {
      price: { grossCent: 2400, taxRuleId: steuer19, revenueAccount: '8400' } }))
    const reservationId = await aufenthalt(zimmer[0]!, 'Petersen')
    const cookie = await freischalten(zimmer[0]!, 'Petersen')
    await bestellen(zimmer[0]!, { itemRef: c.items[0]!.itemRef, qty: 1 }, cookie)
    const [w] = await heute() as Array<{ requestRef: string }>

    const andere = await makeProperty(owner, { name: 'Anker' })
    const fremd = await makeUser(owner, { email: 'fremd@kunde.de',
      propertyId: andere.propertyId, roleKey: 'hotel_director' })
    expect((await app.inject({ method: 'POST', url: `/v1/guest-requests/${w!.requestRef}/done`,
      headers: auth(fremd.sessionId) })).statusCode).toBe(404)

    await owner.query(`UPDATE folio SET status = 'closed' WHERE reservation_id = $1`,
      [reservationId])
    const r = await app.inject({ method: 'POST', url: `/v1/guest-requests/${w!.requestRef}/done`,
      headers: auth(chef.sessionId) })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('guestRequest.noOpenFolio')
    expect((await owner.query(`SELECT 1 FROM charge`)).rowCount).toBe(0)
  })
})

describe('Housekeeping-Wuensche in der Personal-App (0152)', () => {
  it('meldet einen kostenlosen Wunsch der Kraft des Zimmers, und sie hakt ihn ab', async () => {
    const hausdame = await makeUser(owner, { email: 'hd@kunde.de', propertyId: fx.propertyId,
      roleKey: 'housekeeping' })
    const olga = await makeUser(owner, { email: 'olga@kunde.de', propertyId: fx.propertyId,
      roleKey: 'housekeeping_staff' })
    const c = await katalog(
      eintrag({ de: 'Kopfkissen', uk: 'Подушка' }, { handler: 'housekeeping' }),
      eintrag({ de: 'Sekt' }, { handler: 'housekeeping', position: 1,
        price: { grossCent: 2400, taxRuleId: steuer19, revenueAccount: '8400' } }),
      eintrag({ de: 'Decke' }, { handler: 'housekeeping', position: 2 }))
    const [kissen, sekt, decke] = c.items
    await aufenthalt(zimmer[0]!, 'Petersen')
    const plan = await app.inject({ method: 'PUT', url: p('/cleaning-plan'),
      headers: auth(hausdame.sessionId), payload: { date: HEUTE, assignments: [
        { resourceId: zimmer[0], kind: 'stayover', assignedTo: olga.userId }] } })
    expect(plan.statusCode, plan.body).toBe(200)

    const cookie = await freischalten(zimmer[0]!, 'Petersen')
    expect((await bestellen(zimmer[0]!, { itemRef: kissen!.itemRef, qty: 2 }, cookie))
      .statusCode).toBe(200)
    // Mit Preis bleibt es bei der Rezeption, fuer morgen meldet es sich morgen.
    await bestellen(zimmer[0]!, { itemRef: sekt!.itemRef, qty: 1 }, cookie)
    await bestellen(zimmer[0]!, { itemRef: decke!.itemRef, qty: 1, wantedFor: '2026-10-13' },
      cookie)

    const push = await owner.query(
      `SELECT user_id::int, params FROM staff_push WHERE kind = 'request'`)
    expect(push.rows).toEqual([{ user_id: olga.userId, params: { room: expect.any(String) } }])

    const meine = await app.inject({ method: 'GET', url: p('/my-rooms'),
      headers: auth(olga.sessionId) })
    const z = meine.json().rooms[0]
    expect(z.requests).toEqual([{ requestRef: expect.any(String),
      name: { de: 'Kopfkissen', uk: 'Подушка' }, qty: 2 }])

    // Ein fremder Wunsch (der Sekt) ist ueber diese Route nicht zu haben.
    const sektRef = (await heute()).find((w: { itemName: { de: string } }) =>
      w.itemName.de === 'Sekt').requestRef
    expect((await app.inject({ method: 'POST',
      url: p(`/my-rooms/${z.taskId}/requests/${sektRef}/done`),
      headers: auth(olga.sessionId) })).statusCode).toBe(404)

    const ok = await app.inject({ method: 'POST',
      url: p(`/my-rooms/${z.taskId}/requests/${z.requests[0].requestRef}/done`),
      headers: auth(olga.sessionId) })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().rooms[0].requests).toEqual([])
    // Die Rezeption sieht nur noch den Sekt und die Decke; der Gast "erledigt".
    expect((await heute()).map((w: { itemName: { de: string } }) => w.itemName.de).sort())
      .toEqual(['Decke', 'Sekt'])
    const mine = (await mappe(zimmer[0]!, cookie)).json().stay.requests.mine
    expect(mine.find((w: { name: { de: string } }) => w.name.de === 'Kopfkissen').status)
      .toBe('done')
  })
})

describe('Nachricht an die Rezeption (0153)', () => {
  const schreiben = (raum: number, text: string, cookie?: string) => app.inject({
    method: 'POST', url: '/v1/mappe/messages',
    headers: { [FOLDER_ROOM_HEADER]: refs.get(raum)!,
               ...(cookie === undefined ? {} : { cookie: `${FOLDER_SESSION_COOKIE}=${cookie}` }) },
    payload: { text } })

  it('kommt nur eingeschaltet und freigeschaltet an, und die Rezeption erledigt sie', async () => {
    await aufenthalt(zimmer[0]!, 'Petersen')
    expect((await schreiben(zimmer[0]!, 'Hallo')).statusCode).toBe(403)
    const cookie = await freischalten(zimmer[0]!, 'Petersen')
    // Aus als Vorgabe: ohne Katalog und ohne Nachricht keine Wuensche.
    expect((await mappe(zimmer[0]!, cookie)).json().stay.requests).toBeNull()
    expect((await schreiben(zimmer[0]!, 'Hallo', cookie)).statusCode).toBe(422)

    const an = await app.inject({ method: 'PUT', url: p('/guest-folder'),
      headers: auth(chef.sessionId), payload: { enabled: true, wifi: null, messagesEnabled: true } })
    expect(an.json().messagesEnabled).toBe(true)
    // Ohne das Feld bleibt es, wie es ist.
    const wieder = await app.inject({ method: 'PUT', url: p('/guest-folder'),
      headers: auth(chef.sessionId), payload: { enabled: true, wifi: null } })
    expect(wieder.json().messagesEnabled).toBe(true)
    expect((await mappe(zimmer[0]!, cookie)).json().stay.requests)
      .toMatchObject({ items: [], mine: [], messages: true })

    expect((await schreiben(zimmer[0]!, 'x'.repeat(501), cookie)).statusCode).toBe(422)
    const ok = await schreiben(zimmer[0]!, '  Koennen wir morgen um 7 fruehstuecken?  ', cookie)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().mine).toEqual([expect.objectContaining({
      name: null, message: 'Koennen wir morgen um 7 fruehstuecken?', status: 'open' })])

    const offen = await heute()
    expect(offen).toEqual([expect.objectContaining({ isMessage: true, itemName: null,
      message: 'Koennen wir morgen um 7 fruehstuecken?', lastName: 'Petersen' })])
    const ja = await app.inject({ method: 'POST',
      url: `/v1/guest-requests/${offen[0].requestRef}/done`, headers: auth(chef.sessionId) })
    expect(ja.statusCode, ja.body).toBe(200)
    expect(ja.json()).toMatchObject({ status: 'done', isMessage: true })
    expect((await owner.query(`SELECT 1 FROM charge`)).rowCount).toBe(0)

    // Der Freitext steht nicht im Protokoll.
    const log = await owner.query(`SELECT changed::text AS c FROM audit_log
                                    WHERE table_name = 'guest_request'`)
    expect(log.rowCount).toBeGreaterThan(0)
    expect(JSON.stringify(log.rows)).not.toContain('fruehstuecken')
  })

  for (const fn of ['guest_erase_one', 'guest_erase_partial']) {
    it(`${fn} leert den Text der Nachricht`, async () => {
      const r = await aufenthalt(zimmer[0]!, 'Petersen')
      await owner.query(
        `INSERT INTO guest_request (property_id, reservation_id, is_message, message, qty, source)
         VALUES ($1, $2, true, 'Ich bin allergisch gegen Nuesse', 1, 'folder')`,
        [fx.propertyId, r])
      const g = await owner.query<{ id: number }>(
        `SELECT primary_guest_id::int AS id FROM reservation WHERE id = $1`, [r])
      await owner.query(`SELECT set_config('app.account_ids', $1, false), ${fn}($2)`,
        [String(fx.accountId), g.rows[0]!.id])
      await owner.query(`SELECT set_config('app.account_ids', '', false)`)
      const q = await owner.query(`SELECT message, is_message FROM guest_request`)
      expect(q.rows).toEqual([{ message: null, is_message: true }])
    })
  }
})

describe('Zur Abreise und spaete Abreise (0154)', () => {
  async function abreisend(raum: number, lastName: string, departure: string): Promise<number> {
    const g = await makeGuest(owner, fx.accountId, { lastName })
    const r = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
      arrival: '2026-10-10', departure, resourceId: raum, status: 'InHouse',
      reserveInventory: false })
    await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
      [r.reservationId, g.id])
    return r.reservationId
  }
  const namen = async (raum: number, cookie: string) =>
    (await mappe(raum, cookie)).json().stay.requests.items
      .map((i: { name: { de: string }; forDeparture: boolean }) => [i.name.de, i.forDeparture])

  it('bietet erst ab dem Abend davor an und setzt den Abreisetag selbst', async () => {
    const c = await katalog(
      eintrag({ de: 'Kissen' }),
      eintrag({ de: 'Lunchpaket' }, { offer: 'departure' }),
      eintrag({ de: 'Bis 13 Uhr' }, { offer: 'late_checkout', maxQty: 1,
        price: { grossCent: 1500, taxRuleId: steuer19, revenueAccount: '8400' } }))
    expect(c.items.map(i => i.offer)).toEqual(['stay', 'departure', 'late_checkout'])
    const lunch = c.items[1]!.itemRef

    // Abreise uebermorgen: nur das Kissen, und das Lunchpaket nicht per Hand.
    await abreisend(zimmer[0]!, 'Weit', '2026-10-14')
    const weit = await freischalten(zimmer[0]!, 'Weit')
    expect(await namen(zimmer[0]!, weit)).toEqual([['Kissen', false]])
    expect((await bestellen(zimmer[0]!, { itemRef: lunch, qty: 1 }, weit)).statusCode).toBe(422)

    // Abreise morgen: alles, und der Wunschtag ist der Abreisetag.
    const res = await abreisend(zimmer[1]!, 'Nah', '2026-10-13')
    const nah = await freischalten(zimmer[1]!, 'Nah')
    expect(await namen(zimmer[1]!, nah))
      .toEqual([['Kissen', false], ['Lunchpaket', true], ['Bis 13 Uhr', true]])
    const b = await bestellen(zimmer[1]!, { itemRef: lunch, qty: 1, wantedFor: HEUTE }, nah)
    expect(b.statusCode, b.body).toBe(200)
    expect((await owner.query(`SELECT wanted_for::text AS d FROM guest_request
                                WHERE reservation_id = $1`, [res])).rows).toEqual([{ d: '2026-10-13' }])

    // Reist morgen jemand in das Zimmer an, gibt es keine spaete Abreise mehr.
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
      arrival: '2026-10-13', departure: '2026-10-15', resourceId: zimmer[1]!,
      status: 'Confirmed', reserveInventory: false })
    expect(await namen(zimmer[1]!, nah)).toEqual([['Kissen', false], ['Lunchpaket', true]])
    expect((await bestellen(zimmer[1]!, { itemRef: c.items[2]!.itemRef, qty: 1 }, nah))
      .statusCode).toBe(422)
  })

  it('zeigt die Abreiseseite ab dem Abend davor und den Bewertungslink am Abreisetag', async () => {
    const seite = (await owner.query<{ public_ref: string }>(
      `INSERT INTO terminal_content (property_id, title, folder_position)
       VALUES ($1, 'Abreise', 1) RETURNING public_ref`, [fx.propertyId])).rows[0]!.public_ref
    const fremd = await makeProperty(owner, { name: 'Andere' })
    const [link, fremderLink] = await Promise.all([fx.propertyId, fremd.propertyId].map(async id =>
      (await owner.query<{ public_ref: string }>(
        `INSERT INTO terminal_url (property_id, label, url)
         VALUES ($1, 'Google', 'https://g.page/r/seerobbe/review') RETURNING public_ref`,
        [id])).rows[0]!.public_ref))

    const setzen = (payload: object) => app.inject({ method: 'PUT', url: p('/guest-folder'),
      headers: auth(chef.sessionId), payload: { enabled: true, wifi: null, ...payload } })
    expect((await setzen({ reviewUrl: fremderLink })).statusCode).toBe(422)
    const s = await setzen({ departurePage: seite, reviewUrl: link })
    expect(s.statusCode, s.body).toBe(200)
    expect(s.json()).toMatchObject({ departurePage: seite, reviewUrl: link,
      urls: [{ urlRef: link, label: 'Google' }] })
    // Ohne die Felder bleibt beides.
    expect((await setzen({})).json()).toMatchObject({ departurePage: seite, reviewUrl: link })

    await abreisend(zimmer[0]!, 'Weit', '2026-10-14')
    await abreisend(zimmer[1]!, 'Nah', '2026-10-13')
    const weit = (await mappe(zimmer[0]!, await freischalten(zimmer[0]!, 'Weit'))).json().stay
    expect(weit).toMatchObject({ departureSoon: false, departurePage: null, review: null })
    const nahCookie = await freischalten(zimmer[1]!, 'Nah')
    expect((await mappe(zimmer[1]!, nahCookie)).json().stay)
      .toMatchObject({ departureSoon: true, departurePage: seite, review: null })

    // Am Abreisetag der Link; eine entfernte Adresse verschwindet.
    await owner.query(`UPDATE business_day SET date = '2026-10-13' WHERE property_id = $1`,
      [fx.propertyId])
    expect((await mappe(zimmer[1]!, nahCookie)).json().stay.review)
      .toEqual({ label: 'Google', url: 'https://g.page/r/seerobbe/review' })
    await owner.query(`UPDATE terminal_url SET removed_at = now()`)
    expect((await mappe(zimmer[1]!, nahCookie)).json().stay.review).toBeNull()
  })
})

describe('Noch eine Nacht (0155)', () => {
  beforeEach(async () => {
    await owner.query(`SELECT inventory_materialize($1,'2026-10-01'::date,'2026-11-01'::date)`,
      [fx.propertyId])
  })
  const einschalten = (an: boolean) => app.inject({ method: 'PUT', url: p('/guest-folder'),
    headers: auth(chef.sessionId), payload: { enabled: true, wifi: null, extendEnabled: an } })
  async function gast(raum: number, lastName: string, arrival = '2026-10-10',
                      departure = '2026-10-14'): Promise<{ id: number; cookie: string }> {
    const g = await makeGuest(owner, fx.accountId, { lastName })
    const r = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
      arrival, departure, resourceId: raum, status: 'InHouse', priceCent: 9000 })
    await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
      [r.reservationId, g.id])
    return { id: r.reservationId, cookie: await freischalten(raum, lastName) }
  }
  const angebot = async (raum: number, cookie: string) =>
    (await mappe(raum, cookie)).json().stay.requests?.extension ?? null
  const anfragen = (raum: number, cookie: string) => app.inject({ method: 'POST',
    url: '/v1/mappe/extension',
    headers: { [FOLDER_ROOM_HEADER]: refs.get(raum)!, cookie: `${FOLDER_SESSION_COOKIE}=${cookie}` } })

  it('fragt an, und erst das Annehmen rueckt die Abreise', async () => {
    const g = await gast(zimmer[0]!, 'Lang')
    expect(await angebot(zimmer[0]!, g.cookie)).toBeNull()
    expect((await anfragen(zimmer[0]!, g.cookie)).statusCode).toBe(422)

    expect((await einschalten(true)).json().extendEnabled).toBe(true)
    expect(await angebot(zimmer[0]!, g.cookie)).toEqual({ night: '2026-10-14', priceCent: 9000 })
    const a = await anfragen(zimmer[0]!, g.cookie)
    expect(a.statusCode, a.body).toBe(200)
    const w = a.json().mine[0]
    expect(w).toMatchObject({ isExtension: true, wantedFor: '2026-10-14', unitPriceCent: 9000,
      status: 'open' })
    // Eine offene Anfrage genuegt; die zweite waere dieselbe Nacht.
    expect(a.json().extension).toBeNull()
    expect((await anfragen(zimmer[0]!, g.cookie)).statusCode).toBe(422)
    expect((await owner.query(`SELECT departure::text FROM reservation WHERE id = $1`, [g.id]))
      .rows).toEqual([{ departure: '2026-10-14' }])

    const ok = await app.inject({ method: 'POST', url: `/v1/guest-requests/${w.requestRef}/done`,
      headers: auth(chef.sessionId) })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ isExtension: true, status: 'done' })
    const r = await owner.query(
      `SELECT r.departure::text, (SELECT count(*)::int FROM reservation_night
                                   WHERE reservation_id = r.id) AS naechte,
              (SELECT count(*)::int FROM charge WHERE reservation_id = r.id) AS buchungen
         FROM reservation r WHERE r.id = $1`, [g.id])
    expect(r.rows).toEqual([{ departure: '2026-10-15', naechte: 5, buchungen: 0 }])
  })

  it('bietet nichts am Anreisetag und nichts, wenn das Zimmer belegt ist', async () => {
    await einschalten(true)
    const neu = await gast(zimmer[1]!, 'Neu', HEUTE, '2026-10-15')
    expect(await angebot(zimmer[1]!, neu.cookie)).toBeNull()

    const g = await gast(zimmer[0]!, 'Lang')
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
      arrival: '2026-10-14', departure: '2026-10-16', resourceId: zimmer[0]!,
      status: 'Confirmed' })
    expect(await angebot(zimmer[0]!, g.cookie)).toBeNull()
  })

  it('verlaengert nicht, wenn sich die Abreise inzwischen geaendert hat', async () => {
    await einschalten(true)
    const g = await gast(zimmer[0]!, 'Lang')
    const w = (await anfragen(zimmer[0]!, g.cookie)).json().mine[0]
    const ref = (await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM reservation WHERE id = $1`, [g.id])).rows[0]!.public_ref
    const kurz = await app.inject({ method: 'POST', url: `/v1/reservations/${ref}/change-stay`,
      headers: auth(chef.sessionId), payload: { departure: '2026-10-13' } })
    expect(kurz.statusCode, kurz.body).toBe(200)
    const nein = await app.inject({ method: 'POST',
      url: `/v1/guest-requests/${w.requestRef}/done`, headers: auth(chef.sessionId) })
    expect(nein.statusCode).toBe(409)
    expect(nein.json().code).toBe('guestRequest.extensionStale')
  })
})
