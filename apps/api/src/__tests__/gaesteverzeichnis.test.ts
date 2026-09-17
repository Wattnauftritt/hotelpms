import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Das Gaesteverzeichnis, der Nachweis fuer den Gaestebeitrag.
 *
 * Kommunale Satzungen verlangen ihn als Nachweis, nicht als Auskunft --
 * die Stadt Cuxhaven "tagaktuell und kontrollfaehig", quartalsweise
 * uebermittelt, sechs Jahre aufbewahrt, mit Geldbusse bei Verstoss.
 *
 * Geprueft wird vor allem das, was still falsch waere: eine Neuberechnung
 * statt der gebuchten Betraege, eine Gegenbuchung, die nicht mitzaehlt, und
 * ein Nachweis aus Uebungsdaten, der an eine Behoerde ginge.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let rooms: number[]
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
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  rooms = await makeResources(owner, fx.propertyId, catId, 4)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

/** Kurtaxe, 2,50 je Person und Nacht, Kinder unter 16 frei. */
async function regel(kind = 'city_tax', code = 'KURTAXE'): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `INSERT INTO tax_rule (property_id, code, name, kind, basis, amount_cent,
                           exempt_below_age, exempt_business)
     VALUES ($1,$2,$3,$4,'per_person_night',250,16,true) RETURNING id`,
    [fx.propertyId, code, code === 'KURTAXE' ? 'Kurtaxe' : 'Bettensteuer', kind])
  return r.rows[0]!.id
}

/** Ein Aufenthalt mit Gast, Folio und gebuchter Abgabe -- wie der Nachtlauf sie legt. */
async function aufenthalt(opts: {
  nachname: string; regelId: number; naechte?: number; betragCent?: number
  businessTrip?: boolean; zimmer?: number
}): Promise<string> {
  const g = await owner.query<{ id: number }>(
    `INSERT INTO guest (account_id, last_name, first_name, address_line1,
                        postal_code, city, country)
     VALUES ($1,$2,'Anke','Deichweg 3','25980','Westerland','DE') RETURNING id`,
    [fx.accountId, opts.nachname])
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: catId, arrival: VON, departure: BIS,
    status: 'CheckedOut', resourceId: rooms[opts.zimmer ?? 0]! })
  await owner.query(
    `UPDATE reservation SET primary_guest_id = $2, business_trip = $3 WHERE id = $1`,
    [res.reservationId, g.rows[0]!.id, opts.businessTrip ?? false])
  const f = await owner.query<{ id: number }>(
    `INSERT INTO folio (property_id, reservation_id, guest_id, kind)
     VALUES ($1,$2,$3,'guest') RETURNING id`,
    [fx.propertyId, res.reservationId, g.rows[0]!.id])

  for (let i = 0; i < (opts.naechte ?? 3); i++) {
    const tag = new Date(Date.parse(VON) + i * 86400_000).toISOString().slice(0, 10)
    await owner.query(
      `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp,
                           revenue_account, reservation_id, tax_rule_id)
       VALUES ($1,$2,$3::date,'Kurtaxe',2,$4,0,$4,0,'8300',$5,$6)`,
      [fx.propertyId, f.rows[0]!.id, tag, opts.betragCent ?? 500,
       res.reservationId, opts.regelId])
  }
  const ref = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [res.reservationId])
  return ref.rows[0]!.public_ref
}

const holen = (extra = '') =>
  app.inject({ method: 'GET', headers: auth,
    url: `/v1/properties/${fx.propertyId}/exports/guest-levy`
       + `?from=2026-10-01&to=2026-10-31${extra}` })

interface Zeile {
  reservationRef: string; lastName: string; nights: number; persons: number
  amountCent: string; levyName: string; businessTrip: boolean; exemptChildren: number
  postalCode: string; city: string
}

describe('Das Verzeichnis', () => {
  it('fuehrt je Aufenthalt eine Zeile mit Anschrift, Naechten und Betrag', async () => {
    const id = await regel()
    await aufenthalt({ nachname: 'Petersen', regelId: id })

    const r = await holen()
    expect(r.statusCode, r.body).toBe(200)
    const body = JSON.parse(r.body) as {
      rows: Zeile[]; totals: { rows: number; nights: number; amountCent: number } }

    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({
      lastName: 'Petersen', postalCode: '25980', city: 'Westerland',
      nights: 3, persons: 2, levyName: 'Kurtaxe', amountCent: '1500' })
    expect(body.totals).toEqual({ rows: 1, nights: 3, amountCent: 1500 })
  })

  /**
   * Zwei Abgaben nebeneinander sind zwei Satzungen. Sie in eine Zeile zu
   * summieren hiesse, zwei Gemeinden dieselbe Zahl zu schicken.
   */
  it('trennt Kurtaxe und Bettensteuer in eigene Zeilen', async () => {
    const kur = await regel('city_tax', 'KURTAXE')
    const bett = await regel('bed_tax', 'BETT')
    const g = await owner.query<{ id: number }>(
      `INSERT INTO guest (account_id, last_name) VALUES ($1,'Petersen') RETURNING id`,
      [fx.accountId])
    const res = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: VON, departure: BIS,
      status: 'CheckedOut', resourceId: rooms[0]! })
    await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
      [res.reservationId, g.rows[0]!.id])
    const f = await owner.query<{ id: number }>(
      `INSERT INTO folio (property_id, reservation_id, guest_id, kind)
       VALUES ($1,$2,$3,'guest') RETURNING id`,
      [fx.propertyId, res.reservationId, g.rows[0]!.id])
    for (const [regelId, betrag] of [[kur, 500], [bett, 300]]) {
      await owner.query(
        `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                             net_cent, tax_cent, gross_cent, tax_rate_bp,
                             revenue_account, reservation_id, tax_rule_id)
         VALUES ($1,$2,'2026-10-01'::date,'Abgabe',2,$3,0,$3,0,'8300',$4,$5)`,
        [fx.propertyId, f.rows[0]!.id, betrag, res.reservationId, regelId])
    }

    const body = JSON.parse((await holen()).body) as { rows: Zeile[] }
    expect(body.rows.map(z => z.levyName).sort()).toEqual(['Bettensteuer', 'Kurtaxe'])
  })

  /**
   * Gerechnet wird aus den gebuchten Positionen, nicht aus der Regel. Ein
   * Satz, der zum Jahreswechsel gestiegen ist, machte aus einer
   * Neuberechnung eine plausibel aussehende falsche Zahl -- und der Nachweis
   * muss zu der Rechnung passen, die der Gast bekommen hat.
   */
  it('nimmt den damals gebuchten Betrag, auch wenn die Regel inzwischen anders lautet', async () => {
    const id = await regel()
    await aufenthalt({ nachname: 'Petersen', regelId: id, betragCent: 400 })
    // Der Satz steigt -- der Nachweis darf sich davon nicht ruehren.
    await owner.query(`UPDATE tax_rule SET amount_cent = 900 WHERE id = $1`, [id])

    const body = JSON.parse((await holen()).body) as { rows: Zeile[] }
    expect(body.rows[0]!.amountCent).toBe('1200')
  })

  it('zaehlt eine Gegenbuchung mit ihrem Vorzeichen und laesst die Zeile verschwinden', async () => {
    const id = await regel()
    const ref = await aufenthalt({ nachname: 'Petersen', regelId: id })
    const f = await owner.query<{ id: number; res: number }>(
      `SELECT f.id, f.reservation_id AS res FROM folio f
         JOIN reservation r ON r.id = f.reservation_id WHERE r.public_ref = $1`, [ref])
    // Storniert: drei Gegenbuchungen ueber denselben Betrag.
    for (let i = 0; i < 3; i++) {
      const tag = new Date(Date.parse(VON) + i * 86400_000).toISOString().slice(0, 10)
      await owner.query(
        `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                             net_cent, tax_cent, gross_cent, tax_rate_bp,
                             revenue_account, reservation_id, tax_rule_id)
         VALUES ($1,$2,$3::date,'Storno Kurtaxe',2,-500,0,-500,0,'8300',$4,$5)`,
        [fx.propertyId, f.rows[0]!.id, tag, f.rows[0]!.res, id])
    }

    const body = JSON.parse((await holen()).body) as { rows: Zeile[] }
    expect(body.rows).toHaveLength(0)
  })

  it('haelt Geschaeftsreise und befreite Kinder als eigene Spalten fest', async () => {
    const id = await regel()
    const ref = await aufenthalt({ nachname: 'Petersen', regelId: id, businessTrip: true })
    const res = await owner.query<{ id: number }>(
      `SELECT id FROM reservation WHERE public_ref = $1`, [ref])
    await owner.query(
      `INSERT INTO reservation_occupant (property_id, reservation_id, age_at_arrival)
       VALUES ($1,$2,8), ($1,$2,42)`, [fx.propertyId, res.rows[0]!.id])

    const body = JSON.parse((await holen()).body) as { rows: Zeile[] }
    expect(body.rows[0]).toMatchObject({ businessTrip: true, exemptChildren: 1 })
  })

  it('nimmt nur Positionen des angefragten Zeitraums', async () => {
    const id = await regel()
    await aufenthalt({ nachname: 'Petersen', regelId: id })

    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/exports/guest-levy`
         + `?from=2026-11-01&to=2026-11-30` })
    expect(JSON.parse(r.body).rows).toHaveLength(0)
  })
})

describe('Als Datei fuer die Gemeinde', () => {
  it('liefert CSV mit deutschen Ueberschriften, Komma und Summenzeile', async () => {
    const id = await regel()
    await aufenthalt({ nachname: 'Petersen', regelId: id })

    const r = await holen('&format=csv')
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toMatch(/text\/csv/)
    expect(String(r.headers['content-disposition'])).toMatch(/gaesteverzeichnis-/)

    const zeilen = r.body.trim().split(/\r?\n/)
    expect(zeilen[0]).toContain('Nachname')
    expect(zeilen[0]).toContain('Uebernachtungen')
    // Der Empfaenger ist eine Gemeindeverwaltung mit einer deutschen
    // Tabellenkalkulation, kein Programm.
    expect(zeilen[1]).toContain('15,00')
    expect(zeilen[zeilen.length - 1]).toContain('Summe')
  })
})

describe('Was der Nachweis nicht darf', () => {
  it('weist ein Uebungshaus ab -- eine Meldung an eine Behoerde', async () => {
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`,
      [fx.propertyId])
    const r = await holen()
    expect(r.statusCode).toBe(422)
    expect(r.body).toMatch(/Gaesteverzeichnis|Uebungsdaten/)
  })

  it('weist einen Zeitraum ohne Obergrenze ab', async () => {
    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/exports/guest-levy`
         + `?from=2020-01-01&to=2026-12-31` })
    expect(r.statusCode).toBe(422)
  })

  it('braucht das Ausgaberecht', async () => {
    const rezeption = await makeUser(owner,
      { email: 'rezeption@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const r = await app.inject({ method: 'GET',
      headers: { cookie: `hp_session=${rezeption.sessionId}` },
      url: `/v1/properties/${fx.propertyId}/exports/guest-levy`
         + `?from=2026-10-01&to=2026-10-31` })
    expect(r.statusCode).toBe(403)
  })
})
