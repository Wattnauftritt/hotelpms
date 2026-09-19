import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty,
         makeEmailDomain, type Fixture } from '@hotelpms/testing'
import { withTransaction, type DbContext, type Pool } from '@hotelpms/db'
import { EMAIL_MAX_ATTEMPTS } from '@hotelpms/domain'
import { deliverEmails } from '../jobs/emailDelivery.js'
import { createBrevoAdapter } from '../email/brevo.js'

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext

interface Empfangen {
  headers: Record<string, string | undefined>
  body: {
    sender?: { email?: string; name?: string }
    to?: Array<{ email?: string; name?: string }>
    replyTo?: { email?: string }
    bcc?: Array<{ email?: string }>
    subject?: string
    textContent?: string
    htmlContent?: string
    attachment?: Array<{ name: string; content: string }>
  }
}

/**
 * Ein echter HTTP-Empfaenger und der **echte** Brevo-Adapter, nur mit
 * umgelenktem Ziel. Eine Attrappe an dieser Stelle liesse genau das
 * ungeprueft, was hier schiefgehen kann: die Kopfzeile mit dem Schluessel,
 * der Aufbau des Rumpfes und die Kodierung des Anhangs.
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

async function absender(enabled = true, bcc: string | null = null): Promise<void> {
  // Ohne freigeschaltete Domain reiht email_enqueue nichts mehr ein
  // (Migration 0052). Auch bei enabled = false, weil dieselben Tests danach
  // einreihen und erst dann ausschalten.
  await makeEmailDomain(owner, fx.propertyId, 'seeblick.test')
  await owner.query(
    `INSERT INTO property_email_setting
       (property_id, from_name, from_email, reply_to, bcc_email, enabled)
     VALUES ($1,'Hotel Seeblick','post@seeblick.test','rezeption@seeblick.test',$2,$3)
     ON CONFLICT (property_id) DO UPDATE
       SET enabled = EXCLUDED.enabled, bcc_email = EXCLUDED.bcc_email`,
    [fx.propertyId, bcc, enabled])
}

/** Reiht auf demselben Weg ein wie eine Fachroute. */
async function einreihen(opts: {
  kind?: string; to?: string; invoiceId?: number | null; reservationId?: number | null
} = {}): Promise<string> {
  return withTransaction(app, ctx, async client => {
    const r = await client.query<{ ref: string }>(
      `SELECT email_enqueue($1,$2,$3,'Anna Beispiel','Ihre Rechnung',
                            'Guten Tag Anna Beispiel, anbei Ihre Rechnung.',
                            '<p>Guten Tag</p>',$4,$5,NULL) AS ref`,
      [fx.propertyId, opts.kind ?? 'invoice', opts.to ?? 'anna@gast.test',
       opts.invoiceId ?? null, opts.reservationId ?? null])
    return r.rows[0]!.ref
  })
}

/** Eine festgeschriebene Rechnung mit Folio, ohne den Weg ueber die API. */
let rechnungsnummer = 0

async function rechnung(mitBeleg = true): Promise<number> {
  const nummer = `2026-${String(++rechnungsnummer).padStart(6, '0')}`
  const f = await owner.query<{ id: number }>(
    `INSERT INTO folio (property_id, kind) VALUES ($1,'guest') RETURNING id`,
    [fx.propertyId])
  const i = await owner.query<{ id: number }>(
    `INSERT INTO invoice (property_id, folio_id, number, issued_on, business_date,
                          issuer_snapshot, recipient_snapshot, totals)
     VALUES ($1,$2,$3,current_date,current_date,'{}'::jsonb,'{}'::jsonb,
             '{"grossCent":50000}'::jsonb)
     RETURNING id`, [fx.propertyId, f.rows[0]!.id, nummer])
  if (mitBeleg) {
    await owner.query(
      `INSERT INTO invoice_document (invoice_id, property_id, pdf, byte_count, sha256)
       VALUES ($1,$2,$3,$4,'abc123')`,
      [i.rows[0]!.id, fx.propertyId, Buffer.from('%PDF-1.7 Beleg'), 14])
  }
  return i.rows[0]!.id
}

async function zeile(ref: string): Promise<{
  status: string; attempts: number; provider_message_id: string | null
  last_error: string | null; attachment_sha256: string | null; next_attempt_at: Date }> {
  const r = await owner.query(
    `SELECT status, attempts, provider_message_id, last_error, attachment_sha256,
            next_attempt_at FROM outbound_email WHERE public_ref = $1`, [ref])
  return r.rows[0] as never
}

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(5)
})
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  rechnungsnummer = 0
  fx = await makeProperty(owner)
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
})

describe('Einreihen', () => {
  it('verweigert den Versand aus einem Uebungshaus', async () => {
    await absender()
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])

    // Schulungsdaten tragen echte Adressen, weil jemand seine eigene
    // eingetragen hat. Eine erfundene Rechnung an einen echten Empfaenger
    // laesst sich nicht zurueckholen.
    await expect(einreihen()).rejects.toThrow(/Uebungshaus/)
  })

  it('verweigert den Versand, solange er nicht eingeschaltet ist', async () => {
    await absender(false)
    await expect(einreihen()).rejects.toThrow(/nicht eingeschaltet/)
  })

  it('laesst eine Bestaetigung ohne Reservierung nicht zu', async () => {
    await absender()
    await expect(einreihen({ kind: 'reservation_confirmation' }))
      .rejects.toThrow(/outbound_email_bezug/)
  })
})

describe('Zustellung', () => {
  it('schickt Absender, Empfaenger, Antwortadresse und beide Rumpfteile', async () => {
    await absender(true, 'kopie@seeblick.test')
    const id = await rechnung()
    const ref = await einreihen({ invoiceId: id })
    const a = await anbieter(() => 201)

    const r = await deliverEmails(app, ctx, fx.propertyId,
      createBrevoAdapter('xkeysib-test', { baseUrl: a.url }))
    await a.schliessen()

    expect(r).toMatchObject({ attempted: 1, sent: 1, retrying: 0, failed: 0 })
    expect(a.empfangen).toHaveLength(1)
    const m = a.empfangen[0]!
    // Der Schluessel reist als Kopfzeile, nicht als Bearer-Token: so will
    // es die API von Brevo.
    expect(m.headers['api-key']).toBe('xkeysib-test')
    expect(m.body.sender).toMatchObject({ email: 'post@seeblick.test', name: 'Hotel Seeblick' })
    expect(m.body.to?.[0]).toMatchObject({ email: 'anna@gast.test', name: 'Anna Beispiel' })
    expect(m.body.replyTo?.email).toBe('rezeption@seeblick.test')
    expect(m.body.bcc?.[0]?.email).toBe('kopie@seeblick.test')
    expect(m.body.textContent).toContain('Anna Beispiel')
    expect(m.body.htmlContent).toContain('<p>')

    const z = await zeile(ref)
    expect(z.status).toBe('sent')
    expect(z.provider_message_id).toBe('<nachricht-1@brevo>')
  })

  it('haengt den archivierten Beleg an, nicht eine neu erzeugte Fassung', async () => {
    await absender()
    const id = await rechnung()
    const ref = await einreihen({ invoiceId: id })
    const a = await anbieter(() => 201)

    await deliverEmails(app, ctx, fx.propertyId,
      createBrevoAdapter('k', { baseUrl: a.url }))
    await a.schliessen()

    const anhang = a.empfangen[0]!.body.attachment
    expect(anhang).toHaveLength(1)
    expect(anhang![0]!.name).toMatch(/^Rechnung-2026-\d{6}\.pdf$/)
    expect(Buffer.from(anhang![0]!.content, 'base64').toString('utf8'))
      .toBe('%PDF-1.7 Beleg')

    // Der Fingerabdruck des Archivs wandert an die Zustellung: damit ist
    // belegbar, welche Fassung der Gast bekommen hat.
    expect((await zeile(ref)).attachment_sha256).toBe('abc123')
  })

  it('holt eine Rechnungsmail erst, wenn der Beleg fertig ist', async () => {
    await absender()
    const id = await rechnung(false)   // Beleg fehlt noch, wie kurz nach dem Check-out
    const ref = await einreihen({ invoiceId: id })
    const a = await anbieter(() => 201)
    const adapter = createBrevoAdapter('k', { baseUrl: a.url })

    const ohne = await deliverEmails(app, ctx, fx.propertyId, adapter)
    expect(ohne.attempted).toBe(0)
    // Und zwar ohne einen Versuch zu verbrauchen: sie ist nicht
    // fehlgeschlagen, sie ist noch nicht dran.
    expect((await zeile(ref)).attempts).toBe(0)

    await owner.query(
      `INSERT INTO invoice_document (invoice_id, property_id, pdf, byte_count, sha256)
       VALUES ($1,$2,$3,4,'spaeter')`,
      [id, fx.propertyId, Buffer.from('%PDF')])

    const mit = await deliverEmails(app, ctx, fx.propertyId, adapter)
    await a.schliessen()
    expect(mit.sent).toBe(1)
  })

  it('stellt nichts zu, solange der Versand ausgeschaltet ist', async () => {
    await absender()
    const ref = await einreihen({ invoiceId: await rechnung() })
    await owner.query(
      `UPDATE property_email_setting SET enabled = false WHERE property_id = $1`,
      [fx.propertyId])
    const a = await anbieter(() => 201)

    const r = await deliverEmails(app, ctx, fx.propertyId,
      createBrevoAdapter('k', { baseUrl: a.url }))
    await a.schliessen()

    expect(r.attempted).toBe(0)
    expect(a.empfangen).toHaveLength(0)
    expect((await zeile(ref)).status).toBe('pending')
  })
})

describe('Fehlschlag', () => {
  it('gibt eine abgelehnte Adresse sofort auf, statt fuenfmal anzurennen', async () => {
    await absender()
    const ref = await einreihen({ invoiceId: await rechnung() })
    const a = await anbieter(() => 400)

    const r = await deliverEmails(app, ctx, fx.propertyId,
      createBrevoAdapter('k', { baseUrl: a.url }))
    await a.schliessen()

    expect(r).toMatchObject({ attempted: 1, sent: 0, failed: 1, retrying: 0 })
    const z = await zeile(ref)
    expect(z.status).toBe('failed')
    // Genau ein Versuch: eine 400 bleibt eine 400.
    expect(z.attempts).toBe(1)
    expect(z.last_error).toContain('400')
  })

  it('wiederholt eine Ueberlastung mit wachsendem Abstand und gibt dann auf', async () => {
    await absender()
    const ref = await einreihen({ invoiceId: await rechnung() })
    const a = await anbieter(() => 503)
    const adapter = createBrevoAdapter('k', { baseUrl: a.url })

    const abstaende: number[] = []
    for (let i = 1; i <= EMAIL_MAX_ATTEMPTS; i++) {
      const r = await deliverEmails(app, ctx, fx.propertyId, adapter, { baseDelaySeconds: 10 })
      expect(r.attempted).toBe(1)
      const z = await zeile(ref)
      expect(z.attempts).toBe(i)
      if (i < EMAIL_MAX_ATTEMPTS) {
        expect(z.status).toBe('pending')
        abstaende.push(Math.round((z.next_attempt_at.getTime() - Date.now()) / 1000))
        // Faellig stellen, sonst holt der naechste Lauf sie nicht.
        await owner.query(
          `UPDATE outbound_email SET next_attempt_at = now() WHERE public_ref = $1`, [ref])
      }
    }
    await a.schliessen()

    // 10, 20, 40, 80 Sekunden: jeder Abstand groesser als der davor.
    expect(abstaende).toHaveLength(EMAIL_MAX_ATTEMPTS - 1)
    for (let i = 1; i < abstaende.length; i++) {
      expect(abstaende[i]!).toBeGreaterThan(abstaende[i - 1]!)
    }
    expect((await zeile(ref)).status).toBe('failed')
  })

  it('haelt wegen einer unzustellbaren Nachricht nicht das ganze Haus an', async () => {
    await absender()
    const schlecht = await einreihen({ invoiceId: await rechnung(), to: 'weg@gast.test' })
    const gut = await einreihen({ invoiceId: await rechnung() })
    // Die erste wird abgelehnt, die zweite angenommen.
    const a = await anbieter(n => (n === 1 ? 400 : 201))

    const r = await deliverEmails(app, ctx, fx.propertyId,
      createBrevoAdapter('k', { baseUrl: a.url }))
    await a.schliessen()

    expect(r).toMatchObject({ attempted: 2, sent: 1, failed: 1 })
    expect((await zeile(schlecht)).status).toBe('failed')
    expect((await zeile(gut)).status).toBe('sent')
    // Anders als beim Webhook wird nichts stillgelegt: eine falsch
    // getippte Gastadresse darf den Rechnungsversand des Hauses nicht
    // anhalten.
    const s = await owner.query<{ enabled: boolean }>(
      `SELECT enabled FROM property_email_setting WHERE property_id = $1`, [fx.propertyId])
    expect(s.rows[0]!.enabled).toBe(true)
  })

  it('zaehlt den Versuch auch dann, wenn die Verbindung stirbt', async () => {
    await absender()
    const ref = await einreihen({ invoiceId: await rechnung() })
    // Ein Ziel, das niemand bedient: keine Antwort, also kein Code.
    const adapter = createBrevoAdapter('k',
      { baseUrl: 'http://127.0.0.1:9/v3/smtp/email', timeoutMs: 500 })

    const r = await deliverEmails(app, ctx, fx.propertyId, adapter)

    expect(r.retrying).toBe(1)
    const z = await zeile(ref)
    expect(z.attempts).toBe(1)
    // Ohne Code ist der Fehler voruebergehend: es wird wiederholt.
    expect(z.status).toBe('pending')
  })
})

describe('Gastdaten altern lassen', () => {
  it('entfernt Empfaenger und Rumpf, behaelt den Nachweis', async () => {
    await absender()
    const ref = await einreihen({ invoiceId: await rechnung() })
    const a = await anbieter(() => 201)
    await deliverEmails(app, ctx, fx.propertyId, createBrevoAdapter('k', { baseUrl: a.url }))
    await a.schliessen()

    await owner.query(
      `UPDATE outbound_email SET created_at = now() - interval '100 days'
        WHERE public_ref = $1`, [ref])
    const n = await withTransaction(app, ctx, c =>
      c.query<{ n: number }>(`SELECT email_redact_old($1,90) AS n`, [fx.propertyId]))
    expect(n.rows[0]!.n).toBe(1)

    const r = await owner.query<{
      to_email: string; body_text: string; status: string
      provider_message_id: string | null; attachment_sha256: string | null }>(
      `SELECT to_email, body_text, status, provider_message_id, attachment_sha256
         FROM outbound_email WHERE public_ref = $1`, [ref])
    const z = r.rows[0]!
    expect(z.to_email).toBe('entfernt@invalid')
    expect(z.body_text).toBe('')
    // Die Antwort auf "ist die Rechnung rausgegangen" bleibt erhalten.
    expect(z.status).toBe('sent')
    expect(z.provider_message_id).toBe('<nachricht-1@brevo>')
    expect(z.attachment_sha256).toBe('abc123')
  })

  it('ruehrt eine noch nicht abgeschickte Nachricht nicht an', async () => {
    await absender()
    const ref = await einreihen({ invoiceId: await rechnung() })
    await owner.query(
      `UPDATE outbound_email SET created_at = now() - interval '365 days'
        WHERE public_ref = $1`, [ref])

    const n = await withTransaction(app, ctx, c =>
      c.query<{ n: number }>(`SELECT email_redact_old($1,90) AS n`, [fx.propertyId]))
    // Sonst ginge sie spaeter ohne Empfaenger hinaus.
    expect(n.rows[0]!.n).toBe(0)
    expect((await zeile(ref)).status).toBe('pending')
  })
})
