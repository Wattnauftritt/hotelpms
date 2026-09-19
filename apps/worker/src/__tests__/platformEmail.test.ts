import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool } from '@hotelpms/testing'
import { SYSTEM_CONTEXT, type Pool } from '@hotelpms/db'
import { EMAIL_MAX_ATTEMPTS } from '@hotelpms/domain'
import { deliverPlatformEmails, type PlatformSender } from '../jobs/platformEmail.js'
import { createBrevoAdapter } from '../email/brevo.js'

let owner: Pool
let app: Pool

const ABSENDER: PlatformSender = {
  from: { email: 'mail@staygrid.test', name: 'StayGrid' },
  replyTo: { email: 'antwort@staygrid.test' }
}

/** Das Token, wie es in einer echten Nachricht steht. */
const TOKEN = 'ein-token-das-den-zugang-oeffnet'

interface Empfangen {
  headers: Record<string, string | undefined>
  body: {
    sender?: { email?: string; name?: string }
    to?: Array<{ email?: string; name?: string }>
    replyTo?: { email?: string }
    subject?: string
    textContent?: string
  }
}

/**
 * Echter HTTP-Empfaenger, echter Brevo-Adapter, nur mit umgelenktem Ziel --
 * dieselbe Bauart wie in emailDelivery.test.ts und aus demselben Grund: eine
 * Attrappe liesse Kopfzeilen und Rumpfaufbau ungeprueft.
 */
async function anbieter(antwortCode: (nummer: number) => number): Promise<{
  url: string; empfangen: Empfangen[]; schliessen: () => Promise<void>
}> {
  const empfangen: Empfangen[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString('utf8') })
    req.on('end', () => {
      empfangen.push({
        headers: req.headers as Record<string, string | undefined>,
        body: JSON.parse(body || '{}') as Empfangen['body']
      })
      const code = antwortCode(empfangen.length)
      res.writeHead(code, { 'content-type': 'application/json' })
        .end(JSON.stringify(code < 300
          ? { messageId: `<nachricht-${empfangen.length}@brevo>` }
          : { message: 'abgelehnt' }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v3/smtp/email`,
    empfangen,
    schliessen: () => new Promise<void>(r => { server.close(() => { r() }) })
  }
}

async function einreihen(kind: 'invite' | 'password_reset' = 'password_reset'): Promise<number> {
  const u = await owner.query<{ id: number }>(
    `INSERT INTO app_user (email, display_name, status)
     VALUES ('empfaenger@test.de','Frau Meier','invited') RETURNING id`)
  const id = u.rows[0]!.id
  const e = await owner.query<{ id: number }>(
    `INSERT INTO platform_email (user_id, kind, to_email, to_name, subject,
                                 body_text, body_html)
     VALUES ($1,$2,'empfaenger@test.de','Frau Meier','Ihr Zugang',$3,$4)
     RETURNING id`,
    [id, kind, `Guten Tag\n\nhttps://pms.test/kennwort?token=${TOKEN}`,
     `<p><a href="https://pms.test/kennwort?token=${TOKEN}">Link</a></p>`])
  return e.rows[0]!.id
}

interface Zeile {
  status: string; attempts: number; body_text: string; body_html: string | null
  provider_message_id: string | null; last_error: string | null; sent_at: string | null
}

async function zeile(id: number): Promise<Zeile> {
  const r = await owner.query<Zeile>(
    `SELECT status, attempts, body_text, body_html, provider_message_id,
            last_error, sent_at
       FROM platform_email WHERE id = $1`, [id])
  return r.rows[0]!
}

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(4)
})
afterAll(async () => { await owner.end(); await app.end() })
beforeEach(async () => { await truncateAll() })

describe('Zugangspost zustellen', () => {
  it('verschickt mit dem Absender der Plattform, nicht dem eines Hauses', async () => {
    const id = await einreihen()
    const a = await anbieter(() => 201)
    const r = await deliverPlatformEmails(
      app, SYSTEM_CONTEXT, createBrevoAdapter('schluessel', { baseUrl: a.url }), ABSENDER)
    await a.schliessen()

    expect(r).toEqual({ attempted: 1, sent: 1, retrying: 0, failed: 0 })
    expect(a.empfangen).toHaveLength(1)
    const gesendet = a.empfangen[0]!
    expect(gesendet.headers['api-key']).toBe('schluessel')
    // Der Absender kommt aus der Umgebung: diese Nachricht gehoert zu einem
    // Benutzer, und der hat kein Haus, aus dem man ihn nehmen koennte.
    expect(gesendet.body.sender).toEqual({ email: 'mail@staygrid.test', name: 'StayGrid' })
    expect(gesendet.body.replyTo).toEqual({ email: 'antwort@staygrid.test' })
    expect(gesendet.body.to?.[0]?.email).toBe('empfaenger@test.de')
    expect(gesendet.body.textContent).toContain(TOKEN)

    const z = await zeile(id)
    expect(z.status).toBe('sent')
    expect(z.provider_message_id).toBe('<nachricht-1@brevo>')
    expect(z.sent_at).not.toBeNull()
  })

  it('loescht den Rumpf nach dem Versand -- darin steht das Token', async () => {
    const id = await einreihen()
    const a = await anbieter(() => 201)
    await deliverPlatformEmails(
      app, SYSTEM_CONTEXT, createBrevoAdapter('schluessel', { baseUrl: a.url }), ABSENDER)
    await a.schliessen()

    /*
     * Der Punkt der ganzen Uebung: in auth_token steht bewusst nur der Hash
     * des Tokens, damit ein Datenbankauszug keinen Zugang verschafft. Bliebe
     * es hier im Klartext stehen, waere diese Vorsicht wertlos -- und zwar
     * fuer die volle Frist des Tokens.
     */
    const z = await zeile(id)
    expect(z.body_text).toBe('')
    expect(z.body_html).toBeNull()

    // Die Zeile selbst bleibt: "ist die Einladung rausgegangen" kommt noch
    // Wochen spaeter und laesst sich ohne das Token beantworten.
    expect(z.status).toBe('sent')
    expect(z.sent_at).not.toBeNull()
  })

  it('wiederholt einen voruebergehenden Fehler und haelt den Rumpf solange', async () => {
    const id = await einreihen()
    const a = await anbieter(nummer => (nummer === 1 ? 503 : 201))

    const erster = await deliverPlatformEmails(
      app, SYSTEM_CONTEXT, createBrevoAdapter('schluessel', { baseUrl: a.url }), ABSENDER)
    expect(erster).toEqual({ attempted: 1, sent: 0, retrying: 1, failed: 0 })

    const nach = await zeile(id)
    expect(nach.status).toBe('pending')
    expect(nach.attempts).toBe(1)
    // Noch nicht weg: ohne Rumpf gaebe es beim zweiten Versuch nichts mehr
    // zu verschicken.
    expect(nach.body_text).toContain(TOKEN)
    expect(nach.last_error).not.toBeNull()

    // Die Frist steht in der Zukunft; ohne Vorziehen holt der naechste Lauf
    // die Zeile nicht.
    await owner.query(`UPDATE platform_email SET next_attempt_at = now()`)
    const zweiter = await deliverPlatformEmails(
      app, SYSTEM_CONTEXT, createBrevoAdapter('schluessel', { baseUrl: a.url }), ABSENDER)
    await a.schliessen()

    expect(zweiter.sent).toBe(1)
    const fertig = await zeile(id)
    expect(fertig.status).toBe('sent')
    expect(fertig.body_text).toBe('')
  })

  it('gibt eine abgelehnte Adresse sofort auf und raeumt den Rumpf weg', async () => {
    const id = await einreihen()
    const a = await anbieter(() => 400)
    const r = await deliverPlatformEmails(
      app, SYSTEM_CONTEXT, createBrevoAdapter('schluessel', { baseUrl: a.url }), ABSENDER)
    await a.schliessen()

    // Eine abgelehnte Adresse ist beim fuenften Versuch genauso abgelehnt
    // wie beim ersten.
    expect(r).toEqual({ attempted: 1, sent: 0, retrying: 0, failed: 1 })
    const z = await zeile(id)
    expect(z.status).toBe('failed')
    expect(z.attempts).toBe(1)
    // Das Token hat niemanden erreicht und ist wertlos. Es liegenzulassen
    // hiesse, einen ungenutzten Zugang aufzubewahren.
    expect(z.body_text).toBe('')
    expect(z.body_html).toBeNull()
  })

  it('gibt nach der letzten Wiederholung auf', async () => {
    const id = await einreihen()
    const a = await anbieter(() => 503)
    for (let i = 0; i < EMAIL_MAX_ATTEMPTS; i++) {
      await owner.query(`UPDATE platform_email SET next_attempt_at = now()`)
      await deliverPlatformEmails(
        app, SYSTEM_CONTEXT, createBrevoAdapter('schluessel', { baseUrl: a.url }), ABSENDER)
    }
    await a.schliessen()

    const z = await zeile(id)
    expect(z.attempts).toBe(EMAIL_MAX_ATTEMPTS)
    expect(z.status).toBe('failed')
    expect(z.body_text).toBe('')
  })

  it('holt nur faellige Nachrichten', async () => {
    await einreihen()
    await owner.query(`UPDATE platform_email SET next_attempt_at = now() + interval '1 hour'`)
    const a = await anbieter(() => 201)
    const r = await deliverPlatformEmails(
      app, SYSTEM_CONTEXT, createBrevoAdapter('schluessel', { baseUrl: a.url }), ABSENDER)
    await a.schliessen()

    expect(r.attempted).toBe(0)
    expect(a.empfangen).toHaveLength(0)
  })

  it('verschickt ohne Anhang', async () => {
    await einreihen('invite')
    const a = await anbieter(() => 201)
    await deliverPlatformEmails(
      app, SYSTEM_CONTEXT, createBrevoAdapter('schluessel', { baseUrl: a.url }), ABSENDER)
    await a.schliessen()

    // Was hier hinausgeht, ist ein Link und drei Saetze. Ein leeres
    // attachment-Feld mitzuschicken waere fuer Brevo ein Fehler.
    expect(a.empfangen[0]!.body).not.toHaveProperty('attachment')
  })
})
