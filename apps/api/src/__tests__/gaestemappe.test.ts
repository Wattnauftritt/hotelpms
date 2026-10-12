import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { FOLDER_ROOM_HEADER, folderRefAusFragment, wifiQrText,
         type GuestFolderCards } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Digitale Gaestemappe, Bausteine 1 und 2 (Migration 0143): Einstellung,
 * Seiten, WLAN, Zimmerkarten und die Seite des Gastes hinter der
 * Zimmer-Referenz.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: { userId: number; sessionId: string }
let zimmer: number[]

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const p = (pfad: string, haus = fx.propertyId) => `/v1/properties/${haus}${pfad}`
const WLAN = { ssid: 'Seerobbe-Gast', password: 'Krabbe;Watt"1', security: 'WPA', hidden: false }

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
  fx = await makeProperty(owner, { name: 'Seerobbe' })
  const kategorie = await makeCategory(owner, fx.propertyId)
  zimmer = await makeResources(owner, fx.propertyId, kategorie, 2)
  chef = await makeUser(owner, { email: 'chef@kunde.de', propertyId: fx.propertyId,
    roleKey: 'hotel_director' })
})

async function seite(propertyId: number, title: string, body = ''): Promise<string> {
  const r = await owner.query<{ public_ref: string }>(
    `INSERT INTO terminal_content (property_id, title, body) VALUES ($1, $2, $3)
     RETURNING public_ref`, [propertyId, title, body])
  return r.rows[0]!.public_ref
}

const einstellen = (enabled: boolean, wifi: unknown = WLAN) =>
  app.inject({ method: 'PUT', url: p('/guest-folder'), headers: auth(chef.sessionId),
    payload: { enabled, wifi } })
const karten = async (): Promise<GuestFolderCards> => {
  const r = await app.inject({ method: 'GET', url: p('/guest-folder/cards'),
    headers: auth(chef.sessionId) })
  expect(r.statusCode, r.body).toBe(200)
  return r.json<GuestFolderCards>()
}
const refAus = (link: string) => folderRefAusFragment(link.slice(link.indexOf('#')))!
const mappe = (ref: string) =>
  app.inject({ method: 'GET', url: '/v1/mappe', headers: { [FOLDER_ROOM_HEADER]: ref } })

describe('Gaestemappe', () => {
  it('ist aus, bis das Haus sie einschaltet, und die Karte zeigt dann "nicht angeboten"', async () => {
    const k = await karten()
    expect(k.enabled).toBe(false)
    expect(k.rooms).toHaveLength(2)
    const r = await mappe(refAus(k.rooms[0]!.link))
    expect(r.statusCode).toBe(410)
    expect(r.json().code).toBe('folder.off')
  })

  it('zeigt dem Gast WLAN, Zeiten und die gewaehlten Seiten in ihrer Reihenfolge', async () => {
    const fruehstueck = await seite(fx.propertyId, 'Frühstück', '7 bis 10 Uhr')
    const hausordnung = await seite(fx.propertyId, 'Hausordnung', 'Ruhe ab 22 Uhr')
    await seite(fx.propertyId, 'Nur am Terminal')
    expect((await einstellen(true)).statusCode).toBe(200)
    const s = await app.inject({ method: 'PUT', url: p('/guest-folder/pages'),
      headers: auth(chef.sessionId), payload: { contentRefs: [hausordnung, fruehstueck] } })
    expect(s.statusCode, s.body).toBe(200)

    const k = await karten()
    const r = await mappe(refAus(k.rooms[0]!.link))
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    const v = r.json()
    expect(v.propertyName).toBe('Seerobbe')
    expect(v.wifi).toEqual(WLAN)
    expect(v.checkinTime).toBe('15:00')
    expect(v.checkoutTime).toBe('11:00')
    expect(v.pages.map((x: { title: string }) => x.title)).toEqual(['Hausordnung', 'Frühstück'])

    // Leere Folge: nur noch WLAN und Zeiten.
    await app.inject({ method: 'PUT', url: p('/guest-folder/pages'),
      headers: auth(chef.sessionId), payload: { contentRefs: [] } })
    expect((await mappe(refAus(k.rooms[0]!.link))).json().pages).toEqual([])
  })

  it('kennt keine falsche, keine verformte und keine erneuerte Referenz', async () => {
    await einstellen(true)
    const k = await karten()
    const alt = refAus(k.rooms[1]!.link)
    expect((await mappe('ABCDEFGHJKMN')).statusCode).toBe(404)
    expect((await mappe('kein-ref')).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/v1/mappe' })).statusCode).toBe(404)

    const n = await app.inject({ method: 'POST',
      url: p(`/guest-folder/rooms/${zimmer[1]}/renew`), headers: auth(chef.sessionId) })
    expect(n.statusCode, n.body).toBe(200)
    const neu = refAus(n.json<{ link: string }>().link)
    expect(neu).not.toBe(alt)
    expect((await mappe(alt)).statusCode).toBe(404)
    expect((await mappe(neu)).statusCode).toBe(200)
  })

  it('zeigt fuer ein stillgelegtes Zimmer nichts', async () => {
    await einstellen(true)
    const k = await karten()
    await owner.query(`UPDATE resource SET active = false WHERE id = $1`, [zimmer[0]])
    const r = await mappe(refAus(k.rooms[0]!.link))
    expect(r.statusCode).toBe(410)
    expect(r.json().code).toBe('folder.closed')
  })

  it('haelt die Haeuser auseinander: fremde Seiten, fremde Zimmer, fremde Bilder', async () => {
    // Zweites Haus im selben Account, mit eigener Seite und eigenem Zimmer.
    const h2 = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name, address_line1, postal_code, city, country)
       VALUES ($1, 'GH', 'Gästehaus', 'Deich 2', '27476', 'Cuxhaven', 'DE') RETURNING id`,
      [fx.accountId])
    const haus2 = h2.rows[0]!.id
    const fremd = await seite(haus2, 'Fremd')
    const kat2 = await makeCategory(owner, haus2)
    const [zimmer2] = await makeResources(owner, haus2, kat2, 1, 'G')

    await einstellen(true)
    const s = await app.inject({ method: 'PUT', url: p('/guest-folder/pages'),
      headers: auth(chef.sessionId), payload: { contentRefs: [fremd] } })
    expect(s.statusCode).toBe(422)

    const n = await app.inject({ method: 'POST',
      url: p(`/guest-folder/rooms/${zimmer2}/renew`), headers: auth(chef.sessionId) })
    expect(n.statusCode).toBe(404)

    // Ein Bild einer Seite, die nicht in der Mappe steht, gibt es ueber die Karte nicht.
    const eigene = await seite(fx.propertyId, 'Mit Bild')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const bild = await owner.query<{ public_ref: string }>(
      `INSERT INTO terminal_content_image (property_id, content_id, mime, bytes)
       SELECT property_id, id, 'image/png', $2 FROM terminal_content WHERE public_ref = $1
       RETURNING public_ref`, [eigene, png])
    const ref = refAus((await karten()).rooms[0]!.link)
    const holen = () => app.inject({ method: 'GET',
      url: `/v1/mappe/images/${bild.rows[0]!.public_ref}`, headers: { [FOLDER_ROOM_HEADER]: ref } })
    expect((await holen()).statusCode).toBe(404)
    await app.inject({ method: 'PUT', url: p('/guest-folder/pages'),
      headers: auth(chef.sessionId), payload: { contentRefs: [eigene] } })
    const ok = await holen()
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['content-type']).toBe('image/png')
  })

  it('prueft das WLAN und schreibt das Kennwort nicht ins Protokoll', async () => {
    const kurz = await einstellen(true, { ...WLAN, password: 'kurz' })
    expect(kurz.statusCode).toBe(422)
    const lang = await einstellen(true, { ...WLAN, ssid: 'x'.repeat(33) })
    expect(lang.statusCode).toBe(422)
    const offen = await einstellen(true, { ssid: 'Offen', password: 'egal', security: 'nopass',
      hidden: false })
    expect(offen.statusCode, offen.body).toBe(200)
    expect(offen.json().wifi).toEqual({ ssid: 'Offen', password: null, security: 'nopass',
      hidden: false })
    const ohne = await einstellen(true, null)
    expect(ohne.json().wifi).toBeNull()

    await einstellen(true)
    const log = await owner.query<{ changed: unknown }>(
      `SELECT changed FROM audit_log WHERE table_name = 'guest_folder_setting'`)
    expect(log.rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(log.rows)).not.toContain('Krabbe')
  })

  it('zeigt Uebersetzungen nur zur aktuellen deutschen Fassung, und Handarbeit gewinnt (0144)', async () => {
    const ref = await seite(fx.propertyId, 'Frühstück', '7 bis 10 Uhr')
    await einstellen(true)
    await app.inject({ method: 'PUT', url: p('/guest-folder/pages'),
      headers: auth(chef.sessionId), payload: { contentRefs: [ref] } })
    // Was der Worker schreiben wuerde: eine Uebersetzung zur jetzigen Fassung.
    await owner.query(
      `INSERT INTO terminal_content_translation
              (content_id, property_id, lang, title, body, source_hash, origin)
       SELECT id, property_id, 'nl', 'Ontbijt', '7 tot 10 uur',
              terminal_content_hash(title, body), 'machine'
         FROM terminal_content WHERE public_ref = $1`, [ref])
    const k = await karten()
    const gast = async () => (await mappe(refAus(k.rooms[0]!.link))).json().pages[0]
    expect((await gast()).translations).toEqual({ nl: { title: 'Ontbijt', body: '7 tot 10 uur' } })

    const stand = async () => (await app.inject({ method: 'GET', url: p('/guest-folder'),
      headers: auth(chef.sessionId) })).json().pages[0].translations
    expect((await stand()).map((t: { lang: string; state: string }) => [t.lang, t.state]))
      .toEqual([['en', 'pending'], ['nl', 'machine'], ['pl', 'pending']])

    // Von Hand berichtigt.
    const url = p(`/guest-folder/pages/${ref}/translations/nl`)
    const hand = await app.inject({ method: 'PUT', url, headers: auth(chef.sessionId),
      payload: { title: '  Ontbijt ', body: 'Van 7 tot 10 uur' } })
    expect(hand.statusCode, hand.body).toBe(200)
    expect((await gast()).translations.nl).toEqual({ title: 'Ontbijt', body: 'Van 7 tot 10 uur' })
    expect((await stand())[1]).toMatchObject({ state: 'manual', body: 'Van 7 tot 10 uur' })

    // Die deutsche Seite aendert sich: bis zur neuen Uebersetzung deutsch.
    await owner.query(`UPDATE terminal_content SET body = '7:30 bis 10 Uhr' WHERE public_ref = $1`,
      [ref])
    expect((await gast()).translations).toEqual({})
    expect((await stand())[1]).toMatchObject({ state: 'pending', title: null })

    // Zurueck an DeepL.
    await app.inject({ method: 'PUT', url, headers: auth(chef.sessionId),
      payload: { title: 'Ontbijt', body: 'Van 7.30 tot 10 uur' } })
    const weg = await app.inject({ method: 'DELETE', url, headers: auth(chef.sessionId) })
    expect(weg.statusCode, weg.body).toBe(200)
    expect((await stand())[1]).toMatchObject({ state: 'pending', title: null })
  })

  it('nimmt Uebersetzungen nur fuer Seiten des eigenen Hauses und in den Sprachen der Mappe', async () => {
    const ref = await seite(fx.propertyId, 'Frühstück')
    const ok = { title: 'Breakfast', body: '' }
    const put = (url: string, payload: unknown = ok) =>
      app.inject({ method: 'PUT', url, headers: auth(chef.sessionId), payload })
    expect((await put(p(`/guest-folder/pages/${ref}/translations/de`))).statusCode).toBe(422)
    expect((await put(p(`/guest-folder/pages/${ref}/translations/fr`))).statusCode).toBe(422)
    expect((await put(p(`/guest-folder/pages/${ref}/translations/en`),
      { title: ' ', body: '' })).statusCode).toBe(422)
    expect((await put(p(`/guest-folder/pages/${ref}/translations/en`),
      { title: 'x', body: 'y'.repeat(10001) })).statusCode).toBe(422)

    const anderes = await makeProperty(owner, { accountId: fx.accountId, name: 'Ankerplatz' })
    const fremd = await seite(anderes.propertyId, 'Fremd')
    expect((await put(p(`/guest-folder/pages/${fremd}/translations/en`))).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', headers: auth(chef.sessionId),
      url: p(`/guest-folder/pages/${fremd}/translations/en`) })).statusCode).toBe(404)
    expect((await put(p(`/guest-folder/pages/${ref}/translations/en`))).statusCode).toBe(200)
  })

  it('verlangt fuer die Einstellungen das Recht am Haus', async () => {
    const kraft = await makeUser(owner, { email: 'olga@kunde.de', propertyId: fx.propertyId,
      roleKey: 'housekeeping_staff' })
    const r = await app.inject({ method: 'GET', url: p('/guest-folder'),
      headers: auth(kraft.sessionId) })
    expect(r.statusCode).toBe(403)
  })
})

describe('WLAN-QR-Code', () => {
  it('maskiert Sonderzeichen in Name und Kennwort', () => {
    expect(wifiQrText({ ssid: 'A;B', password: 'p:w\\"x,', security: 'WPA', hidden: true }))
      .toBe('WIFI:T:WPA;S:A\\;B;P:p\\:w\\\\\\"x\\,;H:true;;')
    expect(wifiQrText({ ssid: 'Offen', password: null, security: 'nopass', hidden: false }))
      .toBe('WIFI:T:nopass;S:Offen;;')
  })
})
