import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty,
         makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/*
 * Ticketsystem (Migration 0208). Was hier festgehalten wird, ist die Grenze,
 * nicht die Bequemlichkeit: wer welches Ticket sieht, dass der Kunde keine
 * interne Notiz zu sehen bekommt -- auch nicht an der Route vorbei --, und
 * dass keine Mail einen Ticketinhalt traegt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let inhaber: { userId: number; sessionId: string }
let rezeption: { userId: number; sessionId: string }
let kollegin: { userId: number; sessionId: string }
let support: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

// Die kleinste PNG-Datei: Signatur und genug Bytes, um als Bild erkannt zu werden.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)
]).toString('base64')

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(15) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  inhaber = await makeUser(owner,
    { email: 'inhaber@kunde.de', accountId: fx.accountId, roleKey: 'owner' })
  rezeption = await makeUser(owner,
    { email: 'rezeption@kunde.de', propertyId: fx.propertyId, roleKey: 'reception' })
  kollegin = await makeUser(owner,
    { email: 'kollegin@kunde.de', propertyId: fx.propertyId, roleKey: 'reception' })
  support = await makeUser(owner,
    { email: 'support@wir.de', platformRoleKey: 'platform_support', isPlatformStaff: true })
})

const stellen = (session: string, body: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/v1/support-tickets', headers: auth(session),
    payload: { propertyId: fx.propertyId, subject: 'Rechnung druckt nicht',
               body: 'Beim Drucken der Rechnung passiert nichts.', category: 'bug', ...body } })

const lesen = (session: string, id: number) =>
  app.inject({ method: 'GET', url: `/v1/support-tickets/${id}`, headers: auth(session) })

describe('Kundenseite', () => {
  it('legt ein Ticket an und meldet es unserem Postfach, ohne Inhalt', async () => {
    const r = await stellen(rezeption.sessionId, { urgency: 'down' })
    expect(r.statusCode).toBe(201)
    const { id } = r.json() as { id: number }

    const t = await lesen(rezeption.sessionId, id)
    expect(t.statusCode).toBe(200)
    const kopf = t.json() as { status: string; mine: boolean; messages: Array<{ body: string }> }
    expect(kopf.status).toBe('open')
    expect(kopf.mine).toBe(true)
    expect(kopf.messages.map(m => m.body)).toEqual(['Beim Drucken der Rechnung passiert nichts.'])

    const post = await owner.query<{ kind: string; to_email: string; subject: string
                                     body_text: string }>(
      `SELECT kind, to_email, subject, body_text FROM platform_email`)
    expect(post.rows).toHaveLength(1)
    expect(post.rows[0]!.kind).toBe('ticket_notice')
    expect(post.rows[0]!.to_email).toBe('support@staygrid.cloud')
    expect(post.rows[0]!.subject).toContain('DRINGEND')
    // Weder Betreff noch Text des Tickets stehen in der Mail.
    expect(post.rows[0]!.body_text).not.toContain('Drucken')
    expect(post.rows[0]!.subject).not.toContain('druckt')
  })

  it('zeigt die eigenen Tickets, der Kontoverwaltung alle des Betriebs', async () => {
    const eigenes = (await stellen(rezeption.sessionId)).json() as { id: number }
    await stellen(kollegin.sessionId, { subject: 'Andere Frage' })

    const liste = async (s: string) =>
      ((await app.inject({ method: 'GET', url: '/v1/support-tickets', headers: auth(s) }))
        .json() as { tickets: Array<{ id: number }> }).tickets.map(t => t.id)

    expect(await liste(rezeption.sessionId)).toEqual([eigenes.id])
    expect(await liste(inhaber.sessionId)).toHaveLength(2)
    // Und das fremde Ticket direkt: dieselbe Antwort wie fuer eines, das es nicht gibt.
    expect((await lesen(kollegin.sessionId, eigenes.id)).statusCode).toBe(404)
    expect((await lesen(inhaber.sessionId, eigenes.id)).statusCode).toBe(200)
  })

  it('haelt einen anderen Betrieb draussen', async () => {
    const id = ((await stellen(rezeption.sessionId)).json() as { id: number }).id
    const fremd = await makeProperty(owner)
    const fremderInhaber = await makeUser(owner,
      { email: 'fremd@anderer.de', accountId: fremd.accountId, roleKey: 'owner' })
    expect((await lesen(fremderInhaber.sessionId, id)).statusCode).toBe(404)
  })

  it('nimmt PNG an und weist ein SVG ab', async () => {
    const ok = await stellen(rezeption.sessionId,
      { attachments: [{ data: PNG, name: 'bildschirm.png' }] })
    expect(ok.statusCode).toBe(201)
    const id = (ok.json() as { id: number }).id
    const t = (await lesen(rezeption.sessionId, id)).json() as {
      messages: Array<{ attachments: Array<{ id: number; mime: string }> }> }
    const anhang = t.messages[0]!.attachments[0]!
    expect(anhang.mime).toBe('image/png')
    const datei = await app.inject({ method: 'GET', headers: auth(rezeption.sessionId),
      url: `/v1/support-tickets/${id}/attachments/${anhang.id}` })
    expect(datei.statusCode).toBe(200)
    expect(datei.headers['content-type']).toBe('image/png')

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')
    expect((await stellen(rezeption.sessionId,
      { attachments: [{ data: svg, name: 'x.svg' }] })).statusCode).toBe(422)
  })

  it('weist ein Ticket ohne Betreff oder Text ab', async () => {
    expect((await stellen(rezeption.sessionId, { subject: ' ' })).statusCode).toBe(422)
    expect((await stellen(rezeption.sessionId, { body: '' })).statusCode).toBe(422)
    expect((await owner.query(`SELECT 1 FROM support_ticket`)).rowCount).toBe(0)
  })

  it('oeffnet ein geschlossenes Ticket mit einer Antwort wieder', async () => {
    const id = ((await stellen(rezeption.sessionId)).json() as { id: number }).id
    const zu = await app.inject({ method: 'POST', url: `/v1/support-tickets/${id}/close`,
      headers: auth(rezeption.sessionId) })
    expect(zu.statusCode).toBe(200)
    expect((await lesen(rezeption.sessionId, id)).json()).toMatchObject({ status: 'closed' })

    const a = await app.inject({ method: 'POST', url: `/v1/support-tickets/${id}/messages`,
      headers: auth(rezeption.sessionId), payload: { body: 'Doch noch nicht erledigt.' } })
    expect(a.statusCode).toBe(201)
    expect((await lesen(rezeption.sessionId, id)).json()).toMatchObject({ status: 'open' })
  })

  it('laesst Plattformpersonal ohne Kundenrecht keine Kundentickets sehen', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/support-tickets',
      headers: auth(support.sessionId) })
    expect(r.statusCode).toBe(403)
  })
})

describe('Plattformseite', () => {
  it('antwortet, notiert intern, und der Kunde sieht nur die Antwort', async () => {
    const id = ((await stellen(rezeption.sessionId)).json() as { id: number }).id

    const eingang = await app.inject({ method: 'GET', url: '/v1/platform/tickets',
      headers: auth(support.sessionId) })
    expect(eingang.statusCode).toBe(200)
    expect((eingang.json() as { tickets: Array<{ id: number }> }).tickets.map(t => t.id))
      .toEqual([id])

    const notiz = await app.inject({ method: 'POST', url: `/v1/platform/tickets/${id}/messages`,
      headers: auth(support.sessionId), payload: { body: 'Druckertreiber?', internal: true } })
    expect(notiz.statusCode).toBe(201)
    const antwort = await app.inject({ method: 'POST', url: `/v1/platform/tickets/${id}/messages`,
      headers: auth(support.sessionId), payload: { body: 'Bitte Browser neu starten.' } })
    expect(antwort.statusCode).toBe(201)

    const kunde = (await lesen(rezeption.sessionId, id)).json() as {
      status: string; messages: Array<{ body: string; side: string; authorName: string | null }> }
    expect(kunde.status).toBe('waiting_customer')
    expect(kunde.messages.map(m => m.body))
      .toEqual(['Beim Drucken der Rechnung passiert nichts.', 'Bitte Browser neu starten.'])
    // "Der Support" schreibt, nicht ein Mitarbeiter mit Namen.
    expect(kunde.messages[1]!.authorName).toBeNull()

    // Auch an der Route vorbei: die Zeilenrichtlinie selbst blendet die Notiz aus.
    const roh = await pool.connect()
    try {
      await roh.query('BEGIN')
      await roh.query(`SELECT set_config('app.account_ids', $1, true)`, [String(fx.accountId)])
      const r = await roh.query(`SELECT body FROM support_ticket_message WHERE ticket_id = $1`, [id])
      expect(r.rows.map(z => z.body)).not.toContain('Druckertreiber?')
      await roh.query('ROLLBACK')
    } finally { roh.release() }

    const plattform = (await app.inject({ method: 'GET', url: `/v1/platform/tickets/${id}`,
      headers: auth(support.sessionId) })).json() as {
      assignedTo: number | null; messages: Array<{ internal: boolean }> }
    expect(plattform.messages.map(m => m.internal)).toEqual([false, true, false])
    // Wer antwortet, hat es.
    expect(plattform.assignedTo).toBe(support.userId)

    // Der Kunde bekommt einen Hinweis -- ohne die Antwort selbst.
    const post = await owner.query<{ to_email: string; body_text: string }>(
      `SELECT to_email, body_text FROM platform_email WHERE kind = 'ticket_reply'`)
    expect(post.rows).toHaveLength(1)
    expect(post.rows[0]!.to_email).toBe('rezeption@kunde.de')
    expect(post.rows[0]!.body_text).not.toContain('Browser')
  })

  it('setzt den Zustand und nimmt sich das Ticket', async () => {
    const id = ((await stellen(rezeption.sessionId)).json() as { id: number }).id
    const r = await app.inject({ method: 'PATCH', url: `/v1/platform/tickets/${id}`,
      headers: auth(support.sessionId), payload: { status: 'closed', assign: 'me' } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ status: 'closed', assignedTo: support.userId })
    expect((await lesen(rezeption.sessionId, id)).json()).toMatchObject({ status: 'closed' })
  })

  it('verweigert den Eingang ohne platform:tickets', async () => {
    const abrechnung = await makeUser(owner,
      { email: 'abrechnung@wir.de', platformRoleKey: 'platform_billing', isPlatformStaff: true })
    const r = await app.inject({ method: 'GET', url: '/v1/platform/tickets',
      headers: auth(abrechnung.sessionId) })
    expect(r.statusCode).toBe(403)
  })

  it('fragt aus dem Ticket eine Support-Sitzung an, die im Faden erscheint', async () => {
    const id = ((await stellen(rezeption.sessionId)).json() as { id: number }).id
    const s = await app.inject({ method: 'POST', url: '/v1/platform/support-sessions',
      headers: auth(support.sessionId),
      payload: { accountId: fx.accountId, reason: `Ticket #${id}`, ticketId: id } })
    expect(s.statusCode).toBe(201)

    const beimKunden = (await lesen(inhaber.sessionId, id)).json() as {
      sessions: Array<{ state: string }>; canGrant: boolean }
    expect(beimKunden.sessions.map(x => x.state)).toEqual(['pending'])
    expect(beimKunden.canGrant).toBe(true)
    // Die Rezeption sieht die Anfrage, darf sie aber nicht freigeben.
    expect((await lesen(rezeption.sessionId, id)).json()).toMatchObject({ canGrant: false })

    // Ein Ticket eines anderen Kunden laesst sich nicht unterschieben.
    const fremd = await makeProperty(owner)
    await makeUser(owner, { email: 'f@anderer.de', accountId: fremd.accountId, roleKey: 'owner' })
    const falsch = await app.inject({ method: 'POST', url: '/v1/platform/support-sessions',
      headers: auth(support.sessionId),
      payload: { accountId: fremd.accountId, reason: 'x', ticketId: id } })
    expect(falsch.statusCode).toBe(422)
  })
})
