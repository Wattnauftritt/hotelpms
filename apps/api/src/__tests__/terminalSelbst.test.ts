import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { CHECKIN_TOKEN_HEADER } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Selbstbedienung am Gaesteterminal (Dokument 31, Abschnitt 14; Migration
 * 0150).
 *
 * Geprueft wird, was still schiefginge: ein Zimmer, das am Touchscreen mit
 * dem falschen Gast erscheint; ein Link, der die Sitzung ueberlebt und dem
 * naechsten Gast gehoert; ein Auftrag der Rezeption, der an einer offenen
 * Selbstbedienung haengen bleibt; und ein Verzicht, der am Terminal anders
 * wirkt als auf dem Telefon.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let kategorie: number
let zimmer: number[]
let chef: Record<string, string>
let geraet: Record<string, string>
let deviceRef: string

const TAG = '2026-10-01'

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

/** Ein Aufenthalt mit Hauptgast im Zimmer. */
async function aufenthalt(raum: number, nachname: string, arrival: string, departure: string,
                          status: 'Confirmed' | 'InHouse' = 'InHouse',
                          propertyId = fx.propertyId, cat = kategorie, accountId = fx.accountId
): Promise<{ id: number; ref: string }> {
  const r = await makeReservation(owner, { propertyId, categoryId: cat, resourceId: raum,
    arrival, departure, status, reserveInventory: false, withFolio: false })
  const g = await owner.query<{ id: number }>(
    `INSERT INTO guest (account_id, last_name, first_name, language)
     VALUES ($1, $2, 'Anna', 'de') RETURNING id`, [accountId, nachname])
  const v = await owner.query<{ public_ref: string }>(
    `UPDATE reservation SET primary_guest_id = $2 WHERE id = $1 RETURNING public_ref`,
    [r.reservationId, g.rows[0]!.id])
  return { id: r.reservationId, ref: v.rows[0]!.public_ref }
}

async function einschalten(propertyId = fx.propertyId, headers = chef): Promise<void> {
  const v = await app.inject({ method: 'PUT',
    url: `/v1/properties/${propertyId}/cleaning-waiver-settings`, headers,
    payload: { enabled: true, waterGift: false } })
  expect(v.statusCode, v.body).toBe(200)
  const s = await app.inject({ method: 'PUT',
    url: `/v1/properties/${propertyId}/terminal-self-service`, headers,
    payload: { enabled: true } })
  expect(s.statusCode, s.body).toBe(200)
}

beforeEach(async () => {
  await truncateAll()
  limiters.reset()
  fx = await makeProperty(owner, { name: 'Seerobbe' })
  await openBusinessDay(owner, fx.propertyId, TAG)
  kategorie = await makeCategory(owner, fx.propertyId)
  zimmer = await makeResources(owner, fx.propertyId, kategorie, 4)
  const u = await makeUser(owner, { email: 'chef@kunde.de', propertyId: fx.propertyId,
    roleKey: 'hotel_director' })
  chef = { cookie: `hp_session=${u.sessionId}` }
  const t = await app.inject({ method: 'POST', url: `/v1/properties/${fx.propertyId}/terminals`,
    headers: chef, payload: { name: 'Touchscreen' } })
  expect(t.statusCode, t.body).toBe(201)
  deviceRef = t.json<{ deviceRef: string }>().deviceRef
  const k = await app.inject({ method: 'POST', url: '/v1/terminal/pair',
    payload: { code: t.json<{ pairingCode: string }>().pairingCode } })
  expect(k.statusCode, k.body).toBe(200)
  geraet = { cookie: `hp_terminal=${k.cookies.find(c => c.name === 'hp_terminal')!.value}` }
})

const raeume = async () => {
  const r = await app.inject({ method: 'GET', url: '/v1/terminal/self/rooms', headers: geraet })
  expect(r.statusCode, r.body).toBe(200)
  return r.json<{ properties: Array<{ property: string
                                      rooms: Array<{ resourceId: number; code: string }> }> }>()
    .properties
}
const antippen = (resourceId: number) =>
  app.inject({ method: 'POST', url: '/v1/terminal/self/sessions', headers: geraet,
    payload: { resourceId } })
const antworten = (sessionRef: string, yes: boolean) =>
  app.inject({ method: 'POST', url: `/v1/terminal/self/sessions/${sessionRef}/confirm`,
    headers: geraet, payload: { yes } })
const verzichten = (token: string, date: string) =>
  app.inject({ method: 'POST', url: '/v1/checkin/cleaning-waiver',
    headers: { [CHECKIN_TOKEN_HEADER]: token }, payload: { date, waived: true } })

describe('Selbstbedienung am Gaesteterminal', () => {
  it('zeigt keine Zimmer, solange das Haus sie nicht anbietet', async () => {
    await aufenthalt(zimmer[0]!, 'Petersen', '2026-09-30', '2026-10-04')
    expect(await raeume()).toEqual([])
    expect((await antippen(zimmer[0]!)).statusCode).toBe(404)
  })

  it('zeigt belegte Zimmer, auch ohne Check-in, aber nicht storniert und nicht am Abreisetag',
    async () => {
      await einschalten()
      await aufenthalt(zimmer[0]!, 'Petersen', '2026-09-30', '2026-10-04', 'InHouse')
      // Heute angereist, noch nicht eingecheckt: gilt als angereist.
      await aufenthalt(zimmer[1]!, 'Jansen', TAG, '2026-10-03', 'Confirmed')
      // Reist heute ab: kein Bleibetag mehr.
      await aufenthalt(zimmer[2]!, 'Abreise', '2026-09-28', TAG, 'InHouse')
      const storno = await aufenthalt(zimmer[3]!, 'Storno', '2026-09-30', '2026-10-04', 'Confirmed')
      await owner.query(`UPDATE reservation SET status = 'Canceled' WHERE id = $1`, [storno.id])

      const h = await raeume()
      expect(h).toHaveLength(1)
      expect(h[0]!.property).toBe('Seerobbe')
      expect(h[0]!.rooms.map(r => r.resourceId)).toEqual([zimmer[0], zimmer[1]])
      // Nur Nummern, kein Name.
      expect(JSON.stringify(h)).not.toContain('Petersen')
    })

  it('fragt nach dem Nachnamen und gibt nach "Ja" den Verzicht ueber den vorhandenen Endpunkt frei',
    async () => {
      await einschalten()
      const a = await aufenthalt(zimmer[0]!, 'Petersen', '2026-09-30', '2026-10-04')
      const s = await antippen(zimmer[0]!)
      expect(s.statusCode, s.body).toBe(200)
      expect(s.json()).toMatchObject({ lastName: 'Petersen' })
      expect(Object.keys(s.json()).sort()).toEqual(['lastName', 'sessionRef'])

      const j = await antworten(s.json().sessionRef, true)
      expect(j.statusCode, j.body).toBe(200)
      expect(j.headers['cache-control']).toBe('no-store')
      const { token, cleaningWaiver } = j.json<{ token: string; cleaningWaiver: unknown }>()
      expect(cleaningWaiver).toEqual({ waterGift: false, mayEdit: true, days: [
        { date: '2026-10-01', waived: false, locked: false },
        { date: '2026-10-02', waived: false, locked: false },
        { date: '2026-10-03', waived: false, locked: false }] })

      const v = await verzichten(token, '2026-10-02')
      expect(v.statusCode, v.body).toBe(200)
      const w = await owner.query(
        `SELECT reservation_id, business_date::text AS d, source FROM cleaning_waiver`)
      expect(w.rows).toEqual([{ reservation_id: a.id, d: '2026-10-02', source: 'guest' }])

      // Zweimal "Ja" gibt es nicht.
      expect((await antworten(s.json().sessionRef, true)).statusCode).toBe(409)

      // Mit dem Ende der Sitzung faellt der Link.
      const e = await app.inject({ method: 'POST',
        url: `/v1/terminal/self/sessions/${s.json().sessionRef}/end`, headers: geraet,
        payload: { reason: 'done' } })
      expect(e.statusCode, e.body).toBe(200)
      expect((await verzichten(token, '2026-10-03')).statusCode).toBe(410)
    })

  it('beendet die Sitzung auf "Nein" und bremst, wer Zimmer um Zimmer durchtippt', async () => {
    await einschalten()
    await aufenthalt(zimmer[0]!, 'Petersen', '2026-09-30', '2026-10-04')
    const s = await antippen(zimmer[0]!)
    const n = await antworten(s.json().sessionRef, false)
    expect(n.statusCode, n.body).toBe(200)
    expect(n.json()).toEqual({ confirmed: false, lastName: null })
    expect((await antworten(s.json().sessionRef, true)).statusCode).toBe(409)

    // Drei weitere ohne "Ja" in derselben Minute gehen, dann eine Pause.
    for (let i = 0; i < 3; i++) expect((await antippen(zimmer[0]!)).statusCode).toBe(200)
    const p = await antippen(zimmer[0]!)
    expect(p.statusCode).toBe(409)
    expect(p.json().code).toBe('terminalSelf.pause')
  })

  it('beendet eine liegengebliebene Sitzung, sobald die Seite wieder ruht', async () => {
    await einschalten()
    await aufenthalt(zimmer[0]!, 'Petersen', '2026-09-30', '2026-10-04')
    const s = await antippen(zimmer[0]!)
    const { token } = (await antworten(s.json().sessionRef, true)).json<{ token: string }>()
    // Die Seite stuerzt ab und baut sich neu auf; im Ruhezustand holt sie
    // die Diashow.
    const i = await app.inject({ method: 'GET', url: '/v1/terminal/idle', headers: geraet })
    expect(i.statusCode, i.body).toBe(200)
    expect(i.json().selfService).toBe(true)
    expect((await verzichten(token, '2026-10-02')).statusCode).toBe(410)
  })

  it('fragt bei zwei Aufenthalten im Zimmer auf "Nein" nach dem zweiten', async () => {
    await einschalten()
    await aufenthalt(zimmer[0]!, 'Petersen', '2026-09-30', '2026-10-04')
    await aufenthalt(zimmer[0]!, 'Jansen', TAG, '2026-10-03', 'Confirmed')
    const s = await antippen(zimmer[0]!)
    expect(s.json().lastName).toBe('Jansen')
    const n = await antworten(s.json().sessionRef, false)
    expect(n.json()).toEqual({ confirmed: false, lastName: 'Petersen' })
    expect((await antworten(s.json().sessionRef, true)).statusCode).toBe(200)
  })

  it('weicht einem Auftrag der Rezeption: die Sitzung endet, der Link faellt', async () => {
    await einschalten()
    await aufenthalt(zimmer[0]!, 'Petersen', '2026-09-30', '2026-10-04')
    const s = await antippen(zimmer[0]!)
    const { token } = (await antworten(s.json().sessionRef, true)).json<{ token: string }>()

    const desk = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/terminal-desk`, headers: chef })
    expect(desk.json().terminals[0]).toMatchObject({ deviceRef, busy: false, selfService: true })

    // Die Rezeption kann trotzdem schicken ...
    const seite = await owner.query<{ public_ref: string }>(
      `INSERT INTO terminal_content (property_id, title) VALUES ($1, 'Hausordnung')
       RETURNING public_ref`, [fx.propertyId])
    const job = await app.inject({ method: 'POST', url: '/v1/terminal-jobs', headers: chef,
      payload: { deviceRef, propertyId: fx.propertyId, kind: 'content',
                 contentRef: seite.rows[0]!.public_ref } })
    expect(job.statusCode, job.body).toBe(201)
    // ... und das Oeffnen beendet die Selbstbedienung.
    const f = await app.inject({ method: 'GET', url: '/v1/terminal/job', headers: geraet })
    const o = await app.inject({ method: 'POST',
      url: `/v1/terminal/job/${f.json().job.jobRef}/open`, headers: geraet })
    expect(o.statusCode, o.body).toBe(200)
    expect((await verzichten(token, '2026-10-02')).statusCode).toBe(410)
    const z = await owner.query(`SELECT ended_reason FROM terminal_self_session`)
    expect(z.rows).toEqual([{ ended_reason: 'job' }])
  })

  it('erreicht nur ein Geraet, und nur Zimmer seiner Haeuser', async () => {
    await einschalten()
    const fremd = await makeProperty(owner, { name: 'Fremdes Haus' })
    await openBusinessDay(owner, fremd.propertyId, TAG)
    const fk = await makeCategory(owner, fremd.propertyId)
    const [fz] = await makeResources(owner, fremd.propertyId, fk, 1)
    await aufenthalt(fz!, 'Fremd', '2026-09-30', '2026-10-04', 'InHouse',
                     fremd.propertyId, fk, fremd.accountId)
    await owner.query(
      `INSERT INTO property_terminal_self_setting (property_id, enabled) VALUES ($1, true)`,
      [fremd.propertyId])
    await owner.query(
      `INSERT INTO property_cleaning_waiver_setting (property_id, enabled) VALUES ($1, true)`,
      [fremd.propertyId])

    expect(await raeume()).toEqual([])
    expect((await antippen(fz!)).statusCode).toBe(404)
    // Eine Mitarbeitersitzung ist kein Geraet.
    const r = await app.inject({ method: 'GET', url: '/v1/terminal/self/rooms', headers: chef })
    expect([401, 403]).toContain(r.statusCode)
  })

  it('bestellt Kopfkissen aus dem Katalog: nur nach "Ja", nur kostenlos, Quelle terminal',
    async () => {
      await einschalten()
      const a = await aufenthalt(zimmer[0]!, 'Petersen', '2026-09-30', '2026-10-04')
      // Ein Extra mit Preis, am Terminal angehakt: bleibt trotzdem der Mappe.
      const art = await owner.query<{ id: number }>(
        `INSERT INTO product (property_id, code, name, price_cent, charge_mode)
         VALUES ($1, 'SEKT', 'Sekt', 2900, 'once') RETURNING id`, [fx.propertyId])
      const sekt = await owner.query<{ public_ref: string }>(
        `INSERT INTO guest_request_item (property_id, name, product_id, on_terminal)
         VALUES ($1, '{"de":"Sekt"}', $2, true) RETURNING public_ref`,
        [fx.propertyId, art.rows[0]!.id])

      const s = (await antippen(zimmer[0]!)).json<{ sessionRef: string }>().sessionRef
      const vorJa = await app.inject({ method: 'POST',
        url: `/v1/terminal/self/sessions/${s}/requests`, headers: geraet,
        payload: { itemRef: sekt.rows[0]!.public_ref, qty: 1 } })
      expect(vorJa.statusCode).toBe(409)

      const j = await antworten(s, true)
      const items = j.json<{ requests: { items: Array<{ itemRef: string; maxQty: number
                                                       name: Record<string, string> }> } }>()
        .requests.items
      // Der Startbestand vom ersten Einschalten, in allen Sprachen.
      expect(items.map(i => i.name.de)).toEqual(['Zusätzliches Kopfkissen',
                                                  'Kopfkissen ohne Federn'])
      expect(items.every(i => i.maxQty === 2 && Object.keys(i.name).length === 14)).toBe(true)

      const bestellen = (itemRef: string, qty: number) => app.inject({ method: 'POST',
        url: `/v1/terminal/self/sessions/${s}/requests`, headers: geraet,
        payload: { itemRef, qty } })
      const teuer = await bestellen(sekt.rows[0]!.public_ref, 1)
      expect(teuer.statusCode).toBe(422)
      expect(teuer.body).toContain('guestRequest.itemUnavailable')
      const zuviel = await bestellen(items[1]!.itemRef, 3)
      expect(zuviel.statusCode).toBe(422)
      expect(zuviel.body).toContain('guestRequest.qty')
      const ok = await bestellen(items[1]!.itemRef, 2)
      expect(ok.statusCode, ok.body).toBe(200)
      expect(ok.json<{ mine: Array<{ qty: number; status: string }> }>().mine)
        .toMatchObject([{ qty: 2, status: 'open' }])
      const w = await owner.query(
        `SELECT reservation_id::int, resource_id::int, source, wanted_for FROM guest_request`)
      expect(w.rows).toEqual([{ reservation_id: a.id, resource_id: zimmer[0],
                                source: 'terminal', wanted_for: null }])

      // Nach dem Ende der Sitzung nimmt die Route nichts mehr an.
      await app.inject({ method: 'POST', url: `/v1/terminal/self/sessions/${s}/end`,
        headers: geraet, payload: { reason: 'done' } })
      expect((await bestellen(items[0]!.itemRef, 1)).statusCode).toBe(409)
    })

  it('bietet sich ohne Verzicht an, wenn der Katalog etwas hat, und belegt ihn nur einmal vor',
    async () => {
      await aufenthalt(zimmer[0]!, 'Petersen', '2026-09-30', '2026-10-04')
      const schalten = (enabled: boolean) => app.inject({ method: 'PUT',
        url: `/v1/properties/${fx.propertyId}/terminal-self-service`, headers: chef,
        payload: { enabled } })
      const r = await schalten(true)
      expect(r.json()).toEqual({ enabled: true, cleaningWaiverEnabled: false, terminalItems: 2 })
      const ruhe = async () => (await app.inject({ method: 'GET', url: '/v1/terminal/idle',
        headers: geraet })).json<{ selfService: boolean
                                   selfServiceOffers: unknown; wifi: unknown }>()
      expect(await ruhe()).toMatchObject({ selfService: true,
        selfServiceOffers: { cleaning: false, requests: true }, wifi: null })
      expect(await raeume()).toHaveLength(1)

      // Aus und wieder an: kein zweiter Satz Kissen.
      await schalten(false)
      await schalten(true)
      expect((await owner.query(`SELECT count(*)::int AS n FROM guest_request_item`)).rows)
        .toEqual([{ n: 2 }])

      // Ohne Eintrag am Terminal und ohne Verzicht gibt es nichts zu bedienen.
      await owner.query(`UPDATE guest_request_item SET on_terminal = false`)
      expect(await ruhe()).toMatchObject({ selfService: false, selfServiceOffers: null })
      expect(await raeume()).toEqual([])
    })

  it('zeigt im Ruhezustand das WLAN des Hauses, auch ohne Selbstbedienung', async () => {
    await owner.query(
      `INSERT INTO guest_folder_setting (property_id, wifi_ssid, wifi_password)
       VALUES ($1, 'Seerobbe Gast', 'meerblick123')`, [fx.propertyId])
    const r = await app.inject({ method: 'GET', url: '/v1/terminal/idle', headers: geraet })
    expect(r.json()).toMatchObject({ selfService: false, wifi: { ssid: 'Seerobbe Gast',
      password: 'meerblick123', security: 'WPA', hidden: false } })
  })
})
