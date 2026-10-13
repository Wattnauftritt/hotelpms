import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeEmailDomain, makePaymentMethod, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Offene Posten und Mahnung (0163). Bisher stand nirgends gesammelt, welche
 * Firmenrechnung ueber ihr Zahlungsziel ist, und eine Erinnerung schrieb
 * man ausserhalb des Systems.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let lauf = 0

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
  fx = await makeProperty(owner)
  await makePaymentMethod(owner, fx.propertyId, 'BAR')
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

const post = (url: string, payload: unknown = {}) => app.inject({
  method: 'POST', url, headers: { ...auth, 'idempotency-key': `op-${++lauf}` }, payload })

interface Posten { invoiceRef: string; openCent: number; dueOn: string; daysOverdue: number
                   reminderLevel: number | null; recipient: string }
interface Liste { today: string; totalOpenCent: number; totalOverdueCent: number
                  items: Posten[] }

async function liste(): Promise<Liste> {
  const r = await app.inject({ method: 'GET',
    url: `/v1/properties/${fx.propertyId}/open-items`, headers: auth })
  expect(r.statusCode, r.body).toBe(200)
  return JSON.parse(r.body) as Liste
}

/** Firmenrechnung ueber 500 Euro, vor `tageAlt` Tagen ausgestellt, 30 Tage Ziel. */
async function firmenrechnung(tageAlt: number, nummer = '2026-000007'): Promise<{
  ref: string; folioId: number }> {
  const g = await owner.query<{ id: number }>(
    `INSERT INTO guest (account_id, last_name, first_name, email, language)
     VALUES ($1,'Beispiel','Anna','anna@gast.test','de') RETURNING id`, [fx.accountId])
  const c = await owner.query<{ id: number }>(
    `INSERT INTO company (account_id, name, invoice_email, payment_terms_days)
     VALUES ($1,'Nordwind GmbH','buchhaltung@nordwind.test',30) RETURNING id`,
    [fx.accountId])
  const f = await owner.query<{ id: number }>(
    `INSERT INTO folio (property_id, guest_id, company_id, kind)
     VALUES ($1,$2,$3,'company') RETURNING id`, [fx.propertyId, g.rows[0]!.id, c.rows[0]!.id])
  // Gegen den Tag des Hauses, nicht den des Servers: kurz vor Mitternacht
  // liegen beide einen Tag auseinander.
  const i = await owner.query<{ public_ref: string }>(
    `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date,
                          issuer_snapshot, recipient_snapshot, totals)
     SELECT $1,$2,$3,t.d - $4::int,t.d - $4::int,'{}'::jsonb,
            '{"name":"Nordwind GmbH"}'::jsonb,'{"grossCent":50000}'::jsonb
       FROM (SELECT (now() AT TIME ZONE timezone)::date AS d
               FROM property WHERE id = $1) t
     RETURNING public_ref`, [fx.propertyId, f.rows[0]!.id, nummer, tageAlt])
  return { ref: i.rows[0]!.public_ref, folioId: f.rows[0]!.id }
}

async function zahlung(folioId: number, invoiceRef: string, cent: number): Promise<void> {
  await owner.query(
    `INSERT INTO settlement (property_id, folio_id, business_date, amount_cent,
                             payment_method_id, invoice_id)
     SELECT $1, $2, current_date, $3, pm.id, i.id
       FROM payment_method pm, invoice i
      WHERE pm.property_id = $1 AND pm.code = 'BAR' AND i.public_ref = $4`,
    [fx.propertyId, folioId, cent, invoiceRef])
}

describe('Offene Posten', () => {
  it('zeigt Restbetrag und Verzug, unabhaengig vom Ausstellungsmonat', async () => {
    const alt = await firmenrechnung(45, '2026-000001')
    const neu = await firmenrechnung(5, '2026-000002')
    await zahlung(alt.folioId, alt.ref, 20_000)
    const bezahlt = await firmenrechnung(50, '2026-000003')
    await zahlung(bezahlt.folioId, bezahlt.ref, 50_000)

    const l = await liste()
    expect(l.items.map(p => [p.invoiceRef, p.openCent, p.daysOverdue])).toEqual([
      [alt.ref, 30_000, 15], [neu.ref, 50_000, 0]])
    expect(l.items[0]!.recipient).toBe('Nordwind GmbH')
    expect(l.totalOpenCent).toBe(80_000)
    expect(l.totalOverdueCent).toBe(30_000)
  })

  it('laesst stornierte Rechnungen weg', async () => {
    const r = await firmenrechnung(40)
    expect((await post(`/v1/invoices/${r.ref}/cancel`)).statusCode).toBe(201)
    expect((await liste()).items).toEqual([])
  })
})

describe('Mahnung', () => {
  it('steigt je Aufruf eine Stufe und endet nach der dritten', async () => {
    const r = await firmenrechnung(45)
    const eins = await post(`/v1/invoices/${r.ref}/reminders`)
    expect(eins.statusCode, eins.body).toBe(201)
    const e = JSON.parse(eins.body) as { level: number; dueOn: string; messageRef: null }
    expect(e.level).toBe(1)
    expect(e.messageRef).toBeNull()
    const l = await liste()
    expect(l.items[0]!.reminderLevel).toBe(1)
    // Vorgabe: eine Woche ab heute.
    const d = await owner.query<{ d: string }>(`SELECT ($1::date - $2::date) AS d`,
      [e.dueOn, l.today])
    expect(Number(d.rows[0]!.d)).toBe(7)

    expect(JSON.parse((await post(`/v1/invoices/${r.ref}/reminders`)).body).level).toBe(2)
    expect(JSON.parse((await post(`/v1/invoices/${r.ref}/reminders`)).body).level).toBe(3)
    const vier = await post(`/v1/invoices/${r.ref}/reminders`)
    expect(vier.statusCode).toBe(409)
    expect(JSON.parse(vier.body).code).toBe('reminder.maxLevel')
  })

  it('mahnt keine bezahlte Rechnung und keine Frist in der Vergangenheit', async () => {
    const r = await firmenrechnung(45)
    const gestern = await post(`/v1/invoices/${r.ref}/reminders`, { dueOn: '2020-01-01' })
    expect(gestern.statusCode).toBe(422)
    await zahlung(r.folioId, r.ref, 50_000)
    const z = await post(`/v1/invoices/${r.ref}/reminders`)
    expect(z.statusCode).toBe(409)
    expect(JSON.parse(z.body).code).toBe('reminder.notOpen')
  })

  it('schickt die Mahnung mit Rechnung an die Buchhaltung der Firma', async () => {
    await makeEmailDomain(owner, fx.propertyId, 'seeblick.test')
    const s = await app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/email-settings`, headers: auth,
      payload: { fromName: 'Hotel Seeblick', fromEmail: 'post@seeblick.test',
                 replyTo: 'rezeption@seeblick.test', enabled: true } })
    expect(s.statusCode, s.body).toBe(200)

    const r = await firmenrechnung(45)
    await zahlung(r.folioId, r.ref, 12_345)
    await post(`/v1/invoices/${r.ref}/reminders`)
    const m = await post(`/v1/invoices/${r.ref}/reminders`, { send: true })
    expect(m.statusCode, m.body).toBe(201)
    const ref = (JSON.parse(m.body) as { messageRef: string }).messageRef
    const z = await owner.query<{ to_email: string; subject: string; body_text: string
                                  kind: string; invoice: boolean }>(
      `SELECT to_email, subject, body_text, kind, invoice_id IS NOT NULL AS invoice
         FROM outbound_email WHERE public_ref = $1`, [ref])
    expect(z.rows[0]).toMatchObject({ to_email: 'buchhaltung@nordwind.test',
                                      kind: 'invoice', invoice: true })
    expect(z.rows[0]!.subject).toContain('Mahnung')
    expect(z.rows[0]!.body_text).toContain('376,55')

    const v = await owner.query<{ emailed: boolean; open_cent: string }>(
      `SELECT emailed, open_cent::text FROM invoice_reminder WHERE level = 2`)
    expect(v.rows[0]).toEqual({ emailed: true, open_cent: '37655' })
  })
})
