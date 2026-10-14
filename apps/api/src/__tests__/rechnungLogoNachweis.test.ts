import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makePaymentMethod, openBusinessDay, heuteImHaus, type Fixture }
  from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Logo auf der Rechnung und Versandnachweis (Migration 0170).
 *
 * Beim Logo zaehlt, was still schiefgehen kann: ein SVG, das sich als PNG
 * ausgibt, oder ein WebP, das das PDF/A-3 nicht einbettet. Beim Nachweis,
 * dass er die Fassung des Belegs vergleicht und die Adresse zeigt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let chef: Record<string, string>
let rezeption: Record<string, string>
let lauf = 0

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])
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
  fx = await makeProperty(owner)
  await openBusinessDay(owner, fx.propertyId, heuteImHaus())
  await makePaymentMethod(owner, fx.propertyId, 'BAR')
  const c = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  chef = { cookie: `hp_session=${c.sessionId}` }
  const r = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  rezeption = { cookie: `hp_session=${r.sessionId}` }
})

const hochladen = (bytes: Buffer, headers = chef) => app.inject({
  method: 'PUT', url: `/v1/properties/${fx.propertyId}/invoice-logo`, headers,
  payload: { data: `data:image/png;base64,${bytes.toString('base64')}` } })

describe('Logo auf der Rechnung', () => {
  it('speichert, liefert und entfernt das Logo', async () => {
    const r = await hochladen(PNG)
    expect(r.statusCode, r.body).toBe(200)
    expect((JSON.parse(r.body) as { logo: { mime: string } | null }).logo?.mime)
      .toBe('image/png')

    const g = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/invoice-logo`, headers: chef })
    expect(g.statusCode).toBe(200)
    expect(g.headers['content-type']).toContain('image/png')
    expect(Buffer.compare(g.rawPayload, PNG)).toBe(0)

    const d = await app.inject({
      method: 'DELETE', url: `/v1/properties/${fx.propertyId}/invoice-logo`, headers: chef })
    expect(d.statusCode, d.body).toBe(200)
    expect((JSON.parse(d.body) as { logo: unknown }).logo).toBeNull()
    const weg = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/invoice-logo`, headers: chef })
    expect(weg.statusCode).toBe(404)
  })

  it('weist ein SVG und ein WebP ab, gleich was die Angabe sagt', async () => {
    expect((await hochladen(SVG)).statusCode).toBe(422)
    const w = await hochladen(WEBP)
    expect(w.statusCode).toBe(422)
    expect(w.body).toContain('invoice.logoType')
    const n = await owner.query(`SELECT count(*)::int AS n FROM property_invoice_logo`)
    expect(n.rows[0]!.n).toBe(0)
  })

  it('schreibt die Bilddaten nicht ins Protokoll', async () => {
    expect((await hochladen(PNG)).statusCode).toBe(200)
    const a = await owner.query<{ z: string }>(
      `SELECT coalesce(changed, '{}'::jsonb)::text AS z FROM audit_log
        WHERE table_name = 'property_invoice_logo'`)
    expect(a.rowCount).toBeGreaterThan(0)
    for (const z of a.rows) expect(z.z).not.toContain('89504e47')
  })

  it('verlangt das Recht auf die Einstellungen', async () => {
    expect((await hochladen(PNG, rezeption)).statusCode).toBe(403)
  })
})

describe('Versandnachweis', () => {
  async function rechnung(): Promise<{ id: number; ref: string }> {
    const gast = await makeGuest(owner, fx.accountId)
    const f = await owner.query<{ public_ref: string }>(
      `INSERT INTO folio (property_id, kind, guest_id) VALUES ($1,'guest',$2)
       RETURNING public_ref`, [fx.propertyId, gast.id])
    const folioRef = f.rows[0]!.public_ref
    await app.inject({
      method: 'POST', url: `/v1/folios/${folioRef}/charges`,
      headers: { ...rezeption, 'idempotency-key': `c-${++lauf}` },
      payload: { description: 'Uebernachtung', netCent: 10_000, taxRateBp: 700 } })
    const r = await app.inject({
      method: 'POST', url: `/v1/folios/${folioRef}/invoice`,
      headers: { ...rezeption, 'idempotency-key': `i-${++lauf}` }, payload: {} })
    expect(r.statusCode, r.body).toBe(201)
    const ref = (JSON.parse(r.body) as { invoiceRef: string }).invoiceRef
    const i = await owner.query<{ id: number }>(
      `SELECT id FROM invoice WHERE public_ref = $1`, [ref])
    return { id: i.rows[0]!.id, ref }
  }

  it('zeigt Empfaenger, Kennung und ob die Fassung des Belegs stimmt', async () => {
    const inv = await rechnung()
    await owner.query(
      `INSERT INTO invoice_document (invoice_id, property_id, pdf, byte_count, sha256)
       VALUES ($1,$2,'\\x25504446'::bytea,4,'fassung-2')
       ON CONFLICT (invoice_id) DO UPDATE SET sha256 = 'fassung-2'`,
      [inv.id, fx.propertyId])
    for (const [sha, email] of [['fassung-2', 'buch@firma.test'], ['fassung-1', 'entfernt@invalid']]) {
      await owner.query(
        `INSERT INTO outbound_email (property_id, kind, to_email, to_name, subject, body_text,
                                     invoice_id, status, sent_at, provider_message_id,
                                     attachment_sha256)
         VALUES ($1,'invoice',$2,'Buchhaltung','Ihre Rechnung','',$3,'sent',now(),
                 '<id@anbieter>',$4)`, [fx.propertyId, email, inv.id, sha])
    }

    const r = await app.inject({
      method: 'GET', url: `/v1/invoices/${inv.ref}/mails`, headers: rezeption })
    expect(r.statusCode, r.body).toBe(200)
    const b = JSON.parse(r.body) as { documentSha256: string; mails: Array<{
      toEmail: string | null; status: string; providerMessageId: string; sameDocument: boolean }> }
    expect(b.documentSha256).toBe('fassung-2')
    expect(b.mails).toHaveLength(2)
    expect(b.mails[0]).toMatchObject({ toEmail: 'buch@firma.test', status: 'sent',
                                       providerMessageId: '<id@anbieter>', sameDocument: true })
    // Eine entfernte Adresse kommt als "keine" heraus, nicht als Platzhalter.
    expect(b.mails[1]).toMatchObject({ toEmail: null, sameDocument: false })
  })

  it('kennt keine fremde Rechnung', async () => {
    const r = await app.inject({
      method: 'GET', url: '/v1/invoices/inv_gibtsnicht/mails', headers: rezeption })
    expect(r.statusCode).toBe(404)
  })
})
