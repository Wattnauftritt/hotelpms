import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeReservation, makePaymentMethod,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Anzahlungen (Aufgabe 3).
 *
 * Geprüft wird das Abnahmekriterium — 200 Euro auf 500 ergeben eine
 * Schlussrechnung über 500 mit ausgewiesener Anrechnung und 300 offen —
 * und der Punkt, der dahinter steckt: die Steuer entsteht mit der
 * **Vereinnahmung** (§ 13 Abs. 1 Nr. 1a UStG), also im Monat des
 * Geldeingangs und nicht im Monat der Rechnung. Deshalb laufen die
 * Buchungstage hier auseinander, und der DATEV-Stapel wird für beide
 * Monate getrennt abgerufen.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let buchhaltung: Record<string, string>
let categoryId: number
let folioRef: string
let folioId: number
let reservationId: number

/**
 * Der Geschäftstag liegt bewusst zwei Monate in der Zukunft: `issued_on`
 * ist `current_date`, und nur so sind Ausstellungsmonat und
 * Vereinnahmungsmonat verschieden — sonst ginge der Test auch dann durch,
 * wenn der Export weiter nach dem Rechnungsdatum bucht.
 */
function ersterDesMonats(versatz: number): Date {
  const heute = new Date()
  return new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth() + versatz, 1))
}
const iso = (d: Date): string => d.toISOString().slice(0, 10)
function monat(versatz: number): { from: string; to: string } {
  const von = ersterDesMonats(versatz)
  const bis = new Date(Date.UTC(von.getUTCFullYear(), von.getUTCMonth() + 1, 0))
  return { from: iso(von), to: iso(bis) }
}
const EINGANG = monat(2)
const AUSSTELLUNG = monat(0)

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

let lauf = 0
const key = (): string => `d-${++lauf}-${Date.now()}`

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  // Der offene Geschaeftstag bestimmt den Buchungstag jedes Vermerks.
  await openBusinessDay(owner, fx.propertyId, EINGANG.from)
  await makePaymentMethod(owner, fx.propertyId, 'TRANSFER')
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  // Der DATEV-Export haengt an einer eigenen Berechtigung.
  const b = await makeUser(owner,
    { email: 'buha@test.de', propertyId: fx.propertyId, roleKey: 'accounting' })
  buchhaltung = { cookie: `hp_session=${b.sessionId}` }

  categoryId = await makeCategory(owner, fx.propertyId)
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId,
    arrival: '2027-03-01', departure: '2027-03-06',   // fuenf Naechte
    priceCent: 10_000, reserveInventory: false })
  reservationId = res.reservationId
  folioId = res.folioId
  const gast = await makeGuest(owner, fx.accountId)
  const f = await owner.query<{ public_ref: string }>(
    `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`,
    [folioId, gast.id])
  folioRef = f.rows[0]!.public_ref
})

const anzahlungFordern = (payload: unknown) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/deposit-invoice`,
  headers: { ...auth, 'idempotency-key': key() }, payload })

const zahlen = (invoiceRef: string, amountCent: number) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/settlements`,
  headers: { ...auth, 'idempotency-key': key() },
  payload: { amountCent, paymentMethodCode: 'TRANSFER', invoiceRef } })

/** Eine Leistungsposition ueber 500,00 Euro brutto zu 7 Prozent. */
const leistung = (netCent = 46_729, taxRateBp = 700) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/charges`,
  headers: { ...auth, 'idempotency-key': key() },
  payload: { description: 'Uebernachtung', netCent, taxRateBp } })

const fakturieren = () => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/invoice`,
  headers: { ...auth, 'idempotency-key': key() }, payload: {} })

const datev = (bereich: { from: string; to: string }) => app.inject({
  method: 'GET',
  url: `/v1/properties/${fx.propertyId}/exports/datev`
     + `?from=${bereich.from}&to=${bereich.to}`,
  headers: buchhaltung })

/** Die Datenzeilen des Stapels, ohne Kopf und Spaltenueberschriften. */
function stapel(body: string): string[][] {
  return body.trim().split(/\r?\n/).slice(2)
    .map(z => z.split(';').map(f => f.replace(/^"|"$/g, '')))
}

describe('Anzahlungsrechnung', () => {
  it('teilt eine pauschale Anzahlung im Verhaeltnis der erwarteten Leistung auf', async () => {
    const r = await anzahlungFordern({ grossCent: 20_000 })
    expect(r.statusCode, r.body).toBe(201)
    const inv = JSON.parse(r.body) as {
      number: string
      groups: Array<{ rateBp: number; netCent: number; taxCent: number; grossCent: number }> }

    // Fuenf Naechte zu 100 Euro, nichts sonst: ein Satz, alles ermaessigt.
    expect(inv.groups).toEqual([
      { rateBp: 700, netCent: 18_692, taxCent: 1_308, grossCent: 20_000 }])
    // Die Nummer kommt aus demselben Kreis wie jede andere Rechnung
    // (§ 14 Abs. 4 Nr. 4 UStG).
    expect(inv.number).toMatch(/^\d{4}-\d{5}$/)
  })

  /**
   * Der Fall, den Dokument 13 als den nicht trivialen nennt: das
   * Frühstück ist im Ratenpreis enthalten und trägt selbst zwei Sätze —
   * Speisen ermäßigt, Getränke voll.
   */
  it('zerlegt ein im Preis enthaltenes Buffet in Speisen und Getraenke', async () => {
    const satz = async (code: string, rate: number): Promise<number> => {
      const r = await owner.query<{ id: number }>(
        `INSERT INTO tax_rule (property_id, code, name, kind, rate_bp, basis)
         VALUES ($1,$2,$2,'vat',$3,'percent') RETURNING id`,
        [fx.propertyId, code, rate])
      return r.rows[0]!.id
    }
    // Reihenfolge zaehlt: der erste aktive Prozentsatz ist der Logissatz.
    const ermaessigt = await satz('VAT7', 700)
    const voll = await satz('VAT19', 1900)

    const p = await owner.query<{ id: number }>(
      `INSERT INTO product (property_id, code, name, price_cent, tax_rule_id,
                            charge_mode, split_tax_rule_id, split_share_bp)
       VALUES ($1,'FRUE','Fruehstuecksbuffet',1200,$2,'per_night',$3,3000)
       RETURNING id`, [fx.propertyId, ermaessigt, voll])
    const rp = await owner.query<{ id: number }>(
      `INSERT INTO rate_plan (property_id, category_id, code, name)
       VALUES ($1,$2,'BB','Uebernachtung mit Fruehstueck') RETURNING id`,
      [fx.propertyId, categoryId])
    await owner.query(
      `INSERT INTO rate_plan_product (rate_plan_id, product_id) VALUES ($1,$2)`,
      [rp.rows[0]!.id, p.rows[0]!.id])
    // Fuenf Naechte zu 110 Euro: 550 Euro, davon 60 Euro Fruehstueck.
    await owner.query(`UPDATE reservation SET rate_plan_id = $2 WHERE id = $1`,
      [reservationId, rp.rows[0]!.id])
    await owner.query(
      `UPDATE reservation_night SET price_cent = 11_000 WHERE reservation_id = $1`,
      [reservationId])

    const r = await anzahlungFordern({ grossCent: 20_000 })
    expect(r.statusCode, r.body).toBe(201)
    const inv = JSON.parse(r.body) as {
      groups: Array<{ rateBp: number; grossCent: number }> }

    // Erwartet: 532,00 Euro zu 7 Prozent (490 Logis + 42 Speisen) und
    // 18,00 Euro zu 19 Prozent (Getraenke). In diesem Verhaeltnis wird
    // die Anzahlung geteilt.
    expect(inv.groups.map(g => ({ rateBp: g.rateBp, grossCent: g.grossCent }))).toEqual([
      { rateBp: 700, grossCent: 19_345 },
      { rateBp: 1900, grossCent: 655 }])
    expect(inv.groups.reduce((s, g) => s + g.grossCent, 0)).toBe(20_000)
  })

  it('nimmt eine ausdrueckliche Aufteilung, prueft aber die Summe', async () => {
    const falsch = await anzahlungFordern({ grossCent: 20_000, lines: [
      { grossCent: 10_000, taxRateBp: 700 }, { grossCent: 5_000, taxRateBp: 1900 }] })
    expect(falsch.statusCode).toBe(422)

    const r = await anzahlungFordern({ grossCent: 20_000, lines: [
      { grossCent: 15_000, taxRateBp: 700 }, { grossCent: 5_000, taxRateBp: 1900 }] })
    expect(r.statusCode, r.body).toBe(201)
    const inv = JSON.parse(r.body) as { groups: Array<{ rateBp: number; grossCent: number }> }
    expect(inv.groups.map(g => g.rateBp)).toEqual([700, 1900])
  })

  it('verweigert die Ableitung ohne Aufenthalt mit Preisen', async () => {
    const f = await owner.query<{ public_ref: string }>(
      `INSERT INTO folio (property_id, kind) VALUES ($1,'guest') RETURNING public_ref`,
      [fx.propertyId])
    const r = await app.inject({
      method: 'POST', url: `/v1/folios/${f.rows[0]!.public_ref}/deposit-invoice`,
      headers: { ...auth, 'idempotency-key': key() }, payload: { grossCent: 20_000 } })
    expect(r.statusCode).toBe(422)
    expect(r.body).toContain('lines')
  })
})

describe('Vereinnahmung und Anrechnung', () => {
  /**
   * Das Abnahmekriterium, Wort für Wort: eine Anzahlung von 200 Euro auf
   * einen Aufenthalt von 500 Euro ergibt eine Schlussrechnung über 500
   * Euro mit ausgewiesener Anrechnung und 300 Euro offen.
   */
  it('laesst 300 Euro offen, wenn 200 auf 500 angezahlt wurden', async () => {
    const anz = JSON.parse((await anzahlungFordern({ grossCent: 20_000 })).body) as
      { invoiceRef: string; number: string }
    expect((await zahlen(anz.invoiceRef, 20_000)).statusCode).toBe(201)
    expect((await leistung()).statusCode).toBe(201)

    const r = await fakturieren()
    expect(r.statusCode, r.body).toBe(201)
    const inv = JSON.parse(r.body) as {
      invoiceRef: string
      totals: { grossCent: number }
      serviceGrossCent: number; depositAppliedCent: number; openCent: number }

    expect(inv.serviceGrossCent).toBe(50_000)
    expect(inv.depositAppliedCent).toBe(20_000)
    expect(inv.openCent).toBe(30_000)
    expect(inv.totals.grossCent).toBe(30_000)

    // Die Anrechnung steht als eigene Position mit Verweis auf die
    // Anzahlungsrechnung: § 14 Abs. 5 Satz 2 UStG verlangt den Abzug der
    // Anzahlung samt Steuer, nicht eine kleinere Leistung.
    const positionen = await owner.query<{ description: string; gross_cent: number
                                           tax_cent: number; tax_rate_bp: number }>(
      `SELECT c.description, c.gross_cent, c.tax_cent, c.tax_rate_bp
         FROM charge c JOIN invoice i ON i.id = c.invoice_id
        WHERE i.public_ref = $1 AND c.deposit_invoice_id IS NOT NULL`,
      [inv.invoiceRef])
    expect(positionen.rows).toEqual([{
      description: `Anrechnung Anzahlung ${anz.number}`,
      gross_cent: -20_000, tax_cent: -1_308, tax_rate_bp: 700 }])
  })

  it('rechnet nur an, was auch vereinnahmt wurde', async () => {
    // Gestellt, aber nicht bezahlt: bis zum Eingang ist nichts zu
    // versteuern und nichts anzurechnen.
    await anzahlungFordern({ grossCent: 20_000 })
    await leistung()

    const inv = JSON.parse((await fakturieren()).body) as
      { depositAppliedCent: number; openCent: number }
    expect(inv.depositAppliedCent).toBe(0)
    expect(inv.openCent).toBe(50_000)
  })

  it('vermerkt Vereinnahmung und Anrechnung je genau einmal', async () => {
    const anz = JSON.parse((await anzahlungFordern({ grossCent: 20_000 })).body) as
      { invoiceRef: string }
    await zahlen(anz.invoiceRef, 20_000)
    // Ein zweiter Zahlungsvermerk zur selben Anzahlungsrechnung -- etwa
    // ein doppelt erfasster Eingang -- darf sie nicht zweimal
    // vereinnahmen. Sonst zoege die Schlussrechnung 400 Euro ab.
    await zahlen(anz.invoiceRef, 20_000)

    const vorher = JSON.parse((await app.inject({
      method: 'GET', url: `/v1/folios/${folioRef}/deposits`, headers: auth })).body) as
      { balanceCent: number; entries: unknown[] }
    expect(vorher.balanceCent).toBe(20_000)
    expect(vorher.entries).toHaveLength(1)

    await leistung()
    const inv = JSON.parse((await fakturieren()).body) as { depositAppliedCent: number }
    expect(inv.depositAppliedCent).toBe(20_000)

    const nachher = JSON.parse((await app.inject({
      method: 'GET', url: `/v1/folios/${folioRef}/deposits`, headers: auth })).body) as
      { balanceCent: number; entries: unknown[] }
    // Vereinnahmt und verbraucht: der Saldo ist ausgeglichen, die
    // Aufzeichnung bleibt vollstaendig.
    expect(nachher.balanceCent).toBe(0)
    expect(nachher.entries).toHaveLength(2)

    // Und ein zweiter Rechnungslauf setzt sie nicht noch einmal ab.
    const zweiter = await fakturieren()
    expect(zweiter.statusCode).toBe(422)
  })

  it('verbraucht die Anzahlung nicht auf einer Zwischenrechnung', async () => {
    const anz = JSON.parse((await anzahlungFordern({ grossCent: 20_000 })).body) as
      { invoiceRef: string }
    await zahlen(anz.invoiceRef, 20_000)
    const c = JSON.parse((await leistung()).body) as { chargeId: number }
    await leistung(10_000)

    // Eine Auswahl von Positionen gehoert nicht zum ganzen Aufenthalt,
    // und die Anzahlung gehoert nicht zu einer Auswahl.
    const zwischen = await app.inject({
      method: 'POST', url: `/v1/folios/${folioRef}/invoice`,
      headers: { ...auth, 'idempotency-key': key() },
      payload: { kind: 'interim', chargeIds: [c.chargeId] } })
    expect(zwischen.statusCode, zwischen.body).toBe(201)
    expect((JSON.parse(zwischen.body) as { depositAppliedCent: number })
      .depositAppliedCent).toBe(0)

    // Erst die Schlussrechnung ueber den Rest setzt sie ab.
    const schluss = JSON.parse((await fakturieren()).body) as { depositAppliedCent: number }
    expect(schluss.depositAppliedCent).toBe(20_000)
  })

  it('zeigt die Anzahlungen eines fremden Hauses nicht', async () => {
    const anz = JSON.parse((await anzahlungFordern({ grossCent: 20_000 })).body) as
      { invoiceRef: string }
    await zahlen(anz.invoiceRef, 20_000)

    const fremd = await makeProperty(owner, { name: 'Fremdhotel', code: 'FREMD' })
    const u = await makeUser(owner,
      { email: 'fremd@test.de', propertyId: fremd.propertyId, roleKey: 'reception' })
    const r = await app.inject({
      method: 'GET', url: `/v1/folios/${folioRef}/deposits`,
      headers: { cookie: `hp_session=${u.sessionId}` } })
    expect(r.statusCode).toBe(404)
  })
})

describe('DATEV-Stapel', () => {
  /**
   * Der Kern der Aufgabe: die Steuer der Anzahlung ist im Monat der
   * Vereinnahmung ausgewiesen. Die Rechnung ist im laufenden Monat
   * ausgestellt, der Eingang liegt zwei Monate später — gebucht wird
   * nach dem Eingang.
   */
  it('bucht die Anzahlung im Monat der Vereinnahmung, nicht der Ausstellung', async () => {
    const anz = JSON.parse((await anzahlungFordern({ grossCent: 20_000 })).body) as
      { invoiceRef: string; number: string }
    await zahlen(anz.invoiceRef, 20_000)

    const ausstellung = await datev(AUSSTELLUNG)
    expect(ausstellung.statusCode, ausstellung.body).toBe(200)
    expect(stapel(ausstellung.body).some(z => z[10] === anz.number)).toBe(false)

    const eingang = await datev(EINGANG)
    expect(eingang.statusCode, eingang.body).toBe(200)
    const zeilen = stapel(eingang.body).filter(z => z[10] === anz.number)
    expect(zeilen).toHaveLength(1)
    const z = zeilen[0]!
    expect(z[0]).toBe('200,00')
    expect(z[1]).toBe('S')
    // Gegenkonto 1718: erhaltene, versteuerte Anzahlung -- eine
    // Verbindlichkeit, kein Erloes.
    expect(z[7]).toBe('1718')
    expect(z[9]).toBe(EINGANG.from.slice(8, 10) + EINGANG.from.slice(5, 7))
  })

  it('laesst eine gestellte, aber nicht vereinnahmte Anzahlung aus dem Stapel', async () => {
    const anz = JSON.parse((await anzahlungFordern({ grossCent: 20_000 })).body) as
      { number: string }
    await leistung()
    await fakturieren()

    // Ein Zeitraum, der beide Monate umfasst: die Schlussrechnung steht
    // darin, die unbezahlte Anzahlung nicht.
    const r = await datev({ from: AUSSTELLUNG.from, to: EINGANG.to })
    expect(r.statusCode, r.body).toBe(200)
    const nummern = stapel(r.body).map(z => z[10])
    expect(nummern).not.toContain(anz.number)
    expect(nummern.length).toBeGreaterThan(0)
  })

  /**
   * DATEV kennt keinen negativen Umsatz. Die Richtung steht im
   * Soll/Haben-Kennzeichen; ein Minus im Betragsfeld liest der Import als
   * Fehler oder, schlimmer, gar nicht.
   */
  it('bucht die Anrechnung mit umgekehrtem Kennzeichen statt negativem Betrag', async () => {
    const anz = JSON.parse((await anzahlungFordern({ grossCent: 20_000 })).body) as
      { invoiceRef: string }
    await zahlen(anz.invoiceRef, 20_000)
    await leistung()
    const inv = JSON.parse((await fakturieren()).body) as { number: string }

    const r = await datev({ from: AUSSTELLUNG.from, to: EINGANG.to })
    const zeilen = stapel(r.body).filter(z => z[10] === inv.number)
    expect(zeilen.every(z => !z[0]!.startsWith('-'))).toBe(true)

    const anrechnung = zeilen.find(z => z[7] === '1718')!
    expect(anrechnung[0]).toBe('200,00')
    expect(anrechnung[1]).toBe('H')

    const erloes = zeilen.find(z => z[7] === '8300')!
    expect(erloes[0]).toBe('500,00')
    expect(erloes[1]).toBe('S')
  })
})
