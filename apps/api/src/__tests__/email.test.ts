import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeEmailDomain, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let auth: Record<string, string>

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
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  await makeResources(owner, fx.propertyId, catId, 5)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

const post = (url: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, headers: auth, payload })
const put = (url: string, payload: unknown) =>
  app.inject({ method: 'PUT', url, headers: auth, payload })
const get = (url: string) => app.inject({ method: 'GET', url, headers: auth })

async function absenderEinrichten(enabled = true): Promise<void> {
  // Ohne freigeschaltete Domain laesst sich der Versand nicht einschalten
  // (Migration 0052). Der Weg durch die Freigabe steht in
  // absenderdomain.test.ts; hier ist er Vorbedingung, nicht Gegenstand.
  if (enabled) await makeEmailDomain(owner, fx.propertyId, 'seeblick.test')
  const r = await put(`/v1/properties/${fx.propertyId}/email-settings`, {
    fromName: 'Hotel Seeblick', fromEmail: 'post@seeblick.test',
    replyTo: 'rezeption@seeblick.test', enabled
  })
  expect(r.statusCode, r.body).toBe(200)
}

/** Gast mit Adresse, Folio und festgeschriebener Rechnung. */
async function rechnung(opts: {
  email?: string | null; language?: string; anonymized?: boolean
  company?: boolean } = {}): Promise<string> {
  const g = await owner.query<{ id: number }>(
    `INSERT INTO guest (account_id, last_name, first_name, email, language, status)
     VALUES ($1,'Beispiel','Anna',$2,$3,$4) RETURNING id`,
    [fx.accountId, opts.email === undefined ? 'anna@gast.test' : opts.email,
     opts.language ?? 'de', opts.anonymized ? 'anonymized' : 'active'])

  let companyId: number | null = null
  if (opts.company) {
    const c = await owner.query<{ id: number }>(
      `INSERT INTO company (account_id, name, invoice_email, payment_terms_days)
       VALUES ($1,'Nordwind GmbH','buchhaltung@nordwind.test',30) RETURNING id`,
      [fx.accountId])
    companyId = c.rows[0]!.id
  }

  const f = await owner.query<{ id: number }>(
    `INSERT INTO folio (property_id, guest_id, company_id, kind)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [fx.propertyId, g.rows[0]!.id, companyId, companyId ? 'company' : 'guest'])
  const i = await owner.query<{ public_ref: string }>(
    `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date,
                          issuer_snapshot, recipient_snapshot, totals)
     VALUES ($1,$2,'2026-000007',current_date,current_date,'{}'::jsonb,'{}'::jsonb,
             '{"grossCent":50000}'::jsonb)
     RETURNING public_ref`, [fx.propertyId, f.rows[0]!.id])
  return i.rows[0]!.public_ref
}

async function postausgang(): Promise<Array<{
  messageRef: string; status: string; subject: string; toMasked: string | null
  kind: string }>> {
  const r = await get(`/v1/properties/${fx.propertyId}/outbound-emails`)
  expect(r.statusCode, r.body).toBe(200)
  return (JSON.parse(r.body) as { emails: never[] }).emails
}

/** Was tatsaechlich in der Warteschlange steht, ungefiltert. */
async function zeile(ref: string): Promise<{ to_email: string; body_text: string
                                             subject: string }> {
  const r = await owner.query(
    `SELECT to_email, body_text, subject FROM outbound_email WHERE public_ref = $1`, [ref])
  return r.rows[0] as never
}

describe('Absenderangaben', () => {
  it('meldet ein nicht eingerichtetes Haus als ausgeschaltet, nicht als fehlend', async () => {
    const r = await get(`/v1/properties/${fx.propertyId}/email-settings`)
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.body)).toMatchObject({ enabled: false, fromEmail: null })
  })

  it('weist eine unbrauchbare Absenderadresse ab', async () => {
    const r = await put(`/v1/properties/${fx.propertyId}/email-settings`, {
      fromName: 'Hotel', fromEmail: 'kein-at-zeichen', enabled: true })
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).errors.fromEmail).toBeDefined()
  })

  it('laesst den Versand in einem Uebungshaus nicht einschalten', async () => {
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])
    const r = await put(`/v1/properties/${fx.propertyId}/email-settings`, {
      fromName: 'Uebung', fromEmail: 'post@uebung.test', enabled: true })
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).detail).toMatch(/Uebungshaus/)
  })
})

describe('Rechnung verschicken', () => {
  it('reiht ein und antwortet mit 202, ohne selbst zu verschicken', async () => {
    await absenderEinrichten()
    const ref = await rechnung()

    const r = await post(`/v1/invoices/${ref}/send`)
    expect(r.statusCode, r.body).toBe(202)
    const body = JSON.parse(r.body) as { messageRef: string; status: string }
    expect(body.status).toBe('pending')
    // Die Adresse steht bewusst nicht in der Antwort: Antworten landen in
    // Protokollen (C8, Dokument 13).
    expect(r.body).not.toContain('anna@gast.test')

    const z = await zeile(body.messageRef)
    expect(z.to_email).toBe('anna@gast.test')
    expect(z.subject).toContain('2026-000007')
    expect(z.body_text).toContain('Anna Beispiel')
    // Der Betrag steht im Anschreiben, in Euro und Cent.
    expect(z.body_text).toContain('500,00')
  })

  it('nimmt die Rechnungsadresse der Firma, nicht die des Reisenden', async () => {
    await absenderEinrichten()
    const ref = await rechnung({ company: true })

    const r = await post(`/v1/invoices/${ref}/send`)
    expect(r.statusCode).toBe(202)
    const z = await zeile(JSON.parse(r.body).messageRef)
    expect(z.to_email).toBe('buchhaltung@nordwind.test')
    // Und mit Zahlungsziel: 30 Tage aus den Zahlungsbedingungen.
    expect(z.body_text).toMatch(/zahlbar bis zum \d{2}\.\d{2}\.\d{4}/)
  })

  it('schreibt auf Englisch, wenn der Gast Englisch spricht', async () => {
    await absenderEinrichten()
    const ref = await rechnung({ language: 'en' })

    const r = await post(`/v1/invoices/${ref}/send`)
    const z = await zeile(JSON.parse(r.body).messageRef)
    expect(z.subject).toMatch(/^Invoice /)
    expect(z.body_text).toContain('Dear Anna Beispiel')
  })

  it('verschickt nicht zweimal, wenn zweimal geklickt wird', async () => {
    await absenderEinrichten()
    const ref = await rechnung()
    expect((await post(`/v1/invoices/${ref}/send`)).statusCode).toBe(202)

    const zweite = await post(`/v1/invoices/${ref}/send`)
    expect(zweite.statusCode).toBe(409)
    expect(JSON.parse(zweite.body).detail).toMatch(/resend/)

    // Ausdruecklich dagegen geht.
    const erneut = await post(`/v1/invoices/${ref}/send`, { resend: true })
    expect(erneut.statusCode).toBe(202)
    expect(await postausgang()).toHaveLength(2)
  })

  it('nennt die fehlende Adresse beim Namen, statt still nichts zu tun', async () => {
    await absenderEinrichten()
    const ref = await rechnung({ email: null })

    const r = await post(`/v1/invoices/${ref}/send`)
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).detail).toMatch(/Empfaengeradresse/)
    expect(await postausgang()).toHaveLength(0)
  })

  it('verschickt nichts an einen anonymisierten Gast', async () => {
    await absenderEinrichten()
    const ref = await rechnung({ anonymized: true })

    // Eine Loeschung zu unterlaufen, indem man die Adresse doch noch
    // benutzt, waere schlimmer als der fehlgeschlagene Versand.
    const r = await post(`/v1/invoices/${ref}/send`)
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).detail).toMatch(/anonymisiert/)
  })

  it('nimmt eine abweichende Adresse an, aber keinen abweichenden Inhalt', async () => {
    await absenderEinrichten()
    const ref = await rechnung()

    const r = await post(`/v1/invoices/${ref}/send`,
      { to: 'buchhaltung@firma.test', subject: 'Frohe Weihnachten', body: 'Hallo' })
    expect(r.statusCode).toBe(202)
    const z = await zeile(JSON.parse(r.body).messageRef)
    expect(z.to_email).toBe('buchhaltung@firma.test')
    // Betreff und Rumpf entstehen aus dem Fachdatum. Sonst waere der
    // Endpunkt ein Versandapparat fuer beliebige Post.
    expect(z.subject).toContain('Rechnung 2026-000007')
    expect(z.body_text).not.toContain('Frohe Weihnachten')
  })

  it('reiht nichts ein, solange der Versand nicht eingeschaltet ist', async () => {
    await absenderEinrichten(false)
    const ref = await rechnung()
    const r = await post(`/v1/invoices/${ref}/send`)
    expect(r.statusCode).toBe(500)
    expect(await postausgang()).toHaveLength(0)
  })
})

describe('Buchungsbestaetigung', () => {
  async function reservierung(): Promise<string> {
    const g = await owner.query<{ id: number }>(
      `INSERT INTO guest (account_id, last_name, first_name, email)
       VALUES ($1,'Beispiel','Anna','anna@gast.test') RETURNING id`, [fx.accountId])
    const r = await app.inject({ method: 'POST', url: '/v1/bookings',
      headers: { ...auth, 'idempotency-key': 'b-1' },
      payload: { propertyId: fx.propertyId, categoryId: catId,
                 arrival: '2026-10-01', departure: '2026-10-03',
                 guestId: g.rows[0]!.id } })
    expect(r.statusCode, r.body).toBe(201)
    return (JSON.parse(r.body) as { reservationRef: string }).reservationRef
  }

  it('nennt Zeitraum, Zimmergruppe und Zeiten des Hauses', async () => {
    await absenderEinrichten()
    const res = await reservierung()

    const r = await post(`/v1/reservations/${res}/send-confirmation`)
    expect(r.statusCode, r.body).toBe(202)
    const z = await zeile(JSON.parse(r.body).messageRef)
    expect(z.subject).toContain(res)
    expect(z.body_text).toContain('2026-10-01')
    expect(z.body_text).toContain('2026-10-03')
    expect(z.body_text).toMatch(/ab \d{2}:\d{2} Uhr/)
  })
})

describe('Postausgang', () => {
  it('zeigt die Adresse nur verkuerzt', async () => {
    await absenderEinrichten()
    await post(`/v1/invoices/${await rechnung()}/send`)

    const liste = await postausgang()
    expect(liste).toHaveLength(1)
    // Genug zum Wiedererkennen, zu wenig zum Weitergeben.
    expect(liste[0]!.toMasked).toBe('a***@gast.test')
  })

  it('zieht eine eingereihte Nachricht zurueck, eine abgeschickte nicht', async () => {
    await absenderEinrichten()
    const r = await post(`/v1/invoices/${await rechnung()}/send`)
    const ref = JSON.parse(r.body).messageRef as string

    expect((await post(`/v1/outbound-emails/${ref}/cancel`)).statusCode).toBe(200)
    expect((await postausgang())[0]!.status).toBe('canceled')

    // Ein zweites Mal geht nicht: zurueckziehen laesst sich nur, was noch
    // nicht heraus ist.
    expect((await post(`/v1/outbound-emails/${ref}/cancel`)).statusCode).toBe(409)
  })
})

describe('Trennung der Mandanten', () => {
  it('laesst die Rechnung eines fremden Hauses nicht verschicken', async () => {
    await absenderEinrichten()
    const fremd = await makeProperty(owner)
    const f = await owner.query<{ id: number }>(
      `INSERT INTO folio (property_id, kind) VALUES ($1,'guest') RETURNING id`,
      [fremd.propertyId])
    const i = await owner.query<{ public_ref: string }>(
      `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date,
                            issuer_snapshot, recipient_snapshot, totals)
       VALUES ($1,$2,'2026-000001',current_date,current_date,'{}'::jsonb,'{}'::jsonb,
               '{"grossCent":1000}'::jsonb)
       RETURNING public_ref`, [fremd.propertyId, f.rows[0]!.id])

    // Die Zeilenrichtlinie laesst die Rechnung gar nicht erst sehen.
    const r = await post(`/v1/invoices/${i.rows[0]!.public_ref}/send`)
    expect(r.statusCode).toBe(404)
  })
})
