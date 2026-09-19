import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { parseCsv, toRecords } from '../platform/csv.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

interface Bericht {
  dryRun: boolean; rows: number; imported: number; skipped: number
  findings: Array<{ row: number; level: string; message: string }>
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
  art: string, csv: string, commit = false
): Promise<{ status: number; bericht: Bericht }> => {
  const r = await app.inject({
    method: 'POST', url: `/v1/imports/${art}`, headers: auth(admin.sessionId),
    payload: { propertyId: fx.propertyId, csv, commit } })
  return { status: r.statusCode, bericht: JSON.parse(r.body) as Bericht }
}

describe('CSV-Leser', () => {
  it('liest Anfuehrungszeichen, verdoppelte Zeichen und Zeilenumbrueche im Feld', () => {
    const { header, rows } = parseCsv(
      'a;b;c\r\n1;"zwei;drei";"er sagte ""hallo"""\r\n4;"Zeile1\nZeile2";6\r\n')
    expect(header).toEqual(['a', 'b', 'c'])
    expect(rows[0]).toEqual(['1', 'zwei;drei', 'er sagte "hallo"'])
    expect(rows[1]![1]).toBe('Zeile1\nZeile2')
  })

  it('erkennt Komma als Trennzeichen und entfernt die Byte-Reihenfolge-Markierung', () => {
    const { header, rows } = parseCsv('﻿code,name\r\nDZ,Doppelzimmer\r\n')
    expect(header).toEqual(['code', 'name'])
    expect(rows[0]).toEqual(['DZ', 'Doppelzimmer'])
  })

  it('nennt fehlende Pflichtspalten beim Namen', () => {
    const { header, rows } = parseCsv('code;beschreibung\r\nDZ;gross\r\n')
    expect(() => toRecords(header, rows, ['code', 'name']))
      .toThrow(/Fehlende Spalten: name/)
  })
})

describe('Import', () => {
  it('schreibt im Trockenlauf nichts, meldet aber alles', async () => {
    const { status, bericht } = await importieren('categories',
      'code;name;max_occupancy\r\nDZ;Doppelzimmer;2\r\nEZ;Einzelzimmer;1\r\n')
    expect(status).toBe(200)
    expect(bericht.dryRun).toBe(true)
    expect(bericht.rows).toBe(2)
    expect(bericht.imported).toBe(2)

    const da = await owner.query(
      `SELECT 1 FROM resource_category WHERE property_id = $1`, [fx.propertyId])
    expect(da.rowCount).toBe(0)
  })

  it('uebernimmt mit commit und legt die Kategorien an', async () => {
    const { bericht } = await importieren('categories',
      'code;name;max_occupancy\r\nDZ;Doppelzimmer;2\r\nEZ;Einzelzimmer;1\r\n', true)
    expect(bericht.dryRun).toBe(false)
    expect(bericht.imported).toBe(2)

    const da = await owner.query<{ code: string; max_occupancy: number }>(
      `SELECT code, max_occupancy FROM resource_category WHERE property_id = $1
        ORDER BY code`, [fx.propertyId])
    expect(da.rows.map(r => r.code)).toEqual(['DZ', 'EZ'])
    expect(da.rows[0]!.max_occupancy).toBe(2)
  })

  it('bindet das Kontingent ueber dieselbe Funktion wie die Oberflaeche', async () => {
    const catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
    await makeResources(owner, fx.propertyId, catId, 3)
    await owner.query(`SELECT inventory_materialize($1,'2026-06-01'::date,'2027-01-01'::date)`,
      [fx.propertyId])

    const { bericht } = await importieren('reservations',
      'external_reference;category_code;arrival;departure;total_price;guest_last_name\r\n'
      + 'ALT-1001;DZ;01.07.2026;05.07.2026;480,00;Petersen\r\n', true)
    expect(bericht.imported).toBe(1)

    const inv = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2
         AND date='2026-07-01'`, [fx.propertyId, catId])
    expect(inv.rows[0]!.sold).toBe(1)

    // Auch die Haussumme, sonst faellt der Hausueberbuchungsschutz aus.
    const haus = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=0
         AND date='2026-07-01'`, [fx.propertyId])
    expect(haus.rows[0]!.sold).toBe(1)
  })

  it('verteilt den Gesamtpreis cent-genau auf die Naechte', async () => {
    const catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
    await makeResources(owner, fx.propertyId, catId, 2)
    await owner.query(`SELECT inventory_materialize($1,'2026-06-01'::date,'2027-01-01'::date)`,
      [fx.propertyId])

    // 100,00 Euro auf drei Naechte: 3334 + 3333 + 3333 = 10000.
    await importieren('reservations',
      'external_reference;category_code;arrival;departure;total_price\r\n'
      + 'ALT-2001;DZ;2026-07-01;2026-07-04;100,00\r\n', true)

    const n = await owner.query<{ price_cent: number }>(
      `SELECT price_cent FROM reservation_night WHERE property_id = $1 ORDER BY date`,
      [fx.propertyId])
    expect(n.rows.map(r => r.price_cent)).toEqual([3334, 3333, 3333])
    expect(n.rows.reduce((s, r) => s + r.price_cent, 0)).toBe(10_000)
  })

  it('uebernimmt gar nichts, wenn eine einzige Zeile fehlerhaft ist', async () => {
    const catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
    await makeResources(owner, fx.propertyId, catId, 3)
    await owner.query(`SELECT inventory_materialize($1,'2026-06-01'::date,'2027-01-01'::date)`,
      [fx.propertyId])

    const { bericht } = await importieren('reservations',
      'external_reference;category_code;arrival;departure;total_price\r\n'
      + 'ALT-3001;DZ;01.07.2026;05.07.2026;480,00\r\n'
      + 'ALT-3002;XX;01.07.2026;05.07.2026;480,00\r\n'
      + 'ALT-3003;DZ;05.07.2026;01.07.2026;480,00\r\n', true)

    expect(bericht.imported).toBe(0)
    expect(bericht.findings.filter(f => f.level === 'error')).toHaveLength(2)
    expect(bericht.findings[0]!.message).toContain('Kategorie XX gibt es nicht')

    // Auch die fehlerfreie erste Zeile ist nicht angekommen.
    const r = await owner.query(`SELECT 1 FROM reservation WHERE property_id = $1`,
      [fx.propertyId])
    expect(r.rowCount).toBe(0)
    const inv = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=$2
         AND date='2026-07-01'`, [fx.propertyId, catId])
    expect(inv.rows[0]!.sold).toBe(0)
  })

  it('meldet fehlendes Kontingent statt still zu ueberbuchen', async () => {
    const catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
    await makeResources(owner, fx.propertyId, catId, 1)
    await owner.query(`SELECT inventory_materialize($1,'2026-06-01'::date,'2027-01-01'::date)`,
      [fx.propertyId])

    const { bericht } = await importieren('reservations',
      'external_reference;category_code;arrival;departure\r\n'
      + 'ALT-4001;DZ;2026-07-01;2026-07-03\r\n'
      + 'ALT-4002;DZ;2026-07-01;2026-07-03\r\n')
    expect(bericht.findings.some(f => f.message.includes('Kein Kontingent frei'))).toBe(true)
  })

  it('ueberspringt eine bereits importierte Referenz beim zweiten Lauf', async () => {
    const catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
    await makeResources(owner, fx.propertyId, catId, 3)
    await owner.query(`SELECT inventory_materialize($1,'2026-06-01'::date,'2027-01-01'::date)`,
      [fx.propertyId])
    const csv = 'external_reference;category_code;arrival;departure\r\n'
              + 'ALT-5001;DZ;2026-07-01;2026-07-03\r\n'

    await importieren('reservations', csv, true)
    const { bericht } = await importieren('reservations', csv, true)
    expect(bericht.imported).toBe(0)
    expect(bericht.findings[0]!.message).toContain('Bereits importiert')

    const anzahl = await owner.query(
      `SELECT 1 FROM reservation WHERE property_id = $1`, [fx.propertyId])
    expect(anzahl.rowCount).toBe(1)
  })

  it('legt Gaeste an und erkennt eine vorhandene E-Mail', async () => {
    const csv = 'last_name;first_name;email;city;country\r\n'
              + 'Sonnenschein;Anke;anke@example.de;Husum;DE\r\n'
              + 'Petersen;Jan;;Flensburg;DE\r\n'
    await importieren('guests', csv, true)
    const { bericht } = await importieren('guests', csv, true)
    // Anke hat eine E-Mail und wird erkannt, Jan nicht und wird angelegt.
    expect(bericht.imported).toBe(1)
    expect(bericht.findings[0]!.message).toContain('E-Mail existiert')
  })

  /*
   * Die Kategorien- und Gaesteuebernahme laufen mengenbasiert (Performanceaudit):
   * eine Anweisung fuer die ganze Datei statt einer je Zeile. Genau an
   * Dubletten *innerhalb* derselben Datei -- nicht gegen die Datenbank --
   * zeigt sich, ob die Aggregation noch dieselbe "erste gewinnt"-Regel
   * durchsetzt wie die alte Schleife.
   */
  it('laesst bei doppeltem Kategoriecode in derselben Datei nur den ersten gewinnen', async () => {
    const { bericht } = await importieren('categories',
      'code;name;max_occupancy\r\nDZ;Erste Fassung;2\r\nDZ;Zweite Fassung;2\r\n'
      + 'EZ;Einzelzimmer;1\r\n', true)
    expect(bericht.imported).toBe(2)
    expect(bericht.findings).toHaveLength(1)
    expect(bericht.findings[0]!.row).toBe(3)
    expect(bericht.findings[0]!.message).toBe('Kategorie existiert bereits')

    const da = await owner.query<{ code: string; name: string }>(
      `SELECT code, name FROM resource_category WHERE property_id = $1 AND code = 'DZ'`,
      [fx.propertyId])
    expect(da.rows).toHaveLength(1)
    expect(da.rows[0]!.name).toBe('Erste Fassung')
  })

  it('laesst bei doppelter E-Mail in derselben Datei nur den ersten Gast gewinnen', async () => {
    const { bericht } = await importieren('guests',
      'last_name;email\r\nZuerst;doppel@example.de\r\nDanach;Doppel@Example.de\r\n', true)
    expect(bericht.imported).toBe(1)
    expect(bericht.findings).toHaveLength(1)
    expect(bericht.findings[0]!.row).toBe(3)
    expect(bericht.findings[0]!.message).toContain('E-Mail existiert')

    const da = await owner.query<{ last_name: string }>(
      `SELECT last_name FROM guest WHERE account_id = $1 AND lower(email) = 'doppel@example.de'`,
      [fx.accountId])
    expect(da.rows).toHaveLength(1)
    expect(da.rows[0]!.last_name).toBe('Zuerst')
  })

  it('weist eine unlesbare Datei mit Zeilennummer ab', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/imports/categories', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, csv: 'code;name\r\nDZ;"offen\r\n' } })
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).detail).toContain('nicht geschlossen')
  })

  it('liefert Spaltenvorlagen mit Beispiel', async () => {
    const r = await app.inject({
      method: 'GET', url: '/v1/imports/templates', headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    const v = JSON.parse(r.body) as { reservations: { required: string[]; example: string } }
    expect(v.reservations.required).toContain('external_reference')
    expect(v.reservations.example).toContain('01.07.2026')
  })
})
