import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

interface Bericht {
  dryRun: boolean; rows: number; imported: number; skipped: number
  findings: Array<{ row: number; level: string; message: string; reference?: string }>
}

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
  admin = await makeUser(owner,
    { email: 'setup@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL`,
    [admin.userId, fx.accountId])
})

const importieren = async (
  system: 'hotline' | 'hs3' | 'protel', data: string, commit = false
): Promise<{ status: number; bericht: Bericht }> => {
  const r = await app.inject({
    method: 'POST', url: `/v1/imports/legacy/${system}/reservations`,
    headers: auth(admin.sessionId), payload: { propertyId: fx.propertyId, data, commit } })
  return { status: r.statusCode, bericht: JSON.parse(r.body) as Bericht }
}

describe('Vorlagen', () => {
  it('nennt die erwartete Rohform je Altsystem', async () => {
    const r = await app.inject({
      method: 'GET', url: '/v1/imports/legacy/templates', headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body) as { hotline: { delimiter: string }; hs3: unknown; protel: unknown }
    expect(body.hotline.delimiter).toBe(';')
  })
})

describe('hotline: Semikolon, TT.MM.JJJJ, Komma-Betrag', () => {
  beforeEach(async () => {
    const catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
    await makeResources(owner, fx.propertyId, catId, 3)
    await owner.query(`SELECT inventory_materialize($1,'2026-06-01'::date,'2026-12-01'::date)`,
      [fx.propertyId])
  })

  const csv = 'Belegnummer;Zimmerkategorie;Anreise;Abreise;Nachname;Vorname;Gesamtpreis;Herkunft\r\n'
            + 'HL-1;DZ;01.07.2026;05.07.2026;Petersen;Jan;480,00;Booking.com\r\n'

  it('uebersetzt Datum, Betrag und Gastnamen richtig', async () => {
    const { status, bericht } = await importieren('hotline', csv, true)
    expect(status).toBe(200)
    expect(bericht.imported).toBe(1)

    const b = await owner.query(
      `SELECT b.external_reference, b.channel_code, r.arrival::text, r.departure::text,
              g.last_name, g.first_name,
              (SELECT sum(price_cent) FROM reservation_night WHERE reservation_id = r.id) AS total
         FROM booking b JOIN reservation r ON r.booking_id = b.id
         LEFT JOIN guest g ON g.id = r.primary_guest_id
        WHERE b.property_id = $1`, [fx.propertyId])
    expect(b.rows[0]).toMatchObject({
      external_reference: 'hotline:HL-1', channel_code: 'Booking.com',
      arrival: '2026-07-01', departure: '2026-07-05',
      last_name: 'Petersen', first_name: 'Jan', total: '48000'
    })
  })

  it('ueberspringt eine bereits importierte externe Nummer beim zweiten Lauf', async () => {
    await importieren('hotline', csv, true)
    const zweiter = await importieren('hotline', csv, true)
    expect(zweiter.bericht.imported).toBe(0)
    expect(zweiter.bericht.findings[0]!.message).toContain('Bereits importiert')

    const count = await owner.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM booking WHERE property_id = $1`, [fx.propertyId])
    expect(Number(count.rows[0]!.n)).toBe(1)
  })

  it('uebernimmt gar nichts, wenn eine Zeile eine unbekannte Kategorie hat', async () => {
    const kaputt = 'Belegnummer;Zimmerkategorie;Anreise;Abreise;Nachname;Vorname;Gesamtpreis;Herkunft\r\n'
                 + 'HL-1;DZ;01.07.2026;05.07.2026;Petersen;Jan;480,00;Booking.com\r\n'
                 + 'HL-2;NICHT-DA;02.07.2026;03.07.2026;Mueller;Eva;100,00;Direkt\r\n'
    const { bericht } = await importieren('hotline', kaputt, true)
    expect(bericht.imported).toBe(0)
    expect(bericht.findings.some(f => f.level === 'error')).toBe(true)

    const count = await owner.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM booking WHERE property_id = $1`, [fx.propertyId])
    expect(Number(count.rows[0]!.n)).toBe(0)
  })

  it('meldet eine fehlende Pflichtspalte statt eines rohen Fehlers', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/imports/legacy/hotline/reservations',
      headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, data: 'Belegnummer;Anreise\r\nHL-1;01.07.2026\r\n',
                 commit: false } })
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).detail).toContain('Zimmerkategorie')
  })
})

describe('HS/3: Pipe, JJJJMMTT, ganze Cent, kombinierter Gastname', () => {
  beforeEach(async () => {
    const catId = await makeCategory(owner, fx.propertyId, { code: 'EZ' })
    await makeResources(owner, fx.propertyId, catId, 2)
    await owner.query(`SELECT inventory_materialize($1,'2026-06-01'::date,'2026-12-01'::date)`,
      [fx.propertyId])
  })

  it('uebersetzt kompaktes Datum, Cent-Betrag und "Nachname, Vorname"', async () => {
    const csv = 'RES_ID|RM_TYPE|ARR|DEP|GUEST_NAME|AMOUNT_CENT|SRC\r\n'
              + 'R-1|EZ|20260701|20260705|Mueller, Stefan|39600|Expedia\r\n'
    const { bericht } = await importieren('hs3', csv, true)
    expect(bericht.imported).toBe(1)

    const b = await owner.query(
      `SELECT b.external_reference, b.channel_code, r.arrival::text, r.departure::text,
              g.last_name, g.first_name,
              (SELECT sum(price_cent) FROM reservation_night WHERE reservation_id = r.id) AS total
         FROM booking b JOIN reservation r ON r.booking_id = b.id
         LEFT JOIN guest g ON g.id = r.primary_guest_id
        WHERE b.property_id = $1`, [fx.propertyId])
    expect(b.rows[0]).toMatchObject({
      external_reference: 'hs3:R-1', channel_code: 'Expedia',
      arrival: '2026-07-01', departure: '2026-07-05',
      last_name: 'Mueller', first_name: 'Stefan', total: '39600'
    })
  })
})

describe('protel: Komma, MM/TT/JJJJ, Anfuehrungszeichen im Gastnamen', () => {
  beforeEach(async () => {
    const catId = await makeCategory(owner, fx.propertyId, { code: 'SUI' })
    await makeResources(owner, fx.propertyId, catId, 2)
    await owner.query(`SELECT inventory_materialize($1,'2026-06-01'::date,'2026-12-01'::date)`,
      [fx.propertyId])
  })

  it('liest das amerikanische Datum richtig, nicht spiegelverkehrt als Tag/Monat', async () => {
    // 07/01/2026 ist der 1. Juli, nicht der 7. Januar - genau der Fehler,
    // den die grosszuegige TT.MM.-Erkennung des generischen Imports machen
    // wuerde, haette der Adapter nicht selbst umgerechnet.
    const csv = 'ReservationNo,RoomType,CheckIn,CheckOut,GuestName,TotalAmount,Channel\r\n'
              + 'PR-1,SUI,07/01/2026,07/05/2026,"Fischer, Anna",980.00,Direct\r\n'
    const { bericht } = await importieren('protel', csv, true)
    expect(bericht.imported).toBe(1)

    const b = await owner.query(
      `SELECT r.arrival::text, r.departure::text, g.last_name, g.first_name
         FROM booking b JOIN reservation r ON r.booking_id = b.id
         LEFT JOIN guest g ON g.id = r.primary_guest_id
        WHERE b.property_id = $1`, [fx.propertyId])
    expect(b.rows[0]).toMatchObject({
      arrival: '2026-07-01', departure: '2026-07-05',
      last_name: 'Fischer', first_name: 'Anna'
    })
  })
})

describe('Stichtagsmigration im Massstab', () => {
  it('uebernimmt 5000 Reservierungen ohne ueberbuchte Kategorietage', async () => {
    const catA = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
    const catB = await makeCategory(owner, fx.propertyId, { code: 'EZ' })
    await makeResources(owner, fx.propertyId, catA, 40, 'A-')
    await makeResources(owner, fx.propertyId, catB, 40, 'B-')
    await owner.query(`SELECT inventory_materialize($1,'2026-01-01'::date,'2027-06-01'::date)`,
      [fx.propertyId])

    const ZEILEN = 5000
    const TAGE = 350
    const start = new Date('2026-01-05T00:00:00Z')
    const zeilen: string[] = [
      'Belegnummer;Zimmerkategorie;Anreise;Abreise;Nachname;Vorname;Gesamtpreis;Herkunft']
    for (let i = 0; i < ZEILEN; i++) {
      const kategorie = i % 2 === 0 ? 'DZ' : 'EZ'
      const ankunft = new Date(start)
      ankunft.setUTCDate(ankunft.getUTCDate() + (i % TAGE))
      const abreise = new Date(ankunft)
      abreise.setUTCDate(abreise.getUTCDate() + 1 + (i % 2))
      const fmt = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}.`
        + `${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`
      zeilen.push(`ALT-${i};${kategorie};${fmt(ankunft)};${fmt(abreise)};`
        + `Gast${i};Nachname${i};${100 + (i % 50)},00;Altsystem`)
    }
    const csv = zeilen.join('\r\n') + '\r\n'

    const begonnen = Date.now()
    const { status, bericht } = await importieren('hotline', csv, true)
    const dauerMs = Date.now() - begonnen
    console.log(`5000 Reservierungen importiert in ${dauerMs} ms`)

    expect(status).toBe(200)
    expect(bericht.rows).toBe(ZEILEN)
    expect(bericht.findings.filter(f => f.level === 'error')).toHaveLength(0)
    expect(bericht.imported).toBe(ZEILEN)

    const count = await owner.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM reservation WHERE property_id = $1`, [fx.propertyId])
    expect(Number(count.rows[0]!.n)).toBe(ZEILEN)

    // Kein Kategorietag darf mehr verkauft als Kapazitaet zeigen: der
    // Abnahmepunkt der Aufgabe ist "ohne ueberbuchte Kategorietage", nicht
    // nur "ohne Fehler im Bericht".
    const ueberbucht = await owner.query(
      `SELECT category_id, date FROM inventory_day
        WHERE property_id = $1 AND category_id <> 0 AND sold > capacity + overbooking`,
      [fx.propertyId])
    expect(ueberbucht.rows).toHaveLength(0)
  }, 120_000)
})
