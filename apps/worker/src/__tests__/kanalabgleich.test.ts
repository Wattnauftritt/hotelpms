import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeReservation, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { DbContext, Pool } from '@hotelpms/db'
import { encryptSecret, AdapterError, CHANNEL_CREDENTIALS_PURPOSE,
         type AdapterBuchung, type AdapterVerfuegbarkeit, type AdapterZugang,
         type ChannelAdapter } from '@hotelpms/domain'
import { syncChannels, zeitraeume } from '../jobs/channelSync.js'

/*
 * Kanalabgleich gegen einen Channel Manager, den StayGrid selbst anspricht
 * (Migration 0198). Der Anbieter ist hier ein Adapter im Speicher -- kein
 * Mock der Datenbank: Zuordnung, Grenze, Probebetrieb und Buchungsabgleich
 * laufen gegen echtes PostgreSQL, und genau dort laege der Fehler, der still
 * eine Buchung doppelt anlegt oder ein Zimmer nie freigibt.
 */

const SECRET = 'test-schluessel-fuer-den-kanal-0123456789'
const HEUTE = '2026-11-01'

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext
let dz: number
let ez: number

class Anbieter implements ChannelAdapter {
  gesendet: AdapterVerfuegbarkeit[][] = []
  bestaetigt: string[] = []
  offen: AdapterBuchung[] = []
  zugaenge: AdapterZugang[] = []
  fehler: AdapterError | null = null
  gelesen = 0

  async pushAvailability(z: AdapterZugang, items: AdapterVerfuegbarkeit[]): Promise<void> {
    if (this.fehler !== null) throw this.fehler
    this.zugaenge.push(z)
    this.gesendet.push(items)
  }
  async fetchBookings(): Promise<AdapterBuchung[]> {
    return this.offen.filter(b => !this.bestaetigt.includes(b.revisionId))
  }
  async ackBooking(_z: AdapterZugang, revisionId: string): Promise<void> {
    this.bestaetigt.push(revisionId)
  }
  async peekBookings(): Promise<AdapterBuchung[]> {
    this.gelesen++
    return this.offen
  }
}

const fehlerProtokoll = { fehler: [] as unknown[], error(o: object) { this.fehler.push(o) } }
const lauf = (anbieter: ChannelAdapter, provider = 'channex') =>
  syncChannels(app, ctx, fx.propertyId,
    { adapters: { [provider]: anbieter }, secret: SECRET, log: fehlerProtokoll })

async function adapterAnlegen(
  opts: { mode?: 'shadow' | 'active'; provider?: string } = {}
): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `INSERT INTO channel_connection
       (property_id, account_id, provider, name, kind, sync_mode, credentials_enc,
        credentials_hint, external_property_id)
     VALUES ($1,$2,$3,'Test','adapter',$4,$5,'abc…xyz','HOTEL-1') RETURNING id`,
    [fx.propertyId, fx.accountId, opts.provider ?? 'channex', opts.mode ?? 'active',
     encryptSecret('geheimer-schluessel', SECRET, CHANNEL_CREDENTIALS_PURPOSE)])
  await owner.query(
    `INSERT INTO channel_room_map (property_id, connection_id, category_id, external_room_type)
     VALUES ($1,$2,$3,'DBL')`, [fx.propertyId, r.rows[0]!.id, dz])
  return r.rows[0]!.id
}

async function protokoll(id: number): Promise<Array<{ kind: string; mode: string
                                                         status: string; items: number
                                                         differences: number | null
                                                         error_key: string | null }>> {
  return (await owner.query(
    `SELECT kind, mode, status, items, differences, error_key FROM channel_sync_log
      WHERE connection_id = $1 ORDER BY id`, [id])).rows
}

/** Simuliert verstrichene Zeit: der Bestand ist eine Stunde alt, gesendet vor einer halben. */
async function eineStundeSpaeter(id: number): Promise<void> {
  await owner.query(
    `UPDATE inventory_day SET updated_at = now() - interval '1 hour' WHERE property_id = $1`,
    [fx.propertyId])
  await owner.query(
    `UPDATE channel_connection SET availability_sent_until = now() - interval '30 minutes'
      WHERE id = $1`, [id])
}

const buchung = (o: Partial<AdapterBuchung> = {}): AdapterBuchung => ({
  revisionId: 'rev-1', externalReference: 'cx-1', status: 'booked',
  segments: [{ roomType: 'DBL', arrival: '2026-11-10', departure: '2026-11-12', adults: 2 }],
  totalCent: 24_000, channelCode: 'Booking.com',
  guest: { lastName: 'Jansen', firstName: 'Femke' }, ...o })

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(5)
})
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fehlerProtokoll.fehler = []
  fx = await makeProperty(owner)
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
  dz = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  ez = await makeCategory(owner, fx.propertyId, { code: 'EZ', name: 'Einzelzimmer' })
  await makeResources(owner, fx.propertyId, dz, 2)
  await makeResources(owner, fx.propertyId, ez, 1, 'E')
  await openBusinessDay(owner, fx.propertyId, HEUTE)
  await owner.query(`SELECT inventory_materialize($1,'2026-10-01'::date,'2027-12-01'::date)`,
    [fx.propertyId])
})

describe('Zeitraeume', () => {
  it('fasst gleiche Tage je Zimmertyp zusammen, das Ende ausschliesslich', () => {
    expect(zeitraeume([
      { roomType: 'DBL', date: '2026-11-02', available: 1 },
      { roomType: 'DBL', date: '2026-11-01', available: 2 },
      { roomType: 'DBL', date: '2026-11-03', available: 1 },
      { roomType: 'SGL', date: '2026-11-01', available: 1 }
    ])).toEqual([
      { roomType: 'DBL', from: '2026-11-01', to: '2026-11-02', available: 2 },
      { roomType: 'DBL', from: '2026-11-02', to: '2026-11-04', available: 1 },
      { roomType: 'SGL', from: '2026-11-01', to: '2026-11-02', available: 1 }
    ])
  })
})

describe('Verfuegbarkeit', () => {
  it('sendet beim ersten Lauf ein Jahr, nur fuer zugeordnete Gruppen', async () => {
    const id = await adapterAnlegen()
    const a = new Anbieter()
    const r = await lauf(a)
    expect(r).toMatchObject({ connections: 1, days: 365, failed: 0 })
    // Zwei Doppelzimmer, ein Jahr lang frei: ein Zeitraum. Das Einzelzimmer
    // ist keinem Zimmertyp zugeordnet und geht nicht hinaus.
    expect(a.gesendet).toEqual([[
      { roomType: 'DBL', from: HEUTE, to: '2027-11-01', available: 2 }]])
    expect(a.zugaenge[0]).toEqual({ externalPropertyId: 'HOTEL-1',
                                    credentials: 'geheimer-schluessel' })
    expect(await protokoll(id)).toEqual([expect.objectContaining(
      { kind: 'full', mode: 'active', status: 'ok', items: 365 })])
  })

  it('sendet danach nur, was sich geaendert hat', async () => {
    const id = await adapterAnlegen()
    const a = new Anbieter()
    await lauf(a)
    await eineStundeSpaeter(id)
    expect((await lauf(a)).days).toBe(0)

    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
                                   arrival: '2026-11-10', departure: '2026-11-12' })
    const r = await lauf(a)
    expect(r.days).toBe(2)
    expect(a.gesendet.at(-1)).toEqual([
      { roomType: 'DBL', from: '2026-11-10', to: '2026-11-12', available: 1 }])
  })

  it('sendet im Probebetrieb nichts und schreibt nur ins Protokoll', async () => {
    const id = await adapterAnlegen({ mode: 'shadow' })
    const a = new Anbieter()
    expect((await lauf(a)).days).toBe(365)
    expect(a.gesendet).toEqual([])
    // Dazu der Buchungsvergleich, der im Probebetrieb mitlaeuft.
    expect(await protokoll(id)).toEqual([
      expect.objectContaining({ kind: 'full', mode: 'shadow', status: 'ok', items: 365 }),
      expect.objectContaining({ kind: 'bookings', mode: 'shadow', status: 'ok', items: 0,
                                differences: 0 })])
  })

  it('sendet nach einer neuen Zuordnung den ganzen Bestand neu', async () => {
    const id = await adapterAnlegen()
    const a = new Anbieter()
    await lauf(a)
    await eineStundeSpaeter(id)
    await owner.query(
      `INSERT INTO channel_room_map (property_id, connection_id, category_id, external_room_type)
       VALUES ($1,$2,$3,'SGL')`, [fx.propertyId, id, ez])
    await owner.query(`UPDATE channel_connection SET full_sync_requested_at = now() WHERE id = $1`,
      [id])
    expect((await lauf(a)).days).toBe(730)
    const c = await owner.query(
      `SELECT full_sync_requested_at FROM channel_connection WHERE id = $1`, [id])
    expect(c.rows[0].full_sync_requested_at).toBeNull()
  })

  it('vermerkt einen Fehler des Anbieters einmal, nicht bei jedem Lauf', async () => {
    const id = await adapterAnlegen()
    const a = new Anbieter()
    a.fehler = new AdapterError('channel.providerUnavailable')
    expect((await lauf(a)).failed).toBe(1)
    expect((await lauf(a)).failed).toBe(1)
    expect((await protokoll(id)).map(z => z.error_key)).toEqual(['channel.providerUnavailable'])

    // Kein Gesendet-Stand: der naechste erfolgreiche Lauf sendet alles.
    a.fehler = null
    expect((await lauf(a)).days).toBe(365)
    const c = await owner.query(`SELECT last_error_key FROM channel_connection WHERE id = $1`, [id])
    expect(c.rows[0].last_error_key).toBeNull()
  })

  it('meldet einen Anbieter ohne Adapter, statt still nichts zu tun', async () => {
    const id = await adapterAnlegen({ provider: 'roomcloud' })
    const r = await lauf(new Anbieter(), 'channex')
    expect(r.failed).toBe(1)
    expect((await protokoll(id)).map(z => z.error_key)).toEqual(['channel.adapterMissing'])
  })

  it('sendet aus einem Uebungshaus nichts', async () => {
    await adapterAnlegen()
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])
    const a = new Anbieter()
    expect(await lauf(a)).toMatchObject({ connections: 0, days: 0 })
    expect(a.gesendet).toEqual([])
  })
})

describe('Buchungen', () => {
  it('legt eine abgeholte Buchung an und bestaetigt sie erst danach', async () => {
    const id = await adapterAnlegen()
    const a = new Anbieter()
    a.offen = [buchung()]
    const r = await lauf(a)
    expect(r.bookings).toBe(1)
    expect(a.bestaetigt).toEqual(['rev-1'])

    const b = await owner.query(
      `SELECT b.channel_code, b.channel_connection_id, b.channel_owner, r.category_id,
              r.arrival::text, r.departure::text, r.adults,
              (SELECT sum(price_cent) FROM reservation_night n WHERE n.reservation_id = r.id) AS summe
         FROM booking b JOIN reservation r ON r.booking_id = b.id
        WHERE b.external_reference = 'cx-1'`)
    expect(b.rows).toEqual([{ channel_code: 'Booking.com', channel_connection_id: id,
      channel_owner: 'source', category_id: dz, arrival: '2026-11-10',
      departure: '2026-11-12', adults: 2, summe: '24000' }])
    const rev = await owner.query(`SELECT outcome, acknowledged FROM channel_booking_revision`)
    expect(rev.rows).toEqual([{ outcome: 'created', acknowledged: true }])
  })

  it('legt eine erneut gelieferte Revision nicht doppelt an', async () => {
    await adapterAnlegen()
    const a = new Anbieter()
    a.offen = [buchung()]
    await lauf(a)
    // Die Bestaetigung ging verloren: der Anbieter liefert dieselbe Revision.
    a.bestaetigt = []
    await lauf(a)
    expect(a.bestaetigt).toEqual(['rev-1'])
    const n = await owner.query(`SELECT count(*)::int AS n FROM reservation`)
    expect(n.rows[0].n).toBe(1)
  })

  it('storniert ueber eine spaetere Revision', async () => {
    await adapterAnlegen()
    const a = new Anbieter()
    a.offen = [buchung()]
    await lauf(a)
    a.offen.push(buchung({ revisionId: 'rev-2', status: 'cancelled', segments: [] }))
    await lauf(a)
    const r = await owner.query(`SELECT status FROM reservation`)
    expect(r.rows).toEqual([{ status: 'Canceled' }])
    const inv = await owner.query(
      `SELECT sold FROM inventory_day WHERE property_id = $1 AND category_id = $2
          AND date = '2026-11-10'`, [fx.propertyId, dz])
    expect(inv.rows[0].sold).toBe(0)
  })

  it('bestaetigt eine Buchung ohne zugeordneten Zimmertyp nicht', async () => {
    const id = await adapterAnlegen()
    const a = new Anbieter()
    a.offen = [buchung({ segments: [{ roomType: 'SGL', arrival: '2026-11-10',
                                      departure: '2026-11-11' }] })]
    await lauf(a)
    expect(a.bestaetigt).toEqual([])
    expect((await protokoll(id)).at(-1)).toMatchObject(
      { kind: 'bookings', status: 'failed', error_key: 'channel.unmappedRoomType' })

    // Wer den Zimmertyp zuordnet, bekommt die Buchung im naechsten Lauf.
    await owner.query(
      `INSERT INTO channel_room_map (property_id, connection_id, category_id, external_room_type)
       VALUES ($1,$2,$3,'SGL')`, [fx.propertyId, id, ez])
    await lauf(a)
    expect(a.bestaetigt).toEqual(['rev-1'])
  })

  it('aendert eine Buchung nicht mehr, die die Rezeption umgebucht hat', async () => {
    await adapterAnlegen()
    const a = new Anbieter()
    a.offen = [buchung()]
    await lauf(a)
    await owner.query(`UPDATE booking SET channel_owner = 'local' WHERE external_reference = 'cx-1'`)
    a.offen.push(buchung({ revisionId: 'rev-2',
      segments: [{ roomType: 'DBL', arrival: '2026-11-10', departure: '2026-11-14' }] }))
    await lauf(a)
    const r = await owner.query(`SELECT departure::text FROM reservation`)
    expect(r.rows).toEqual([{ departure: '2026-11-12' }])
    const rev = await owner.query(
      `SELECT outcome FROM channel_booking_revision WHERE external_revision_id = 'rev-2'`)
    expect(rev.rows[0].outcome).toBe('kept_local')
  })

  it('vergleicht im Probebetrieb nur und bestaetigt nichts', async () => {
    const id = await adapterAnlegen({ mode: 'shadow' })
    // StayGrid kennt cx-1 schon (etwa ueber das Adminpanel), cx-2 nicht.
    const vorhanden = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: '2026-11-10', departure: '2026-11-12' })
    await owner.query(`UPDATE booking SET external_reference = 'cx-1' WHERE id = $1`,
      [vorhanden.bookingId])
    const a = new Anbieter()
    a.offen = [buchung(), buchung({ revisionId: 'rev-9', externalReference: 'cx-2' })]
    await lauf(a)
    expect(a.bestaetigt).toEqual([])
    expect(a.gelesen).toBe(1)
    const n = await owner.query(`SELECT count(*)::int AS n FROM booking`)
    expect(n.rows[0].n).toBe(1)
    expect((await protokoll(id)).at(-1)).toMatchObject(
      { kind: 'bookings', mode: 'shadow', items: 2, differences: 1 })

    // Ohne Bestaetigung kaeme jede Minute dieselbe Liste: erst nach einer
    // Viertelstunde wird wieder verglichen.
    await lauf(a)
    expect(a.gelesen).toBe(1)
  })
})
