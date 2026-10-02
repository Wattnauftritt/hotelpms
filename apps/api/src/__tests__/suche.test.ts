import { Writable } from 'node:stream'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, makeGuest, openBusinessDay,
         countQueries, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import type { SearchResult } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Die Suche der Rezeption (`GET /v1/properties/:propertyId/search`).
 *
 * Geprueft wird, was still schiefgehen wuerde: ein Treffer aus dem Nachbarhaus
 * desselben Accounts (die Zeilenrichtlinie filtert nach Mandant, nicht nach
 * Haus), ein anonymisierter Gast, der ueber seinen alten Namen wieder
 * auftaucht, ein Suchbegriff im Protokoll, und eine Suche, die je Treffer
 * eine Anweisung mehr braucht.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let zeilen: string[]

let hausA: Fixture
/** Zweites Haus im selben Account wie A. */
let hausA2: number
let catA: number
let zimmerA: number[]
let catA2: number
let zimmerA2: number[]
/** Rezeption, nur in Haus A. */
let rezeption: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

async function suchen(sessionId: string, propertyId: number, q: string,
                      extra = ''): Promise<{ status: number; body: SearchResult }> {
  const r = await app.inject({
    method: 'GET',
    url: `/v1/properties/${propertyId}/search?q=${encodeURIComponent(q)}${extra}`,
    headers: auth(sessionId) })
  return { status: r.statusCode, body: JSON.parse(r.body) as SearchResult }
}

/** Eine Reservierung mit Hauptgast und optional weiteren Belegten. */
async function aufenthalt(opts: {
  propertyId: number; categoryId: number; arrival: string; departure: string
  gast: number; begleiter?: number[]; resourceId?: number
  status?: 'Optional' | 'Confirmed' | 'InHouse'
}): Promise<{ reservationRef: string; bookingRef: string; bookingId: number }> {
  const r = await makeReservation(owner, {
    propertyId: opts.propertyId, categoryId: opts.categoryId,
    arrival: opts.arrival, departure: opts.departure,
    status: opts.status, resourceId: opts.resourceId,
    // Der Bestand ist hier nicht die Frage, und dreissig Aufenthalte am
    // selben Tag passen in kein Testhaus.
    reserveInventory: false, withFolio: false })
  await owner.query(`UPDATE reservation SET primary_guest_id = $1 WHERE id = $2`,
    [opts.gast, r.reservationId])
  await owner.query(`UPDATE booking SET booker_guest_id = $1 WHERE id = $2`,
    [opts.gast, r.bookingId])
  await owner.query(
    `INSERT INTO reservation_occupant (property_id, reservation_id, guest_id, is_primary)
     SELECT $1, $2, g, g = $3 FROM unnest($4::bigint[]) g`,
    [opts.propertyId, r.reservationId, opts.gast, [opts.gast, ...(opts.begleiter ?? [])]])
  const refs = await owner.query<{ r: string; b: string }>(
    `SELECT r.public_ref AS r, b.public_ref AS b FROM reservation r
       JOIN booking b ON b.id = r.booking_id WHERE r.id = $1`, [r.reservationId])
  return { reservationRef: refs.rows[0]!.r, bookingRef: refs.rows[0]!.b,
           bookingId: r.bookingId }
}

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const senke = new Writable({
    write(chunk: Buffer, _enc, cb) { zeilen.push(chunk.toString('utf8')); cb() }
  })
  const built = await buildServer({ pool: appPool(5), logStream: senke })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

beforeEach(async () => {
  await truncateAll()
  limiters.reset()
  zeilen = []
  hausA = await makeProperty(owner)
  catA = await makeCategory(owner, hausA.propertyId)
  zimmerA = await makeResources(owner, hausA.propertyId, catA, 3)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
    [hausA.propertyId])
  await openBusinessDay(owner, hausA.propertyId, '2026-10-01')

  const p2 = await owner.query<{ id: number }>(
    `INSERT INTO property (account_id, code, name, address_line1, postal_code, city,
                           country, tax_number)
     VALUES ($1,'ZWEI','Zweites Haus','Markt 2','25813','Husum','DE','21/815/00124')
     RETURNING id`, [hausA.accountId])
  hausA2 = p2.rows[0]!.id
  catA2 = await makeCategory(owner, hausA2)
  zimmerA2 = await makeResources(owner, hausA2, catA2, 2, 'B')
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
    [hausA2])

  rezeption = await makeUser(owner,
    { email: 'rezeption@test.de', propertyId: hausA.propertyId, roleKey: 'reception' })
})

describe('Suche: was gefunden wird', () => {
  it('findet eine Reservierung ueber Gast, Begleitperson und Nummer', async () => {
    const jan = await makeGuest(owner, hausA.accountId, { lastName: 'Petersen', firstName: 'Jan' })
    const anna = await makeGuest(owner, hausA.accountId, { lastName: 'Lund', firstName: 'Anna' })
    const r = await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-10-05', departure: '2026-10-08', gast: jan.id, begleiter: [anna.id],
      resourceId: zimmerA[0] })
    await owner.query(`UPDATE booking SET source = 'channel', external_reference = '4711-9988'
                        WHERE id = $1`, [r.bookingId])

    const nachName = await suchen(rezeption.sessionId, hausA.propertyId, 'Petersen')
    expect(nachName.status).toBe(200)
    const treffer = nachName.body.reservations.find(x => x.reservationRef === r.reservationRef)
    expect(treffer).toBeDefined()
    expect(treffer!.matchedBy).toBe('guest')
    expect(treffer!.roomCode).toBe('101')
    expect(treffer!.arrival).toBe('2026-10-05')
    // Die Begleitperson steht in der Zeile, der Hauptgast nicht ein zweites Mal.
    expect(treffer!.companions).toEqual(['Anna Lund'])

    // Ueber die Begleitperson: dieselbe Reservierung, und die Zeile sagt warum.
    const nachBegleitung = await suchen(rezeption.sessionId, hausA.propertyId, 'Lund')
    const b = nachBegleitung.body.reservations.find(x => x.reservationRef === r.reservationRef)
    expect(b?.matchedBy).toBe('companion')
    expect(b?.lastName).toBe('Petersen')

    // Die ersten Zeichen der Nummer, klein getippt.
    const nachNummer = await suchen(rezeption.sessionId, hausA.propertyId,
      r.reservationRef.slice(0, 5).toLowerCase())
    expect(nachNummer.body.reservations[0]?.reservationRef).toBe(r.reservationRef)
    expect(nachNummer.body.reservations[0]?.matchedBy).toBe('number')

    const nachBuchung = await suchen(rezeption.sessionId, hausA.propertyId,
      r.bookingRef.slice(0, 6))
    expect(nachBuchung.body.reservations.map(x => x.reservationRef))
      .toContain(r.reservationRef)

    // Die Nummer des Kanals, wie sie auf der Bestaetigung des Portals steht.
    const nachKanal = await suchen(rezeption.sessionId, hausA.propertyId, '4711-99')
    expect(nachKanal.body.reservations[0]?.reservationRef).toBe(r.reservationRef)
    expect(nachKanal.body.reservations[0]?.externalReference).toBe('4711-9988')
  })

  it('findet einen Namen schon an den ersten Buchstaben und trotz Tippfehler', async () => {
    const g = await makeGuest(owner, hausA.accountId, { lastName: 'Brodersen-Hansen' })
    const r = await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-10-05', departure: '2026-10-06', gast: g.id })
    for (const begriff of ['Bro', 'Hansen', 'Brodersn-Hansen']) {
      const s = await suchen(rezeption.sessionId, hausA.propertyId, begriff)
      expect(s.body.reservations.map(x => x.reservationRef), begriff)
        .toContain(r.reservationRef)
    }
  })

  it('stellt Aktuelles vor Vergangenes und zeigt auch Stornos', async () => {
    const g = await makeGuest(owner, hausA.accountId, { lastName: 'Jessen' })
    const alt = await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-09-02', departure: '2026-09-04', gast: g.id })
    await owner.query(`UPDATE reservation SET status = 'CheckedOut' WHERE public_ref = $1`,
      [alt.reservationRef])
    const storno = await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-11-02', departure: '2026-11-04', gast: g.id })
    await owner.query(`UPDATE reservation SET status = 'Canceled', canceled_at = now()
                        WHERE public_ref = $1`, [storno.reservationRef])
    const kommt = await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-10-20', departure: '2026-10-22', gast: g.id })
    const da = await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-09-30', departure: '2026-10-03', gast: g.id, status: 'InHouse',
      resourceId: zimmerA[1] })

    const s = await suchen(rezeption.sessionId, hausA.propertyId, 'Jessen')
    const reihe = s.body.reservations.map(x => x.reservationRef)
    // Im Haus, dann was kommt, dann alles andere -- das Juengste zuerst.
    expect(reihe).toEqual([da.reservationRef, kommt.reservationRef,
                           storno.reservationRef, alt.reservationRef])
    const vergangen = s.body.reservations.find(x => x.reservationRef === alt.reservationRef)
    expect(vergangen?.past).toBe(true)
    expect(vergangen?.status).toBe('CheckedOut')
    expect(s.body.reservations.find(x => x.reservationRef === kommt.reservationRef)?.past)
      .toBe(false)
  })

  it('trennt Reservierungen und Kunden nach dem Filter', async () => {
    const g = await makeGuest(owner, hausA.accountId, { lastName: 'Carstensen' })
    await owner.query(`UPDATE guest SET email = 'carstensen@example.de', phone = '0481 1234'
                        WHERE id = $1`, [g.id])
    await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-09-30', departure: '2026-10-03', gast: g.id, status: 'InHouse',
      resourceId: zimmerA[0] })
    await owner.query(`INSERT INTO company (account_id, name, city)
                       VALUES ($1, 'Carstensen Werft GmbH', 'Husum')`, [hausA.accountId])

    const nurReservierung = await suchen(rezeption.sessionId, hausA.propertyId,
      'Carstensen', '&scope=reservation')
    expect(nurReservierung.body.reservations).toHaveLength(1)
    expect(nurReservierung.body.customers).toEqual([])

    const nurKunde = await suchen(rezeption.sessionId, hausA.propertyId,
      'Carstensen', '&scope=customer')
    expect(nurKunde.body.reservations).toEqual([])
    const gast = nurKunde.body.customers.find(c => c.kind === 'guest')
    expect(gast).toMatchObject({ ref: g.publicRef, name: 'Carstensen',
      email: 'carstensen@example.de', phone: '0481 1234', reservations: 1, inHouse: true })
    const firma = nurKunde.body.customers.find(c => c.kind === 'company')
    expect(firma?.name).toBe('Carstensen Werft GmbH')
    // Der genaue Name vor dem, der ihn nur enthaelt.
    expect(nurKunde.body.customers[0]?.kind).toBe('guest')

    // Die Mail von vorn, aber nur mit @: ein Name allein sucht nicht in Adressen.
    const nachMail = await suchen(rezeption.sessionId, hausA.propertyId,
      'carstensen@exa', '&scope=customer')
    expect(nachMail.body.customers.map(c => c.ref)).toEqual([g.publicRef])
  })
})

describe('Suche: was nicht gefunden wird', () => {
  it('zeigt nichts aus einem fremden Mandanten', async () => {
    const fremd = await makeProperty(owner, { name: 'Fremdes Hotel', code: 'FREMD' })
    const fremdKat = await makeCategory(owner, fremd.propertyId)
    await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
      [fremd.propertyId])
    const fremderGast = await makeGuest(owner, fremd.accountId, { lastName: 'Ketelsen' })
    const fremdeRes = await aufenthalt({ propertyId: fremd.propertyId, categoryId: fremdKat,
      arrival: '2026-10-05', departure: '2026-10-06', gast: fremderGast.id })

    const s = await suchen(rezeption.sessionId, hausA.propertyId, 'Ketelsen')
    expect(s.status).toBe(200)
    expect(s.body.reservations).toEqual([])
    expect(s.body.customers).toEqual([])
    // Auch ueber die Nummer nicht.
    const n = await suchen(rezeption.sessionId, hausA.propertyId,
      fremdeRes.reservationRef.slice(0, 6))
    expect(n.body.reservations).toEqual([])
    // Und das fremde Haus im Pfad ist keine Hintertuer.
    const pfad = await suchen(rezeption.sessionId, fremd.propertyId, 'Ketelsen')
    expect(pfad.status).toBe(403)
  })

  it('zeigt aus dem Nachbarhaus desselben Accounts keine Reservierung', async () => {
    /*
     * Der Fall, den die Zeilenrichtlinie nicht abdeckt: dieser Benutzer
     * darf in **beide** Haeuser, sucht aber in A. Ohne `property_id = $1`
     * kaemen die Reservierungen aus A2 mit -- und die Rezeption sprange im
     * Plan von A zu einem Balken, den es dort nicht gibt.
     */
    const beide = await makeUser(owner,
      { email: 'beide@test.de', propertyId: hausA.propertyId, roleKey: 'reception' })
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'reception' AND account_id IS NULL`,
      [beide.userId, hausA2])
    const g = await makeGuest(owner, hausA.accountId, { lastName: 'Nissen' })
    const inA = await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-10-10', departure: '2026-10-12', gast: g.id })
    const inA2 = await aufenthalt({ propertyId: hausA2, categoryId: catA2,
      arrival: '2026-09-30', departure: '2026-10-03', gast: g.id, status: 'InHouse',
      resourceId: zimmerA2[0] })

    const s = await suchen(beide.sessionId, hausA.propertyId, 'Nissen')
    const refs = s.body.reservations.map(x => x.reservationRef)
    expect(refs).toContain(inA.reservationRef)
    expect(refs).not.toContain(inA2.reservationRef)
    // Der Gast gehoert dem Account und wird gefunden -- aber was er im
    // anderen Haus tut, zaehlt hier nicht mit.
    const kunde = s.body.customers.find(c => c.ref === g.publicRef)
    expect(kunde).toMatchObject({ reservations: 1, inHouse: false })

    // In A2 gesucht ist es umgekehrt.
    const s2 = await suchen(beide.sessionId, hausA2, 'Nissen')
    expect(s2.body.reservations.map(x => x.reservationRef)).toEqual([inA2.reservationRef])
    expect(s2.body.customers.find(c => c.ref === g.publicRef)?.inHouse).toBe(true)
  })

  it('findet einen anonymisierten Gast nicht, auch nicht als Begleitperson', async () => {
    /*
     * Der Name bleibt hier absichtlich stehen: geprueft wird der Filter auf
     * den Zustand, nicht die Anonymisierung selbst. Taete die nur ihr halbes
     * Werk, soll die Suche trotzdem nichts zeigen.
     */
    const weg = await makeGuest(owner, hausA.accountId, { lastName: 'Thomsen' })
    const gast = await makeGuest(owner, hausA.accountId, { lastName: 'Asmussen' })
    const r = await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-10-05', departure: '2026-10-06', gast: gast.id, begleiter: [weg.id] })
    const eigene = await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-10-07', departure: '2026-10-08', gast: weg.id })
    await owner.query(`UPDATE guest SET status = 'anonymized', anonymized_at = now()
                        WHERE id = $1`, [weg.id])

    const s = await suchen(rezeption.sessionId, hausA.propertyId, 'Thomsen')
    expect(s.body.reservations).toEqual([])
    expect(s.body.customers).toEqual([])
    // Die Reservierung des anderen Gastes bleibt -- ohne den Namen darin.
    const a = await suchen(rezeption.sessionId, hausA.propertyId, 'Asmussen')
    expect(a.body.reservations.find(x => x.reservationRef === r.reservationRef)?.companions)
      .toEqual([])
    // Ueber die Nummer bleibt die eigene auffindbar: der Beleg wird aufbewahrt.
    const n = await suchen(rezeption.sessionId, hausA.propertyId,
      eigene.reservationRef.slice(0, 7))
    expect(n.body.reservations.map(x => x.reservationRef)).toEqual([eigene.reservationRef])
  })

  it('zeigt der Rolle ohne Gastrecht keine Kunden', async () => {
    const revenue = await makeUser(owner,
      { email: 'revenue@test.de', propertyId: hausA.propertyId, roleKey: 'revenue' })
    const g = await makeGuest(owner, hausA.accountId, { lastName: 'Hansen' })
    await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-10-05', departure: '2026-10-06', gast: g.id })

    const alle = await suchen(revenue.sessionId, hausA.propertyId, 'Hansen')
    expect(alle.status).toBe(200)
    expect(alle.body.reservations).toHaveLength(1)
    expect(alle.body.customers).toEqual([])
    const kunden = await suchen(revenue.sessionId, hausA.propertyId, 'Hansen',
      '&scope=customer')
    expect(kunden.status).toBe(403)

    const hk = await makeUser(owner,
      { email: 'hk@test.de', propertyId: hausA.propertyId, roleKey: 'housekeeping' })
    expect((await suchen(hk.sessionId, hausA.propertyId, 'Hansen')).status).toBe(403)
  })
})

describe('Suche: Grenzen', () => {
  it('verlangt zwei Zeichen, begrenzt Laenge und Trefferzahl und kennt nur drei Filter',
    async () => {
      expect((await suchen(rezeption.sessionId, hausA.propertyId, 'P')).status).toBe(422)
      expect((await suchen(rezeption.sessionId, hausA.propertyId, ' P ')).status).toBe(422)
      expect((await suchen(rezeption.sessionId, hausA.propertyId, 'x'.repeat(101))).status)
        .toBe(422)
      expect((await suchen(rezeption.sessionId, hausA.propertyId, 'Petersen',
        '&scope=rechnung')).status).toBe(422)
      expect((await suchen(rezeption.sessionId, hausA.propertyId, 'Petersen',
        '&q=Jansen')).status).toBe(422)

      const g = await makeGuest(owner, hausA.accountId, { lastName: 'Paulsen' })
      for (let i = 0; i < 30; i++) {
        await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
          arrival: '2026-10-05', departure: '2026-10-06', gast: g.id })
      }
      const s = await suchen(rezeption.sessionId, hausA.propertyId, 'Paulsen', '&limit=1000')
      expect(s.status).toBe(200)
      expect(s.body.reservations).toHaveLength(25)
      expect(s.body.moreReservations).toBe(true)
      const standard = await suchen(rezeption.sessionId, hausA.propertyId, 'Paulsen')
      expect(standard.body.reservations).toHaveLength(8)
    })

  it('behandelt Platzhalterzeichen als Zeichen', async () => {
    const g = await makeGuest(owner, hausA.accountId, { lastName: 'Lorenzen' })
    await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-10-05', departure: '2026-10-06', gast: g.id })
    // `_` und `%` waeren in einem LIKE "beliebig" und faenden jede Nummer.
    for (const begriff of ['___', '%%%', '_%_']) {
      const s = await suchen(rezeption.sessionId, hausA.propertyId, begriff)
      expect(s.status, begriff).toBe(200)
      expect(s.body.reservations, begriff).toEqual([])
    }
  })

  it('braucht je Anfrage dieselben zwei Anweisungen, egal wie viele Treffer', async () => {
    /*
     * Das N+1 zeigte sich hier nicht als Fehler, sondern als Zeit: eine
     * Trefferzeile, die ihre Begleitpersonen oder Aufenthalte selbst
     * nachlaedt, ist bei einem Treffer so schnell wie bei zwanzig -- im
     * Test. Gezaehlt werden die Anweisungen an den Fachtabellen; Anmeldung
     * und Transaktionsrahmen stehen bei jeder Anfrage gleich da.
     */
    const fach = /\b(reservation|guest|company|booking)\b/
    const zaehlen = async (q: string): Promise<number> => {
      const { report } = await countQueries(pool, () =>
        suchen(rezeption.sessionId, hausA.propertyId, q, '&limit=25'))
      return report.statements.filter(s => fach.test(s)).length
    }

    const einer = await makeGuest(owner, hausA.accountId, { lastName: 'Matthiesen' })
    await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-10-05', departure: '2026-10-06', gast: einer.id })
    const wenige = await zaehlen('Matthiesen')

    for (let i = 0; i < 12; i++) {
      const g = await makeGuest(owner, hausA.accountId,
        { lastName: 'Matthiesen', firstName: `Gast${i}` })
      const begleiter = await makeGuest(owner, hausA.accountId, { lastName: `Begleiter${i}` })
      await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
        arrival: '2026-10-05', departure: '2026-10-06', gast: g.id, begleiter: [begleiter.id] })
    }
    const viele = await zaehlen('Matthiesen')

    expect(wenige).toBe(2)
    expect(viele).toBe(2)
  })
})

describe('Suche: Protokoll', () => {
  it('schreibt den Suchbegriff nicht ins Anfrageprotokoll', async () => {
    const g = await makeGuest(owner, hausA.accountId, { lastName: 'Petersen' })
    await aufenthalt({ propertyId: hausA.propertyId, categoryId: catA,
      arrival: '2026-10-05', departure: '2026-10-06', gast: g.id })

    const s = await suchen(rezeption.sessionId, hausA.propertyId, 'Petersen',
      '&scope=all&limit=5')
    expect(s.status).toBe(200)
    expect(s.body.reservations).toHaveLength(1)

    const protokoll = zeilen.join('\n')
    // Weder der Begriff noch der Name aus der Antwort steht im Protokoll.
    expect(protokoll).not.toContain('Petersen')
    // Pfad und Namen der Parameter bleiben -- ablesbar, wonach gesucht
    // wurde, nicht wer.
    expect(protokoll).toContain('/search')
    expect(protokoll).toContain('q=[redigiert]')
    expect(protokoll).toContain('scope=[redigiert]')
  })
})
