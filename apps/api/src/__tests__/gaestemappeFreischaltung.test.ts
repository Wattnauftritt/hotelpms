import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeGuest, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { FOLDER_ROOM_HEADER, FOLDER_SESSION_COOKIE, CHECKIN_TOKEN_HEADER,
         folderRefAusFragment, type GuestFolderCards } from '@hotelpms/contracts'
import { neuesToken, FOLDER_UNLOCK_MAX_FAILURES, folderNameMatches,
         folderPostalMatches } from '@hotelpms/domain'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Freischalten der Gaestemappe mit Nachname oder PLZ (Migration 0147):
 * Wechseltag, Fehlversuche je Zimmer, Mail-Link, Aufheben an der Rezeption
 * und die Loeschung des Gastes.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: { userId: number; sessionId: string }
let kategorie: number
let zimmer: number[]
let refs: Map<number, string>

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
  await app.inject({ method: 'PUT', url: p('/guest-folder'), headers: auth(chef.sessionId),
    payload: { enabled: true, wifi: null } })
  const k = await app.inject({ method: 'GET', url: p('/guest-folder/cards'),
    headers: auth(chef.sessionId) })
  refs = new Map(k.json<GuestFolderCards>().rooms.map(r =>
    [r.resourceId, folderRefAusFragment(r.link.slice(r.link.indexOf('#')))!]))
})

async function aufenthalt(o: {
  zimmer: number; arrival: string; departure: string; lastName: string
  status?: 'Confirmed' | 'InHouse'
}): Promise<{ reservationId: number; guestId: number }> {
  const g = await makeGuest(owner, fx.accountId, { lastName: o.lastName })
  const r = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kategorie,
    arrival: o.arrival, departure: o.departure, resourceId: o.zimmer,
    status: o.status ?? 'InHouse', reserveInventory: false, withFolio: false })
  await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
    [r.reservationId, g.id])
  return { reservationId: r.reservationId, guestId: g.id }
}

function cookieAus(r: LightMyRequestResponse): string {
  const c = r.cookies.find(x => x.name === FOLDER_SESSION_COOKIE)
  expect(c, 'Cookie der Freischaltung').toBeDefined()
  return c!.value
}

const mappe = (raum: number, cookie?: string) => app.inject({ method: 'GET', url: '/v1/mappe',
  headers: { [FOLDER_ROOM_HEADER]: refs.get(raum)!,
             ...(cookie === undefined ? {} : { cookie: `${FOLDER_SESSION_COOKIE}=${cookie}` }) } })
const freischalten = (raum: number, value: string) => app.inject({ method: 'POST',
  url: '/v1/mappe/unlock', headers: { [FOLDER_ROOM_HEADER]: refs.get(raum)! },
  payload: { value } })

describe('Vergleich von Nachname und PLZ', () => {
  it('ist nachsichtig mit Umlauten, Akzenten und Doppelnamen, aber nicht mit Anfaengen', () => {
    expect(folderNameMatches('muller', ['Müller'])).toBe(true)
    expect(folderNameMatches('MUELLER', ['Müller'])).toBe(true)
    expect(folderNameMatches('Garcia', ['García López'])).toBe(true)
    expect(folderNameMatches('lopez', ['García López'])).toBe(true)
    expect(folderNameMatches('hansen', ['Schmidt-Hansen'])).toBe(true)
    expect(folderNameMatches('schmidt hansen', ['Schmidt-Hansen'])).toBe(true)
    expect(folderNameMatches('Sch', ['Schmidt'])).toBe(false)
    expect(folderNameMatches('s', ['S'])).toBe(false)
    expect(folderNameMatches('Strauss', ['Strauß'])).toBe(true)
    expect(folderPostalMatches('nw1 6xe', ['NW1 6XE'])).toBe(true)
    expect(folderPostalMatches('24937', ['24937'])).toBe(true)
    expect(folderPostalMatches('249', ['24937'])).toBe(false)
  })
})

describe('Freischalten', () => {
  it('schaltet mit dem Nachnamen frei und zeigt dann nur den Abreisetag', async () => {
    await aufenthalt({ zimmer: zimmer[0]!, arrival: '2026-10-10', departure: '2026-10-14',
      lastName: 'Müller' })
    const vorher = await mappe(zimmer[0]!)
    expect(vorher.json().stay).toBeNull()

    const r = await freischalten(zimmer[0]!, 'mueller')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toEqual({ stay: { departure: '2026-10-14' } })
    const c = r.cookies.find(x => x.name === FOLDER_SESSION_COOKIE)!
    expect(c).toMatchObject({ httpOnly: true, path: '/v1/mappe', sameSite: 'Strict' })
    // Bis zum Ende des Abreisetags am Ort des Hauses.
    expect(new Date(c.expires!).toISOString()).toBe('2026-10-14T22:00:00.000Z')

    const nachher = await mappe(zimmer[0]!, c.value)
    expect(nachher.json().stay).toEqual({ departure: '2026-10-14' })
    // Im Nachbarzimmer gilt die Freischaltung nicht.
    expect((await mappe(zimmer[1]!, c.value)).json().stay).toBeNull()
    // Kein Name in der Antwort.
    expect(nachher.body).not.toContain('Müller')
  })

  it('schaltet mit der PLZ frei und bindet sich am Wechseltag an den passenden Aufenthalt', async () => {
    const geht = await aufenthalt({ zimmer: zimmer[0]!, arrival: '2026-10-09',
      departure: HEUTE, lastName: 'Abreise' })
    const kommt = await aufenthalt({ zimmer: zimmer[0]!, arrival: HEUTE,
      departure: '2026-10-15', lastName: 'Anreise', status: 'Confirmed' })
    await owner.query(`UPDATE guest SET postal_code = '27472' WHERE id = $1`, [kommt.guestId])

    const a = await freischalten(zimmer[0]!, 'Abreise')
    expect(a.json().stay).toEqual({ departure: HEUTE })
    const b = await freischalten(zimmer[0]!, '27472')
    expect(b.json().stay).toEqual({ departure: '2026-10-15' })

    const sitzungen = await owner.query<{ reservation_id: number }>(
      `SELECT reservation_id::int FROM guest_folder_session ORDER BY id`)
    expect(sitzungen.rows.map(s => s.reservation_id)).toEqual([geht.reservationId, kommt.reservationId])
  })

  it('folgt dem Gast in ein anderes Zimmer und erkennt Mitreisende', async () => {
    const a = await aufenthalt({ zimmer: zimmer[0]!, arrival: '2026-10-10',
      departure: '2026-10-14', lastName: 'Petersen' })
    const mit = await makeGuest(owner, fx.accountId, { lastName: 'Jensen' })
    await owner.query(
      `INSERT INTO reservation_occupant (reservation_id, property_id, guest_id, is_primary)
       VALUES ($1, $2, $3, false)`, [a.reservationId, fx.propertyId, mit.id])
    const c = cookieAus(await freischalten(zimmer[0]!, 'Jensen'))
    await owner.query(`UPDATE reservation SET resource_id = $2 WHERE id = $1`,
      [a.reservationId, zimmer[1]])
    expect((await mappe(zimmer[0]!, c)).json().stay).toBeNull()
    expect((await mappe(zimmer[1]!, c)).json().stay).toEqual({ departure: '2026-10-14' })
  })

  it('sagt bei einem leeren und einem fremden Zimmer dasselbe und zaehlt je Zimmer', async () => {
    await aufenthalt({ zimmer: zimmer[0]!, arrival: '2026-10-10', departure: '2026-10-14',
      lastName: 'Petersen' })
    const leer = await freischalten(zimmer[1]!, 'Petersen')
    const falsch = await freischalten(zimmer[0]!, 'Hansen')
    expect(leer.statusCode).toBe(422)
    expect(falsch.statusCode).toBe(422)
    expect(leer.json().code).toBe(falsch.json().code)

    for (let i = 1; i < FOLDER_UNLOCK_MAX_FAILURES; i++) {
      limiters.reset()
      expect((await freischalten(zimmer[0]!, `Falsch${i}`)).statusCode).toBe(422)
    }
    limiters.reset()
    // Gesperrt, auch mit dem richtigen Namen -- und nur dieses Zimmer.
    expect((await freischalten(zimmer[0]!, 'Petersen')).statusCode).toBe(429)
    const z = await owner.query<{ failures: number }>(
      `SELECT failures FROM guest_folder_unlock_failure WHERE resource_id = $1`, [zimmer[0]])
    expect(z.rows[0]!.failures).toBe(FOLDER_UNLOCK_MAX_FAILURES)

    // Nach der Viertelstunde geht es wieder, und der Erfolg loescht den Zaehler.
    await owner.query(`UPDATE guest_folder_unlock_failure
                          SET window_start = now() - interval '16 minutes'`)
    expect((await freischalten(zimmer[0]!, 'Petersen')).statusCode).toBe(200)
    expect((await owner.query(`SELECT 1 FROM guest_folder_unlock_failure WHERE resource_id = $1`,
      [zimmer[0]])).rowCount).toBe(0)
  })

  it('kennt keinen stornierten und keinen kuenftigen Aufenthalt', async () => {
    const a = await aufenthalt({ zimmer: zimmer[0]!, arrival: '2026-10-13',
      departure: '2026-10-15', lastName: 'Morgen', status: 'Confirmed' })
    expect((await freischalten(zimmer[0]!, 'Morgen')).statusCode).toBe(422)
    await owner.query(`UPDATE reservation SET arrival = $2, status = 'Canceled' WHERE id = $1`,
      [a.reservationId, HEUTE])
    expect((await freischalten(zimmer[0]!, 'Morgen')).statusCode).toBe(422)
  })
})

describe('Aufheben', () => {
  it('hebt die eigene auf und an der Rezeption alle eines Aufenthalts', async () => {
    const a = await aufenthalt({ zimmer: zimmer[0]!, arrival: '2026-10-10',
      departure: '2026-10-14', lastName: 'Petersen' })
    const eins = cookieAus(await freischalten(zimmer[0]!, 'Petersen'))
    const zwei = cookieAus(await freischalten(zimmer[0]!, '24937'))

    const weg = await app.inject({ method: 'POST', url: '/v1/mappe/lock',
      headers: { [FOLDER_ROOM_HEADER]: refs.get(zimmer[0]!)!,
                 cookie: `${FOLDER_SESSION_COOKIE}=${eins}` } })
    expect(weg.statusCode, weg.body).toBe(200)
    expect((await mappe(zimmer[0]!, eins)).json().stay).toBeNull()
    expect((await mappe(zimmer[0]!, zwei)).json().stay).not.toBeNull()

    const ref = await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM reservation WHERE id = $1`, [a.reservationId])
    const detail = async () => (await app.inject({ method: 'GET',
      url: `/v1/reservations/${ref.rows[0]!.public_ref}`, headers: auth(chef.sessionId) })).json()
    expect((await detail()).guestFolder).toEqual({ activeSessions: 1 })
    const r = await app.inject({ method: 'POST',
      url: `/v1/reservations/${ref.rows[0]!.public_ref}/guest-folder/revoke`,
      headers: auth(chef.sessionId) })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().revoked).toBe(1)
    expect((await mappe(zimmer[0]!, zwei)).json().stay).toBeNull()
    expect((await detail()).guestFolder).toEqual({ activeSessions: 0 })
  })

  it('loescht die Freischaltungen mit dem Gast und schreibt den Hash nicht ins Protokoll', async () => {
    const a = await aufenthalt({ zimmer: zimmer[0]!, arrival: '2026-10-10',
      departure: '2026-10-14', lastName: 'Petersen' })
    await freischalten(zimmer[0]!, 'Petersen')
    const h = await owner.query<{ token_hash: string }>(`SELECT token_hash FROM guest_folder_session`)
    const log = await owner.query(`SELECT changed::text AS c FROM audit_log
                                    WHERE table_name = 'guest_folder_session'`)
    expect(log.rowCount).toBeGreaterThan(0)
    expect(JSON.stringify(log.rows)).not.toContain(h.rows[0]!.token_hash)

    await owner.query(
      `SELECT set_config('app.account_ids', $1, false), guest_erase_one($2)`,
      [String(fx.accountId), a.guestId])
    await owner.query(`SELECT set_config('app.account_ids', '', false)`)
    expect((await owner.query(`SELECT 1 FROM guest_folder_session`)).rowCount).toBe(0)
  })
})

describe('Mail-Link', () => {
  async function link(reservationId: number, channel: 'mail' | 'terminal'): Promise<string> {
    const t = neuesToken()
    await owner.query(
      `INSERT INTO checkin_token (property_id, reservation_id, token_hash, channel, expires_on)
       VALUES ($1, $2, $3, $4, '2026-10-14')`, [fx.propertyId, reservationId, t.hash, channel])
    return t.token
  }
  const oeffnen = (token: string) => app.inject({ method: 'POST', url: '/v1/mappe/from-checkin',
    headers: { [CHECKIN_TOKEN_HEADER]: token } })

  it('oeffnet die Mappe freigeschaltet, aber nicht am Terminal und nicht vor der Anreise', async () => {
    const a = await aufenthalt({ zimmer: zimmer[0]!, arrival: '2026-10-10',
      departure: '2026-10-14', lastName: 'Petersen' })
    const mail = await link(a.reservationId, 'mail')
    const form = await app.inject({ method: 'GET', url: '/v1/checkin/form',
      headers: { [CHECKIN_TOKEN_HEADER]: mail } })
    expect(form.json().guestFolder).toBe(true)

    const r = await oeffnen(mail)
    expect(r.statusCode, r.body).toBe(200)
    const ref = folderRefAusFragment(r.json<{ link: string }>().link.split('#')[1]!)
    expect(ref).toBe(refs.get(zimmer[0]!))
    expect((await mappe(zimmer[0]!, cookieAus(r))).json().stay).toEqual({ departure: '2026-10-14' })

    expect((await oeffnen(await link(a.reservationId, 'terminal'))).statusCode).toBe(422)

    await owner.query(`UPDATE reservation SET arrival = '2026-10-13', status = 'Confirmed'
                        WHERE id = $1`, [a.reservationId])
    expect((await oeffnen(mail)).statusCode).toBe(422)
    const vorher = await app.inject({ method: 'GET', url: '/v1/checkin/form',
      headers: { [CHECKIN_TOKEN_HEADER]: mail } })
    expect(vorher.json().guestFolder).toBe(false)
  })
})
