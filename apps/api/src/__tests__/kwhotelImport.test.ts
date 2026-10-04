import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import type { KwhotelImportReport, KwhotelUndoReport } from '@hotelpms/contracts'
import { addDays } from '@hotelpms/domain'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { readKwhotelDump, decimalToCent } from '../platform/legacyImport/kwhotel.js'
import { readDumpTables, DumpFormatError } from '../platform/legacyImport/mysqlDump.js'
import { roomKey } from '../routes/kwhotelImport.js'
import { FOLGEN_RESERVIERUNG, FOLGEN_FOLIO, TEIL_DER_UEBERNAHME, VERWEISE_GAST,
         VERWEISE_ZIMMER, ZUSTAND_ZIMMER, VERWEISE_GRUPPE } from '../routes/kwhotelUndo.js'

/**
 * Uebernahme aus KWHotel. Alle Namen hier sind erfunden; der echte Abzug
 * eines Hauses traegt Gastdaten und gehoert nicht ins Repository. Die Form
 * -- Spalten, Maskierung, Klammern um Stornogruende, letzte Nacht statt
 * Abreise -- ist die des echten Abzugs vom 03.10.2026.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let admin: { userId: number; sessionId: string }
let heute: string
const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

interface Zeile {
  id: number; room: number; von: string; letzte: string; cena: string
  osob?: number; kinder?: [number, number, number]; status: number
  gruppe?: number | null; gast: number; weitere?: number[]; uwagi?: string | null
  geaendert?: string
}

const q = (v: string | number | null): string =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v)
    : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r')
           .replace(/\n/g, '\\n')}'`

/** Ein Abzug in der Form, wie `mariadb-dump` ihn fuer KWHotel schreibt. */
function abzug(zeilen: Zeile[], gaeste: Array<[number, string, string | null]>,
               zimmer: Array<[number, string]> = ZIMMER): string {
  const kopf = `/*M!999999\\- enable the sandbox mode */
-- MariaDB dump 10.19  Distrib 10.6.24-MariaDB, for Win64 (AMD64)
/*!40101 SET NAMES utf8 */;

DROP TABLE IF EXISTS \`Asortyment\`;
CREATE TABLE \`Asortyment\` (
  \`AsortymentID\` int(11) NOT NULL AUTO_INCREMENT,
  \`Nazwa\` varchar(255) NOT NULL,
  PRIMARY KEY (\`AsortymentID\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;
INSERT INTO \`Asortyment\` VALUES (1,'Fruehstueck (kaputt\\'s egal');
`
  const tabelle = (name: string, spalten: string[]) =>
    `DROP TABLE IF EXISTS \`${name}\`;\nCREATE TABLE \`${name}\` (\n`
    + spalten.map(s => `  \`${s}\` varchar(255) DEFAULT NULL,`).join('\n')
    + `\n  PRIMARY KEY (\`${spalten[0]}\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;\n`
  const werte = (name: string, rows: Array<Array<string | number | null>>) =>
    rows.length === 0 ? '' :
      `INSERT INTO \`${name}\` VALUES ${rows.map(r => `(${r.map(q).join(',')})`).join(',')};\n`

  return kopf
    + tabelle('hotels', ['id', 'name']) + werte('hotels', [[1, 'Haus am Deich']])
    + tabelle('Pokoje', ['PokojID', 'Symbol', 'Opis'])
    + werte('Pokoje', zimmer.map(([id, s]) => [id, s, 'Doppelzimmer']))
    + tabelle('rooms', ['id', 'name', 'deleted'])
    + werte('rooms', zimmer.map(([id, s]) => [id, s, 0]))
    + tabelle('Klienci', ['KlientID', 'Nazwisko', 'Email', 'Countrie', 'privacy_policy'])
    // Bitfeld wie im echten Abzug: b'0' ohne Anfuehrung um den Wert.
    + (gaeste.length === 0 ? '' : `INSERT INTO \`Klienci\` VALUES ${gaeste.map(([id, n, c]) =>
        `(${id},${q(n)},NULL,${q(c)},b'0')`).join(',')};\n`)
    + tabelle('Rezerwacje', ['RezerwacjaID', 'PokojID', 'DataOd', 'DataDo', 'Cena', 'Uwagi',
                             'Osob', 'Dzieci1', 'Dzieci2', 'Dzieci3', 'KlientID', 'status_id',
                             'group_id', 'modefied_date'])
    + werte('Rezerwacje', zeilen.map(z => [z.id, z.room, `${z.von} 00:00:00`,
        `${z.letzte} 00:00:00`, z.cena, z.uwagi ?? null, z.osob ?? 2, ...(z.kinder ?? [0, 0, 0]),
        z.gast, z.status, z.gruppe ?? null, z.geaendert ?? '2026-01-02 10:00:00']))
    + tabelle('RezerwKlient', ['RezerwacjaID', 'KlientID', 'checkin'])
    + werte('RezerwKlient', zeilen.flatMap(z =>
        [z.gast, ...(z.weitere ?? [])].map(g => [z.id, g, 0])))
    + '/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n'
}

const ZIMMER: Array<[number, string]> = [[3, '01 EZ Balkon'], [4, '02 DZ'], [10, '08 FZ']]
const GAESTE: Array<[number, string, string | null]> = [
  [100, 'Deichgraf Anna', 'de'], [101, 'Wattwurm GmbH', 'DE'], [102, 'ungereinigt', 'de'],
  [103, 'Leuchtturm', null], [104, 'Möwe', 'nl']]

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

let kat: { dz: number; ez: number }
let zimmerId: Record<string, number>

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  admin = await makeUser(owner,
    { email: 'setup@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  heute = (await owner.query<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]!.d
  kat = { dz: await makeCategory(owner, fx.propertyId, { code: 'DZ' }),
          ez: await makeCategory(owner, fx.propertyId, { code: 'EZ', name: 'Einzelzimmer' }) }
  zimmerId = {}
  for (const [code, k] of [['1', kat.ez], ['2', kat.dz], ['8', kat.dz], ['9', kat.dz]] as const) {
    zimmerId[code] = (await owner.query<{ id: number }>(
      `INSERT INTO resource (property_id, category_id, code) VALUES ($1,$2,$3) RETURNING id`,
      [fx.propertyId, k, code])).rows[0]!.id
  }
  await owner.query(`SELECT inventory_materialize($1, current_date - 3, current_date + 400)`,
    [fx.propertyId])
})

const uebernehmen = async (
  data: string, extra: Record<string, unknown> = {}
): Promise<{ status: number; bericht: KwhotelImportReport }> => {
  const r = await app.inject({
    method: 'POST', url: '/v1/imports/legacy/kwhotel', headers: auth(admin.sessionId),
    payload: { propertyId: fx.propertyId, data, ...extra } })
  return { status: r.statusCode, bericht: JSON.parse(r.body) as KwhotelImportReport }
}

/** Ein kleiner Bestand: Vergangenheit, Gast im Haus, Zukunft, Gruppe, Storno, Platzhalter. */
const bestand = (): Zeile[] => [
  // abgereist, drei Naechte, 100,01 EUR: der Restcent liegt auf der letzten Nacht
  { id: 1, room: 4, von: '2024-05-01', letzte: '2024-05-03', cena: '100.0100', gast: 100,
    uwagi: 'Spaet \'an\'\r\nParkplatz' },
  // gerade im Haus
  { id: 2, room: 3, von: addDays(heute, -2), letzte: addDays(heute, 1), cena: '320.0000',
    osob: 1, gast: 103 },
  // Gruppe aus zwei Zimmern, kuenftig. Osob ist die Gesamtzahl: vier Personen,
  // davon zwei Kinder.
  { id: 3, room: 4, von: addDays(heute, 10), letzte: addDays(heute, 11), cena: '200.0000',
    osob: 4, gast: 101, gruppe: 77, kinder: [1, 0, 1], weitere: [104] },
  // widerspruechlich: zwei Personen, zwei Kinder -- es bleibt die Gesamtzahl
  { id: 4, room: 10, von: addDays(heute, 10), letzte: addDays(heute, 11), cena: '180.0000',
    gast: 101, gruppe: 77, kinder: [2, 0, 0] },
  // storniert, mit Grund in Klammern wie in KWHotel
  { id: 5, room: 10, von: addDays(heute, 20), letzte: addDays(heute, 20), cena: '0.0000',
    status: 11, gast: 104, uwagi: '{Aus persoenlichen Gruenden\r\n}' },
  // Platzhalter
  { id: 6, room: 4, von: addDays(heute, 5), letzte: addDays(heute, 5), cena: '1.0000',
    status: 10, gast: 102 }
].map(z => ({ status: 1, ...z }) as Zeile)

describe('Lesen des Abzugs', () => {
  it('liest Werte mit Maskierung, NULL und Bitfeld, ohne das SQL auszufuehren', () => {
    const t = readDumpTables(abzug(bestand(), GAESTE), ['Klienci', 'Rezerwacje'])
    expect(t.has('Asortyment')).toBe(false)
    const k = t.get('Klienci')!
    expect(k.columns).toEqual(['KlientID', 'Nazwisko', 'Email', 'Countrie', 'privacy_policy'])
    expect(k.rows[0]).toEqual(['100', 'Deichgraf Anna', null, 'de', '0'])
    const r = t.get('Rezerwacje')!
    expect(r.rows[0]![5]).toBe("Spaet 'an'\r\nParkplatz")
  })

  it('macht aus der letzten Nacht den Abreisetag und aus Cena Cent', () => {
    const b = readKwhotelDump(abzug(bestand(), GAESTE))
    expect(b.hotelName).toBe('Haus am Deich')
    const r1 = b.reservations.find(r => r.id === '1')!
    expect(r1).toMatchObject({ arrival: '2024-05-01', departure: '2024-05-04',
                               totalCent: 10001, notes: "Spaet 'an'\nParkplatz" })
    expect(b.reservations.find(r => r.id === '5')!.notes).toBe('Aus persoenlichen Gruenden')
    expect(b.reservations.find(r => r.id === '3')!).toMatchObject(
      { children: 2, groupId: '77', guestIds: ['101', '104'] })
    expect(b.guests.get('103')!.country).toBeNull()
    expect(b.guests.get('101')!.country).toBe('DE')
  })

  it('rechnet Dezimalbetraege ohne Fliesskomma', () => {
    expect(decimalToCent('625.0000')).toBe(62500)
    expect(decimalToCent('169.6000')).toBe(16960)
    expect(decimalToCent('0.0050')).toBe(1)
    expect(decimalToCent('0.0049')).toBe(0)
    expect(decimalToCent('1234567.8900')).toBe(123456789)
    expect(decimalToCent('abc')).toBeNull()
  })

  it('vergleicht Zimmernummern ohne fuehrende Null', () => {
    expect(roomKey('08 FZ')).toBe('8')
    expect(roomKey('8')).toBe('8')
    expect(roomKey('0')).toBe('0')
    expect(roomKey('Suite Nord')).toBe('suitenord')
  })

  it('weist eine andere Datei verstaendlich ab', async () => {
    expect(() => readKwhotelDump('Belegnummer;Anreise\n1;2026-01-01\n'))
      .toThrow(DumpFormatError)
    const { status, bericht } = await uebernehmen('irgendwas')
    expect(status).toBe(422)
    expect((bericht as unknown as { code: string }).code).toBe('import.kwhotel.notADump')
  })

  it('weist einen abgeschnittenen Abzug ab, statt halb zu lesen', async () => {
    const ganz = abzug(bestand(), GAESTE)
    const abgeschnitten = ganz.slice(0, ganz.indexOf("INSERT INTO `Rezerwacje`") + 60)
    const { status } = await uebernehmen(abgeschnitten)
    expect(status).toBe(422)
  })
})

describe('Trockenlauf', () => {
  it('prueft alles und schreibt nichts', async () => {
    const { status, bericht } = await uebernehmen(abzug(bestand(), GAESTE),
      { excludeGuestNames: ['Ungereinigt '] })
    expect(status).toBe(200)
    expect(bericht.dryRun).toBe(true)
    expect(bericht.findings.filter(f => f.level === 'error')).toEqual([])
    expect(bericht.counts).toMatchObject({ placeholder: 1, checkedOut: 1, inHouse: 1,
      confirmed: 2, canceled: 1, bookings: 4, groupBookings: 1, guests: 4, multiGuest: 1 })
    expect(bericht.imported).toBe(5)
    expect(bericht.rooms.map(r => [r.name, r.roomCode, r.match])).toEqual([
      ['01 EZ Balkon', '1', 'auto'], ['02 DZ', '2', 'auto'], ['08 FZ', '8', 'auto']])
    expect(bericht.frequentNames.find(n => n.name === 'ungereinigt')!.excluded).toBe(true)

    for (const t of ['reservation', 'booking', 'guest', 'folio']) {
      const n = await owner.query(`SELECT count(*)::int AS n FROM ${t}`)
      expect(n.rows[0].n, t).toBe(0)
    }
    const sold = await owner.query(`SELECT coalesce(sum(sold),0)::int AS n FROM inventory_day
                                     WHERE property_id = $1`, [fx.propertyId])
    expect(sold.rows[0].n).toBe(0)
  })

  it('nennt unbekannte Statuscodes und Zimmer ohne Gegenstueck und schreibt dann nichts',
    async () => {
      const zeilen = [...bestand(),
        { id: 7, room: 4, von: addDays(heute, 30), letzte: addDays(heute, 30), cena: '90.0000',
          status: 3, gast: 100 },
        { id: 8, room: 11, von: addDays(heute, 30), letzte: addDays(heute, 30), cena: '90.0000',
          status: 1, gast: 100 }]
      const { bericht } = await uebernehmen(
        abzug(zeilen, GAESTE, [...ZIMMER, [11, '12 Apt']]), { commit: true })
      expect(bericht.dryRun).toBe(true)
      expect(bericht.imported).toBe(0)
      const keys = bericht.findings.filter(f => f.level === 'error').map(f => f.messageKey)
      expect(keys).toEqual(['import.kwhotel.unknownStatus', 'import.kwhotel.roomUnmapped'])
      expect(bericht.findings[0]!.message).toContain('Statuscode 3')
      expect(bericht.statusCodes.find(s => s.code === 3)!.group).toBeNull()
      const n = await owner.query(`SELECT count(*)::int AS n FROM reservation`)
      expect(n.rows[0].n).toBe(0)
    })
})

describe('Uebernahme', () => {
  it('legt Vergangenheit, Haus, Zukunft, Gruppe und Storno richtig an', async () => {
    const { bericht } = await uebernehmen(abzug(bestand(), GAESTE),
      { commit: true, excludeGuestNames: ['ungereinigt'] })
    expect(bericht.dryRun).toBe(false)
    expect(bericht.imported).toBe(5)

    const r = await owner.query<{ legacy_reference: string; status: string; arrival: string
      departure: string; code: string; total: string; booking_id: string; last_name: string | null
      adults: number | null; children: number | null; guest_count: number | null
      notes: string | null; folio: number; checked_in: boolean; canceled: boolean
      booking_legacy: string | null; source: string }>(
      `SELECT r.legacy_reference, r.status, r.arrival::text, r.departure::text, u.code,
              (SELECT sum(price_cent) FROM reservation_night n WHERE n.reservation_id = r.id)::text
                AS total,
              r.booking_id::text, g.last_name, r.adults, r.children, r.guest_count, r.notes,
              (SELECT count(*)::int FROM folio f WHERE f.reservation_id = r.id) AS folio,
              r.checked_in_at IS NOT NULL AS checked_in, r.canceled_at IS NOT NULL AS canceled,
              b.legacy_reference AS booking_legacy, b.source
         FROM reservation r JOIN resource u ON u.id = r.resource_id
         JOIN booking b ON b.id = r.booking_id
         LEFT JOIN guest g ON g.id = r.primary_guest_id
        WHERE r.legacy_system = 'kwhotel' ORDER BY r.legacy_reference`)
    const z = Object.fromEntries(r.rows.map(x => [x.legacy_reference, x]))
    expect(Object.keys(z)).toEqual(['1', '2', '3', '4', '5'])

    expect(z['1']).toMatchObject({ status: 'CheckedOut', arrival: '2024-05-01',
      departure: '2024-05-04', code: '2', total: '10001', last_name: 'Deichgraf Anna',
      notes: "Spaet 'an'\nParkplatz", folio: 0, checked_in: true, source: 'import' })
    expect(z['2']).toMatchObject({ status: 'InHouse', code: '1', total: '32000', adults: 1,
      children: 0, guest_count: 1, folio: 1 })
    expect(z['3']).toMatchObject({ status: 'Confirmed', adults: 2, children: 2, guest_count: 4,
      booking_legacy: '77', last_name: 'Wattwurm GmbH' })
    expect(z['4']).toMatchObject({ adults: null, children: null, guest_count: 2 })
    expect(z['4']!.booking_id).toBe(z['3']!.booking_id)
    expect(z['5']).toMatchObject({ status: 'Canceled', canceled: true, folio: 0,
      notes: 'Aus persoenlichen Gruenden', last_name: 'Möwe' })

    // Restcent auf der letzten Nacht.
    const naechte = await owner.query<{ p: string }>(
      `SELECT n.price_cent::text AS p FROM reservation_night n
         JOIN reservation r ON r.id = n.reservation_id
        WHERE r.legacy_reference = '1' ORDER BY n.date`)
    expect(naechte.rows.map(n => n.p)).toEqual(['3333', '3333', '3335'])

    // Ein Gastprofil je KWHotel-Gast, auch wenn er zwei Zimmer gebucht hat.
    const gaeste = await owner.query(`SELECT last_name, country FROM guest ORDER BY last_name`)
    expect(gaeste.rows).toEqual([
      { last_name: 'Deichgraf Anna', country: 'DE' }, { last_name: 'Leuchtturm', country: null },
      { last_name: 'Möwe', country: 'NL' }, { last_name: 'Wattwurm GmbH', country: 'DE' }])
  })

  it('bindet nur die Naechte ab heute, und der Abgleich findet keine Abweichung', async () => {
    await uebernehmen(abzug(bestand(), GAESTE),
      { commit: true, excludeGuestNames: ['ungereinigt'] })
    // Dieselbe Abfrage wie reconcileInventory im Worker.
    const drift = await owner.query(
      `WITH gezaehlt AS (
         SELECT r.category_id, d.day::date AS date, count(*)::int AS counted
           FROM reservation r
           CROSS JOIN LATERAL generate_series(r.arrival, r.departure - 1, interval '1 day') d(day)
          WHERE r.property_id = $1 AND r.status IN ('Optional','Confirmed','InHouse')
            AND d.day >= current_date
          GROUP BY r.category_id, d.day)
       SELECT i.category_id, i.date FROM inventory_day i
         LEFT JOIN gezaehlt g ON g.category_id = i.category_id AND g.date = i.date
        WHERE i.property_id = $1 AND i.category_id <> 0 AND i.date >= current_date
          AND i.sold IS DISTINCT FROM COALESCE(g.counted, 0)`, [fx.propertyId])
    expect(drift.rows).toEqual([])
    // Die Nacht vor heute des Gastes im Haus bindet nichts.
    const gestern = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id = $1 AND category_id = $2
          AND date = current_date - 1`, [fx.propertyId, kat.ez])
    expect(gestern.rows[0]!.sold).toBe(0)
  })

  it('ueberspringt beim zweiten Lauf, was schon da ist, und haengt neue Gruppenzimmer an',
    async () => {
      await uebernehmen(abzug(bestand(), GAESTE),
        { commit: true, excludeGuestNames: ['ungereinigt'] })
      const mehr = [...bestand(),
        { id: 9, room: 3, von: addDays(heute, 10), letzte: addDays(heute, 11), cena: '150.0000',
          status: 1, gast: 101, gruppe: 77 }]
      const { bericht } = await uebernehmen(abzug(mehr, GAESTE),
        { commit: true, excludeGuestNames: ['ungereinigt'] })
      expect(bericht.imported).toBe(1)
      expect(bericht.counts.alreadyImported).toBe(5)
      expect(bericht.counts.bookings).toBe(0)
      expect(bericht.findings.map(f => f.messageKey)).toContain('import.kwhotel.alreadyImported')

      const b = await owner.query<{ n: number }>(
        `SELECT count(DISTINCT booking_id)::int AS n FROM reservation
          WHERE legacy_reference IN ('3', '4', '9')`)
      expect(b.rows[0]!.n).toBe(1)
    })

  it('folgt der Zuordnung des Hauses und laesst ein Zimmer bewusst weg', async () => {
    const { bericht } = await uebernehmen(abzug(bestand(), GAESTE), {
      commit: true, excludeGuestNames: ['ungereinigt'],
      roomMap: { 10: zimmerId['9'], 3: null } })
    expect(bericht.rooms.find(r => r.kwRoomId === '10')).toMatchObject(
      { roomCode: '9', match: 'manual' })
    expect(bericht.counts.roomSkipped).toBe(1)
    const r = await owner.query<{ code: string }>(
      `SELECT u.code FROM reservation r JOIN resource u ON u.id = r.resource_id
        WHERE r.legacy_reference = '4'`)
    expect(r.rows[0]!.code).toBe('9')
    const weg = await owner.query(`SELECT 1 FROM reservation WHERE legacy_reference = '2'`)
    expect(weg.rowCount).toBe(0)
  })

  it('nimmt kein Zimmer eines anderen Hauses an', async () => {
    const fremd = await makeProperty(owner, { code: 'FREMD' })
    const k = await makeCategory(owner, fremd.propertyId)
    const z = await owner.query<{ id: number }>(
      `INSERT INTO resource (property_id, category_id, code) VALUES ($1,$2,'2') RETURNING id`,
      [fremd.propertyId, k])
    const { status } = await uebernehmen(abzug(bestand(), GAESTE),
      { roomMap: { 4: z.rows[0]!.id } })
    expect(status).toBe(422)
  })

  it('laesst Aufenthalte vor dem Stichtag weg, wenn ein Zeitraum gesetzt ist', async () => {
    const { bericht } = await uebernehmen(abzug(bestand(), GAESTE),
      { excludeGuestNames: ['ungereinigt'], fromDate: '2025-01-01' })
    expect(bericht.counts.beforeFrom).toBe(1)
    expect(bericht.counts.checkedOut).toBe(0)
  })

  it('meldet ein ueberbuchtes Zimmer und schreibt nichts', async () => {
    // Zwei kuenftige Zeilen im einzigen Einzelzimmer, dieselbe Nacht.
    const zeilen: Zeile[] = [
      { id: 1, room: 3, von: addDays(heute, 3), letzte: addDays(heute, 3), cena: '80.0000',
        status: 1, gast: 100 },
      { id: 2, room: 3, von: addDays(heute, 3), letzte: addDays(heute, 3), cena: '80.0000',
        status: 1, gast: 103 }]
    const { bericht } = await uebernehmen(abzug(zeilen, GAESTE), { commit: true })
    expect(bericht.imported).toBe(0)
    expect(bericht.findings.map(f => f.messageKey)).toEqual(['import.kwhotel.soldOut'])
    expect(bericht.findings[0]!.reference).toBe('2')
    const n = await owner.query(`SELECT count(*)::int AS n FROM reservation`)
    expect(n.rows[0].n).toBe(0)
  })

  it('liefert die KWHotel-Nummer in der Reservierungsliste fuer das Adminpanel', async () => {
    await uebernehmen(abzug(bestand(), GAESTE),
      { commit: true, excludeGuestNames: ['ungereinigt'] })
    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/reservations`,
      headers: auth(admin.sessionId) })
    const l = JSON.parse(r.body) as { reservations: Array<Record<string, unknown>> }
    const z = l.reservations.find(x => x.legacyReference === '3')!
    expect(z).toMatchObject({ legacySystem: 'kwhotel', externalReference: null,
                              lastNight: addDays(heute, 11) })
  })

  it('findet eine Reservierung ueber ihre KWHotel-Nummer in der Suche', async () => {
    const zeilen: Zeile[] = [
      { id: 4711, room: 4, von: addDays(heute, 3), letzte: addDays(heute, 4), cena: '160.0000',
        status: 1, gast: 100 },
      { id: 47110, room: 3, von: addDays(heute, 3), letzte: addDays(heute, 4), cena: '90.0000',
        status: 1, gast: 103 }]
    await uebernehmen(abzug(zeilen, GAESTE), { commit: true })
    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/search?q=4711`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    const ref = await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM reservation WHERE legacy_reference = '4711'`)
    // Genau getroffen: 47110 beginnt mit 4711 und ist trotzdem kein Treffer.
    const treffer = (JSON.parse(r.body) as { reservations: Array<{ reservationRef: string }> })
      .reservations.map(x => x.reservationRef)
    expect(treffer).toEqual([ref.rows[0]!.public_ref])
  })
})

describe('Fehlende Zimmer', () => {
  const NEU: Array<[number, string]> = [...ZIMMER, [11, '12 Apt'], [12, '014 DZ']]
  const zeilen = (): Zeile[] => [
    { id: 1, room: 11, von: addDays(heute, 5), letzte: addDays(heute, 6), cena: '300.0000',
      osob: 3, kinder: [1, 0, 0], status: 1, gast: 100 },
    { id: 2, room: 12, von: addDays(heute, 5), letzte: addDays(heute, 5), cena: '90.0000',
      status: 1, gast: 103 }]
  const auftrag = [
    { kwRoomId: '11', code: '12',
      newCategory: { code: 'APT', name: 'Apartment', maxOccupancy: 4 } },
    { kwRoomId: '12', code: '14', categoryId: 0 }]
  const mitDz = () => auftrag.map(a => a.kwRoomId === '12' ? { ...a, categoryId: kat.dz } : a)

  it('schlaegt Nummer, Gruppe und Belegung aus KWHotel vor und legt nichts still an',
    async () => {
      const { bericht } = await uebernehmen(abzug(zeilen(), GAESTE, NEU))
      expect(bericht.rooms.find(r => r.kwRoomId === '11')).toMatchObject({
        match: 'none',
        // Osob 3 mit einem Kind sind drei Personen, nicht vier.
        suggestion: { code: '12', categoryCode: 'APT', categoryName: 'Doppelzimmer',
                      maxOccupancy: 3 } })
      expect(bericht.rooms.find(r => r.kwRoomId === '12')!.suggestion)
        .toMatchObject({ code: '14', categoryCode: 'DZ' })
      expect(bericht.findings.map(f => f.messageKey)).toContain('import.kwhotel.roomUnmapped')
      const n = await owner.query(`SELECT 1 FROM resource WHERE property_id = $1 AND code = '12'`,
        [fx.propertyId])
      expect(n.rowCount).toBe(0)
    })

  it('rollt im Trockenlauf auch die angelegten Zimmer zurueck', async () => {
    const { bericht } = await uebernehmen(abzug(zeilen(), GAESTE, NEU),
      { createRooms: mitDz() })
    expect(bericht.dryRun).toBe(true)
    expect(bericht.findings.filter(f => f.level === 'error')).toEqual([])
    expect(bericht.imported).toBe(2)
    expect(bericht.rooms.find(r => r.kwRoomId === '11'))
      .toMatchObject({ match: 'created', roomCode: '12' })
    const z = await owner.query(`SELECT 1 FROM resource WHERE property_id = $1
                                    AND code IN ('12', '14')`, [fx.propertyId])
    expect(z.rowCount).toBe(0)
    const k = await owner.query(`SELECT 1 FROM resource_category WHERE code = 'APT'`)
    expect(k.rowCount).toBe(0)
  })

  it('legt Zimmer in neuer und vorhandener Gruppe an und bindet ihre Reservierungen',
    async () => {
      const { bericht } = await uebernehmen(abzug(zeilen(), GAESTE, NEU),
        { commit: true, createRooms: mitDz() })
      expect(bericht.dryRun).toBe(false)
      expect(bericht.imported).toBe(2)
      const z = await owner.query<{ code: string; kat: string; occ: number }>(
        `SELECT u.code, k.code AS kat, k.max_occupancy AS occ
           FROM resource u JOIN resource_category k ON k.id = u.category_id
          WHERE u.property_id = $1 AND u.code IN ('12', '14') ORDER BY u.code`, [fx.propertyId])
      expect(z.rows).toEqual([{ code: '12', kat: 'APT', occ: 4 },
                              { code: '14', kat: 'DZ', occ: z.rows[1]!.occ }])
      const r = await owner.query<{ code: string }>(
        `SELECT u.code FROM reservation r JOIN resource u ON u.id = r.resource_id
          WHERE r.legacy_reference = '1'`)
      expect(r.rows[0]!.code).toBe('12')
      // Die neue Gruppe hat Bestand bekommen, und die Reservierung haelt ihn.
      const sold = await owner.query<{ n: number }>(
        `SELECT coalesce(sum(d.sold), 0)::int AS n FROM inventory_day d
           JOIN resource_category k ON k.id = d.category_id
          WHERE k.code = 'APT' AND d.property_id = $1`, [fx.propertyId])
      expect(sold.rows[0]!.n).toBe(2)
    })

  it('uebernimmt den Zimmernamen aus KWHotel und laesst einen geleerten weg', async () => {
    const { bericht } = await uebernehmen(abzug(zeilen(), GAESTE, NEU),
      { commit: true,
        createRooms: [{ ...auftrag[0]!, name: '  12   Apt ' },
                      { ...mitDz()[1]!, name: '' }] })
    // Der Vorschlag traegt den Namen schon, damit die Oberflaeche ihn vorbelegt.
    expect(bericht.rooms.find(r => r.kwRoomId === '11')!.suggestion)
      .toMatchObject({ name: '12 Apt' })
    const z = await owner.query<{ code: string; name: string | null }>(
      `SELECT code, name FROM resource WHERE property_id = $1 AND code IN ('12', '14')
        ORDER BY code`, [fx.propertyId])
    expect(z.rows).toEqual([{ code: '12', name: '12 Apt' }, { code: '14', name: null }])
  })

  it('meldet eine vergebene Nummer und ein vorhandenes Gruppenkuerzel und schreibt nichts',
    async () => {
      const { bericht } = await uebernehmen(abzug(zeilen(), GAESTE, NEU), {
        commit: true,
        createRooms: [
          { kwRoomId: '11', code: '2',
            newCategory: { code: 'dz', name: 'Noch ein DZ', maxOccupancy: 2 } },
          { kwRoomId: '12', code: '14', categoryId: kat.dz }] })
      expect(bericht.dryRun).toBe(true)
      const keys = bericht.findings.filter(f => f.level === 'error').map(f => f.messageKey)
      expect(keys).toContain('import.kwhotel.roomCodeTaken')
      expect(keys).toContain('import.kwhotel.categoryCodeTaken')
      const z = await owner.query(`SELECT 1 FROM resource WHERE property_id = $1 AND code = '14'`,
        [fx.propertyId])
      expect(z.rowCount).toBe(0)
    })

  it('nimmt keine Zimmergruppe eines anderen Hauses an', async () => {
    const fremd = await makeProperty(owner, { code: 'FREMD' })
    const k = await makeCategory(owner, fremd.propertyId)
    const { status } = await uebernehmen(abzug(zeilen(), GAESTE, NEU), {
      createRooms: auftrag.map(a => a.kwRoomId === '12' ? { ...a, categoryId: k } : a) })
    expect(status).toBe(422)
  })
})

describe('Uebernahme zuruecknehmen', () => {
  const NEU: Array<[number, string]> = [...ZIMMER, [11, '12 Apt']]
  const zeilen = (): Zeile[] => [...bestand(),
    { id: 20, room: 11, von: addDays(heute, 5), letzte: addDays(heute, 6), cena: '300.0000',
      status: 1, gast: 100 }]
  const zuruecknehmen = async (commit = false) => {
    const r = await app.inject({
      method: 'POST', url: '/v1/imports/legacy/kwhotel/undo',
      headers: auth(admin.sessionId), payload: { propertyId: fx.propertyId, commit } })
    expect(r.statusCode, r.body).toBe(200)
    return JSON.parse(r.body) as KwhotelUndoReport
  }
  const stand = async () => (await owner.query<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM reservation) AS res,
            (SELECT count(*)::int FROM booking) AS buchungen,
            (SELECT count(*)::int FROM guest) AS gaeste,
            (SELECT count(*)::int FROM folio) AS folios,
            (SELECT count(*)::int FROM resource WHERE property_id = $1) AS zimmer,
            (SELECT count(*)::int FROM resource_category WHERE property_id = $1) AS gruppen,
            (SELECT coalesce(sum(sold), 0)::int FROM inventory_day WHERE property_id = $1) AS sold`,
    [fx.propertyId])).rows[0]!

  beforeEach(async () => {
    // Ein Gast und eine Buchung, die schon vorher im Haus waren, bleiben.
    await owner.query(
      `INSERT INTO guest (account_id, public_ref, last_name) VALUES ($1, 'VORHER0000001', 'Vorher')`,
      [fx.accountId])
  })

  it('nimmt im Trockenlauf nichts zurueck und nennt, was ginge', async () => {
    const vorher = await stand()
    const { bericht } = await uebernehmen(abzug(zeilen(), GAESTE, NEU), {
      commit: true, excludeGuestNames: ['ungereinigt'],
      createRooms: [{ kwRoomId: '11', code: '12',
                      newCategory: { code: 'APT', name: 'Apartment', maxOccupancy: 4 } }] })
    expect(bericht.dryRun).toBe(false)
    const danach = await stand()

    const z = await zuruecknehmen()
    expect(z.dryRun).toBe(true)
    expect(z.findings).toEqual([])
    expect(z.runs).toHaveLength(1)
    expect(z.counts).toMatchObject({ reservations: 6, rooms: 1, categories: 1,
                                     roomsKept: 0, categoriesKept: 0, guestsKept: 0 })
    expect(z.counts.guests).toBe(danach.gaeste! - vorher.gaeste!)
    expect(await stand()).toEqual(danach)
  })

  it('stellt den Stand vor der Uebernahme wieder her, und ein Neuimport geht', async () => {
    const vorher = await stand()
    await uebernehmen(abzug(zeilen(), GAESTE, NEU), {
      commit: true, excludeGuestNames: ['ungereinigt'],
      createRooms: [{ kwRoomId: '11', code: '12',
                      newCategory: { code: 'APT', name: 'Apartment', maxOccupancy: 4 } }] })

    const z = await zuruecknehmen(true)
    expect(z.dryRun).toBe(false)
    expect(await stand()).toEqual(vorher)
    const vorhanden = await owner.query(`SELECT 1 FROM guest WHERE public_ref = 'VORHER0000001'`)
    expect(vorhanden.rowCount).toBe(1)

    const neu = await uebernehmen(abzug(zeilen(), GAESTE, NEU), {
      commit: true, excludeGuestNames: ['ungereinigt'],
      createRooms: [{ kwRoomId: '11', code: '12',
                      newCategory: { code: 'APT', name: 'Apartment', maxOccupancy: 4 } }] })
    expect(neu.bericht.counts.alreadyImported).toBe(0)
    expect(neu.bericht.imported).toBe(6)
  })

  it('weigert sich, sobald an der Uebernahme gearbeitet wurde', async () => {
    await uebernehmen(abzug(zeilen(), GAESTE, NEU), {
      commit: true, excludeGuestNames: ['ungereinigt'], roomMap: { 11: null } })
    const vorher = await stand()
    await owner.query(
      `INSERT INTO reservation_occupant (property_id, reservation_id)
       SELECT property_id, id FROM reservation WHERE legacy_reference = '3'`)
    const z = await zuruecknehmen(true)
    expect(z.dryRun).toBe(true)
    expect(z.findings.map(f => [f.messageKey, f.params])).toEqual(
      [['import.undo.blocked', { table: 'reservation_occupant', count: 1 }]])
    expect(await stand()).toEqual(vorher)
  })

  it('sagt, wenn es nichts zurueckzunehmen gibt', async () => {
    const z = await zuruecknehmen(true)
    expect(z.findings.map(f => f.messageKey)).toEqual(['import.undo.nothing'])
  })

  it('kennt jeden Verweis der Datenbank auf das, was sie entfernt', async () => {
    /*
     * Kommt eine Tabelle mit einem Verweis auf eine Reservierung, ein
     * Folio, einen Gast, ein Zimmer oder eine Zimmergruppe dazu, muss die
     * Ruecknahme sie kennen: als Folgedaten, die sie aufhalten, oder als
     * Teil dessen, was sie entfernt. Sonst entfernt sie still, was niemand
     * zuruecknehmen wollte, oder scheitert an einem Fremdschluessel.
     */
    const fk = await owner.query<{ ziel: string; von: string; spalte: string }>(
      `SELECT c.confrelid::regclass::text AS ziel, c.conrelid::regclass::text AS von,
              a.attname AS spalte
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND NOT c.conrelid::regclass::text ~ '_[0-9]{4}_[0-9]{2}$'
          AND c.confrelid::regclass::text IN
              ('reservation', 'folio', 'guest', 'resource', 'resource_category')`)
    const bekannt = (ziel: string, von: string, spalte: string): boolean => {
      switch (ziel) {
        case 'reservation': return (FOLGEN_RESERVIERUNG as readonly string[]).includes(von)
          || (TEIL_DER_UEBERNAHME as readonly string[]).includes(von)
        case 'folio': return (FOLGEN_FOLIO as readonly string[]).includes(von)
        case 'guest': return VERWEISE_GAST.some(([t, s]) => t === von && s === spalte)
        case 'resource': return VERWEISE_ZIMMER.some(([t, s]) => t === von && s === spalte)
          || (ZUSTAND_ZIMMER as readonly string[]).includes(von)
        default: return VERWEISE_GRUPPE.some(([t, s]) => t === von && s === spalte)
      }
    }
    expect(fk.rows.filter(f => !bekannt(f.ziel, f.von, f.spalte))).toEqual([])
  })
})
