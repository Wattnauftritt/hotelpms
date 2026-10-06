import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * DATEV-Export des Kassenbuchs (Migration 0097). Geprueft wird das, was in
 * der Buchhaltung nicht mehr zu reparieren ist: keine Zeile zweimal, kein
 * Export vor dem Stichtag und keiner aus dem Uebungshaus, und ein Storno
 * nach dem Export als Korrektur unter der alten Belegnummer.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: Record<string, string>

const HEUTE = '2026-10-06'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: { body: string }) => JSON.parse(r.body) as any

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
  chef = { cookie: `hp_session=${c.sessionId}` }
})

const url = (rest = '') => `/v1/properties/${fx.propertyId}/cashbook${rest}`

async function einstellen(datevFrom: string | null = '2026-10-01'): Promise<void> {
  const r = await app.inject({ method: 'PUT', url: `/v1/properties/${fx.propertyId}/cashbook-settings`,
    headers: chef, payload: { enabled: true, openingBalanceCent: 0, openingDate: '2026-09-01',
                              datevFrom } })
  expect(r.statusCode, r.body).toBe(200)
}

async function buchen(payload: Record<string, unknown>) {
  const r = await app.inject({ method: 'POST', url: url('/entries'), headers: chef,
    payload: { businessDate: HEUTE, ...payload } })
  expect(r.statusCode, r.body).toBe(201)
  return json(r) as { entryNo: number }
}

async function exportieren(q = '') {
  return app.inject({ method: 'GET', url: url(`/datev${q}`), headers: chef })
}

/** Datenzeilen ohne Kopf, als Felder. */
function zeilen(body: string): string[][] {
  return body.replace(/^﻿/, '').trim().split('\r\n').slice(1).map(z => z.split(';'))
}

describe('DATEV-Export des Kassenbuchs', () => {
  it('exportiert nicht ohne oder vor dem Stichtag und nicht aus einem Uebungshaus', async () => {
    await einstellen(null)
    expect((await exportieren()).statusCode).toBe(409)
    await einstellen('2026-10-07')
    const vorher = await exportieren()
    expect(vorher.statusCode).toBe(409)
    expect(json(vorher).detail).toContain('07')
    await einstellen()
    expect((await exportieren()).statusCode).toBe(200)
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])
    expect((await exportieren()).statusCode).toBe(422)
  })

  it('schreibt das Format „Kassenbuch online" mit Konto, BU und Vorzeichen', async () => {
    await einstellen()
    const g = await buchen({ kind: 'guest', totalCent: 18_900, breakfasts: 4, cityTaxCent: 840,
                             text: 'Zi. 12; 2 Naechte', guestName: 'Petersen' })
    await buchen({ kind: 'bank_deposit', amountCent: 5_000 })
    await buchen({ kind: 'expense', amountCent: 1_290, taxRateBp: 1900, text: 'Blumen' })
    const r = await exportieren()
    expect(r.headers['content-type']).toContain('text/csv')
    expect(r.body.startsWith('﻿Währung;VorzBetrag;RechNr;BelegDatum;Belegtext;UStSatz;BU;'))
      .toBe(true)
    expect(zeilen(r.body).map(z => z.slice(0, 8))).toEqual([
      ['EUR', '+167,00', `SG-${g.entryNo}`, '0610', 'Zi. 12 2 Naechte', '7', '9', '4300'],
      ['EUR', '+15,40', `SG-${g.entryNo + 1}`, '0610', 'Zi. 12 2 Naechte', '7', '9', '4300'],
      ['EUR', '+6,60', `SG-${g.entryNo + 2}`, '0610', 'Zi. 12 2 Naechte', '19', '3', '4400'],
      ['EUR', '+8,40', `SG-${g.entryNo + 3}`, '0610', 'Zi. 12 2 Naechte', '7', '9', '4300'],
      ['EUR', '-50,00', 'SG-5', '0610', '', '0', '', '1200'],
      ['EUR', '-12,90', 'SG-6', '0610', 'Blumen', '19', '3', '6980']])
    expect(r.headers['x-staygrid-cashbook-through']).toBe('6')
  })

  it('zerlegt Altdaten in ihre Bruttoteile und behaelt die Belegnummer des Adminpanels', async () => {
    await einstellen()
    await owner.query(
      `INSERT INTO cashbook_entry (property_id, business_date, kind, amount_cent, tax_rate_bp,
          guest_name, legacy_split, external_system, external_reference, external_number)
       VALUES ($1, '2026-09-20', 'legacy_guest', 12000, 700, 'Jansen',
               '{"lodging":10900,"breakfastFood":770,"breakfastDrinks":330}', 'adminpanel', '18', 'KB-18')`,
      [fx.propertyId])
    const r = await exportieren()
    expect(zeilen(r.body).map(z => [z[1], z[2], z[3], z[4], z[5], z[6], z[7]])).toEqual([
      ['+109,00', 'KB-18', '2009', 'Jansen', '7', '9', '4300'],
      ['+7,70', 'KB-18', '2009', 'Jansen', '7', '9', '4300'],
      ['+3,30', 'KB-18', '2009', 'Jansen', '19', '3', '4400']])
  })

  it('laesst ein Storno vor dem Export weg und schickt eines danach als Korrektur', async () => {
    await einstellen()
    const a = await buchen({ kind: 'cash_in', amountCent: 1_000 })
    await app.inject({ method: 'POST', url: url(`/entries/${a.entryNo}/void`), headers: chef })
    const b = await buchen({ kind: 'cash_in', amountCent: 2_000 })
    const r = await exportieren()
    expect(zeilen(r.body).map(z => z[2])).toEqual([`SG-${b.entryNo}`])

    const m = await app.inject({ method: 'POST', url: url('/datev/mark'), headers: chef,
      payload: { through: Number(r.headers['x-staygrid-cashbook-through']) } })
    expect(json(m)).toEqual({ marked: 1 })
    expect(zeilen((await exportieren()).body)).toEqual([])

    await app.inject({ method: 'POST', url: url(`/entries/${b.entryNo}/void`), headers: chef,
      payload: { reason: 'Doppelt' } })
    expect(zeilen((await exportieren()).body).map(z => [z[1], z[2], z[4]]))
      .toEqual([['-20,00', `SG-${b.entryNo}`, 'Doppelt']])
  })

  it('markiert nur, was der Export enthielt', async () => {
    await einstellen()
    await buchen({ kind: 'cash_in', amountCent: 1_000 })
    const r = await exportieren()
    const spaeter = await buchen({ kind: 'cash_in', amountCent: 3_000 })
    await app.inject({ method: 'POST', url: url('/datev/mark'), headers: chef,
      payload: { through: Number(r.headers['x-staygrid-cashbook-through']) } })
    expect(zeilen((await exportieren()).body).map(z => z[2])).toEqual([`SG-${spaeter.entryNo}`])
  })

  it('laesst schon vom Adminpanel Gesendetes im offenen Export weg, im Zeitraum nicht', async () => {
    await einstellen()
    const r = await owner.query<{ id: string }>(
      `INSERT INTO cashbook_entry (property_id, business_date, kind, amount_cent, tax_rate_bp,
          external_system, external_reference, external_number)
       VALUES ($1, '2026-09-20', 'cash_in', 500, 0, 'adminpanel', '7', 'KB-7') RETURNING id`,
      [fx.propertyId])
    await owner.query(`INSERT INTO cashbook_datev_mark (entry_id, property_id, source)
                       VALUES ($1, $2, 'import')`, [r.rows[0]!.id, fx.propertyId])
    expect(zeilen((await exportieren()).body)).toEqual([])
    const zeitraum = await exportieren('?mode=range&from=2026-09-01&to=2026-09-30')
    expect(zeilen(zeitraum.body).map(z => z[2])).toEqual(['KB-7'])
    expect((await exportieren('?mode=range&from=2025-01-01&to=2026-09-30')).statusCode).toBe(422)
  })

  it('bleibt der Buchhaltung vorbehalten', async () => {
    await einstellen()
    const r = await makeUser(owner,
      { email: 'empfang@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const res = await app.inject({ method: 'GET', url: url('/datev'),
      headers: { cookie: `hp_session=${r.sessionId}` } })
    expect(res.statusCode).toBe(403)
  })
})
