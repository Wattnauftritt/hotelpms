import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         openBusinessDay, countQueries, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Uebernahme des Kassenbuchs aus dem Adminpanel (Migration 0095).
 *
 * Das Adminpanel schiebt wiederholt, bis umgeschaltet ist. Geprueft wird
 * deshalb vor allem, was ein zweiter Lauf tut: nichts doppelt, ein Storno
 * dort als Gegenbuchung hier, eine Loeschung dort ebenso -- und dass der
 * Bestand hier nach der Regel des Adminpanels herauskommt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: Record<string, string>
let maschine: Record<string, string>

const HEUTE = '2026-10-06'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: { body: string }) => JSON.parse(r.body) as any
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

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
  const c = await makeUser(owner, { email: 'chef@test.de', propertyId: fx.propertyId,
    roleKey: 'hotel_director', accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [c.userId, fx.accountId])
  chef = { cookie: `hp_session=${c.sessionId}` }

  const z = await app.inject({ method: 'POST', url: '/v1/oauth-clients', headers: chef,
    payload: { name: 'Adminpanel', scopes: ['cashbook:import'], propertyIds: [fx.propertyId] } })
  expect(z.statusCode, z.body).toBe(201)
  const { clientId, clientSecret } = json(z)
  const t = await app.inject({ method: 'POST', url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'client_credentials',
                                   client_id: clientId, client_secret: clientSecret }).toString() })
  expect(t.statusCode, t.body).toBe(200)
  maschine = { authorization: `Bearer ${json(t).access_token}` }
})

const url = (rest = '') => `/v1/properties/${fx.propertyId}/cashbook${rest}`

/** Ein Stand des Adminpanels, wie der Befehl ihn schickt. */
function eintraege(): Record<string, unknown>[] {
  const z = (id: number, type: string, amountCent: number, rest: Record<string, unknown> = {}) => ({
    id, date: '2026-09-15', type, amountCent, taxRate: 7, text: null, guestName: null,
    groupId: null, voided: false, datevSentAt: null, createdBy: 'Sven',
    createdAt: '2026-09-15T10:00:00+02:00', ...rest })
  return [
    // Eine Gastbuchung: die erste Zeile zeigt im Adminpanel auf sich selbst.
    z(10, 'uebernachtung', 16_700, { groupId: 10, guestName: 'Petersen', text: 'Zi. 12',
      reportReference: 'RC-4711', bookingReportEntryId: 99, updatedAt: '2026-09-15T08:00:00Z' }),
    z(11, 'fruehstueck_speisen', 1_540, { groupId: 10, guestName: 'Petersen' }),
    z(12, 'fruehstueck_getraenke', 660, { groupId: 10, taxRate: 19, guestName: 'Petersen' }),
    z(13, 'kurtaxe', 840, { groupId: 10, guestName: 'Petersen' }),
    // Positiv gespeichert, senkt den Bestand.
    z(15, 'bankeinzahlung', 5_000, { taxRate: 0, datevSentAt: '2026-09-30T18:00:00Z' }),
    z(16, 'ausgabe', -1_290, { taxRate: 19, text: 'Blumen' }),
    z(17, 'bareinlage', 3_000, { taxRate: 0 }),
    // Altdaten: eine Zeile mit Gesamtpreis, der Betrag zaehlt nicht.
    z(18, 'gast', 0, { guestName: 'Jansen', guest: { totalCent: 12_000, breakfasts: 2,
      lodgingGrossCent: 10_900, breakfastFoodGrossCent: 770, breakfastDrinksGrossCent: 330 } })
  ]
}

const stand = { openingBalanceCent: 20_000, openingDate: '2026-09-01', breakfastPriceCent: 550,
                breakfastFoodShareBp: 7000, chartOfAccounts: 'SKR04',
                accounts: { lodging: '4300', expense: '6980' } }

async function schieben(payload: Record<string, unknown>, wer = maschine) {
  return app.inject({ method: 'POST', url: url('/import'), headers: wer,
    payload: { system: 'adminpanel', ...payload } })
}

async function monat(m = '2026-09') {
  await app.inject({ method: 'PUT', url: `/v1/properties/${fx.propertyId}/cashbook-settings`,
    headers: chef, payload: { ...stand, enabled: true } })
  const r = await app.inject({ method: 'GET', url: url(`?month=${m}`), headers: chef })
  expect(r.statusCode, r.body).toBe(200)
  return json(r)
}

describe('Kassenbuch aus dem Adminpanel uebernehmen', () => {
  it('legt an, rechnet die Vorzeichen nach der Regel des Adminpanels und bildet die Gruppe', async () => {
    const r = await schieben({ settings: stand, entries: eintraege() })
    expect(r.statusCode, r.body).toBe(200)
    expect(json(r)).toMatchObject({ received: 8, created: 8, unchanged: 0, voided: [],
                                    datevMarked: 1, conflicts: [] })
    expect(json(r).warnings).toEqual([])

    const m = await monat()
    // 200 + 167 + 15,40 + 6,60 + 8,40 - 50 - 12,90 + 30 + 120
    expect(m.closingBalanceCent).toBe(20_000 + 16_700 + 1_540 + 660 + 840 - 5_000 - 1_290
                                      + 3_000 + 12_000)
    const nach = (n: string) => m.entries.find((e: { externalNumber: string }) => e.externalNumber === n)
    expect(nach('KB-15')).toMatchObject({ kind: 'bank_deposit', amountCent: -5_000, datevExported: true })
    expect(nach('KB-11').groupNo).toBe(nach('KB-10').entryNo)
    expect(nach('KB-10').groupNo).toBeNull()
    expect(nach('KB-18')).toMatchObject({ kind: 'legacy_guest', amountCent: 12_000 })
    expect(nach('KB-10').createdBy).toBe('Sven')
    const ref = await owner.query(`SELECT external_reference AS id, origin_reservation_ref AS ref
                                     FROM cashbook_entry WHERE origin_reservation_ref IS NOT NULL`)
    expect(ref.rows).toEqual([{ id: '10', ref: 'RC-4711' }])
    // Die Altdaten-Zeile geht ueber ihre Aufteilung in die Steuergruppen.
    expect(m.taxGroups.find((g: { rateBp: number }) => g.rateBp === 1900).grossCent).toBe(660 + 330)
  })

  it('legt beim zweiten Lauf nichts doppelt an und meldet Abweichungen', async () => {
    await schieben({ settings: stand, entries: eintraege() })
    const zwei = eintraege()
    zwei[5]!.amountCent = -1_390
    const r = await schieben({ entries: zwei })
    expect(json(r)).toMatchObject({ created: 0, unchanged: 8, datevMarked: 0,
                                    conflicts: [{ id: 16, reason: 'differs' }] })
    const n = await owner.query(`SELECT count(*)::int AS n FROM cashbook_entry`)
    expect(n.rows[0].n).toBe(8)
  })

  it('findet die erste Zeile einer Gruppe aus einem frueheren Stapel', async () => {
    const alle = eintraege()
    await schieben({ entries: alle.slice(0, 2) })
    await schieben({ entries: alle.slice(2, 4) })
    const g = await owner.query<{ ref: string; kopf: string | null }>(
      `SELECT e.external_reference AS ref, h.external_reference AS kopf
         FROM cashbook_entry e LEFT JOIN cashbook_entry h ON h.id = e.group_id
        ORDER BY e.external_reference`)
    expect(g.rows).toEqual([{ ref: '10', kopf: null }, { ref: '11', kopf: '10' },
                            { ref: '12', kopf: '10' }, { ref: '13', kopf: '10' }])
  })

  it('macht aus einem Storno dort eine Gegenbuchung hier, einmal', async () => {
    await schieben({ settings: stand, entries: eintraege() })
    const zwei = eintraege()
    zwei[5]!.voided = true
    expect(json(await schieben({ entries: zwei })).voided).toEqual([16])
    expect(json(await schieben({ entries: zwei })).voided).toEqual([])
    const m = await monat()
    const ausgabe = m.entries.find((e: { externalNumber: string }) => e.externalNumber === 'KB-16')
    expect(ausgabe.voidedByNo).not.toBeNull()
    expect(m.closingBalanceCent).toBe(20_000 + 16_700 + 1_540 + 660 + 840 - 5_000 + 3_000 + 12_000)

    // Dort wieder aufgehoben: hier nicht rueckgaengig zu machen, also ein Befund.
    expect(json(await schieben({ entries: eintraege() })).conflicts)
      .toContainEqual({ id: 16, reason: 'voided_here_not_at_source' })
  })

  it('storniert, was dort hart geloescht wurde, aber nur mit vollstaendiger Liste', async () => {
    await schieben({ settings: stand, entries: eintraege() })
    const alle = [10, 11, 12, 13, 15, 16, 17, 18]

    const unvollstaendig = await schieben({ entries: eintraege().slice(0, 1),
      reconcile: { maxId: 18, allIds: [11, 12] } })
    expect(unvollstaendig.statusCode).toBe(422)

    const r = await schieben({ entries: [],
      reconcile: { maxId: 18, allIds: alle.filter(i => i !== 17) } })
    expect(json(r).deletedAtSource).toEqual([17])
    // Ueber dem Wasserstand ist nichts geloescht, nur noch nicht geschickt.
    await schieben({ entries: [{ ...eintraege()[0], id: 30, groupId: null }] })
    const s = await schieben({ entries: [], reconcile: { maxId: 18, allIds: alle } })
    expect(json(s).deletedAtSource).toEqual([])
    const n = await owner.query(`SELECT count(*)::int AS n FROM cashbook_entry WHERE reverses_id IS NOT NULL`)
    expect(n.rows[0].n).toBe(1)
  })

  it('rechnet im Probelauf alles und behaelt nichts', async () => {
    const r = await schieben({ dryRun: true, settings: stand, entries: eintraege() })
    expect(json(r)).toMatchObject({ dryRun: true, created: 8, datevMarked: 1 })
    const n = await owner.query(`SELECT (SELECT count(*) FROM cashbook_entry)::int AS e,
                                        (SELECT count(*) FROM cashbook_setting)::int AS s,
                                        (SELECT count(*) FROM cashbook_counter)::int AS c`)
    expect(n.rows[0]).toEqual({ e: 0, s: 0, c: 0 })
    // Danach beginnt die Nummer trotzdem bei eins.
    await schieben({ entries: eintraege().slice(0, 1) })
    const nr = await owner.query(`SELECT entry_no::int AS n FROM cashbook_entry`)
    expect(nr.rows[0].n).toBe(1)
  })

  it('nimmt im Probelauf die ganze Kasse in einem Stapel, im echten Lauf nicht', async () => {
    // Ueber mehrere Stapel behielte der Probelauf nichts, und die Gegenprobe
    // im letzten saehe weder die frueheren Zeilen noch den Anfangsbestand.
    const viele = Array.from({ length: 600 }, (_, i) => ({ ...eintraege()[6], id: 1000 + i,
                                                          groupId: null, amountCent: 100 }))
    expect((await schieben({ entries: viele })).statusCode).toBe(422)
    const r = await schieben({ dryRun: true, settings: stand, entries: viele,
      check: [{ month: '2026-09', count: 600, sumCent: 60_000, closingBalanceCent: 80_000 }] })
    expect(r.statusCode, r.body).toBe(200)
    expect(json(r).comparison[0]).toMatchObject({ month: '2026-09', equal: true })
  })

  it('stellt die Monatswerte des Adminpanels neben die eigenen', async () => {
    const summe = 16_700 + 1_540 + 660 + 840 - 5_000 - 1_290 + 3_000 + 12_000
    const r = await schieben({ settings: stand, entries: eintraege(), check: [
      { month: '2026-09', count: 8, sumCent: summe, closingBalanceCent: 20_000 + summe },
      { month: '2026-10', count: 1, sumCent: 100, closingBalanceCent: 20_000 + summe + 100 }] })
    expect(json(r).comparison).toEqual([
      { month: '2026-09', equal: true,
        source: { count: 8, sumCent: summe, closingBalanceCent: 20_000 + summe },
        staygrid: { count: 8, sumCent: summe, closingBalanceCent: 20_000 + summe } },
      { month: '2026-10', equal: false,
        source: { count: 1, sumCent: 100, closingBalanceCent: 20_000 + summe + 100 },
        staygrid: { count: 0, sumCent: 0, closingBalanceCent: 20_000 + summe } }])
  })

  it('meldet Ausreisser, statt sie abzuweisen', async () => {
    const r = await schieben({ entries: [
      { ...eintraege()[5], id: 40, amountCent: 500 },
      { ...eintraege()[6], id: 41, amountCent: 0 },
      { ...eintraege()[1], id: 42, groupId: 39 }] })
    expect(r.statusCode, r.body).toBe(200)
    expect(json(r).warnings).toEqual([{ id: 40, reason: 'positive_expense' },
      { id: 41, reason: 'zero_amount' }, { id: 42, reason: 'group_head_missing' }])
  })

  it('weist unbekannte Typen und Saetze ab', async () => {
    const r = await schieben({ entries: [{ ...eintraege()[0], type: 'entnahme', taxRate: 16 }] })
    expect(r.statusCode).toBe(422)
    expect(Object.keys(json(r).errors)).toEqual(['entries[0].type', 'entries[0].taxRate'])
  })

  it('ist dem Maschinenzugang vorbehalten', async () => {
    expect((await schieben({ entries: [] }, chef)).statusCode).toBe(403)
  })

  it('braucht je Stapel gleich viele Abfragen', async () => {
    const stapel = (von: number, n: number) => Array.from({ length: n }, (_, i) => (
      { ...eintraege()[6], id: von + i, voided: i % 3 === 0, datevSentAt: '2026-09-30T18:00:00Z' }))
    const zaehlen = async (s: Record<string, unknown>[]) => {
      const { report } = await countQueries(pool, () => schieben({ entries: s }))
      return report.count
    }
    expect(await zaehlen(stapel(100, 300))).toBe(await zaehlen(stapel(1000, 3)))
  })
})

describe('Belege aus dem Adminpanel', () => {
  const beleg = (legacyId: number, bytes = PDF, hash = sha(PDF)) => app.inject({
    method: 'PUT', url: url(`/import/${legacyId}/receipt`), headers: maschine,
    payload: { system: 'adminpanel', data: bytes.toString('base64'), sha256: hash,
               name: `kassenbuch-belege/2026/09/KB-${legacyId}-2026-09-15.pdf` } })

  it('haengt den Beleg an, prueft die Pruefsumme und legt ihn nur einmal an', async () => {
    await schieben({ settings: stand, entries: eintraege() })
    expect((await beleg(10, PDF, sha(Buffer.from('anders')))).statusCode).toBe(422)
    const r = await beleg(10)
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r)).toMatchObject({ result: 'stored', mime: 'application/pdf' })
    const zwei = await beleg(10)
    expect(zwei.statusCode).toBe(200)
    expect(json(zwei)).toMatchObject({ result: 'exists', ref: json(r).ref })

    const m = await monat()
    const kopf = m.entries.find((e: { externalNumber: string }) => e.externalNumber === 'KB-10')
    expect(kopf.receipts).toEqual([{ ref: json(r).ref, mime: 'application/pdf' }])
    const name = await owner.query(`SELECT original_name FROM cashbook_receipt`)
    expect(name.rows[0].original_name).toBe('kassenbuch-belege/2026/09/KB-10-2026-09-15.pdf')
  })

  it('haengt einen Beleg an einer Folgezeile an die erste Zeile der Gruppe', async () => {
    await schieben({ entries: eintraege() })
    await beleg(12)
    const z = await owner.query(
      `SELECT e.external_reference AS ref FROM cashbook_receipt r JOIN cashbook_entry e ON e.id = r.entry_id`)
    expect(z.rows).toEqual([{ ref: '10' }])
  })

  it('kennt keine Zeile, die noch nicht geschickt wurde, und keine Fremddatei', async () => {
    expect((await beleg(99)).statusCode).toBe(404)
    await schieben({ entries: eintraege() })
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect((await beleg(10, svg, sha(svg))).statusCode).toBe(422)
  })
})
