import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         openBusinessDay, makeEmailDomain, type Fixture } from '@hotelpms/testing'
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

const UPLOAD = 'abc-123@uploadmail.datev.de'

async function einstellen(datevFrom: string | null = '2026-10-01',
                          datevUploadEmail: string | null = null): Promise<void> {
  const r = await app.inject({ method: 'PUT', url: `/v1/properties/${fx.propertyId}/cashbook-settings`,
    headers: chef, payload: { enabled: true, openingBalanceCent: 0, openingDate: '2026-09-01',
                              datevFrom, datevUploadEmail } })
  expect(r.statusCode, r.body).toBe(200)
}

async function postEinschalten(): Promise<void> {
  await makeEmailDomain(owner, fx.propertyId, 'seeblick.test')
  await owner.query(
    `INSERT INTO property_email_setting (property_id, from_name, from_email, enabled)
     VALUES ($1, 'Hotel Seeblick', 'rezeption@seeblick.test', true)`, [fx.propertyId])
}

const PDF = Buffer.from('%PDF-1.7 Beleg Blumen').toString('base64')

async function markieren(): Promise<{ marked: number; receipts: Record<string, unknown> }> {
  const r = await exportieren()
  const m = await app.inject({ method: 'POST', url: url('/datev/mark'), headers: chef,
    payload: { through: Number(r.headers['x-staygrid-cashbook-through']) } })
  expect(m.statusCode, m.body).toBe(200)
  return json(m)
}

async function belegmails() {
  const r = await owner.query<{ to_email: string; subject: string; body_text: string
                                attachment_name: string; status: string }>(
    `SELECT to_email, subject, body_text, attachment_name, status FROM outbound_email
      WHERE kind = 'cashbook_receipt' ORDER BY id`)
  return r.rows
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
    // Wie im Adminpanel: UStSatz leer, die Steuer im BU-Schluessel, „;" im Text wird „,".
    const t = 'Petersen Zi. 12, 2 Naechte'
    expect(zeilen(r.body).map(z => z.slice(0, 8))).toEqual([
      ['EUR', '+167,00', `SG-${g.entryNo}`, '0610', `Übernachtung ${t}`, '', '9', '4300'],
      ['EUR', '+15,40', `SG-${g.entryNo + 1}`, '0610', `Frühstück Speisen ${t}`, '', '9', '4300'],
      ['EUR', '+6,60', `SG-${g.entryNo + 2}`, '0610', `Frühstück Getränke ${t}`, '', '3', '4400'],
      ['EUR', '+8,40', `SG-${g.entryNo + 3}`, '0610', `Kurtaxe ${t}`, '', '9', '4300'],
      ['EUR', '-50,00', 'SG-5', '0610', 'Bankeinzahlung', '', '', '1200'],
      ['EUR', '-12,90', 'SG-6', '0610', 'Ausgabe Blumen', '', '3', '6980']])
    expect(zeilen(r.body).every(z => z.length === 13)).toBe(true)
    expect(r.body.endsWith('\r\n')).toBe(true)
    expect(r.headers['content-disposition']).toContain('Kassenbuch_20261006.csv')
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
      ['+109,00', 'KB-18', '2009', 'Gast Jansen (Übernachtung)', '', '9', '4300'],
      ['+7,70', 'KB-18', '2009', 'Gast Jansen (Frühst. Sp.)', '', '9', '4300'],
      ['+3,30', 'KB-18', '2009', 'Gast Jansen (Frühst. Gt.)', '', '3', '4400']])
  })

  it('nimmt bei uebernommenen Zeilen mit Gast nur die Beschreibung, wie das Adminpanel', async () => {
    await einstellen()
    await owner.query(
      `INSERT INTO cashbook_entry (property_id, business_date, kind, amount_cent, tax_rate_bp,
          guest_name, text, external_system, external_reference, external_number)
       VALUES ($1, '2026-09-05', 'lodging', 16700, 700, 'Muster',
               'Übernachtung Muster Zi. 12', 'adminpanel', '10', 'KB-10')`, [fx.propertyId])
    expect(zeilen((await exportieren()).body)[0]!.slice(1, 5))
      .toEqual(['+167,00', 'KB-10', '0509', 'Übernachtung Muster Zi. 12'])
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
    expect(json(m)).toEqual({ marked: 1, receipts: { queued: 0, waiting: 0, blocked: null } })
    expect(zeilen((await exportieren()).body)).toEqual([])

    await app.inject({ method: 'POST', url: url(`/entries/${b.entryNo}/void`), headers: chef,
      payload: { reason: 'Doppelt' } })
    expect(zeilen((await exportieren()).body).map(z => [z[1], z[2], z[4]]))
      .toEqual([['-20,00', `SG-${b.entryNo}`, 'Bareinlage Doppelt']])
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

describe('Belege an die DATEV-Uploadmail', () => {
  it('schickt beim Markieren jeden Beleg einmal, mit der Belegnummer im Dateinamen', async () => {
    await einstellen('2026-10-01', UPLOAD)
    await postEinschalten()
    const g = await buchen({ kind: 'guest', totalCent: 10_000, breakfasts: 0, cityTaxCent: 0,
                             guestName: 'Petersen', receipts: [{ data: PDF }] })
    const a = await buchen({ kind: 'expense', amountCent: 1_290, taxRateBp: 1900, text: 'Blumen',
                             receipts: [{ data: PDF }, { data: Buffer.from('%PDF-1.7 zwei').toString('base64') }] })
    expect((await exportieren()).headers['x-staygrid-cashbook-receipts-waiting']).toBe('0')

    expect((await markieren()).receipts).toEqual({ queued: 3, waiting: 0, blocked: null })
    const mails = await belegmails()
    expect(mails.map(m => m.attachment_name)).toEqual([
      `SG-${g.entryNo}-${HEUTE}.pdf`, `SG-${a.entryNo}-${HEUTE}.pdf`, `SG-${a.entryNo}-${HEUTE}-2.pdf`])
    expect(mails.every(m => m.to_email === UPLOAD && m.status === 'pending')).toBe(true)
    expect(mails[1]!.subject).toBe('Kassenbuch-Beleg 06.10.2026 – Ausgabe')
    // Kein Gastname in der Mail: sie bleibt im Postausgang stehen.
    expect(mails.some(m => `${m.subject} ${m.body_text}`.includes('Petersen'))).toBe(false)

    await buchen({ kind: 'cash_in', amountCent: 500 })
    expect((await markieren()).receipts).toEqual({ queued: 0, waiting: 0, blocked: null })
    expect(await belegmails()).toHaveLength(3)
  })

  it('laesst Belege ohne Adresse oder Versand warten und schickt sie nach', async () => {
    await einstellen()
    const a = await buchen({ kind: 'expense', amountCent: 1_290, taxRateBp: 1900,
                             receipts: [{ data: PDF }] })
    expect((await markieren()).receipts).toEqual({ queued: 0, waiting: 1, blocked: 'noAddress' })
    expect((await exportieren()).headers['x-staygrid-cashbook-receipts-waiting']).toBe('1')

    await einstellen('2026-10-01', UPLOAD)
    const senden = () => app.inject({ method: 'POST', url: url('/datev/receipts'), headers: chef })
    expect(json(await senden())).toEqual({ queued: 0, waiting: 1, blocked: 'mailNotReady' })
    await postEinschalten()
    expect(json(await senden())).toEqual({ queued: 1, waiting: 0, blocked: null })
    expect(json(await senden())).toEqual({ queued: 0, waiting: 0, blocked: null })

    // Ein endgueltig gescheiterter Versand kommt beim naechsten Mal wieder an die Reihe.
    await owner.query(`UPDATE outbound_email SET status = 'failed' WHERE kind = 'cashbook_receipt'`)
    expect(json(await senden())).toEqual({ queued: 1, waiting: 0, blocked: null })
    expect((await belegmails()).map(m => m.attachment_name))
      .toEqual([`SG-${a.entryNo}-${HEUTE}.pdf`, `SG-${a.entryNo}-${HEUTE}.pdf`])
  })

  it('schickt nicht, was das Adminpanel schon an DATEV gegeben hat', async () => {
    await einstellen('2026-10-01', UPLOAD)
    await postEinschalten()
    const r = await owner.query<{ id: string }>(
      `INSERT INTO cashbook_entry (property_id, business_date, kind, amount_cent, tax_rate_bp,
          external_system, external_reference, external_number)
       VALUES ($1, '2026-09-20', 'expense', -500, 1900, 'adminpanel', '7', 'KB-7') RETURNING id`,
      [fx.propertyId])
    const beleg = Buffer.from('%PDF-1.7 alt')
    await owner.query(
      `INSERT INTO cashbook_receipt (property_id, entry_id, mime, bytes, byte_count, sha256)
       VALUES ($1, $2, 'application/pdf', $3, $4, 'x')`,
      [fx.propertyId, r.rows[0]!.id, beleg, beleg.length])
    await owner.query(`INSERT INTO cashbook_datev_mark (entry_id, property_id, source)
                       VALUES ($1, $2, 'import')`, [r.rows[0]!.id, fx.propertyId])
    const s = await app.inject({ method: 'POST', url: url('/datev/receipts'), headers: chef })
    expect(json(s)).toEqual({ queued: 0, waiting: 0, blocked: null })
  })

  it('nimmt als Adresse nur DATEV-Uploadmail an', async () => {
    const r = await app.inject({ method: 'PUT', url: `/v1/properties/${fx.propertyId}/cashbook-settings`,
      headers: chef, payload: { enabled: true, datevUploadEmail: 'buchhaltung@example.com' } })
    expect(r.statusCode).toBe(422)
    expect(Object.keys(json(r).errors)).toEqual(['datevUploadEmail'])
    await expect(owner.query(
      `INSERT INTO cashbook_setting (property_id, datev_upload_email) VALUES ($1, 'x@uploadmail.datev.de.evil.test')`,
      [fx.propertyId])).rejects.toThrow()
  })
})
