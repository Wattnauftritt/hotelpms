import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeGuest, makeReservation, makePaymentMethod,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Die Kassenschnittstelle, geprüft auf dem Weg, den die Kasse wirklich
 * nimmt: als Maschine mit Token und Zugriffsbereichen, nicht mit der
 * Sitzung einer Rezeptionistin.
 *
 * Das Abnahmekriterium hat zwei Hälften, und die zweite ist die
 * wichtigere: ein Kassenumsatz erscheint als `charge` mit Herkunftsvermerk,
 * und es entsteht **kein** Kassenbestand und **kein** Bon. Der zweite Teil
 * lässt sich nicht durch Hinsehen prüfen, sondern nur dadurch, dass nichts
 * entsteht — deshalb zählt fast jeder Test hier auch, was *nicht* da ist.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let admin: { userId: number; sessionId: string }
let kasse: string          // Token der Kasse
let zimmer: number[]
let gastFolio: { id: number; ref: string }
let reservierung: number

const sitzung = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, never>

const TAG = '2026-10-01'

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

/** Legt einen Maschinenzugang an und holt dafuer ein Token. */
async function maschinenToken(
  scopes: string[], propertyIds?: number[]
): Promise<string> {
  const c = await app.inject({
    method: 'POST', url: '/v1/oauth-clients', headers: sitzung(admin.sessionId),
    payload: { name: 'Ladenkasse Bar', scopes, propertyIds } })
  expect(c.statusCode, c.body).toBe(201)
  const zugang = json(c) as unknown as { clientId: string; clientSecret: string }

  const t = await app.inject({
    method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: zugang.clientId, client_secret: zugang.clientSecret }).toString() })
  expect(t.statusCode, t.body).toBe(200)
  return (json(t) as unknown as { access_token: string }).access_token
}

/** Artikel der Stammdaten: Erloeskonto und Steuersatz kommen von hier. */
async function artikel(
  code: string, name: string, rateBp: number, account: string, propertyId = fx.propertyId
): Promise<void> {
  const tr = await owner.query<{ id: number }>(
    `INSERT INTO tax_rule (property_id, code, name, kind, rate_bp, basis)
     VALUES ($1, $2, $3, 'vat', $4, 'percent') RETURNING id`,
    [propertyId, `VAT${rateBp}_${code}`, `Umsatzsteuer ${rateBp / 100} Prozent`, rateBp])
  await owner.query(
    `INSERT INTO product (property_id, code, name, price_cent, tax_rule_id,
                          charge_mode, revenue_account)
     VALUES ($1,$2,$3,0,$4,'once',$5)`,
    [propertyId, code, name, tr.rows[0]!.id, account])
}

let lauf = 0
function buchen(payload: Record<string, unknown>, token = kasse, property = fx.propertyId) {
  return app.inject({
    method: 'POST', url: `/v1/properties/${property}/pos/charges`,
    headers: { ...bearer(token), 'idempotency-key': `pos-${++lauf}` },
    payload })
}

function stornieren(payload: Record<string, unknown>, token = kasse) {
  return app.inject({
    method: 'POST', url: `/v1/properties/${fx.propertyId}/pos/charges/reverse`,
    headers: { ...bearer(token), 'idempotency-key': `storno-${++lauf}` },
    payload })
}

interface ChargeRow {
  id: number; folio_id: number; description: string; net_cent: number; tax_cent: number
  gross_cent: number; tax_rate_bp: number; revenue_account: string
  source: string | null; external_reference: string | null
  reverses_id: number | null; reservation_id: number | null
}

async function positionen(propertyId = fx.propertyId): Promise<ChargeRow[]> {
  const r = await owner.query<ChargeRow>(
    `SELECT id, folio_id, description, net_cent, tax_cent, gross_cent, tax_rate_bp,
            revenue_account, source, external_reference, reverses_id, reservation_id
       FROM charge WHERE property_id = $1 ORDER BY id`, [propertyId])
  return r.rows
}

beforeEach(async () => {
  await truncateAll()
  limiters.reset()
  fx = await makeProperty(owner)
  await openBusinessDay(owner, fx.propertyId, TAG)
  const kategorie = await makeCategory(owner, fx.propertyId)
  zimmer = await makeResources(owner, fx.propertyId, kategorie, 3)   // 101, 102, 103

  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [admin.userId, fx.accountId])

  await artikel('BAR', 'Getraenke Bar', 1900, '8400')
  await artikel('FRUEH', 'Fruehstueck', 700, '8310')

  const gast = await makeGuest(owner, fx.accountId, { lastName: 'Petersen' })
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: kategorie, arrival: TAG, departure: '2026-10-04',
    status: 'InHouse', resourceId: zimmer[0]!, reserveInventory: false
  })
  reservierung = res.reservationId
  await owner.query(`UPDATE folio SET guest_id = $2 WHERE id = $1`, [res.folioId, gast.id])
  const f = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM folio WHERE id = $1`, [res.folioId])
  gastFolio = { id: res.folioId, ref: f.rows[0]!.public_ref }

  kasse = await maschinenToken(['folio:read', 'folio:post'], [fx.propertyId])
})

describe('Kasse bucht auf das Zimmer', () => {
  it('erzeugt eine Position mit Herkunftsvermerk und sonst nichts', async () => {
    const r = await buchen({
      room: '101', productCode: 'BAR', reference: 'BAR-4711',
      grossCent: 1190, description: 'Zwei Weizen'
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r)).toMatchObject({
      folioRef: gastFolio.ref, grossCent: 1190, netCent: 1000, taxCent: 190,
      taxRateBp: 1900, revenueAccount: '8400', routed: false, duplicate: false
    })

    const p = await positionen()
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({
      folio_id: gastFolio.id, description: 'Zwei Weizen',
      source: 'pos', external_reference: 'BAR-4711',
      revenue_account: '8400', tax_rate_bp: 1900
    })
    // Der Bezug zum Aufenthalt bleibt, sonst fehlte der Umsatz in jeder
    // Auswertung je Reservierung.
    expect(p[0]!.reservation_id).toBe(reservierung)

    /*
     * Der zweite Teil des Abnahmekriteriums: kein Kassenbestand, kein Bon.
     * Ein Zimmerbon ist keine Zahlung, sondern ihre Verschiebung -- der
     * Gast zahlt beim Check-out. Entstuende hier ein Zahlungsvermerk, waere
     * das System das kassierende und fiele unter § 146a AO.
     */
    const zahlungen = await owner.query(
      `SELECT count(*)::int AS n FROM settlement WHERE property_id = $1`, [fx.propertyId])
    expect(zahlungen.rows[0]!.n).toBe(0)
  })

  /**
   * Eine Kasse rechnet brutto: die Karte ist brutto ausgezeichnet. Rechnete
   * sie selbst um, stünde auf der Hotelrechnung ein anderer Betrag als auf
   * dem Beleg in der Tasche des Gastes.
   */
  it('teilt den Bruttobetrag in netto und Steuer', async () => {
    await buchen({ room: '101', productCode: 'FRUEH', reference: 'F-1', grossCent: 1000 })
    const p = await positionen()
    // 10,00 brutto zu 7 Prozent: 9,35 netto und 0,65 Steuer.
    expect(p[0]).toMatchObject({ net_cent: 935, tax_cent: 65, gross_cent: 1000 })
  })

  /**
   * Der Satz der Kasse gewinnt: dasselbe Getränk ist im Haus 19 und außer
   * Haus 7 Prozent, und die Kasse weiß, was der Gast getan hat.
   */
  it('laesst die Kasse den Steuersatz uebersteuern', async () => {
    await buchen({ room: '101', productCode: 'BAR', reference: 'BAR-1',
                   grossCent: 1070, taxRateBp: 700 })
    const p = await positionen()
    expect(p[0]).toMatchObject({ tax_rate_bp: 700, net_cent: 1000, tax_cent: 70 })
  })

  /**
   * Kein stilles Ausweichkonto. Ein Getränkeumsatz auf dem Logiskonto
   * fälschte ADR und RevPAR — derselbe Fehler, der bei der No-Show-Gebühr
   * schon einmal drohte.
   */
  it('weist einen unbekannten Artikel ab, statt auf ein Standardkonto zu buchen', async () => {
    const r = await buchen({ room: '101', productCode: 'WELLNESS', reference: 'W-1',
                             grossCent: 5000 })
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).detail).toContain('WELLNESS')
    expect(await positionen()).toHaveLength(0)
  })

  it('verlangt einen Steuersatz, wenn der Artikel keinen hat', async () => {
    await owner.query(`UPDATE product SET tax_rule_id = NULL WHERE code = 'BAR'`)
    const r = await buchen({ room: '101', productCode: 'BAR', reference: 'BAR-2',
                             grossCent: 1190 })
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).detail).toContain('taxRateBp')
  })

  it('nimmt keine Gutschrift ueber den Buchungsweg entgegen', async () => {
    const r = await buchen({ room: '101', productCode: 'BAR', reference: 'BAR-3',
                             grossCent: -1190 })
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).errors.grossCent[0]).toContain('reverse')
  })
})

describe('Doppelbuchung', () => {
  /**
   * Der eigentliche Betriebsfall: die Kasse bekommt keine Antwort, startet
   * neu und stellt denselben Bon erneut zu — mit einem **neuen**
   * Idempotenzschlüssel, weil der alte im Arbeitsspeicher lag. Nur ihre
   * eigene Belegnummer ist über den Neustart hinweg dieselbe.
   */
  it('bucht denselben Beleg auch mit neuem Schluessel nicht zweimal', async () => {
    const erst = await buchen({ room: '101', productCode: 'BAR', reference: 'BAR-99',
                                grossCent: 1190 })
    expect(erst.statusCode).toBe(201)

    const zweit = await buchen({ room: '101', productCode: 'BAR', reference: 'BAR-99',
                                 grossCent: 1190 })
    // Kein Fehler: die Kasse soll aufhoeren zu wiederholen, nicht in eine
    // Schleife geraten.
    expect(zweit.statusCode).toBe(200)
    expect(json(zweit)).toMatchObject({ duplicate: true, chargeId: json(erst).chargeId })
    expect(await positionen()).toHaveLength(1)
  })

  it('haelt die Belege zweier Haeuser auseinander', async () => {
    const fremd = await makeProperty(owner, { name: 'Zweites Haus', code: 'ZWEI' })
    await openBusinessDay(owner, fremd.propertyId, TAG)
    await artikel('BAR', 'Getraenke Bar', 1900, '8400', fremd.propertyId)
    const kat2 = await makeCategory(owner, fremd.propertyId)
    const r2 = await makeResources(owner, fremd.propertyId, kat2, 1, 'Z')
    const res2 = await makeReservation(owner, {
      propertyId: fremd.propertyId, categoryId: kat2, arrival: TAG, departure: '2026-10-02',
      status: 'InHouse', resourceId: r2[0]!, reserveInventory: false })
    expect(res2.folioId).toBeGreaterThan(0)

    await buchen({ room: '101', productCode: 'BAR', reference: 'BON-1', grossCent: 1190 })

    // Dieselbe Belegnummer im anderen Haus ist eine andere Buchung.
    const admin2 = await makeUser(owner,
      { email: 'chef2@test.de', propertyId: fremd.propertyId, roleKey: 'hotel_director',
        accountId: fremd.accountId })
    await owner.query(
      `INSERT INTO user_account_role (user_id, account_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
       ON CONFLICT DO NOTHING`, [admin2.userId, fremd.accountId])
    const vorher = admin
    admin = admin2
    const kasse2 = await maschinenToken(['folio:read', 'folio:post'], [fremd.propertyId])
    admin = vorher

    const r = await buchen({ room: 'Z101', productCode: 'BAR', reference: 'BON-1',
                             grossCent: 1190 }, kasse2, fremd.propertyId)
    expect(r.statusCode, r.body).toBe(201)
    expect(await positionen(fremd.propertyId)).toHaveLength(1)
  })
})

describe('Zuordnung zum Zimmer', () => {
  it('unterscheidet unbekanntes Zimmer und leeres Zimmer', async () => {
    const unbekannt = await buchen({ room: '999', productCode: 'BAR', reference: 'A',
                                     grossCent: 500 })
    expect(unbekannt.statusCode).toBe(422)
    expect(JSON.parse(unbekannt.body).detail).toContain('gibt es in diesem Haus nicht')

    const leer = await buchen({ room: '102', productCode: 'BAR', reference: 'B',
                                grossCent: 500 })
    expect(leer.statusCode).toBe(422)
    expect(JSON.parse(leer.body).detail).toContain('Check-in')
  })

  /**
   * Zwei angereiste Gäste im selben Zimmer mit getrennter Abrechnung. Raten
   * wäre hier die schlechteste Antwort: der Umsatz landete beim Falschen,
   * und auffallen würde es beim Check-out des Anderen.
   */
  it('fragt nach, wenn im Zimmer zwei Gaeste angereist sind', async () => {
    const kategorie = await owner.query<{ id: number }>(
      `SELECT category_id AS id FROM resource WHERE id = $1`, [zimmer[0]!])
    const zweite = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: kategorie.rows[0]!.id,
      arrival: TAG, departure: '2026-10-03', status: 'InHouse',
      resourceId: zimmer[0]!, reserveInventory: false })

    const r = await buchen({ room: '101', productCode: 'BAR', reference: 'C', grossCent: 500 })
    expect(r.statusCode).toBe(409)
    const detail = JSON.parse(r.body).detail as string
    expect(detail).toContain(gastFolio.ref)
    expect(detail).toContain('folioRef')
    expect(await positionen()).toHaveLength(0)

    // Mit dem Folio ist es eindeutig.
    const f2 = await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM folio WHERE id = $1`, [zweite.folioId])
    const gezielt = await buchen({ folioRef: f2.rows[0]!.public_ref, productCode: 'BAR',
                                   reference: 'D', grossCent: 500 })
    expect(gezielt.statusCode, gezielt.body).toBe(201)
  })

  it('nimmt nichts auf ein geschlossenes Folio', async () => {
    await owner.query(`UPDATE folio SET status = 'closed' WHERE id = $1`, [gastFolio.id])
    const r = await buchen({ folioRef: gastFolio.ref, productCode: 'BAR', reference: 'E',
                             grossCent: 500 })
    expect(r.statusCode).toBe(409)
    expect(await positionen()).toHaveLength(0)
  })
})

/**
 * Umleitung ist genau für diesen Fall gemacht: die Firma zahlt die
 * Übernachtung, die Getränke der Gast — oder umgekehrt. Ignorierte
 * ausgerechnet die Kassenbuchung die Regel, müsste die Rezeption beim
 * Check-out jede Position von Hand umtragen.
 */
describe('Umleitung', () => {
  async function firmenfolio(): Promise<{ id: number; ref: string }> {
    const c = await owner.query<{ id: number }>(
      `INSERT INTO company (account_id, name, address_line1, postal_code, city)
       VALUES ($1,'Nordwind GmbH','Deichweg 4','24937','Flensburg') RETURNING id`,
      [fx.accountId])
    const f = await owner.query<{ id: number; public_ref: string }>(
      `INSERT INTO folio (property_id, kind, company_id, label)
       VALUES ($1,'company',$2,'Nordwind GmbH') RETURNING id, public_ref`,
      [fx.propertyId, c.rows[0]!.id])
    return { id: f.rows[0]!.id, ref: f.rows[0]!.public_ref }
  }

  async function regel(kind: string, value: string | null, ziel: number): Promise<void> {
    await owner.query(
      `INSERT INTO routing_rule (property_id, reservation_id, target_folio_id,
                                 match_kind, match_value)
       VALUES ($1,$2,$3,$4,$5)`,
      [fx.propertyId, reservierung, ziel, kind, value])
  }

  it('bucht nach der Regel auf das Firmenfolio', async () => {
    const firma = await firmenfolio()
    await regel('all', null, firma.id)

    const r = await buchen({ room: '101', productCode: 'BAR', reference: 'R-1',
                             grossCent: 1190 })
    expect(r.statusCode).toBe(201)
    expect(json(r)).toMatchObject({ folioRef: firma.ref, routed: true })
    expect((await positionen())[0]!.folio_id).toBe(firma.id)
  })

  it('laesst die genauere Regel gewinnen', async () => {
    const firma = await firmenfolio()
    const zweites = await firmenfolio()
    await regel('all', null, firma.id)
    await regel('product', 'BAR', zweites.id)

    await buchen({ room: '101', productCode: 'BAR', reference: 'R-2', grossCent: 1190 })
    expect((await positionen())[0]!.folio_id).toBe(zweites.id)

    // Fuer den anderen Artikel bleibt es bei der allgemeinen Regel.
    await buchen({ room: '101', productCode: 'FRUEH', reference: 'R-3', grossCent: 1000 })
    expect((await positionen())[1]!.folio_id).toBe(firma.id)
  })

  /**
   * Ein geschlossenes Zielfolio ist bereits abgerechnet. Ein später Umsatz
   * gehört dann auf das Gastkonto und nicht in eine Rechnung, die schon
   * beim Kunden liegt.
   */
  it('uebergeht ein geschlossenes Zielfolio', async () => {
    const firma = await firmenfolio()
    await regel('all', null, firma.id)
    await owner.query(`UPDATE folio SET status = 'closed' WHERE id = $1`, [firma.id])

    const r = await buchen({ room: '101', productCode: 'BAR', reference: 'R-4',
                             grossCent: 1190 })
    expect(r.statusCode).toBe(201)
    expect(json(r)).toMatchObject({ folioRef: gastFolio.ref, routed: false })
  })
})

describe('Storno der Kasse', () => {
  it('bucht gegen, statt zu aendern', async () => {
    await buchen({ room: '101', productCode: 'BAR', reference: 'S-1', grossCent: 1190 })
    const original = (await positionen())[0]!

    const r = await stornieren({ reference: 'S-1', reversalReference: 'S-1-STORNO',
                                 reason: 'Zimmer vertippt' })
    expect(r.statusCode, r.body).toBe(201)

    const p = await positionen()
    expect(p).toHaveLength(2)
    // Das Original bleibt unangetastet: charge ist Haertegrad 1.
    expect(p[0]).toMatchObject({ id: original.id, gross_cent: 1190, reverses_id: null })
    expect(p[1]).toMatchObject({
      gross_cent: -1190, net_cent: -1000, tax_cent: -190,
      reverses_id: original.id, source: 'pos', external_reference: 'S-1-STORNO',
      folio_id: original.folio_id, revenue_account: original.revenue_account
    })
    expect(p[1]!.description).toContain('Storno')
    expect(p[1]!.description).toContain('Zimmer vertippt')
  })

  it('storniert kein zweites Mal', async () => {
    await buchen({ room: '101', productCode: 'BAR', reference: 'S-2', grossCent: 1190 })
    const erst = await stornieren({ reference: 'S-2', reversalReference: 'S-2-A' })
    expect(erst.statusCode).toBe(201)
    const zweit = await stornieren({ reference: 'S-2', reversalReference: 'S-2-B' })
    expect(zweit.statusCode).toBe(200)
    expect(json(zweit)).toMatchObject({ duplicate: true })
    expect(await positionen()).toHaveLength(2)
  })

  it('kennt den Beleg nicht, den es nie gab', async () => {
    const r = await stornieren({ reference: 'GIBTESNICHT', reversalReference: 'X' })
    expect(r.statusCode).toBe(404)
  })
})

describe('Offene Folios fuer die Kasse', () => {
  function liste(query = '', token = kasse) {
    return app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/pos/folios${query}`,
      headers: bearer(token) })
  }

  it('nennt Zimmer, Namen und Saldo in einem Aufruf', async () => {
    await buchen({ room: '101', productCode: 'BAR', reference: 'L-1', grossCent: 1190 })
    const pm = await makePaymentMethod(owner, fx.propertyId)
    await owner.query(
      `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                               payment_method_id)
       VALUES ($1,$2,$3::date,190,$4)`,
      [fx.propertyId, gastFolio.id, TAG, pm])

    const r = await liste()
    expect(r.statusCode, r.body).toBe(200)
    const folios = (json(r) as unknown as { folios: Array<Record<string, unknown>> }).folios
    const eigenes = folios.find(f => f.folioRef === gastFolio.ref)!
    expect(eigenes).toMatchObject({ room: '101', name: 'Petersen, Jan', balanceCent: 1000 })
    expect(eigenes.departure).toBe('2026-10-04')
  })

  it('filtert nach Zimmernummer', async () => {
    const kategorie = await owner.query<{ id: number }>(
      `SELECT category_id AS id FROM resource WHERE id = $1`, [zimmer[1]!])
    await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: kategorie.rows[0]!.id,
      arrival: TAG, departure: '2026-10-02', status: 'InHouse',
      resourceId: zimmer[1]!, reserveInventory: false })

    const alle = (json(await liste()) as unknown as { folios: unknown[] }).folios
    expect(alle.length).toBe(2)
    const eins = (json(await liste('?room=101')) as unknown as
      { folios: Array<{ room: string }> }).folios
    expect(eins).toHaveLength(1)
    expect(eins[0]!.room).toBe('101')
  })
})

describe('Zugang der Kasse', () => {
  /**
   * Scopes sind Berechtigungsschlüssel, kein zweiter Rechteweg. Eine Kasse,
   * die nur lesen darf, bucht auch dann nicht, wenn sie den Endpunkt kennt.
   */
  it('laesst eine Kasse ohne folio:post nicht buchen', async () => {
    const nurLesen = await maschinenToken(['folio:read'], [fx.propertyId])
    const r = await buchen({ room: '101', productCode: 'BAR', reference: 'Z-1',
                             grossCent: 1190 }, nurLesen)
    expect(r.statusCode).toBe(403)
    expect(await positionen()).toHaveLength(0)
  })

  it('laesst die Kasse eines Hauses nicht in ein anderes buchen', async () => {
    const fremd = await makeProperty(owner, { name: 'Fremdhotel', code: 'FREMD' })
    const r = await buchen({ room: '101', productCode: 'BAR', reference: 'Z-2',
                             grossCent: 1190 }, kasse, fremd.propertyId)
    expect(r.statusCode).toBe(403)
  })

  it('weist eine Kasse ohne Token ab', async () => {
    const r = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/pos/charges`,
      headers: { 'idempotency-key': 'ohne-token' },
      payload: { room: '101', productCode: 'BAR', reference: 'Z-3', grossCent: 1190 } })
    expect(r.statusCode).toBe(401)
  })
})
