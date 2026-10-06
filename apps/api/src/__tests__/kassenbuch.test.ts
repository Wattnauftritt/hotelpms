import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         openBusinessDay, countQueries, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Kassenbuch (Migration 0095). Gegen die echte Datenbank, weil die Zusagen
 * dort stecken: die lueckenlose Nummer im Trigger, die Unveraenderlichkeit
 * im Entzug der Rechte, die Trennung der Haeuser in der Zeilenrichtlinie
 * und der laufende Bestand in einer Fensterfunktion.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: Record<string, string>
let rezeption: Record<string, string>

const HEUTE = '2026-10-06'
const sitzung = (s: string) => ({ cookie: `hp_session=${s}` })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: { body: string }) => JSON.parse(r.body) as any

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

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
  await openBusinessDay(owner, fx.propertyId, HEUTE)
  const c = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  chef = sitzung(c.sessionId)
  const r = await makeUser(owner,
    { email: 'empfang@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  rezeption = sitzung(r.sessionId)
})

const url = (rest = '') => `/v1/properties/${fx.propertyId}/cashbook${rest}`

async function einschalten(extra: Record<string, unknown> = {}): Promise<void> {
  const r = await app.inject({ method: 'PUT', url: `/v1/properties/${fx.propertyId}/cashbook-settings`,
    headers: chef, payload: { enabled: true, openingBalanceCent: 20_000,
                              openingDate: '2026-09-01', ...extra } })
  expect(r.statusCode, r.body).toBe(200)
}

async function buchen(payload: Record<string, unknown>, wer = chef) {
  return app.inject({ method: 'POST', url: url('/entries'), headers: wer,
    payload: { businessDate: HEUTE, ...payload } })
}

describe('Kassenbuch einschalten', () => {
  it('ist aus, bis das Haus es einschaltet', async () => {
    const r = await app.inject({ method: 'GET', url: url(), headers: chef })
    expect(r.statusCode).toBe(409)
    expect(json(r).detailKey ?? json(r).detail).toBeTruthy()
    const e = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/cashbook-settings`, headers: chef })
    expect(json(e)).toMatchObject({ enabled: false, breakfastPriceCent: 550,
      breakfastFoodShareBp: 7000, accounts: { lodging: '4300', expense: '6980' } })
  })

  it('laesst die Einstellung nur mit cashbook:export aendern', async () => {
    const r = await app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/cashbook-settings`, headers: rezeption,
      payload: { enabled: true } })
    expect(r.statusCode).toBe(403)
  })
})

describe('Buchen', () => {
  beforeEach(() => einschalten())

  it('zerlegt eine Gastbuchung in Gruppenzeilen mit fortlaufender Nummer', async () => {
    const r = await buchen({ kind: 'guest', totalCent: 10_000, breakfasts: 2,
      cityTaxCent: 600, guestName: 'Petersen', text: 'Zimmer 12' })
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r)).toMatchObject({ entryNo: 1, entryNos: [1, 2, 3, 4] })

    const m = json(await app.inject({ method: 'GET', url: url('?month=2026-10'), headers: chef }))
    expect(m.entries.map((e: { kind: string; amountCent: number; groupNo: number | null }) =>
      [e.kind, e.amountCent, e.groupNo])).toEqual([
      ['lodging', 8_900, null], ['breakfast_food', 770, 1],
      ['breakfast_drinks', 330, 1], ['city_tax', 600, 1]])
    expect(m.startBalanceCent).toBe(20_000)
    expect(m.closingBalanceCent).toBe(30_600)
    expect(m.entries.at(-1).balanceAfterCent).toBe(30_600)
    expect(m.taxGroups).toEqual([
      { rateBp: 700, grossCent: 10_270, netCent: 9_598, taxCent: 672 },
      { rateBp: 1900, grossCent: 330, netCent: 277, taxCent: 53 }])
  })

  it('fuehrt Ausgabe und Bankeinzahlung als Abgang', async () => {
    await buchen({ kind: 'expense', amountCent: 1_250, taxRateBp: 1900, text: 'Briefmarken' })
    await buchen({ kind: 'bank_deposit', amountCent: 5_000 })
    await buchen({ kind: 'cash_in', amountCent: 3_000 })
    const m = json(await app.inject({ method: 'GET', url: url(), headers: chef }))
    expect(m.entries.map((e: { amountCent: number }) => e.amountCent)).toEqual([-1_250, -5_000, 3_000])
    expect(m.todayBalanceCent).toBe(20_000 - 1_250 - 5_000 + 3_000)
    expect(m.incomeCent).toBe(3_000)
    expect(m.outgoingCent).toBe(-6_250)
    // Einlage und Bankeinzahlung sind kein Umsatz.
    expect(m.taxGroups).toEqual([])
    expect(m.inputTaxGroups).toEqual([{ rateBp: 1900, grossCent: 1_250, netCent: 1_050, taxCent: 200 }])
  })

  it('weist ein Datum nach dem Geschaeftstag und vor dem Anfangsbestand ab', async () => {
    expect((await buchen({ kind: 'cash_in', amountCent: 100, businessDate: '2026-10-07' }))
      .statusCode).toBe(422)
    expect((await buchen({ kind: 'cash_in', amountCent: 100, businessDate: '2026-08-31' }))
      .statusCode).toBe(422)
    expect((await buchen({ kind: 'cash_in', amountCent: 100, businessDate: '2026-09-01' }))
      .statusCode).toBe(201)
  })

  it('weist unbekannte Arten, null und freie Steuersaetze ab', async () => {
    expect((await buchen({ kind: 'tip', amountCent: 100 })).statusCode).toBe(422)
    expect((await buchen({ kind: 'expense', amountCent: 0 })).statusCode).toBe(422)
    expect((await buchen({ kind: 'expense', amountCent: 100, taxRateBp: 1600 })).statusCode).toBe(422)
    expect((await buchen({ kind: 'guest', totalCent: 0, breakfasts: 0 })).statusCode).toBe(422)
  })

  it('rechnet den Bestand vor dem Monat ab dem Anfangsbestand', async () => {
    await buchen({ kind: 'cash_in', amountCent: 1_000, businessDate: '2026-09-15' })
    const m = json(await app.inject({ method: 'GET', url: url('?month=2026-10'), headers: chef }))
    expect(m.startBalanceCent).toBe(21_000)
    expect(m.entries).toEqual([])
    const s = json(await app.inject({ method: 'GET', url: url('?month=2026-09'), headers: chef }))
    expect(s.startBalanceCent).toBe(20_000)
    expect(s.entries[0].balanceAfterCent).toBe(21_000)
  })
})

describe('Stornieren', () => {
  beforeEach(() => einschalten())

  it('hebt eine Gastbuchung als Ganzes per Gegenbuchung auf', async () => {
    await buchen({ kind: 'guest', totalCent: 10_000, breakfasts: 2, cityTaxCent: 0 })
    await buchen({ kind: 'cash_in', amountCent: 500 })
    // Storno ueber eine Zeile mitten in der Gruppe
    const s = await app.inject({ method: 'POST', url: url('/entries/2/void'), headers: chef,
      payload: { reason: 'Doppelt erfasst' } })
    expect(s.statusCode, s.body).toBe(201)
    expect(json(s).reversalNos).toEqual([5, 6, 7])

    const m = json(await app.inject({ method: 'GET', url: url(), headers: chef }))
    const zeilen = m.entries as Array<{ entryNo: number; voidedByNo: number | null
                                        reversesNo: number | null; balanceAfterCent: number | null }>
    expect(zeilen.filter(z => z.voidedByNo !== null).map(z => z.entryNo)).toEqual([1, 2, 3])
    expect(zeilen.filter(z => z.reversesNo !== null).map(z => z.reversesNo)).toEqual([1, 2, 3])
    // Stornierte Zeilen und ihre Gegenbuchungen stehen ohne Bestand da.
    expect(zeilen.filter(z => z.balanceAfterCent !== null).map(z => z.balanceAfterCent))
      .toEqual([20_500])
    expect(m.closingBalanceCent).toBe(20_500)
    expect(m.taxGroups).toEqual([])
  })

  it('storniert nicht zweimal und kein Storno', async () => {
    await buchen({ kind: 'cash_in', amountCent: 500 })
    expect((await app.inject({ method: 'POST', url: url('/entries/1/void'), headers: chef }))
      .statusCode).toBe(201)
    expect((await app.inject({ method: 'POST', url: url('/entries/1/void'), headers: chef }))
      .statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: url('/entries/2/void'), headers: chef }))
      .statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: url('/entries/99/void'), headers: chef }))
      .statusCode).toBe(404)
  })

  it('bleibt der Rezeption verwehrt, die nur bucht', async () => {
    expect((await buchen({ kind: 'cash_in', amountCent: 500 }, rezeption)).statusCode).toBe(201)
    expect((await app.inject({ method: 'POST', url: url('/entries/1/void'), headers: rezeption }))
      .statusCode).toBe(403)
  })
})

describe('Belege', () => {
  beforeEach(() => einschalten())

  it('kommen mit der Buchung und lassen sich ansehen', async () => {
    const r = await buchen({ kind: 'expense', amountCent: 999, taxRateBp: 1900,
      receipts: [{ data: `data:application/pdf;base64,${PDF.toString('base64')}`, name: 'quittung.pdf' },
                 { data: JPEG.toString('base64') }] })
    expect(r.statusCode, r.body).toBe(201)
    const belege = json(r).receipts as Array<{ ref: string; mime: string }>
    expect(belege.map(b => b.mime)).toEqual(['application/pdf', 'image/jpeg'])

    const m = json(await app.inject({ method: 'GET', url: url(), headers: rezeption }))
    expect(m.entries[0].receipts).toEqual(belege)

    const pdf = await app.inject({ method: 'GET', url: url(`/receipts/${belege[0]!.ref}`), headers: rezeption })
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.headers['x-content-type-options']).toBe('nosniff')
    expect(pdf.rawPayload.equals(PDF)).toBe(true)
    const bild = await app.inject({ method: 'GET', url: url(`/receipts/${belege[1]!.ref}`), headers: chef })
    expect(bild.headers['content-security-policy']).toContain('sandbox')
  })

  it('erkennt die Art an den Bytes und nimmt kein SVG', async () => {
    const r = await buchen({ kind: 'expense', amountCent: 999, taxRateBp: 0,
      receipts: [{ data: `data:image/png;base64,${SVG.toString('base64')}` }] })
    expect(r.statusCode).toBe(422)
    // Nichts gebucht: Buchung und Beleg gehen zusammen oder gar nicht.
    const m = json(await app.inject({ method: 'GET', url: url(), headers: chef }))
    expect(m.entries).toEqual([])
  })

  it('haengt nachgereichte Belege einer Gastbuchung an die erste Zeile, ohne Doppel', async () => {
    await buchen({ kind: 'guest', totalCent: 10_000, breakfasts: 2, cityTaxCent: 0 })
    const nach = () => app.inject({ method: 'POST', url: url('/entries/3/receipts'), headers: chef,
      payload: { data: PDF.toString('base64') } })
    expect((await nach()).statusCode).toBe(201)
    expect((await nach()).statusCode).toBe(409)
    const m = json(await app.inject({ method: 'GET', url: url(), headers: chef }))
    expect(m.entries.map((e: { receipts: unknown[] }) => e.receipts.length)).toEqual([1, 0, 0])
  })
})

describe('Unveraenderlich und getrennt', () => {
  beforeEach(() => einschalten())

  it('erlaubt der Anwendung weder Aendern noch Loeschen', async () => {
    await buchen({ kind: 'cash_in', amountCent: 500 })
    const c = await pool.connect()
    try {
      await expect(c.query(`UPDATE cashbook_entry SET amount_cent = 1`)).rejects.toThrow()
      await expect(c.query(`DELETE FROM cashbook_entry`)).rejects.toThrow()
    } finally { c.release() }
    await expect(owner.query(`UPDATE cashbook_entry SET amount_cent = 1`)).rejects.toThrow(/GoBD/)
  })

  it('zeigt einem anderen Haus nichts', async () => {
    await buchen({ kind: 'cash_in', amountCent: 500 })
    const fremd = await makeProperty(owner, { code: 'ANDERS' })
    const u = await makeUser(owner, { email: 'x@test.de', propertyId: fremd.propertyId,
      roleKey: 'hotel_director' })
    const r = await app.inject({ method: 'GET', url: url(), headers: sitzung(u.sessionId) })
    expect(r.statusCode).toBe(403)
  })

  it('vergibt Nummern je Haus lueckenlos, auch wenn eine Buchung scheitert', async () => {
    await buchen({ kind: 'cash_in', amountCent: 500 })
    expect((await buchen({ kind: 'expense', amountCent: 1, taxRateBp: 0,
      receipts: [{ data: SVG.toString('base64') }] })).statusCode).toBe(422)
    const r = await buchen({ kind: 'cash_in', amountCent: 700 })
    expect(json(r).entryNo).toBe(2)
  })
})

describe('Leistung', () => {
  beforeEach(() => einschalten())

  it('liest einen Monat mit fester Zahl von Anweisungen, gleich wie viele Zeilen', async () => {
    const monat = async () => {
      const { report } = await countQueries(pool, () =>
        app.inject({ method: 'GET', url: url('?month=2026-10'), headers: chef }))
      return report.count
    }
    await buchen({ kind: 'guest', totalCent: 10_000, breakfasts: 2, cityTaxCent: 300 })
    const wenige = await monat()
    for (let i = 0; i < 15; i++) {
      await buchen({ kind: 'guest', totalCent: 5_000 + i, breakfasts: 1, cityTaxCent: 0,
        receipts: [{ data: Buffer.concat([JPEG, Buffer.from([i])]).toString('base64') }] })
    }
    expect(await monat()).toBe(wenige)
  })
})
