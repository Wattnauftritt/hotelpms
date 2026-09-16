import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Gruppenbuchung: **eine** Buchung, mehrere Zimmer.
 *
 * Der Belegungsplan laesst mehrere Zimmerzeilen zugleich markieren, und was
 * dabei herauskommt, ist genau das, was das Datenmodell seit Anfang vorsieht
 * -- eine `booking` mit mehreren `reservation`. Der Unterschied zu acht
 * einzelnen Buchungen ist nicht kosmetisch: die Gruppe hat einen Besteller
 * und eine Rechnung, und acht lose Vorgaenge verbindet spaeter nichts mehr.
 *
 * Geprueft wird vor allem, was dabei still schiefgehen kann: ein Zimmer
 * doppelt in der Auswahl, ein belegtes Zimmer mitten in der Gruppe, der
 * Besteller als Mitreisender in jedem Zimmer.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let dz: number
let suite: number
let dzZimmer: number[]
let suiteZimmer: number[]
let auth: Record<string, string>

const VON = '2026-10-01'
const BIS = '2026-10-04'

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
  fx = await makeProperty(owner)
  dz = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  suite = await makeCategory(owner, fx.propertyId, { code: 'SUI' })
  dzZimmer = await makeResources(owner, fx.propertyId, dz, 6, 'D')
  suiteZimmer = await makeResources(owner, fx.propertyId, suite, 2, 'S')
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

let schluessel = 0
const buchen = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...auth, 'idempotency-key': `k-${++schluessel}` },
    payload: { propertyId: fx.propertyId, arrival: VON, departure: BIS, ...payload } })

const zimmerListe = (ids: number[], categoryId: number) =>
  ids.map(id => ({ categoryId, resourceId: id }))

async function bestand(categoryId: number, datum = VON): Promise<number> {
  const r = await owner.query<{ sold: number }>(
    `SELECT sold FROM inventory_day
      WHERE property_id = $1 AND category_id = $2 AND date = $3`,
    [fx.propertyId, categoryId, datum])
  return r.rows[0]!.sold
}

async function anzahlBuchungen(): Promise<{ buchungen: number; reservierungen: number }> {
  const b = await owner.query(`SELECT 1 FROM booking WHERE property_id = $1`, [fx.propertyId])
  const r = await owner.query(`SELECT 1 FROM reservation WHERE property_id = $1`, [fx.propertyId])
  return { buchungen: b.rowCount ?? 0, reservierungen: r.rowCount ?? 0 }
}

describe('Mehrere Zimmer in einer Buchung', () => {
  it('legt eine Buchung mit einer Reservierung je Zimmer an', async () => {
    const r = await buchen({ rooms: zimmerListe(dzZimmer.slice(0, 3), dz) })
    expect(r.statusCode, r.body).toBe(201)
    const body = JSON.parse(r.body) as {
      bookingRef: string; reservationRef: string
      reservations: Array<{ reservationRef: string; resourceId: number | null }>
    }

    expect(body.reservations).toHaveLength(3)
    expect(body.reservations.map(x => x.resourceId)).toEqual(dzZimmer.slice(0, 3))
    // Die erste Referenz bleibt oben stehen: jeder bestehende Aufrufer liest sie.
    expect(body.reservationRef).toBe(body.reservations[0]!.reservationRef)

    expect(await anzahlBuchungen()).toEqual({ buchungen: 1, reservierungen: 3 })

    // Eine Buchung, nicht drei: daran haengt die Gruppe zusammen.
    const gemeinsam = await owner.query<{ n: number }>(
      `SELECT count(DISTINCT booking_id)::int AS n FROM reservation WHERE property_id = $1`,
      [fx.propertyId])
    expect(gemeinsam.rows[0]!.n).toBe(1)
  })

  it('bindet so viel Bestand, wie Zimmer gebucht wurden', async () => {
    expect(await bestand(dz)).toBe(0)
    await buchen({ rooms: zimmerListe(dzZimmer.slice(0, 4), dz) })
    expect(await bestand(dz)).toBe(4)
  })

  it('rechnet den Gesamtpreis ueber alle Zimmer, nicht ueber das erste', async () => {
    const plan = await owner.query<{ id: number }>(
      `INSERT INTO rate_plan (property_id, code, name, category_id)
       VALUES ($1,'STD','Standard',$2) RETURNING id`, [fx.propertyId, dz])
    const ratePlanId = plan.rows[0]!.id
    await owner.query(
      `INSERT INTO rate_day (property_id, rate_plan_id, date, price_cent)
       SELECT $1, $2, d::date, ARRAY[9000, 10000]
         FROM generate_series($3::date, $4::date - 1, '1 day') d`,
      [fx.propertyId, ratePlanId, VON, BIS])

    const r = await buchen({ rooms: zimmerListe(dzZimmer.slice(0, 2), dz), ratePlanId })
    const body = JSON.parse(r.body) as { totalCent: number
                                         reservations: Array<{ totalCent: number }> }
    // Drei Naechte zu 100,00 je Zimmer, zwei Zimmer.
    expect(body.reservations[0]!.totalCent).toBe(30000)
    expect(body.totalCent).toBe(60000)
  })

  it('bucht ueber mehrere Zimmergruppen hinweg', async () => {
    const r = await buchen({ rooms: [
      ...zimmerListe(dzZimmer.slice(0, 2), dz),
      ...zimmerListe(suiteZimmer.slice(0, 1), suite)
    ] })
    expect(r.statusCode, r.body).toBe(201)
    expect(await bestand(dz)).toBe(2)
    expect(await bestand(suite)).toBe(1)
  })

  it('traegt den Besteller nur einmal als Mitreisenden ein', async () => {
    const g = await owner.query<{ public_ref: string }>(
      `INSERT INTO guest (account_id, last_name) VALUES ($1,'Petersen')
       RETURNING public_ref`, [fx.accountId])

    await buchen({ rooms: zimmerListe(dzZimmer.slice(0, 3), dz),
                   guestRef: g.rows[0]!.public_ref })

    /*
     * Der Besteller ist nicht der Bewohner von drei Zimmern. Stuende er in
     * jedem, zaehlte die Kurtaxe ihn dreimal -- und das faellt niemandem
     * auf, weil die Rechnung plausibel aussieht.
     */
    const o = await owner.query(
      `SELECT 1 FROM reservation_occupant WHERE property_id = $1`, [fx.propertyId])
    expect(o.rowCount).toBe(1)

    // Am Balken steht trotzdem in jedem Zimmer sein Name.
    const res = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reservation
        WHERE property_id = $1 AND primary_guest_id IS NOT NULL`, [fx.propertyId])
    expect(res.rows[0]!.n).toBe(3)
  })

  it('gibt je Reservierung ein Ereignis aus, mit derselben Buchungsreferenz', async () => {
    await owner.query(
      `INSERT INTO webhook_subscription (account_id, url, signing_secret)
       VALUES ($1,'https://kanal.example.de/hook','geheim')`, [fx.accountId])

    const r = await buchen({ rooms: zimmerListe(dzZimmer.slice(0, 3), dz) })
    const bookingRef = (JSON.parse(r.body) as { bookingRef: string }).bookingRef

    /*
     * Ein Kanalmanager fuehrt seine Zimmer einzeln. Ein Ereignis mit drei
     * Referenzen darin muesste er auseinandernehmen, und die bestehenden
     * Empfaenger erwarten `reservationRef` im Singular.
     */
    const ev = await owner.query<{ payload: { data: { bookingRef: string
                                                      reservationRef: string } } }>(
      `SELECT payload FROM webhook_delivery
        WHERE property_id = $1 AND event_type = 'reservation.created'`, [fx.propertyId])
    expect(ev.rowCount).toBe(3)
    expect(ev.rows.every(x => x.payload.data.bookingRef === bookingRef)).toBe(true)
    expect(new Set(ev.rows.map(x => x.payload.data.reservationRef)).size).toBe(3)
  })
})

describe('Was eine Gruppe abweisen muss', () => {
  it('weist dasselbe Zimmer zweimal in der Auswahl ab', async () => {
    const r = await buchen({ rooms: zimmerListe(
      [dzZimmer[0]!, dzZimmer[1]!, dzZimmer[0]!], dz) })
    expect(r.statusCode).toBe(422)
    expect(await anzahlBuchungen()).toEqual({ buchungen: 0, reservierungen: 0 })
  })

  it('rollt die ganze Gruppe zurueck, wenn ein Zimmer belegt ist', async () => {
    expect((await buchen({ rooms: zimmerListe([dzZimmer[1]!], dz) })).statusCode).toBe(201)
    const vorher = await bestand(dz)

    // Das belegte Zimmer steht in der Mitte: die erste Reservierung der
    // Gruppe ist zu diesem Zeitpunkt schon geschrieben.
    const r = await buchen({ rooms: zimmerListe(
      [dzZimmer[0]!, dzZimmer[1]!, dzZimmer[2]!], dz) })
    expect(r.statusCode).toBe(409)

    // Ganz oder gar nicht.
    expect(await bestand(dz)).toBe(vorher)
    expect(await anzahlBuchungen()).toEqual({ buchungen: 1, reservierungen: 1 })
  })

  it('weist mehr Zimmer ab, als das Haus hat', async () => {
    // Sechs Doppelzimmer, sieben angefragt. Der Bestand haelt dagegen --
    // und zwar bevor die erste Reservierung geschrieben ist, weil die
    // ganze Gruppe in einem Zug gebunden wird.
    const r = await buchen({ rooms: [...Array(7)].map((_, i) =>
      ({ categoryId: dz, resourceId: dzZimmer[i] })) })
    expect(r.statusCode).toBe(409)
    expect(await anzahlBuchungen()).toEqual({ buchungen: 0, reservierungen: 0 })
  })

  it('weist eine Zimmergruppe aus einem anderen Haus ab', async () => {
    const fremd = await makeProperty(owner, { name: 'Anderes Haus', code: 'AND' })
    const fremdeKategorie = await makeCategory(owner, fremd.propertyId, { code: 'DZ' })

    const r = await buchen({ rooms: [{ categoryId: fremdeKategorie }] })
    // Nicht "kein Bestand", sondern "unbekannte Zimmergruppe": die
    // Zeilenrichtlinie filtert nach Mandant, nicht nach Haus.
    expect(r.statusCode).toBe(422)
    expect(r.body).toMatch(/Zimmergruppe|category/i)
  })

  it('weist eine leere Zimmerliste ab', async () => {
    expect((await buchen({ rooms: [] })).statusCode).toBe(422)
  })

  it('weist Zimmerliste und Zimmergruppe nebeneinander ab', async () => {
    const r = await buchen({ categoryId: dz, rooms: zimmerListe([dzZimmer[0]!], dz) })
    expect(r.statusCode).toBe(422)
  })

  it('weist eine Buchung ohne Zimmergruppe und ohne Liste ab', async () => {
    expect((await buchen({})).statusCode).toBe(422)
  })
})

describe('Einzelbuchung bleibt, wie sie war', () => {
  it('nimmt categoryId und resourceId wie bisher und liefert die Gruppe mit', async () => {
    const r = await buchen({ categoryId: dz, resourceId: dzZimmer[0] })
    expect(r.statusCode, r.body).toBe(201)
    const body = JSON.parse(r.body) as {
      reservationRef: string; totalCent: number
      reservations: Array<{ reservationRef: string; resourceId: number | null }>
    }
    expect(body.reservations).toHaveLength(1)
    expect(body.reservations[0]!.reservationRef).toBe(body.reservationRef)
    expect(body.reservations[0]!.resourceId).toBe(dzZimmer[0])
  })

  it('bucht weiterhin ohne Zimmer, nur gegen die Zimmergruppe', async () => {
    const r = await buchen({ categoryId: dz })
    expect(r.statusCode, r.body).toBe(201)
    expect(JSON.parse(r.body).reservations[0].resourceId).toBeNull()
    expect(await bestand(dz)).toBe(1)
  })
})

describe('Gruppe aus einem Kontingent', () => {
  async function kontingent(quantity: number): Promise<string> {
    const r = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/blocks`,
      headers: auth,
      payload: { name: 'Reisegruppe Nordsee', categoryId: dz,
                 fromDate: VON, toDate: BIS, quantity } })
    expect(r.statusCode, r.body).toBe(201)
    return JSON.parse(r.body).blockRef as string
  }

  it('ruft mehrere Plaetze auf einmal ab', async () => {
    const blockRef = await kontingent(4)
    const r = await buchen({ rooms: zimmerListe(dzZimmer.slice(0, 3), dz), blockRef })
    expect(r.statusCode, r.body).toBe(201)

    const b = await owner.query<{ picked_up: number; quantity: number }>(
      `SELECT picked_up, quantity FROM availability_block WHERE property_id = $1`,
      [fx.propertyId])
    expect(b.rows[0]!.picked_up).toBe(3)

    // Der Platz wandert von `blocked` nach `sold`, die Summe bleibt.
    const z = await owner.query<{ sold: number; blocked: number }>(
      `SELECT sold, blocked FROM inventory_day
        WHERE property_id = $1 AND category_id = $2 AND date = $3`,
      [fx.propertyId, dz, VON])
    expect(z.rows[0]!).toMatchObject({ sold: 3, blocked: 1 })
  })

  it('weist ab, wenn der Rest des Kontingents nicht reicht', async () => {
    const blockRef = await kontingent(2)
    const r = await buchen({ rooms: zimmerListe(dzZimmer.slice(0, 3), dz), blockRef })
    expect(r.statusCode).toBe(409)
    // `picked_up` darf nie ueber `quantity` steigen -- der Nachtlauf gaebe
    // sonst am Freigabedatum eine negative Menge frei.
    const b = await owner.query<{ picked_up: number }>(
      `SELECT picked_up FROM availability_block WHERE property_id = $1`, [fx.propertyId])
    expect(b.rows[0]!.picked_up).toBe(0)
  })

  it('weist eine Gruppe ab, die nicht ganz zur Zimmergruppe des Kontingents passt', async () => {
    const blockRef = await kontingent(3)
    const r = await buchen({ rooms: [
      ...zimmerListe(dzZimmer.slice(0, 2), dz),
      { categoryId: suite, resourceId: suiteZimmer[0] }
    ], blockRef })
    expect(r.statusCode).toBe(422)
  })
})
