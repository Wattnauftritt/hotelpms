import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeEmailDomain, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'
import { stripeAttrappe, kontoVerbinden, signiert, bezahltEreignis } from './stripeAttrappe.js'

/**
 * Rechnung mit Bankverbindung, Zahlungslink oder beidem (Migration 0172).
 *
 * Geprueft wird, was der Gast liest und was danach in der Rechnungsliste
 * steht: die Bankverbindung aus der Momentaufnahme der Rechnung, ein Link
 * ueber den offenen Rest -- und eine Zahlung ueber diesen Link, die die
 * Rechnung ausgleicht, nicht nur das Folio.
 */

const WEBHOOK_SECRET = 'whsec_test_rechnung_zahlweg'
const IBAN = 'DE89370400440532013000'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
const fakeStripe = stripeAttrappe()

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  process.env.STRIPE_CONNECT_CLIENT_ID = 'ca_test_plattform'
  const built = await buildServer({ pool: appPool(10) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app, { payments: { stripe: fakeStripe } })
  await app.ready()
})
afterAll(async () => {
  await app.close(); await owner.end(); await pool.end()
  delete process.env.STRIPE_WEBHOOK_SECRET
  delete process.env.STRIPE_CONNECT_CLIENT_ID
})

beforeEach(async () => {
  await truncateAll()
  limiters.reset()
  fakeStripe.zuruecksetzen()
  fx = await makeProperty(owner)
  await kontoVerbinden(owner, fx.propertyId)
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  await makeEmailDomain(owner, fx.propertyId, 'seeblick.test')
  const r = await app.inject({ method: 'PUT', headers: auth,
    url: `/v1/properties/${fx.propertyId}/email-settings`,
    payload: { fromName: 'Hotel Seeblick', fromEmail: 'post@seeblick.test', enabled: true } })
  expect(r.statusCode, r.body).toBe(200)
})

/** Offene Rechnung ueber 500 EUR; `iban` steht in der Momentaufnahme oder nicht. */
async function rechnung(iban: string | null = IBAN): Promise<{ ref: string; id: number
                                                                folioId: number }> {
  const g = await owner.query<{ id: number }>(
    `INSERT INTO guest (account_id, last_name, first_name, email, language)
     VALUES ($1,'Beispiel','Anna','anna@gast.test','de') RETURNING id`, [fx.accountId])
  const f = await owner.query<{ id: number }>(
    `INSERT INTO folio (property_id, guest_id, kind) VALUES ($1,$2,'guest') RETURNING id`,
    [fx.propertyId, g.rows[0]!.id])
  const aussteller = iban === null ? { name: 'Hotel Seeblick' }
    : { name: 'Hotel Seeblick GmbH', iban, bic: 'COBADEFFXXX', bankName: 'Commerzbank' }
  const i = await owner.query<{ id: number; public_ref: string }>(
    `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date,
                          issuer_snapshot, recipient_snapshot, totals)
     VALUES ($1,$2,'2026-000042',current_date,current_date,$3::jsonb,'{}'::jsonb,
             '{"grossCent":50000,"payableCent":50000}'::jsonb)
     RETURNING id, public_ref`, [fx.propertyId, f.rows[0]!.id, JSON.stringify(aussteller)])
  return { ref: i.rows[0]!.public_ref, id: i.rows[0]!.id, folioId: f.rows[0]!.id }
}

const senden = (ref: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/v1/invoices/${ref}/send`, headers: auth, payload })

async function mailText(messageRef: string): Promise<string> {
  const r = await owner.query<{ body_text: string }>(
    `SELECT body_text FROM outbound_email WHERE public_ref = $1`, [messageRef])
  return r.rows[0]!.body_text
}

const linkAus = (text: string): string => {
  const m = /https?:\/\/\S+\/v1\/pay\?t=\S+/.exec(text)
  expect(m, text).not.toBeNull()
  return m![0]
}

describe('Rechnungsmail mit Zahlweg', () => {
  it('ohne Wahl wie bisher: weder Bankverbindung noch Link', async () => {
    const i = await rechnung()
    const r = await senden(i.ref, {})
    expect(r.statusCode, r.body).toBe(202)
    const text = await mailText((r.json() as { messageRef: string }).messageRef)
    expect(text).not.toContain('IBAN')
    expect(text).not.toContain('/v1/pay?t=')
    const links = await owner.query(`SELECT 1 FROM payment_link`)
    expect(links.rowCount).toBe(0)
  })

  it('Ueberweisung: Bankverbindung aus der Rechnung, Rechnungsnummer als Verwendungszweck',
    async () => {
      const i = await rechnung()
      // Die heutige Bankverbindung des Hauses gilt nicht fuer die alte Rechnung.
      await owner.query(`UPDATE property SET bank_iban = 'DE02120300000000202051'
                          WHERE id = $1`, [fx.propertyId])
      const r = await senden(i.ref, { transfer: true })
      expect(r.statusCode, r.body).toBe(202)
      const text = await mailText((r.json() as { messageRef: string }).messageRef)
      expect(text).toContain('IBAN: DE89 3704 0044 0532 0130 00')
      expect(text).toContain('BIC: COBADEFFXXX')
      expect(text).toContain('Empfänger: Hotel Seeblick GmbH')
      expect(text).toContain('Verwendungszweck: 2026-000042')
      expect(text).not.toContain('DE02')
      expect(text).not.toContain('/v1/pay?t=')
    })

  it('Ueberweisung ohne Bankverbindung auf der Rechnung: Fehler statt halber Mail', async () => {
    const i = await rechnung(null)
    const r = await senden(i.ref, { transfer: true })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ code: 'invoice.noBankAccount' })
    const post = await owner.query(`SELECT 1 FROM outbound_email`)
    expect(post.rowCount).toBe(0)
  })

  it('beides: Bankverbindung und Link ueber den offenen Betrag', async () => {
    const i = await rechnung()
    const r = await senden(i.ref, { transfer: true, paymentLink: true })
    expect(r.statusCode, r.body).toBe(202)
    const text = await mailText((r.json() as { messageRef: string }).messageRef)
    expect(text).toContain('IBAN:')
    linkAus(text)
    const l = await owner.query<{ invoice_id: number; amount_cent: string
                                  email_id: number | null }>(
      `SELECT invoice_id, amount_cent, email_id FROM payment_link`)
    expect(l.rows).toHaveLength(1)
    expect(l.rows[0]).toMatchObject({ invoice_id: i.id })
    expect(Number(l.rows[0]!.amount_cent)).toBe(50_000)
    expect(l.rows[0]!.email_id).not.toBeNull()
  })

  it('kein Link ohne verbundenes Stripe-Konto', async () => {
    await owner.query(`DELETE FROM property_payment_account WHERE property_id = $1`,
      [fx.propertyId])
    const i = await rechnung()
    const r = await senden(i.ref, { paymentLink: true })
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ code: 'payments.accountNotConnected' })
  })

  it('eine beglichene Rechnung bekommt weder Bankverbindung noch Link', async () => {
    const i = await rechnung()
    const pm = await owner.query<{ id: number }>(
      `INSERT INTO payment_method (property_id, code, name) VALUES ($1,'BAR','Bar')
       RETURNING id`, [fx.propertyId])
    await owner.query(
      `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                               payment_method_id, invoice_id)
       VALUES ($1,$2,current_date,50000,$3,$4)`, [fx.propertyId, i.folioId, pm.rows[0]!.id, i.id])
    const r = await senden(i.ref, { transfer: true, paymentLink: true })
    expect(r.statusCode, r.body).toBe(202)
    const text = await mailText((r.json() as { messageRef: string }).messageRef)
    expect(text).not.toContain('IBAN')
    expect(text).not.toContain('/v1/pay?t=')
  })
})

describe('Zahlung ueber den Link der Rechnung', () => {
  it('gleicht die Rechnung aus, nicht nur das Folio', async () => {
    const i = await rechnung()
    const r = await senden(i.ref, { paymentLink: true })
    const url = linkAus(await mailText((r.json() as { messageRef: string }).messageRef))
    const t = new URL(url).searchParams.get('t')!

    const co = await app.inject({ method: 'GET', url: `/v1/pay/checkout?t=${t}` })
    expect(co.statusCode, co.body).toBe(303)
    const ref = String(co.headers.location).split('/').pop()!
    expect(fakeStripe.sitzungen.get(ref)!.amountCent).toBe(50_000)

    const raw = bezahltEreignis('evt_rechnung_1', ref, 50_000)
    const w = await app.inject({ method: 'POST', url: '/v1/payments/stripe/webhook',
      headers: { 'content-type': 'application/json',
                 'stripe-signature': signiert(raw, WEBHOOK_SECRET) },
      payload: raw })
    expect(w.statusCode, w.body).toBe(200)

    const s = await owner.query<{ invoice_id: number | null }>(
      `SELECT invoice_id FROM settlement WHERE folio_id = $1`, [i.folioId])
    expect(s.rows).toEqual([{ invoice_id: i.id }])

    // Danach gibt es auf der Seite nichts mehr zu zahlen.
    const seite = await app.inject({ method: 'GET', url: `/v1/pay?t=${t}` })
    expect(seite.statusCode).toBe(200)
    const nochmal = await app.inject({ method: 'GET', url: `/v1/pay/checkout?t=${t}` })
    expect(nochmal.statusCode).not.toBe(303)
  })

  it('verlangt nur den Rest, wenn inzwischen ein Teil ueberwiesen wurde', async () => {
    const i = await rechnung()
    const r = await senden(i.ref, { paymentLink: true })
    const url = linkAus(await mailText((r.json() as { messageRef: string }).messageRef))
    const t = new URL(url).searchParams.get('t')!

    const pm = await owner.query<{ id: number }>(
      `INSERT INTO payment_method (property_id, code, name) VALUES ($1,'UEB','Ueberweisung')
       RETURNING id`, [fx.propertyId])
    await owner.query(
      `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                               payment_method_id, invoice_id)
       VALUES ($1,$2,current_date,20000,$3,$4)`, [fx.propertyId, i.folioId, pm.rows[0]!.id, i.id])

    const co = await app.inject({ method: 'GET', url: `/v1/pay/checkout?t=${t}` })
    expect(co.statusCode, co.body).toBe(303)
    const ref = String(co.headers.location).split('/').pop()!
    expect(fakeStripe.sitzungen.get(ref)!.amountCent).toBe(30_000)
  })

  it('ein Link am Folio zahlt auf die aelteste offene Rechnung', async () => {
    const i = await rechnung()
    const folio = await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM folio WHERE id = $1`, [i.folioId])
    const l = await app.inject({ method: 'POST', headers: { ...auth, 'idempotency-key': 'f-1' },
      url: `/v1/folios/${folio.rows[0]!.public_ref}/payment-links`,
      payload: { amountCent: 50_000 } })
    expect(l.statusCode, l.body).toBe(201)
    const t = new URL((l.json() as { url: string }).url).searchParams.get('t')!
    const co = await app.inject({ method: 'GET', url: `/v1/pay/checkout?t=${t}` })
    const ref = String(co.headers.location).split('/').pop()!

    const raw = bezahltEreignis('evt_folio_1', ref, 50_000)
    const w = await app.inject({ method: 'POST', url: '/v1/payments/stripe/webhook',
      headers: { 'content-type': 'application/json',
                 'stripe-signature': signiert(raw, WEBHOOK_SECRET) },
      payload: raw })
    expect(w.statusCode, w.body).toBe(200)

    const s = await owner.query<{ invoice_id: number | null }>(
      `SELECT invoice_id FROM settlement WHERE folio_id = $1`, [i.folioId])
    expect(s.rows).toEqual([{ invoice_id: i.id }])
  })
})
