import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeGuest, makePaymentMethod, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Der Rundungscent (Aufgabe 12).
 *
 * Die Rechnung kann nicht jeden Bruttobetrag treffen: die Steuer wird je
 * Satzgruppe aus der Nettosumme gerechnet, und bei ganzzahligem Netto und
 * ganzzahliger Steuer gibt es Bruttobetraege, zu denen kein Netto passt.
 * Geprueft wird hier die Zusage, die daraus folgt: **die Rechnung fordert,
 * was die Positionen zusammen ergeben, und das Folio schliesst** -- ohne
 * dass dafuer eine Position erfunden wird, denn eine Rundung ist kein
 * Umsatz und haette zu 0 Prozent keinen Befreiungsgrund (§ 14 Abs. 4
 * Nr. 8 UStG).
 */

let owner: Pool, app: FastifyInstance, pool: Pool, fx: Fixture
let auth: Record<string, string>
let schluessel = 0

beforeAll(async () => {
  await ensureSchema(); owner = ownerPool()
  const b = await buildServer({ pool: appPool(10) })
  app = b.app; pool = b.pool; registerAllRoutes(app); await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

beforeEach(async () => {
  await truncateAll(); limiters.reset(); schluessel = 0
  fx = await makeProperty(owner)
  const cat = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  await makeResources(owner, fx.propertyId, cat, 3)
  await openBusinessDay(owner, fx.propertyId)
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  await makePaymentMethod(owner, fx.propertyId, 'BAR')
})

/**
 * Ein Folio mit Positionen, deren Brutto vorgegeben ist — wie von der Kasse.
 *
 * Mit vollstaendig angeschriebenem Gast: oberhalb von 250 Euro ist eine
 * Rechnung ohne Empfaenger keine Rechnung (§ 14 Abs. 4 Nr. 1 UStG), und die
 * Pflichtangabenpruefung wiese sie ab, bevor die Rundung ueberhaupt drankaeme.
 */
async function folioMit(
  posten: ReadonlyArray<{ brutto: number; rateBp: number }>
): Promise<string> {
  const gast = await makeGuest(owner, fx.accountId)
  const f = await owner.query<{ id: number; public_ref: string }>(
    `INSERT INTO folio (property_id, kind, guest_id) VALUES ($1,'guest',$2)
     RETURNING id, public_ref`,
    [fx.propertyId, gast.id])
  for (const p of posten) {
    // Brutto herein, netto und Steuer heraus — genau wie routes/pos.ts es tut.
    const steuer = Math.round((p.brutto * p.rateBp) / (10_000 + p.rateBp))
    await owner.query(
      `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account)
       VALUES ($1,$2,current_date,'Kassenumsatz',1,$3,$4,$5,$6,'4300')`,
      [fx.propertyId, f.rows[0]!.id, p.brutto - steuer, steuer, p.brutto, p.rateBp])
  }
  return f.rows[0]!.public_ref
}

interface Summen {
  netCent: number; taxCent: number; grossCent: number
  roundingCent: number; payableCent: number
  groups: Array<{ rateBp: number; netCent: number; taxCent: number }>
}

async function faktura(folioRef: string): Promise<{ status: number; totals: Summen }> {
  const r = await app.inject({ method: 'POST',
    headers: { ...auth, 'idempotency-key': `inv-${++schluessel}` },
    url: `/v1/folios/${folioRef}/invoice`, payload: {} })
  return { status: r.statusCode, totals: JSON.parse(r.body).totals as Summen }
}

async function saldo(folioRef: string): Promise<number> {
  const r = await app.inject({ method: 'GET', headers: auth, url: `/v1/folios/${folioRef}` })
  return JSON.parse(r.body).balanceCent as number
}

async function positionen(folioRef: string): Promise<Array<{
  description: string; gross_cent: number; tax_rate_bp: number }>> {
  const r = await owner.query(
    `SELECT c.description, c.gross_cent, c.tax_rate_bp
       FROM charge c JOIN folio f ON f.id = c.folio_id
      WHERE f.public_ref = $1 ORDER BY c.id`, [folioRef])
  return r.rows as never
}

describe('Der Betrag, den die Rechnung fordert', () => {
  it('trifft die Summe der Positionen, auch wenn sie nicht darstellbar ist', async () => {
    // 250,00 zu 7 Prozent ist genau so ein Betrag: 233,64 + 16,35 = 249,99,
    // 233,65 + 16,36 = 250,01. Dazwischen liegt nichts.
    const ref = await folioMit([{ brutto: 25_000, rateBp: 700 }])
    const r = await faktura(ref)

    expect(r.status).toBe(201)
    expect(r.totals.payableCent).toBe(25_000)
    // Die Gesamtsumme nach BT-112 bleibt die normgerecht gerechnete; der
    // Unterschied steht als Rundungsbetrag daneben und nicht in ihr drin.
    expect(r.totals.grossCent).toBe(24_999)
    expect(r.totals.roundingCent).toBe(1)
  })

  it('laesst das Folio auf null schliessen', async () => {
    const ref = await folioMit([{ brutto: 25_000, rateBp: 700 }])
    const r = await faktura(ref)

    // Der Gast zahlt, was die Rechnung fordert -- nicht, was das Folio
    // gebucht hat. Genau hier entstand der Cent: ohne Ausgleich forderte die
    // Rechnung 249,99, und die 0,01 blieben stehen. Fuer immer, weil niemand
    // nach einem Cent sucht.
    const pm = await owner.query<{ id: number }>(
      `SELECT id FROM payment_method WHERE property_id = $1 LIMIT 1`, [fx.propertyId])
    await owner.query(
      `INSERT INTO settlement (property_id, folio_id, business_date, payment_method_id,
                               amount_cent)
       VALUES ($1,(SELECT id FROM folio WHERE public_ref=$2),current_date,$3,$4)`,
      [fx.propertyId, ref, pm.rows[0]!.id, r.totals.payableCent])

    expect(await saldo(ref)).toBe(0)
  })

  it('erfindet dafuer keine Position', async () => {
    const ref = await folioMit([{ brutto: 25_000, rateBp: 700 }])
    await faktura(ref)

    // Eine Rundung ist kein Umsatz. Als Position zu 0 Prozent braeuchte sie
    // einen Befreiungsgrund (§ 14 Abs. 4 Nr. 8 UStG), den es nicht gibt --
    // und im Satz der Gruppe verschoebe sie deren Steuer mit.
    expect(await positionen(ref)).toHaveLength(1)
  })

  it('weist nichts aus, wenn der Betrag darstellbar ist', async () => {
    // 100,00 zu 19 Prozent geht glatt auf.
    const ref = await folioMit([{ brutto: 10_000, rateBp: 1900 }])
    const r = await faktura(ref)

    expect(r.totals.payableCent).toBe(10_000)
    expect(r.totals.grossCent).toBe(10_000)
    // Ein Rundungsbetrag von null auf jedem Beleg ist Rauschen, das ein
    // Pruefer erst einmal fuer einen Fehler haelt.
    expect(r.totals.roundingCent).toBe(0)
  })

  it('traegt auch mehrere Cent ueber viele Posten', async () => {
    // Ein Barumsatz aus zehn Posten zu 19 Prozent. Die Abweichungen der
    // einzelnen Posten heben sich meist auf; wo sie es nicht tun, werden es
    // mehrere Cent. Dieser Korb ergibt drei.
    const posten = [550, 650, 650, 780, 850, 950, 1200, 1200, 1690, 2900]
      .map(brutto => ({ brutto, rateBp: 1900 }))
    const ref = await folioMit(posten)
    const summe = posten.reduce((s, p) => s + p.brutto, 0)

    const r = await faktura(ref)
    expect(r.totals.roundingCent).toBe(3)
    expect(r.totals.payableCent).toBe(summe)
    expect(r.totals.grossCent + r.totals.roundingCent).toBe(summe)
  })

  it('trifft auch bei zwei Satzgruppen', async () => {
    const posten = [
      { brutto: 25_000, rateBp: 700 },   // Logis
      { brutto: 1_790, rateBp: 1900 },   // Bar
      { brutto: 650, rateBp: 1900 }
    ]
    const ref = await folioMit(posten)
    const r = await faktura(ref)
    expect(r.totals.payableCent).toBe(posten.reduce((s, p) => s + p.brutto, 0))
  })

  it('haelt die Satzgruppen der Leistungen unberuehrt', async () => {
    const ref = await folioMit([{ brutto: 25_000, rateBp: 700 }])
    const r = await faktura(ref)

    // Der Ausgleich wirkt auf Belegebene. Die Leistung bleibt vollstaendig im
    // ermaessigten Satz, und es entsteht keine Gruppe zu 0 Prozent -- sonst
    // stuende im DATEV-Stapel ein steuerfreier Umsatz, den es nicht gab.
    expect(r.totals.groups).toHaveLength(1)
    expect(r.totals.groups[0]).toMatchObject({
      rateBp: 700, netCent: 23_364, taxCent: 1_635 })
  })
})
