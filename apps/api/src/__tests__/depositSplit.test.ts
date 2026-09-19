import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, makePaymentMethod,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Anzahlungen, zweiter Teil (Aufgabe 3): die Steuersätze und der
 * Buchungsstapel.
 *
 * Zwei Dinge werden hier geprüft, die `depositInvoice.test.ts` offen lässt.
 * Erstens die Aufteilung: eine Anzahlung ist ein pauschaler Betrag, die
 * spätere Leistung nicht — Übernachtung ermäßigt, Getränke voll, ein
 * Frühstücksbuffet beides in einem Preis. Zweitens der DATEV-Stapel: die
 * Steuer muss im Monat der **Vereinnahmung** gebucht sein, und eine
 * Anzahlung erzeugt keine `charge`, über die der Export sonst liest.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let buchhaltung: Record<string, string>
let categoryId: number

/**
 * Der Zahlungseingang liegt zwei Monate vor dem Ausstellungstag der
 * Rechnung — `issued_on` ist `current_date`. Nur so sind Ausstellungs- und
 * Vereinnahmungsmonat verschieden, und nur dann sagt der Test etwas: sonst
 * ginge er auch durch, wenn der Export weiter nach dem Rechnungsdatum
 * buchte.
 */
function monat(versatz: number): { from: string; to: string; erster: string } {
  const heute = new Date()
  const von = new Date(Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth() + versatz, 1))
  const bis = new Date(Date.UTC(von.getUTCFullYear(), von.getUTCMonth() + 1, 0))
  const iso = (d: Date): string => d.toISOString().slice(0, 10)
  return { from: iso(von), to: iso(bis), erster: iso(von) }
}
const EINGANG = monat(-2)
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
const key = (): string => `ds-${++lauf}-${Date.now()}`

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  // Der offene Geschaeftstag ist heute: die Schlussrechnung traegt
  // current_date, und Buchungstag und Rechnungstag sollen zusammenfallen.
  await openBusinessDay(owner, fx.propertyId, new Date().toISOString().slice(0, 10))
  await makePaymentMethod(owner, fx.propertyId, 'TRANSFER')
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  // Der DATEV-Export haengt an einer eigenen Berechtigung.
  const b = await makeUser(owner,
    { email: 'buha@test.de', propertyId: fx.propertyId, roleKey: 'accounting' })
  buchhaltung = { cookie: `hp_session=${b.sessionId}` }

  categoryId = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, categoryId, 1)
})

interface Aufenthalt { folioRef: string; folioId: number; reservationId: number }

/** Fuenf Naechte mit Gast und Folio, Preis je Nacht wie angegeben. */
async function aufenthalt(priceCent = 10_000): Promise<Aufenthalt> {
  const gast = await makeGuest(owner, fx.accountId)
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId,
    arrival: '2027-03-01', departure: '2027-03-06',
    priceCent, reserveInventory: false })
  const f = await owner.query<{ public_ref: string }>(
    `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`,
    [res.folioId, gast.id])
  return { folioRef: f.rows[0]!.public_ref, folioId: res.folioId,
           reservationId: res.reservationId }
}

/**
 * Zahlungsvermerk mit einem Geschaeftstag in der Vergangenheit: der
 * Zeitpunkt der Vereinnahmung ist der Kern der Aufgabe und muss frei
 * setzbar sein.
 */
async function eingang(folioId: number, amountCent: number,
                       businessDate = EINGANG.erster): Promise<number> {
  const pm = await owner.query<{ id: number }>(
    `SELECT id FROM payment_method WHERE property_id = $1 AND code = 'TRANSFER'`,
    [fx.propertyId])
  const s = await owner.query<{ id: number }>(
    `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                             payment_method_id)
     VALUES ($1,$2,$3::date,$4,$5) RETURNING id`,
    [fx.propertyId, folioId, businessDate, amountCent, pm.rows[0]!.id])
  return s.rows[0]!.id
}

const anzahlungsrechnung = (folioRef: string, payload: unknown) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/deposit-invoice`,
  headers: { ...auth, 'idempotency-key': key() }, payload })

const buchen = (folioRef: string, netCent: number, taxRateBp = 700) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/charges`,
  headers: { ...auth, 'idempotency-key': key() },
  payload: { description: 'Uebernachtung', netCent, taxRateBp } })

const fakturieren = (folioRef: string) => app.inject({
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

/** Ein Fruehstuecksbuffet im Ratenpreis: ein Preis, zwei Saetze. */
async function ratenplanMitBuffet(reservationId: number, preisJeNacht = 1_200): Promise<void> {
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
     VALUES ($1,'FRUE','Fruehstuecksbuffet',$2,$3,'per_night',$4,3000)
     RETURNING id`, [fx.propertyId, preisJeNacht, ermaessigt, voll])
  const rp = await owner.query<{ id: number }>(
    `INSERT INTO rate_plan (property_id, category_id, code, name)
     VALUES ($1,$2,'BB','Uebernachtung mit Fruehstueck') RETURNING id`,
    [fx.propertyId, categoryId])
  await owner.query(
    `INSERT INTO rate_plan_product (rate_plan_id, product_id, property_id)
     VALUES ($1,$2,$3)`,
    [rp.rows[0]!.id, p.rows[0]!.id, fx.propertyId])
  await owner.query(`UPDATE reservation SET rate_plan_id = $2 WHERE id = $1`,
    [reservationId, rp.rows[0]!.id])
}

describe('Steuersaetze der Anzahlung', () => {
  it('leitet den Satz aus dem Aufenthalt ab, wenn keiner mitkommt', async () => {
    const a = await aufenthalt()
    const s = await eingang(a.folioId, 20_000)

    const r = await anzahlungsrechnung(a.folioRef, { settlementId: s })
    expect(r.statusCode, r.body).toBe(201)
    const body = JSON.parse(r.body) as {
      grossCent: number
      groups: Array<{ rateBp: number; netCent: number; taxCent: number; grossCent: number }> }

    // Fuenf Naechte zu 100 Euro, nichts sonst: ein Satz, alles ermaessigt.
    expect(body.groups).toEqual([
      { rateBp: 700, netCent: 18_692, taxCent: 1_308, grossCent: 20_000 }])
    expect(body.grossCent).toBe(20_000)
  })

  /**
   * Der Fall, den Dokument 13 als den nicht trivialen nennt: das Frühstück
   * steckt im Ratenpreis und trägt selbst zwei Sätze — Speisen ermäßigt,
   * Getränke voll.
   */
  it('zerlegt ein im Preis enthaltenes Buffet in Speisen und Getraenke', async () => {
    const a = await aufenthalt(11_000)          // fuenf Naechte zu 110 Euro
    await ratenplanMitBuffet(a.reservationId)   // davon 12 Euro Fruehstueck
    const s = await eingang(a.folioId, 20_000)

    const r = await anzahlungsrechnung(a.folioRef, { settlementId: s })
    expect(r.statusCode, r.body).toBe(201)
    const body = JSON.parse(r.body) as {
      groups: Array<{ rateBp: number; grossCent: number }> }

    // Erwartet: 532,00 Euro zu 7 Prozent (490 Logis + 42 Speisen) und 18,00
    // Euro zu 19 Prozent (Getraenke). In diesem Verhaeltnis wird geteilt.
    expect(body.groups.map(g => ({ rateBp: g.rateBp, grossCent: g.grossCent }))).toEqual([
      { rateBp: 700, grossCent: 19_345 },
      { rateBp: 1900, grossCent: 655 }])
    expect(body.groups.reduce((sum, g) => sum + g.grossCent, 0)).toBe(20_000)

    // Je Satz eine Zeile im Journal, mit genau den Betraegen des Belegs.
    const journal = await owner.query<{ tax_rate_bp: number; amount_gross_cent: number
                                        net_cent: number; tax_cent: number }>(
      `SELECT tax_rate_bp, amount_gross_cent, net_cent, tax_cent FROM deposit_ledger
        WHERE folio_id = $1 AND kind = 'received' ORDER BY tax_rate_bp`, [a.folioId])
    expect(journal.rows.map(z => z.tax_rate_bp)).toEqual([700, 1900])
    expect(journal.rows.reduce((sum, z) => sum + Number(z.amount_gross_cent), 0)).toBe(20_000)
    for (const z of journal.rows) {
      expect(Number(z.net_cent) + Number(z.tax_cent)).toBe(Number(z.amount_gross_cent))
    }
  })

  it('nimmt eine ausdrueckliche Aufteilung, prueft aber die Summe', async () => {
    const a = await aufenthalt()
    const s = await eingang(a.folioId, 20_000)

    const falsch = await anzahlungsrechnung(a.folioRef, { settlementId: s, lines: [
      { grossCent: 10_000, taxRateBp: 700 }, { grossCent: 5_000, taxRateBp: 1900 }] })
    expect(falsch.statusCode).toBe(422)

    const r = await anzahlungsrechnung(a.folioRef, { settlementId: s, lines: [
      { grossCent: 15_000, taxRateBp: 700 }, { grossCent: 5_000, taxRateBp: 1900 }] })
    expect(r.statusCode, r.body).toBe(201)
    const body = JSON.parse(r.body) as { groups: Array<{ rateBp: number; grossCent: number }> }
    expect(body.groups.map(g => g.rateBp)).toEqual([700, 1900])
  })

  it('weist eine Rueckzahlung als Anzahlung ab', async () => {
    // Negative Zahlungsvermerke gibt es (Storno, Erstattung). Ohne Pruefung
    // schluege erst die Bedingung am Journal zu -- als Fehler 500.
    const a = await aufenthalt()
    const s = await eingang(a.folioId, -5_000)
    const r = await anzahlungsrechnung(a.folioRef, { settlementId: s, taxRateBp: 700 })
    expect(r.statusCode, r.body).toBe(422)
  })

  it('verlangt eine Angabe, wenn der Aufenthalt keine Preise hat', async () => {
    const gast = await makeGuest(owner, fx.accountId)
    const res = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId,
      arrival: '2027-04-01', departure: '2027-04-03',
      priceCent: 0, reserveInventory: false })
    const f = await owner.query<{ public_ref: string }>(
      `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`,
      [res.folioId, gast.id])
    const s = await eingang(res.folioId, 20_000)

    const r = await anzahlungsrechnung(f.rows[0]!.public_ref, { settlementId: s })
    expect(r.statusCode).toBe(422)
    expect(r.body).toContain('taxRateBp')
  })

  it('verrechnet eine aufgeteilte Anzahlung je Satz', async () => {
    const a = await aufenthalt(11_000)
    await ratenplanMitBuffet(a.reservationId)
    const s = await eingang(a.folioId, 20_000)
    await anzahlungsrechnung(a.folioRef, { settlementId: s })

    // Der Aufenthalt selbst: 500 Euro brutto zu 7 Prozent.
    await buchen(a.folioRef, 46_729)

    const r = await fakturieren(a.folioRef)
    expect(r.statusCode, r.body).toBe(201)
    const body = JSON.parse(r.body) as {
      totals: { grossCent: number; groups: Array<{ rateBp: number; grossCent: number }> }
      depositsApplied: Array<{ amountGrossCent: number }> }

    // Angerechnet wird zu den Saetzen, zu denen versteuert wurde: der
    // volle Satz erscheint mit negativem Betrag, obwohl der Aufenthalt
    // selbst nur ermaessigte Positionen hat.
    expect(body.totals.groups.find(g => g.rateBp === 1900)?.grossCent).toBe(-655)
    expect(body.depositsApplied.reduce((sum, d) => sum + d.amountGrossCent, 0)).toBe(20_000)

    /*
     * Der ausgewiesene Endbetrag darf hier um einen Cent von 500 minus 200
     * abweichen, und das ist kein Rundungsfehler, sondern eine Grenze der
     * Norm: die Steuer wird je Satzgruppe aus der Nettosumme gerechnet
     * (BR-CO-14), und mit den Saetzen 7 und 19 Prozent ist in diesem Fall
     * kein Nettobetrag darstellbar, der genau 300,00 Euro ergibt. Das Geld
     * bleibt davon unberuehrt -- der Saldo des Folios ist exakt.
     */
    expect(Math.abs(body.totals.grossCent - 30_000)).toBeLessThanOrEqual(1)

    const folio = await app.inject({
      method: 'GET', url: `/v1/folios/${a.folioRef}`, headers: auth })
    expect((JSON.parse(folio.body) as { balanceCent: number }).balanceCent).toBe(30_000)

    const journal = await owner.query<{ kind: string; tax_rate_bp: number }>(
      `SELECT kind, tax_rate_bp FROM deposit_ledger WHERE folio_id = $1
        ORDER BY kind, tax_rate_bp`, [a.folioId])
    expect(journal.rows).toEqual([
      { kind: 'applied', tax_rate_bp: 700 }, { kind: 'applied', tax_rate_bp: 1900 },
      { kind: 'received', tax_rate_bp: 700 }, { kind: 'received', tax_rate_bp: 1900 }
    ])
  })
})

describe('Anzahlung und Zwischenrechnung', () => {
  /**
   * Eine Anzahlung gehört zum ganzen Aufenthalt, nicht zu einer Auswahl
   * daraus. Verbrauchte eine Zwischenrechnung sie, bekäme die
   * Schlussrechnung nichts mehr — und eine Zwischenrechnung über ein
   * Mineralwasser lautete über einen negativen Betrag.
   */
  it('verbraucht die Anzahlung nicht auf einer Zwischenrechnung', async () => {
    const a = await aufenthalt()
    const s = await eingang(a.folioId, 20_000)
    await anzahlungsrechnung(a.folioRef, { settlementId: s })

    const klein = JSON.parse((await buchen(a.folioRef, 1_000, 1900)).body) as
      { chargeId: number }
    await buchen(a.folioRef, 46_729)

    const zwischen = await app.inject({
      method: 'POST', url: `/v1/folios/${a.folioRef}/invoice`,
      headers: { ...auth, 'idempotency-key': key() },
      payload: { kind: 'interim', chargeIds: [klein.chargeId] } })
    expect(zwischen.statusCode, zwischen.body).toBe(201)
    const zwischenBody = JSON.parse(zwischen.body) as {
      totals: { grossCent: number }; depositsApplied: unknown[] }
    expect(zwischenBody.depositsApplied).toEqual([])
    expect(zwischenBody.totals.grossCent).toBe(1_190)

    // Erst die Schlussrechnung ueber den Rest setzt sie ab.
    const schluss = JSON.parse((await fakturieren(a.folioRef)).body) as {
      depositsApplied: Array<{ amountGrossCent: number }> }
    expect(schluss.depositsApplied.reduce((sum, d) => sum + d.amountGrossCent, 0))
      .toBe(20_000)
  })

  /**
   * Mehr angezahlt als abzurechnen — etwa weil der Gast früher abreist.
   * Dem Gast steht Geld zu, und dafür ist eine Rechnung über einen
   * negativen Betrag das falsche Papier.
   */
  it('stellt keine Rechnung ueber einen negativen Betrag aus', async () => {
    const a = await aufenthalt()
    const s = await eingang(a.folioId, 20_000)
    await anzahlungsrechnung(a.folioRef, { settlementId: s })
    await buchen(a.folioRef, 5_000)          // 53,50 Euro brutto

    const r = await fakturieren(a.folioRef)
    expect(r.statusCode, r.body).toBe(422)
    expect(r.body).toContain('Rueckzahlung')

    // Und die Anzahlung ist dabei nicht verbraucht worden.
    const journal = await owner.query(
      `SELECT 1 FROM deposit_ledger WHERE folio_id = $1 AND kind = 'applied'`, [a.folioId])
    expect(journal.rowCount).toBe(0)
  })
})

describe('Anzahlung im DATEV-Stapel', () => {
  /**
   * Der Kern der Abnahme: die Steuer der Anzahlung ist im Monat der
   * Vereinnahmung ausgewiesen. Der Zahlungseingang liegt zwei Monate vor
   * dem Ausstellungstag der Rechnung.
   */
  it('bucht die Vereinnahmung im Monat des Geldeingangs', async () => {
    const a = await aufenthalt()
    const s = await eingang(a.folioId, 20_000)
    const dep = JSON.parse((await anzahlungsrechnung(a.folioRef, { settlementId: s })).body) as
      { number: string }

    const ausstellung = await datev(AUSSTELLUNG)
    expect(ausstellung.statusCode, ausstellung.body).toBe(200)
    expect(stapel(ausstellung.body).some(z => z[10] === dep.number)).toBe(false)

    const eingangsmonat = await datev(EINGANG)
    expect(eingangsmonat.statusCode, eingangsmonat.body).toBe(200)
    const zeilen = stapel(eingangsmonat.body).filter(z => z[10] === dep.number)
    expect(zeilen).toHaveLength(1)
    const z = zeilen[0]!
    expect(z[0]).toBe('200,00')
    expect(z[1]).toBe('S')
    // Gegenkonto 1718: erhaltene, versteuerte Anzahlung -- eine
    // Verbindlichkeit, kein Erloes.
    expect(z[7]).toBe('1718')
    expect(z[9]).toBe(EINGANG.erster.slice(8, 10) + EINGANG.erster.slice(5, 7))
  })

  /**
   * Die Verrechnung löst die Anzahlung wieder auf. DATEV kennt keinen
   * negativen Umsatz; die Richtung steht im Soll/Haben-Kennzeichen.
   */
  it('loest die Anzahlung mit der Schlussrechnung wieder auf', async () => {
    const a = await aufenthalt()
    const s = await eingang(a.folioId, 20_000)
    await anzahlungsrechnung(a.folioRef, { settlementId: s })
    await buchen(a.folioRef, 46_729)
    const finale = JSON.parse((await fakturieren(a.folioRef)).body) as { number: string }

    const r = await datev({ from: EINGANG.from, to: AUSSTELLUNG.to })
    expect(r.statusCode, r.body).toBe(200)
    const zeilen = stapel(r.body)
    expect(zeilen.every(z => !z[0]!.startsWith('-'))).toBe(true)

    const aufloesung = zeilen.filter(z => z[10] === finale.number && z[7] === '1718')
    expect(aufloesung).toHaveLength(1)
    expect(aufloesung[0]![0]).toBe('200,00')
    expect(aufloesung[0]![1]).toBe('H')

    // Die Leistung selbst steht in voller Hoehe im Stapel: die Anzahlung
    // mindert die Rechnung, nicht den Umsatz (§ 14 Abs. 5 Satz 2 UStG).
    const erloes = zeilen.filter(z => z[10] === finale.number && z[7] === '8300')
    expect(erloes).toHaveLength(1)
    expect(erloes[0]![0]).toBe('500,00')
    expect(erloes[0]![1]).toBe('S')
  })

  it('laeuft chronologisch, nicht nach Belegart', async () => {
    const a = await aufenthalt()
    const s = await eingang(a.folioId, 20_000)
    await anzahlungsrechnung(a.folioRef, { settlementId: s })
    await buchen(a.folioRef, 46_729)
    await fakturieren(a.folioRef)

    const zeilen = stapel((await datev({ from: EINGANG.from, to: AUSSTELLUNG.to })).body)
    // Die Vereinnahmung liegt zwei Monate vor den Rechnungen und steht
    // deshalb zuerst.
    expect(zeilen[0]![9]).toBe(EINGANG.erster.slice(8, 10) + EINGANG.erster.slice(5, 7))
  })

  it('zeigt die Anzahlung eines fremden Hauses nicht', async () => {
    const a = await aufenthalt()
    const s = await eingang(a.folioId, 20_000)
    const dep = JSON.parse((await anzahlungsrechnung(a.folioRef, { settlementId: s })).body) as
      { number: string }

    const fremd = await makeProperty(owner, { name: 'Fremdhotel', code: 'FREMD' })
    const u = await makeUser(owner,
      { email: 'fremd@test.de', propertyId: fremd.propertyId, roleKey: 'accounting' })
    const r = await app.inject({
      method: 'GET',
      url: `/v1/properties/${fremd.propertyId}/exports/datev`
         + `?from=${EINGANG.from}&to=${EINGANG.to}`,
      headers: { cookie: `hp_session=${u.sessionId}` } })
    expect(r.statusCode, r.body).toBe(200)
    expect(stapel(r.body).some(z => z[10] === dep.number)).toBe(false)
  })
})
