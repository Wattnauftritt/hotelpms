import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/*
 * Kanalbuchungen aus einem fuehrenden Umsystem (Migration 0092): das
 * Adminpanel pusht das Gaestehaus, StayGrid gleicht ab. Geprueft wird, was
 * im Betrieb still schiefginge: doppelte Reservierungen, ein Zaehler, der
 * nach dem Umziehen nicht mehr stimmt, und ein Push, der eine Aenderung der
 * Rezeption ueberschreibt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let admin: { userId: number; sessionId: string }
let schluessel = 0

const session = () => ({ cookie: `hp_session=${admin.sessionId}` })

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
  catId = await makeCategory(owner, fx.propertyId, { code: 'GH' })
  await makeResources(owner, fx.propertyId, catId, 2, '6')   // 6101, 6102
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
    [fx.propertyId])
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
})

async function zugang(provider = 'generic'): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: `/v1/properties/${fx.propertyId}/channel-connections`,
    headers: session(), payload: { provider, name: 'Adminpanel' } })
  expect(r.statusCode).toBe(201)
  return (JSON.parse(r.body) as { token: string }).token
}

const put = (token: string, ref: string, payload: unknown) => app.inject({
  method: 'PUT', url: `/v1/channel/ari/bookings/${ref}`,
  headers: { authorization: `Bearer ${token}` }, payload })
const cancel = (token: string, ref: string, payload: unknown = {}) => app.inject({
  method: 'POST', url: `/v1/channel/ari/bookings/${ref}/cancel`,
  headers: { authorization: `Bearer ${token}` }, payload })

interface Antwort {
  status: string
  bookingRef: string
  sourceChanged?: boolean
  reservations?: Array<{ reservationRef: string; roomCode: string; arrival: string
                         departure: string; conflict: string | null }>
}

async function verkauft(von: string, bis: string): Promise<number[]> {
  const { rows } = await owner.query<{ sold: number }>(
    `SELECT sold FROM inventory_day
      WHERE property_id = $1 AND category_id = $2 AND date >= $3 AND date < $4
      ORDER BY date`, [fx.propertyId, catId, von, bis])
  return rows.map(r => r.sold)
}

async function reservierungen(bookingRef: string): Promise<Array<{
  public_ref: string; status: string; arrival: string; departure: string; code: string | null
  total: number }>> {
  const { rows } = await owner.query(
    `SELECT r.public_ref, r.status::text, r.arrival::text, r.departure::text, u.code,
            (SELECT COALESCE(sum(price_cent),0)::int FROM reservation_night
              WHERE reservation_id = r.id) AS total
       FROM reservation r JOIN booking b ON b.id = r.booking_id
       LEFT JOIN resource u ON u.id = r.resource_id
      WHERE b.public_ref = $1 ORDER BY r.arrival, r.id`, [bookingRef])
  return rows
}

const ZWEI_ABSCHNITTE = {
  segments: [
    { roomCode: '6101', arrival: '2026-11-02', departure: '2026-11-04', adults: 2 },
    { roomCode: '6102', arrival: '2026-11-04', departure: '2026-11-06', adults: 2 }
  ],
  totalCent: 40_001,
  channelCode: 'Booking.com',
  guest: { firstName: 'Erika', lastName: 'Muster' },
  sourceUpdatedAt: '2026-10-05T10:00:00Z'
}

describe('Anlegen und Abgleichen', () => {
  it('legt eine Buchung mit Zimmerwechsel als zwei Reservierungen an', async () => {
    const token = await zugang()
    const r = await put(token, 'rc-1', ZWEI_ABSCHNITTE)
    expect(r.statusCode).toBe(201)
    const a = JSON.parse(r.body) as Antwort
    expect(a.status).toBe('created')
    expect(a.reservations!.map(x => x.roomCode)).toEqual(['6101', '6102'])
    expect(a.reservations!.every(x => x.conflict === null)).toBe(true)

    const rs = await reservierungen(a.bookingRef)
    expect(rs.map(x => [x.code, x.arrival, x.departure, x.status])).toEqual([
      ['6101', '2026-11-02', '2026-11-04', 'Confirmed'],
      ['6102', '2026-11-04', '2026-11-06', 'Confirmed']])
    // Der Gesamtpreis auf die vier Naechte, auf den Cent.
    expect(rs.reduce((s, x) => s + x.total, 0)).toBe(40_001)
    expect(await verkauft('2026-11-01', '2026-11-07')).toEqual([0, 1, 1, 1, 1, 0])

    const b = await owner.query(`SELECT channel_code, channel_owner FROM booking
                                  WHERE public_ref = $1`, [a.bookingRef])
    expect(b.rows[0]).toEqual({ channel_code: 'Booking.com', channel_owner: 'source' })
  })

  it('tut beim selben Stand nichts', async () => {
    const token = await zugang()
    const a = JSON.parse((await put(token, 'rc-1', ZWEI_ABSCHNITTE)).body) as Antwort
    const zweit = await put(token, 'rc-1', ZWEI_ABSCHNITTE)
    expect(zweit.statusCode).toBe(200)
    expect((JSON.parse(zweit.body) as Antwort).status).toBe('unchanged')
    expect(await reservierungen(a.bookingRef)).toHaveLength(2)
    expect(await verkauft('2026-11-01', '2026-11-07')).toEqual([0, 1, 1, 1, 1, 0])
  })

  it('zieht um und verlaengert, ohne die Nummern zu wechseln, und der Zaehler stimmt', async () => {
    const token = await zugang()
    const a = JSON.parse((await put(token, 'rc-1', ZWEI_ABSCHNITTE)).body) as Antwort
    const vorher = await reservierungen(a.bookingRef)

    // Das Adminpanel hat umoptimiert: alles in 6102, eine Nacht laenger.
    const r = await put(token, 'rc-1', {
      ...ZWEI_ABSCHNITTE,
      segments: [{ roomCode: '6102', arrival: '2026-11-02', departure: '2026-11-07', adults: 2 }],
      sourceUpdatedAt: '2026-10-05T11:00:00Z'
    })
    expect(r.statusCode).toBe(200)
    expect((JSON.parse(r.body) as Antwort).status).toBe('updated')

    const nachher = await reservierungen(a.bookingRef)
    const lebend = nachher.filter(x => x.status === 'Confirmed')
    expect(lebend).toHaveLength(1)
    expect(lebend[0]!.code).toBe('6102')
    expect([lebend[0]!.arrival, lebend[0]!.departure]).toEqual(['2026-11-02', '2026-11-07'])
    // Behalten wurde die Reservierung, die schon in 6102 lag.
    expect(lebend[0]!.public_ref).toBe(vorher[1]!.public_ref)
    expect(nachher.find(x => x.public_ref === vorher[0]!.public_ref)!.status).toBe('Canceled')
    expect(lebend[0]!.total).toBe(40_001)
    expect(await verkauft('2026-11-01', '2026-11-08')).toEqual([0, 1, 1, 1, 1, 1, 0])
  })

  it('nimmt eine Buchung auch an, wenn das Zimmer belegt ist, und vermerkt den Konflikt', async () => {
    const token = await zugang()
    const direkt = await app.inject({ method: 'POST', url: '/v1/bookings',
      headers: { ...session(), 'idempotency-key': `k-${++schluessel}` },
      payload: { propertyId: fx.propertyId, categoryId: catId,
                 arrival: '2026-11-02', departure: '2026-11-04',
                 resourceId: (await owner.query<{ id: number }>(
                   `SELECT id FROM resource WHERE code = '6101'`)).rows[0]!.id } })
    expect(direkt.statusCode).toBe(201)

    const r = await put(token, 'rc-2', {
      segments: [{ roomCode: '6101', arrival: '2026-11-03', departure: '2026-11-05' }] })
    expect(r.statusCode).toBe(201)
    expect((JSON.parse(r.body) as Antwort).reservations![0]!.conflict).toBe('room')

    // Nicht unter dem anderen Balken, sondern in der Ablage (Sven, 10.10.2026),
    // mit dem gewollten Zimmer vermerkt.
    const zeile = await owner.query<{ resource_id: number | null; wanted: string | null }>(
      `SELECT r.resource_id, z.code AS wanted FROM reservation r
         JOIN booking b ON b.id = r.booking_id
         LEFT JOIN resource z ON z.id = r.channel_wanted_resource_id
        WHERE b.external_reference = 'rc-2'`)
    expect(zeile.rows[0]).toEqual({ resource_id: null, wanted: '6101' })
  })

  it('legt eine wartende Buchung in ihr Zimmer, sobald ein Push es frei macht', async () => {
    const token = await zugang()
    await put(token, 'rc-1', {
      segments: [{ roomCode: '6101', arrival: '2026-11-02', departure: '2026-11-04' }] })
    // Das Umsystem sortiert um: rc-2 will 6101, bevor rc-1 dort ausgezogen ist.
    const zwei = await put(token, 'rc-2', {
      segments: [{ roomCode: '6101', arrival: '2026-11-02', departure: '2026-11-04' }] })
    expect((JSON.parse(zwei.body) as Antwort).reservations![0]!.conflict).toBe('room')
    await put(token, 'rc-1', {
      segments: [{ roomCode: '6102', arrival: '2026-11-02', departure: '2026-11-04' }] })

    const zeilen = await owner.query<{ ref: string; code: string | null
                                       konflikt: string | null }>(
      `SELECT b.external_reference AS ref, z.code, r.channel_conflict AS konflikt
         FROM reservation r JOIN booking b ON b.id = r.booking_id
         LEFT JOIN resource z ON z.id = r.resource_id
        WHERE r.status = 'Confirmed' ORDER BY b.external_reference`)
    expect(zeilen.rows).toEqual([
      { ref: 'rc-1', code: '6102', konflikt: null },
      { ref: 'rc-2', code: '6101', konflikt: null }])
    expect(await verkauft('2026-11-02', '2026-11-04')).toEqual([2, 2])
  })

  it('nimmt eine Buchung an, wenn die Gruppe voll ist', async () => {
    const token = await zugang()
    await put(token, 'rc-1', { segments: [
      { roomCode: '6101', arrival: '2026-11-02', departure: '2026-11-03' },
      { roomCode: '6102', arrival: '2026-11-02', departure: '2026-11-03' }] })
    const r = await put(token, 'gh-7', { segments: [
      { roomCode: '6101', arrival: '2026-11-02', departure: '2026-11-03' }] })
    expect(r.statusCode).toBe(201)
    expect((JSON.parse(r.body) as Antwort).reservations![0]!.conflict).not.toBeNull()
    expect(await verkauft('2026-11-02', '2026-11-03')).toEqual([3])
  })

  it('ignoriert einen aelteren Stand', async () => {
    const token = await zugang()
    await put(token, 'rc-1', ZWEI_ABSCHNITTE)
    const r = await put(token, 'rc-1', {
      ...ZWEI_ABSCHNITTE, totalCent: 1, sourceUpdatedAt: '2026-10-05T09:00:00Z' })
    expect((JSON.parse(r.body) as Antwort).status).toBe('stale')
  })

  it('weist ein unbekanntes Zimmer ab', async () => {
    const token = await zugang()
    const r = await put(token, 'rc-1', {
      segments: [{ roomCode: '999', arrival: '2026-11-02', departure: '2026-11-03' }] })
    expect(r.statusCode).toBe(422)
  })

  it('aendert keine Buchung, die ein anderer Zugang angelegt hat', async () => {
    const roomcloud = await zugang('roomcloud')
    const fremd = await app.inject({ method: 'POST', url: '/v1/channel/ari/bookings',
      headers: { authorization: `Bearer ${roomcloud}` },
      payload: { externalReference: 'rc-1', categoryCode: 'GH',
                 arrival: '2026-11-02', departure: '2026-11-03' } })
    expect(fremd.statusCode).toBe(201)
    const token = await zugang()
    const r = await put(token, 'rc-1', ZWEI_ABSCHNITTE)
    expect(r.statusCode).toBe(409)
  })
})

describe('Stornieren', () => {
  it('storniert, gibt frei und ist wiederholbar; ein spaeterer PUT belebt wieder', async () => {
    const token = await zugang()
    const a = JSON.parse((await put(token, 'rc-1', ZWEI_ABSCHNITTE)).body) as Antwort

    const c = await cancel(token, 'rc-1')
    expect(c.statusCode).toBe(200)
    expect((JSON.parse(c.body) as Antwort).status).toBe('canceled')
    expect(await verkauft('2026-11-01', '2026-11-07')).toEqual([0, 0, 0, 0, 0, 0])
    expect((JSON.parse((await cancel(token, 'rc-1')).body) as Antwort).status)
      .toBe('already_canceled')

    const wieder = await put(token, 'rc-1', { ...ZWEI_ABSCHNITTE,
      sourceUpdatedAt: '2026-10-05T12:00:00Z' })
    expect((JSON.parse(wieder.body) as Antwort).status).toBe('updated')
    const lebend = (await reservierungen(a.bookingRef)).filter(x => x.status === 'Confirmed')
    expect(lebend).toHaveLength(2)
    expect(await verkauft('2026-11-01', '2026-11-07')).toEqual([0, 1, 1, 1, 1, 0])
  })

  it('kennt eine unbekannte Nummer nicht', async () => {
    const token = await zugang()
    expect((await cancel(token, 'rc-404')).statusCode).toBe(404)
  })
})

describe('Aenderung an der Rezeption', () => {
  it('macht die Buchung lokal; danach aendert der Push nichts und meldet die Abweichung', async () => {
    const token = await zugang()
    const a = JSON.parse((await put(token, 'rc-1', ZWEI_ABSCHNITTE)).body) as Antwort
    const erste = a.reservations![0]!.reservationRef

    // Die Rezeption verlaengert den ersten Abschnitt um eine Nacht davor.
    const z = await app.inject({ method: 'POST',
      url: `/v1/reservations/${erste}/change-stay`, headers: session(),
      payload: { arrival: '2026-11-01' } })
    expect(z.statusCode).toBe(200)

    const liste = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/reservations`, headers: session() })
    const zeilen = (JSON.parse(liste.body) as { reservations: Array<{
      reservationRef: string; channelOwner: string | null; externalReference: string }> })
      .reservations
    expect(zeilen.filter(x => x.externalReference === 'rc-1')
      .every(x => x.channelOwner === 'local')).toBe(true)

    const r = await put(token, 'rc-1', { ...ZWEI_ABSCHNITTE, totalCent: 50_000,
      sourceUpdatedAt: '2026-10-05T13:00:00Z' })
    const antwort = JSON.parse(r.body) as Antwort
    expect(antwort.status).toBe('kept_local')
    expect(antwort.sourceChanged).toBe(true)
    const rs = await reservierungen(a.bookingRef)
    expect(rs.find(x => x.public_ref === erste)!.arrival).toBe('2026-11-01')

    const c = await cancel(token, 'rc-1')
    expect((JSON.parse(c.body) as Antwort).status).toBe('kept_local')
    expect((await reservierungen(a.bookingRef)).every(x => x.status === 'Confirmed')).toBe(true)

    const d = await app.inject({ method: 'GET', url: `/v1/reservations/${erste}`,
      headers: session() })
    const detail = JSON.parse(d.body) as { channelOwner: string; sourceChangedAt: string | null
                                           sourceCanceledAt: string | null }
    expect(detail.channelOwner).toBe('local')
    expect(detail.sourceChangedAt).not.toBeNull()
    expect(detail.sourceCanceledAt).not.toBeNull()
  })

  it('aendert und storniert nichts mehr, sobald der Gast angereist ist', async () => {
    const token = await zugang()
    const a = JSON.parse((await put(token, 'rc-1', ZWEI_ABSCHNITTE)).body) as Antwort
    const erste = a.reservations![0]!.reservationRef
    // Wie der Nachtlauf seit 0088: angereist, ohne die Belegung zu aendern.
    await owner.query(`UPDATE reservation SET status = 'InHouse', checked_in_at = now()
                        WHERE public_ref = $1`, [erste])

    const r = await put(token, 'rc-1', { ...ZWEI_ABSCHNITTE, totalCent: 1,
      sourceUpdatedAt: '2026-10-05T14:00:00Z' })
    const antwort = JSON.parse(r.body) as Antwort
    expect(antwort.status).toBe('kept_checked_in')
    expect(antwort.sourceChanged).toBe(true)
    expect((await reservierungen(a.bookingRef)).reduce((s, x) => s + x.total, 0)).toBe(40_001)

    const c = await cancel(token, 'rc-1')
    expect((JSON.parse(c.body) as Antwort).status).toBe('kept_checked_in')
    expect((await reservierungen(a.bookingRef)).map(x => x.status))
      .toEqual(['InHouse', 'Confirmed'])
    expect(await verkauft('2026-11-01', '2026-11-07')).toEqual([0, 1, 1, 1, 1, 0])

    const d = await app.inject({ method: 'GET', url: `/v1/reservations/${erste}`,
      headers: session() })
    const detail = JSON.parse(d.body) as { channelOwner: string; sourceCanceledAt: string | null }
    expect(detail.channelOwner).toBe('source')
    expect(detail.sourceCanceledAt).not.toBeNull()
  })

  it('macht die Buchung lokal, wenn die Rezeption die Personenzahl aendert', async () => {
    // Sonst ueberschriebe der naechste Push die Zahl still (0093).
    const token = await zugang()
    const a = JSON.parse((await put(token, 'rc-1', ZWEI_ABSCHNITTE)).body) as Antwort
    const p = await app.inject({ method: 'PATCH',
      url: `/v1/reservations/${a.reservations![0]!.reservationRef}`, headers: session(),
      payload: { adults: 3 } })
    expect(p.statusCode, p.body).toBe(200)
    const b = await owner.query(`SELECT channel_owner FROM booking WHERE public_ref = $1`,
      [a.bookingRef])
    expect(b.rows[0]!.channel_owner).toBe('local')
  })

  it('laesst die Buchung beim Umsystem, wenn sich nur die Notiz aendert', async () => {
    const token = await zugang()
    const a = JSON.parse((await put(token, 'rc-1', ZWEI_ABSCHNITTE)).body) as Antwort
    await owner.query(`UPDATE reservation SET notes = 'Spaeter Check-in'
                        WHERE public_ref = $1`, [a.reservations![0]!.reservationRef])
    const b = await owner.query(`SELECT channel_owner FROM booking WHERE public_ref = $1`,
      [a.bookingRef])
    expect(b.rows[0]!.channel_owner).toBe('source')
  })
})

/*
 * StayGrid vergibt die Zimmer im Gaestehaus (Sven, 07.10.2026, Thread
 * "Zimmer-Sortierung"). Der Schalter ist der Modus des Hauses: auf
 * "automatisch" gilt ein mitgeschicktes Zimmer nicht mehr, und am Ende jedes
 * Pushes sortiert StayGrid -- ohne die Buchung dem Umsystem wegzunehmen.
 */
describe('StayGrid vergibt die Zimmer', () => {
  async function automatisch(): Promise<void> {
    await openBusinessDay(owner, fx.propertyId, '2026-10-10')
    await owner.query(`UPDATE resource SET quality = CASE code WHEN '6102' THEN 90 ELSE 40 END
                        WHERE property_id = $1`, [fx.propertyId])
    await owner.query(`INSERT INTO room_sort_setting (property_id, mode) VALUES ($1, 'auto')`,
      [fx.propertyId])
  }
  async function lage(): Promise<Record<string, string | null>> {
    const { rows } = await owner.query<{ ref: string; code: string | null }>(
      `SELECT b.external_reference AS ref, z.code FROM reservation r
         JOIN booking b ON b.id = r.booking_id
         LEFT JOIN resource z ON z.id = r.resource_id
        WHERE r.status = 'Confirmed' ORDER BY b.external_reference`)
    return Object.fromEntries(rows.map(r => [r.ref, r.code]))
  }

  it('gibt einer Buchung ohne Zimmer eines und den laengsten Gast ins schoenste', async () => {
    await automatisch()
    const token = await zugang()
    const kurz = await put(token, 'rc-kurz', {
      segments: [{ arrival: '2026-11-02', departure: '2026-11-03' }] })
    expect(kurz.statusCode).toBe(201)
    expect((JSON.parse(kurz.body) as Antwort).reservations![0]!.roomCode).toBe('6102')

    const lang = await put(token, 'rc-lang', {
      segments: [{ arrival: '2026-11-02', departure: '2026-11-09' }] })
    expect((JSON.parse(lang.body) as Antwort).reservations![0]!.roomCode).toBe('6102')
    expect(await lage()).toEqual({ 'rc-kurz': '6101', 'rc-lang': '6102' })

    // Der Zug gehoert dem Sortierer, nicht der Rezeption: beide Buchungen
    // nehmen weiter Aenderungen und Stornos aus RoomCloud an.
    const owners = await owner.query<{ channel_owner: string }>(
      `SELECT DISTINCT channel_owner FROM booking WHERE property_id = $1`, [fx.propertyId])
    expect(owners.rows).toEqual([{ channel_owner: 'source' }])
    const laeufe = await owner.query<{ trigger: string }>(
      `SELECT trigger FROM room_sort_run WHERE property_id = $1`, [fx.propertyId])
    expect(laeufe.rows.map(r => r.trigger)).toContain('auto')
  })

  it('folgt nicht mehr dem Zimmer, das die Quelle mitschickt', async () => {
    await automatisch()
    const token = await zugang()
    await put(token, 'rc-1', {
      segments: [{ roomCode: '6101', arrival: '2026-11-02', departure: '2026-11-05' }] })
    expect(await lage()).toEqual({ 'rc-1': '6102' })
  })

  it('behaelt das Zimmer, wenn die Quelle nur verlaengert', async () => {
    await automatisch()
    const token = await zugang()
    const a = JSON.parse((await put(token, 'rc-1', {
      segments: [{ arrival: '2026-11-02', departure: '2026-11-04' }] })).body) as Antwort
    const b = JSON.parse((await put(token, 'rc-1', {
      segments: [{ arrival: '2026-11-02', departure: '2026-11-06' }] })).body) as Antwort
    expect(b.reservations![0]!.reservationRef).toBe(a.reservations![0]!.reservationRef)
    expect(b.reservations![0]!.roomCode).toBe('6102')
    expect(await verkauft('2026-11-01', '2026-11-07')).toEqual([0, 1, 1, 1, 1, 0])
  })

  it('legt eine Buchung ohne Zimmer in die Ablage, solange das Haus nicht selbst vergibt', async () => {
    const token = await zugang()
    const r = await put(token, 'rc-1', {
      segments: [{ arrival: '2026-11-02', departure: '2026-11-04' }] })
    expect(r.statusCode).toBe(201)
    expect((JSON.parse(r.body) as Antwort).reservations![0]!.roomCode).toBeNull()
    expect(await lage()).toEqual({ 'rc-1': null })
    expect(await verkauft('2026-11-02', '2026-11-04')).toEqual([1, 1])
  })

  it('verlangt die Gruppe, wenn das Haus mehrere hat', async () => {
    await makeCategory(owner, fx.propertyId, { code: 'FW' })
    const token = await zugang()
    const ohne = await put(token, 'rc-1', {
      segments: [{ arrival: '2026-11-02', departure: '2026-11-04' }] })
    expect(ohne.statusCode).toBe(422)
    const mit = await put(token, 'rc-1', {
      segments: [{ categoryCode: 'GH', arrival: '2026-11-02', departure: '2026-11-04' }] })
    expect(mit.statusCode).toBe(201)
    const unbekannt = await put(token, 'rc-2', {
      segments: [{ categoryCode: 'XX', arrival: '2026-11-02', departure: '2026-11-04' }] })
    expect(unbekannt.statusCode).toBe(422)
  })
})
