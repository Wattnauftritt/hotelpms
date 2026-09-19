import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty,
         type Fixture } from '@hotelpms/testing'
import { withTransaction, type DbContext, type Pool } from '@hotelpms/db'
import { webhookSignature, WEBHOOK_HEADERS, WEBHOOK_MAX_ATTEMPTS,
         parseCidrList } from '@hotelpms/domain'
import { deliverWebhooks } from '../jobs/webhookDelivery.js'

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext

const SECRET = 'test-schluessel-fuer-die-signatur'

/*
 * Der Empfaenger im Test steht auf `127.0.0.1`, und genau dorthin wird seit
 * Befund B1 nicht mehr zugestellt. Dieselbe Freigabe, die ein selbst
 * betriebenes Haus fuer sein eigenes Netz eintraegt, macht ihn wieder
 * erreichbar -- der Test geht also denselben Weg wie der Betreiber und nicht
 * an der Pruefung vorbei.
 */
const LOKAL_FREIGEGEBEN = parseCidrList('127.0.0.0/8')

interface Empfangen {
  headers: Record<string, string | undefined>
  body: string
}

/**
 * Ein echter HTTP-Empfaenger, kein Mock: geprueft werden Kopfzeilen,
 * Signatur und das Verhalten bei Fehlerantworten, und all das entsteht erst
 * auf der Leitung.
 */
async function empfaenger(antwortCode: (nummer: number) => number): Promise<{
  url: string; empfangen: Empfangen[]; schliessen: () => Promise<void>
}> {
  const empfangen: Empfangen[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString('utf8') })
    req.on('end', () => {
      empfangen.push({ headers: req.headers as Record<string, string | undefined>, body })
      res.writeHead(antwortCode(empfangen.length)).end()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/ereignisse`,
    empfangen,
    schliessen: () => new Promise<void>(r => { server.close(() => { r() }) })
  }
}

async function abonnement(url: string, eventTypes: string[] = []): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `INSERT INTO webhook_subscription (account_id, url, signing_secret, event_types)
     VALUES ($1,$2,$3,$4::text[]) RETURNING id`,
    [fx.accountId, url, SECRET, eventTypes])
  return r.rows[0]!.id
}

/** Reiht ein Ereignis auf demselben Weg ein wie eine Fachroute. */
async function einreihen(eventType: string, data: Record<string, unknown> = {}): Promise<number> {
  return withTransaction(app, ctx, async client => {
    const r = await client.query<{ webhook_enqueue: number }>(
      `SELECT webhook_enqueue($1,$2,$3::jsonb)`,
      [fx.propertyId, eventType, JSON.stringify(data)])
    return r.rows[0]!.webhook_enqueue
  })
}

/** Simuliert verstrichene Zeit: macht die naechste Wiederholung faellig. */
async function faelligStellen(): Promise<void> {
  await owner.query(
    `UPDATE webhook_delivery SET next_attempt_at = now()
      WHERE property_id = $1 AND status = 'pending'`, [fx.propertyId])
}

interface ZustellZeile {
  status: string; attempts: number; last_status_code: number | null
  last_error: string | null; wartesekunden: number
}

async function zustellung(): Promise<ZustellZeile> {
  const r = await owner.query<ZustellZeile>(
    `SELECT status, attempts, last_status_code, last_error,
            EXTRACT(epoch FROM (next_attempt_at - now()))::int AS wartesekunden
       FROM webhook_delivery WHERE property_id = $1 ORDER BY id LIMIT 1`,
    [fx.propertyId])
  return r.rows[0]!
}

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(10)
})
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
})

describe('Zustellung ausgehender Ereignisse', () => {
  it('stellt zu und signiert ueber Zeitstempel und Rumpf', async () => {
    const e = await empfaenger(() => 200)
    try {
      await abonnement(e.url)
      expect(await einreihen('reservation.created', { reservationRef: 'ABC' })).toBe(1)

      const r = await deliverWebhooks(app, ctx, fx.propertyId, { allowedCidrs: LOKAL_FREIGEGEBEN })
      expect(r).toMatchObject({ attempted: 1, delivered: 1, disabled: 0 })
      expect(e.empfangen).toHaveLength(1)

      const [gesendet] = e.empfangen
      expect(gesendet!.headers[WEBHOOK_HEADERS.event]).toBe('reservation.created')

      const umschlag = JSON.parse(gesendet!.body) as {
        id: string; type: string; propertyRef: string; data: { reservationRef: string } }
      expect(umschlag.type).toBe('reservation.created')
      expect(umschlag.data.reservationRef).toBe('ABC')
      // Nach aussen geht die oeffentliche Referenz, nie die laufende id.
      expect(umschlag.propertyRef).not.toBe(String(fx.propertyId))
      expect(gesendet!.headers[WEBHOOK_HEADERS.delivery]).toBe(umschlag.id)

      const zeitstempel = Number(gesendet!.headers[WEBHOOK_HEADERS.timestamp])
      expect(gesendet!.headers[WEBHOOK_HEADERS.signature])
        .toBe(webhookSignature(SECRET, zeitstempel, gesendet!.body))

      expect((await zustellung()).status).toBe('delivered')
    } finally { await e.schliessen() }
  })

  /**
   * Der Zeitstempel steht innerhalb des signierten Textes. Stuende er nur in
   * der Kopfzeile, koennte ein Mitschneider ihn auf jetzt setzen und eine
   * alte Zustellung erneut einspielen, ohne die Signatur zu brechen.
   */
  it('bindet den Zeitstempel in die Signatur ein', async () => {
    const e = await empfaenger(() => 200)
    try {
      await abonnement(e.url)
      await einreihen('reservation.created')
      await deliverWebhooks(app, ctx, fx.propertyId, { allowedCidrs: LOKAL_FREIGEGEBEN })

      const [gesendet] = e.empfangen
      const echt = Number(gesendet!.headers[WEBHOOK_HEADERS.timestamp])
      expect(webhookSignature(SECRET, echt + 3600, gesendet!.body))
        .not.toBe(gesendet!.headers[WEBHOOK_HEADERS.signature])
    } finally { await e.schliessen() }
  })

  it('wiederholt mit wachsendem Abstand und legt danach das Abonnement still', async () => {
    const e = await empfaenger(() => 500)
    try {
      const abo = await abonnement(e.url)
      await einreihen('reservation.created')

      const erste = await deliverWebhooks(app, ctx, fx.propertyId, { allowedCidrs: LOKAL_FREIGEGEBEN })
      expect(erste).toMatchObject({ attempted: 1, delivered: 0, retrying: 1, disabled: 0 })
      const nachErster = await zustellung()
      expect(nachErster).toMatchObject({ status: 'pending', attempts: 1, last_status_code: 500 })

      await faelligStellen()
      const zweite = await deliverWebhooks(app, ctx, fx.propertyId, { allowedCidrs: LOKAL_FREIGEGEBEN })
      expect(zweite).toMatchObject({ retrying: 1, disabled: 0 })
      const nachZweiter = await zustellung()
      expect(nachZweiter.attempts).toBe(2)
      // Der Kern: der Abstand waechst, er bleibt nicht gleich.
      expect(nachZweiter.wartesekunden).toBeGreaterThan(nachErster.wartesekunden)

      await faelligStellen()
      const dritte = await deliverWebhooks(app, ctx, fx.propertyId, { allowedCidrs: LOKAL_FREIGEGEBEN })
      expect(dritte).toMatchObject({ attempted: 1, delivered: 0, retrying: 0, disabled: 1 })

      expect(e.empfangen).toHaveLength(WEBHOOK_MAX_ATTEMPTS)
      expect((await zustellung()).status).toBe('failed')

      const a = await owner.query<{ status: string; disabled_reason: string
                                    disabled_at: string | null }>(
        `SELECT status, disabled_reason, disabled_at FROM webhook_subscription WHERE id = $1`,
        [abo])
      expect(a.rows[0]!.status).toBe('disabled')
      expect(a.rows[0]!.disabled_at).not.toBeNull()
      // Der Grund nennt die Art, nicht mehr `HTTP 500` und erst recht keine
      // Adresse: das Protokoll gab bisher heraus, was wo geantwortet hat.
      expect(a.rows[0]!.disabled_reason).toContain('abgelehnt')
      expect(a.rows[0]!.disabled_reason).not.toMatch(/127\.0\.0\.1|ECONN/)

      // Und im Versuchsprotokoll steht jeder einzelne Versuch.
      const protokoll = await owner.query<{ attempt: number; status_code: number }>(
        `SELECT attempt, status_code FROM webhook_delivery_attempt
          WHERE property_id = $1 ORDER BY attempt`, [fx.propertyId])
      expect(protokoll.rows.map(z => z.attempt)).toEqual([1, 2, 3])
      expect(protokoll.rows.every(z => z.status_code === 500)).toBe(true)
    } finally { await e.schliessen() }
  })

  it('stellt an ein stillgelegtes Abonnement nichts mehr zu', async () => {
    const e = await empfaenger(() => 500)
    try {
      await abonnement(e.url)
      await einreihen('reservation.created')
      for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i++) {
        await faelligStellen()
        await deliverWebhooks(app, ctx, fx.propertyId, { allowedCidrs: LOKAL_FREIGEGEBEN })
      }
      const bisher = e.empfangen.length

      // Ein neues Ereignis wird gar nicht erst eingereiht ...
      expect(await einreihen('reservation.checked_in')).toBe(0)
      // ... und auch sonst geht nichts mehr hinaus.
      expect(await deliverWebhooks(app, ctx, fx.propertyId, { allowedCidrs: LOKAL_FREIGEGEBEN }))
        .toMatchObject({ attempted: 0 })
      expect(e.empfangen).toHaveLength(bisher)
    } finally { await e.schliessen() }
  })

  it('reiht nur die abonnierten Ereignisarten ein', async () => {
    const e = await empfaenger(() => 200)
    try {
      await abonnement(e.url, ['invoice.finalized'])
      expect(await einreihen('reservation.created')).toBe(0)
      expect(await einreihen('invoice.finalized')).toBe(1)

      await deliverWebhooks(app, ctx, fx.propertyId, { allowedCidrs: LOKAL_FREIGEGEBEN })
      expect(e.empfangen).toHaveLength(1)
      expect((JSON.parse(e.empfangen[0]!.body) as { type: string }).type)
        .toBe('invoice.finalized')
    } finally { await e.schliessen() }
  })

  it('behandelt einen unerreichbaren Empfaenger wie eine Fehlerantwort', async () => {
    // Ein Server, der sofort wieder zumacht: die Verbindung wird abgelehnt.
    const e = await empfaenger(() => 200)
    const url = e.url
    await e.schliessen()

    await abonnement(url)
    await einreihen('reservation.created')
    const r = await deliverWebhooks(app, ctx, fx.propertyId,
      { requestTimeoutMs: 2000, allowedCidrs: LOKAL_FREIGEGEBEN })

    expect(r).toMatchObject({ attempted: 1, delivered: 0, retrying: 1 })
    const z = await zustellung()
    expect(z.last_status_code).toBeNull()
    // Die Art, nicht der Rohtext von Node: der nannte Adresse und Port.
    expect(z.last_error).toBe('refused')
  })

  /*
   * Befund B1. Die drei Tests hier pruefen nicht, dass eine Meldung kommt,
   * sondern dass der Empfaenger **nichts** bekommt: der Schaden entsteht
   * schon durch die Verbindung, nicht erst durch das, was zurueckkommt.
   */
  it('stellt ohne Freigabe nicht an eine innere Adresse zu', async () => {
    const e = await empfaenger(() => 200)
    try {
      await abonnement(e.url)
      await einreihen('reservation.created')

      // Ohne allowedCidrs -- so, wie jede gehostete Installation laeuft.
      const r = await deliverWebhooks(app, ctx, fx.propertyId)
      expect(r).toMatchObject({ attempted: 1, delivered: 0, retrying: 1 })

      // Der Kern: es ist nie jemand angeklopft worden.
      expect(e.empfangen).toHaveLength(0)
      const z = await zustellung()
      expect(z.last_error).toBe('blockedTarget')
      expect(z.last_status_code).toBeNull()
    } finally { await e.schliessen() }
  })

  it('stellt nicht an die Metadatenadresse des Hosters zu', async () => {
    // Die Adresse, unter der jeder Hoster Rollen und Zugangsdaten
    // ausliefert. Sie beginnt mit https und kam frueher durch.
    await abonnement('https://169.254.169.254/latest/meta-data/')
    await einreihen('reservation.created')

    const r = await deliverWebhooks(app, ctx, fx.propertyId, { requestTimeoutMs: 2000 })
    expect(r).toMatchObject({ attempted: 1, delivered: 0, retrying: 1 })
    expect((await zustellung()).last_error).toBe('blockedTarget')
  })

  it('folgt keiner Umleitung auf eine gesperrte Adresse', async () => {
    /*
     * Der Umweg ist der Grund, warum die Pruefung allein nicht reicht: das
     * Ziel ist sauber, und erst die Antwort zeigt nach innen. `fetch` waere
     * der `302` von sich aus gefolgt.
     */
    const e = await empfaenger(() => 302)
    try {
      await abonnement(e.url)
      await einreihen('reservation.created')

      const r = await deliverWebhooks(app, ctx, fx.propertyId,
        { allowedCidrs: LOKAL_FREIGEGEBEN })
      expect(r).toMatchObject({ attempted: 1, delivered: 0, retrying: 1 })
      // Einmal angeklopft, der Umleitung nicht gefolgt.
      expect(e.empfangen).toHaveLength(1)
      const z = await zustellung()
      expect(z.last_status_code).toBe(302)
      expect(z.last_error).toBe('httpStatus')
    } finally { await e.schliessen() }
  })

  it('laesst die Ereignisse eines fremden Mandanten unberuehrt', async () => {
    const e = await empfaenger(() => 200)
    try {
      await abonnement(e.url)
      await einreihen('reservation.created')

      // Ein anderes Haus, anderer Account: sein Worker-Kontext sieht nichts.
      const fremd = await makeProperty(owner, { code: 'FREMD' })
      const fremdCtx: DbContext = {
        accountIds: [fremd.accountId], propertyIds: [fremd.propertyId], userId: null }
      expect(await deliverWebhooks(app, fremdCtx, fremd.propertyId,
        { allowedCidrs: LOKAL_FREIGEGEBEN }))
        .toMatchObject({ attempted: 0 })
      expect(e.empfangen).toHaveLength(0)

      // Auch nicht mit der fremden Property-Nummer im eigenen Kontext.
      expect(await deliverWebhooks(app, fremdCtx, fx.propertyId,
        { allowedCidrs: LOKAL_FREIGEGEBEN }))
        .toMatchObject({ attempted: 0 })
      expect(e.empfangen).toHaveLength(0)
    } finally { await e.schliessen() }
  })
})
