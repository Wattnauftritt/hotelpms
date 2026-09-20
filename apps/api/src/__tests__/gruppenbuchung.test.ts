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

/**
 * Die Namensliste.
 *
 * Der Bucher nimmt fuenf Zimmer, und die uebrigen Namen stehen bis zum
 * Anreisetag nicht fest. Geplant wird deshalb mit seinem Namen -- an allen
 * fuenf Balken, und das ist richtig. Am Tresen bekommt dann jedes Zimmer
 * seinen eigenen: § 30 BMG verlangt den tatsaechlichen Gast, nicht den, der
 * bestellt hat.
 */
describe('Hauptgast je Zimmer setzen', () => {
  const patch = (ref: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url: `/v1/reservations/${ref}`,
      headers: auth, payload })

  async function gast(nachname: string): Promise<string> {
    const g = await owner.query<{ public_ref: string }>(
      `INSERT INTO guest (account_id, last_name) VALUES ($1,$2)
       RETURNING public_ref`, [fx.accountId, nachname])
    return g.rows[0]!.public_ref
  }

  /** Eine Gruppe aus drei Zimmern auf den Namen des Buchers. */
  async function gruppe(): Promise<{ refs: string[]; bucher: string }> {
    const bucher = await gast('Petersen')
    const r = await buchen({ rooms: zimmerListe(dzZimmer.slice(0, 3), dz),
                             guestRef: bucher })
    expect(r.statusCode, r.body).toBe(201)
    const body = JSON.parse(r.body) as { reservations: Array<{ reservationRef: string }> }
    return { refs: body.reservations.map(x => x.reservationRef), bucher }
  }

  it('setzt den Gast eines Zimmers und laesst die uebrigen in Ruhe', async () => {
    const { refs } = await gruppe()
    const mueller = await gast('Mueller')

    const r = await patch(refs[1]!, { guestRef: mueller })
    expect(r.statusCode, r.body).toBe(200)

    const namen = await owner.query<{ public_ref: string; last_name: string }>(
      `SELECT r.public_ref, g.last_name FROM reservation r
         JOIN guest g ON g.id = r.primary_guest_id
        WHERE r.property_id = $1 ORDER BY r.id`, [fx.propertyId])
    expect(namen.rows.map(x => x.last_name)).toEqual(['Petersen', 'Mueller', 'Petersen'])
  })

  it('legt den Mitreisendeneintrag an, wo das Zimmer keinen hatte', async () => {
    const { refs } = await gruppe()
    // Zimmer zwei und drei haben bewusst keinen: den Bucher in jedes zu
    // schreiben zaehlte ihn dreimal, und die Kurtaxe rechnet je Person.
    const vorher = await owner.query(
      `SELECT 1 FROM reservation_occupant WHERE property_id = $1`, [fx.propertyId])
    expect(vorher.rowCount).toBe(1)

    await patch(refs[1]!, { guestRef: await gast('Mueller') })

    const nachher = await owner.query<{ last_name: string }>(
      `SELECT g.last_name FROM reservation_occupant o
         JOIN guest g ON g.id = o.guest_id
         JOIN reservation r ON r.id = o.reservation_id
        WHERE r.public_ref = $1`, [refs[1]!])
    expect(nachher.rows.map(x => x.last_name)).toEqual(['Mueller'])
  })

  it('tauscht den bestehenden Eintrag, statt einen zweiten anzulegen', async () => {
    const { refs } = await gruppe()
    await patch(refs[0]!, { guestRef: await gast('Mueller') })

    // Sonst stuende der Bucher weiter daneben, und die Personenzahl auf dem
    // Meldeschein zaehlte jemanden mit, der gar nicht da ist.
    const o = await owner.query<{ last_name: string }>(
      `SELECT g.last_name FROM reservation_occupant o
         JOIN guest g ON g.id = o.guest_id
         JOIN reservation r ON r.id = o.reservation_id
        WHERE r.public_ref = $1`, [refs[0]!])
    expect(o.rows.map(x => x.last_name)).toEqual(['Mueller'])
  })

  it('zieht den Rechnungsempfaenger am Gastfolio mit', async () => {
    const { refs } = await gruppe()
    const mueller = await gast('Mueller')
    await patch(refs[1]!, { guestRef: mueller })

    const f = await owner.query<{ last_name: string }>(
      `SELECT g.last_name FROM folio f
         JOIN guest g ON g.id = f.guest_id
         JOIN reservation r ON r.id = f.reservation_id
        WHERE r.public_ref = $1 AND f.kind = 'guest'`, [refs[1]!])
    expect(f.rows[0]!.last_name).toBe('Mueller')
  })

  it('nimmt Notiz und Gast in einem Aufruf', async () => {
    const { refs } = await gruppe()
    const r = await patch(refs[0]!, { notes: 'Spaete Anreise', guestRef: await gast('Mueller') })
    expect(r.statusCode, r.body).toBe(200)

    const z = await owner.query<{ notes: string; last_name: string }>(
      `SELECT r.notes, g.last_name FROM reservation r
         JOIN guest g ON g.id = r.primary_guest_id
        WHERE r.public_ref = $1`, [refs[0]!])
    expect(z.rows[0]).toMatchObject({ notes: 'Spaete Anreise', last_name: 'Mueller' })
  })

  it('weist eine unbekannte Gastreferenz ab', async () => {
    const { refs } = await gruppe()
    expect((await patch(refs[0]!, { guestRef: 'GIBTESNICHT' })).statusCode).toBe(404)
  })

  /**
   * Nach dem Check-in liegt der Meldeschein vor, und er ist eine Erklaerung
   * des Gastes ueber sich selbst. Den Hauptgast dann auszutauschen liesse
   * eine Unterschrift unter einem fremden Namen stehen.
   */
  it('wechselt den Gast nach dem Check-in nicht mehr', async () => {
    const { refs } = await gruppe()
    const ein = await app.inject({ method: 'POST', headers: auth,
      url: `/v1/reservations/${refs[0]!}/check-in` })
    expect(ein.statusCode, ein.body).toBe(200)

    const r = await patch(refs[0]!, { guestRef: await gast('Mueller') })
    expect(r.statusCode).toBe(409)

    const z = await owner.query<{ last_name: string }>(
      `SELECT g.last_name FROM reservation r JOIN guest g ON g.id = r.primary_guest_id
        WHERE r.public_ref = $1`, [refs[0]!])
    expect(z.rows[0]!.last_name).toBe('Petersen')
  })

  /**
   * Am Folio haengt der Rechnungsempfaenger. Ist fakturiert, steht der Name
   * auf einem Beleg mit Haertegrad 1.
   */
  it('wechselt den Gast nach dem Fakturieren nicht mehr', async () => {
    const { refs } = await gruppe()
    const f = await owner.query<{ id: number; res_id: number }>(
      `SELECT f.id, f.reservation_id AS res_id FROM folio f
         JOIN reservation r ON r.id = f.reservation_id
        WHERE r.public_ref = $1 AND f.kind = 'guest'`, [refs[0]!])
    const inv = await owner.query<{ id: number }>(
      `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date,
                            issuer_snapshot, recipient_snapshot, totals)
       VALUES ($1,$2,'RE-1', current_date, current_date, '{}'::jsonb, '{}'::jsonb,
               '{}'::jsonb) RETURNING id`, [fx.propertyId, f.rows[0]!.id])
    await owner.query(
      `INSERT INTO charge (property_id, folio_id, business_date, description,
                           net_cent, tax_cent, gross_cent, tax_rate_bp,
                           revenue_account, reservation_id, invoice_id)
       VALUES ($1,$2,current_date,'Logis',10000,700,10700,700,'4200',$3,$4)`,
      [fx.propertyId, f.rows[0]!.id, f.rows[0]!.res_id, inv.rows[0]!.id])

    const r = await patch(refs[0]!, { guestRef: await gast('Mueller') })
    expect(r.statusCode).toBe(409)
  })
})

/**
 * Der Preis einer Gruppe: eingegeben wird, was verhandelt wurde.
 *
 * Eine Gruppe wird nicht je Nacht und Zimmer verhandelt, sondern als
 * Betrag: "die Gruppe kostet 2.400". Gespeichert wird trotzdem je Nacht --
 * `reservation_night.price_cent` ist die Wahrheit, aus der Rechnung, Storno
 * und Statistik rechnen. Zwischen beidem liegt eine Division, und genau
 * dort verschwindet ein Cent, wenn man nicht aufpasst.
 *
 * Die Probe ist deshalb immer dieselbe: **die Summe der gespeicherten
 * Naechte ist der eingegebene Betrag.** Nicht ungefaehr, sondern auf den
 * Cent -- in der Buchhaltung ist eine Differenz ohne Ursache teurer als
 * eine ungerechte Aufteilung.
 */
describe('Gesamtpreis statt Preis je Nacht', () => {
  /** Alle Naechte einer Reservierung, in der Reihenfolge des Aufenthalts. */
  async function naechte(ref: string): Promise<number[]> {
    const r = await owner.query<{ price_cent: string }>(
      `SELECT n.price_cent FROM reservation_night n
         JOIN reservation r ON r.id = n.reservation_id
        WHERE r.public_ref = $1 ORDER BY n.date`, [ref])
    return r.rows.map(x => Number(x.price_cent))
  }

  it('teilt einen Gesamtpreis auf die Naechte und laesst keinen Cent liegen', async () => {
    // Drei Naechte, 100,00 EUR. Dreimal 33,33 waeren 99,99.
    const r = await buchen({ categoryId: dz, resourceId: dzZimmer[0], totalCent: 10_000 })
    expect(r.statusCode).toBe(201)
    const body = JSON.parse(r.body) as { reservationRef: string; totalCent: number }
    expect(await naechte(body.reservationRef)).toEqual([3334, 3333, 3333])
    expect(body.totalCent).toBe(10_000)
  })

  it('teilt einen Gruppenpreis nach Personen auf die Zimmer', async () => {
    // Die Suite fasst vier, das Doppelzimmer zwei: Gewichte 2, 2, 4.
    await owner.query(`UPDATE resource_category SET max_occupancy = 4 WHERE id = $1`, [suite])
    const r = await buchen({
      rooms: [...zimmerListe(dzZimmer.slice(0, 2), dz),
              ...zimmerListe(suiteZimmer.slice(0, 1), suite)],
      totalCent: 80_000
    })
    expect(r.statusCode).toBe(201)
    const body = JSON.parse(r.body) as
      { reservations: Array<{ totalCent: number }>; totalCent: number }
    expect(body.reservations.map(x => x.totalCent)).toEqual([20_000, 20_000, 40_000])
    expect(body.totalCent).toBe(80_000)
  })

  it('geht auch dann auf, wenn die Aufteilung krumm ist', async () => {
    /*
     * 1.000,01 EUR auf drei gleiche Zimmer und drei Naechte -- neun Posten,
     * zwei Reste. Jeder liegt genau einmal, und die Summe stimmt.
     */
    const r = await buchen({
      rooms: zimmerListe(dzZimmer.slice(0, 3), dz), totalCent: 100_001
    })
    expect(r.statusCode).toBe(201)
    const body = JSON.parse(r.body) as
      { reservations: Array<{ reservationRef: string; totalCent: number }>
        totalCent: number }
    expect(body.totalCent).toBe(100_001)
    let summe = 0
    for (const res of body.reservations) {
      const n = await naechte(res.reservationRef)
      expect(n.reduce((s, x) => s + x, 0)).toBe(res.totalCent)
      summe += n.reduce((s, x) => s + x, 0)
    }
    expect(summe).toBe(100_001)
  })

  it('nimmt einen Preis je Zimmer, wenn einer dabeisteht', async () => {
    const r = await buchen({
      rooms: [{ categoryId: dz, resourceId: dzZimmer[0], totalCent: 30_000 },
              { categoryId: suite, resourceId: suiteZimmer[0], totalCent: 90_000 }]
    })
    expect(r.statusCode).toBe(201)
    const body = JSON.parse(r.body) as
      { reservations: Array<{ totalCent: number }>; totalCent: number }
    expect(body.reservations.map(x => x.totalCent)).toEqual([30_000, 90_000])
    expect(body.totalCent).toBe(120_000)
  })

  it('weist zwei Preise fuer dieselbe Sache ab, statt einen zu waehlen', async () => {
    /*
     * Stillschweigend einen gewinnen zu lassen waere bequem und faellt erst
     * an der Rechnung auf: der Anrufer glaubt, den anderen gesetzt zu haben.
     */
    expect((await buchen({ categoryId: dz, priceCent: 5000, totalCent: 10_000 })).statusCode)
      .toBe(422)
    expect((await buchen({
      rooms: [{ categoryId: dz, totalCent: 30_000 }], totalCent: 30_000
    })).statusCode).toBe(422)
    expect((await buchen({
      rooms: [{ categoryId: dz, totalCent: 30_000 }], priceCent: 5000
    })).statusCode).toBe(422)
  })

  it('weist einen negativen Betrag ab', async () => {
    expect((await buchen({ categoryId: dz, totalCent: -1 })).statusCode).toBe(422)
    expect((await buchen({ rooms: [{ categoryId: dz, totalCent: -1 }] })).statusCode)
      .toBe(422)
  })
})
