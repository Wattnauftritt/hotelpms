import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { renderTicketNotice, renderTicketReplyEmail } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { Errors, type Meldung } from '../platform/errors.js'
import { loadConfig } from '../platform/config.js'
import { tx } from '../platform/db.js'
import { accountsWith, canInAccount, type Principal } from '../platform/context.js'
import { tooManyRequests } from '../platform/rateLimit.js'
import { belegArt, belegSenden } from '../platform/kassenbuch.js'
import { kennung } from './platform.js'

const config = loadConfig()

/**
 * Das Ticketsystem (Migration 0208): Anfragen unserer Kunden an uns.
 *
 * **Zwei Seiten.** Der Kunde arbeitet unter seinem Mandantenkontext, die
 * Zeilenrichtlinie haelt ihn in seinem Account und blendet interne Notizen
 * aus. Die Plattform arbeitet ueber die Funktionen aus 0208, die das Recht
 * selbst pruefen -- ohne Support-Sitzung hat sie keinen Kontext, und eine
 * gewoehnliche Abfrage kaeme still leer zurueck.
 *
 * **Wer was sieht (Sven, 23.10.2026).** Jeder seine eigenen Tickets; wer im
 * Betrieb `settings:account` hat, also Inhaber und Kontoverwaltung, alle
 * des Betriebs. Ein Ticket ohne Anmeldung gibt es nicht: wer ausgesperrt
 * ist, hat "Kennwort vergessen" und die Mail an support@.
 *
 * **Keine Ticketinhalte in Mails.** Beide Hinweise nennen Nummer und Link,
 * sonst nichts (`renderTicketNotice`, `renderTicketReplyEmail`).
 */

/** Hoechstens so viele Anhaenge je Nachricht, so gross je Datei. */
export const TICKET_ANHAENGE_MAX = 3
export const TICKET_ANHANG_MAX_BYTES = 5 * 1024 * 1024
/** Base64 traegt ein Drittel mehr, dazu Text und Huelle. */
const TICKET_RUMPF_MAX = Math.ceil(TICKET_ANHAENGE_MAX * TICKET_ANHANG_MAX_BYTES * 4 / 3)
  + 64 * 1024
const BETREFF_MAX = 200
const TEXT_MAX = 10_000
/**
 * Nachrichten eines Menschen je Stunde, Tickets und Antworten zusammen.
 *
 * Jede erzeugt eine Mail an unser Postfach, und die allgemeine
 * Ratenbegrenzung erreicht eine angemeldete Anfrage nicht (CLAUDE.md). In
 * der Datenbank gezaehlt statt im Speicher: so gilt die Grenze ueber einen
 * Neustart hinweg, und kein Test muss einen Zaehler zuruecksetzen.
 */
const NACHRICHTEN_JE_STUNDE = 30

export const TICKET_ARTEN = ['question', 'bug', 'wish', 'billing'] as const
const DRINGLICHKEITEN = ['normal', 'down'] as const
const ZUSTAENDE = ['open', 'waiting_customer', 'closed'] as const

interface Anhang { mime: string; bytes: Buffer; name: string | null }

/** Ein Anhang aus dem Rumpf, an den ersten Bytes erkannt (wie die Kassenbelege). */
function anhaengeAusRumpf(roh: unknown): Anhang[] {
  if (roh === undefined || roh === null) return []
  if (!Array.isArray(roh)) throw Errors.validation({ attachments: ['field.invalid'] })
  if (roh.length > TICKET_ANHAENGE_MAX) {
    throw Errors.validation({ attachments: ['ticket.tooManyAttachments'] },
      { max: TICKET_ANHAENGE_MAX })
  }
  return roh.map((a: { data?: unknown; name?: unknown } | null) => {
    const daten = a?.data
    if (typeof daten !== 'string' || daten === '') {
      throw Errors.validation({ attachments: ['field.invalid'] })
    }
    const text = daten.replace(/^data:[^,]*,/, '')
    if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) throw Errors.validation({ attachments: ['field.invalid'] })
    const bytes = Buffer.from(text, 'base64')
    if (bytes.length === 0) throw Errors.validation({ attachments: ['field.invalid'] })
    if (bytes.length > TICKET_ANHANG_MAX_BYTES) {
      throw Errors.validation({ attachments: ['ticket.attachmentTooLarge'] },
        { max: TICKET_ANHANG_MAX_BYTES / 1024 / 1024 })
    }
    const mime = belegArt(bytes)
    if (mime === null) throw Errors.validation({ attachments: ['ticket.attachmentType'] })
    const name = typeof a?.name === 'string' && a.name.trim() !== ''
      ? a.name.trim().slice(0, 255) : null
    return { mime, bytes, name }
  })
}

function textFeld(
  wert: unknown, max: number, feld: string, fehler: Record<string, Meldung[]>
): string {
  const s = typeof wert === 'string' ? wert.trim() : ''
  if (s === '') fehler[feld] = ['field.required']
  else if (s.length > max) fehler[feld] = ['field.maxLength']
  return s
}

/** Ein Ticket gehoert einem Menschen. Ein Maschinenzugang hat niemanden, der antwortet. */
function mensch(p: Principal): number {
  if (p.userId === null || p.terminalDeviceId !== null) throw Errors.forbidden('ticket.humanOnly')
  return p.userId
}

/**
 * Die Bedingung, unter der ein Ticket sichtbar ist, als SQL-Bruchstueck
 * ueber `t`. Zwei Listen statt einer, weil die eigenen Tickets in jedem
 * Betrieb sichtbar sind, in dem man fragen darf, die fremden nur dort, wo
 * man `settings:account` hat -- nicht dort, wo man nur putzt.
 */
function sichtbarkeit(p: Principal, ab: number): { sql: string; params: unknown[] } {
  return {
    sql: `(t.account_id = ANY($${ab}::bigint[])
           OR (t.created_by = $${ab + 1} AND t.account_id = ANY($${ab + 2}::bigint[])))`,
    params: [accountsWith(p, 'settings:account'), p.userId,
             accountsWith(p, 'support:ticket')]
  }
}

interface KopfZeile {
  id: number; account_id: number; property_name: string | null; created_by: number
  created_by_name: string; subject: string; category: string; urgency: string
  status: string; created_at: string; updated_at: string; last_customer_at: string
  last_staff_at: string | null; closed_at: string | null
}

function kopfNachAussen(z: KopfZeile, ich: number | null): Record<string, unknown> {
  return {
    id: z.id, accountId: z.account_id, propertyName: z.property_name,
    createdByName: z.created_by_name, mine: z.created_by === ich,
    subject: z.subject, category: z.category, urgency: z.urgency, status: z.status,
    createdAt: z.created_at, updatedAt: z.updated_at,
    lastCustomerAt: z.last_customer_at, lastStaffAt: z.last_staff_at, closedAt: z.closed_at
  }
}

const KOPF = `
  t.id, t.account_id, p.name AS property_name, t.created_by,
  u.display_name AS created_by_name, t.subject, t.category, t.urgency, t.status,
  t.created_at::text, t.updated_at::text, t.last_customer_at::text,
  t.last_staff_at::text, t.closed_at::text
  FROM support_ticket t
  JOIN app_user u ON u.id = t.created_by
  -- LEFT: ein Haus, das der Leser nicht sieht, laesst den Namen leer, nicht das Ticket.
  LEFT JOIN property p ON p.id = t.property_id`

/** Zustand einer Sitzung, wie support.ts ihn zeigt. Abgeleitet, nicht gespeichert. */
function sitzungsZustand(s: { granted_at: string | null; expires_at: string
                              revoked_at: string | null }): string {
  if (s.revoked_at !== null) return 'revoked'
  if (Date.parse(s.expires_at) <= Date.now()) return 'expired'
  return s.granted_at !== null ? 'active' : 'pending'
}

async function nachrichtenProStunde(client: PoolClient, userId: number): Promise<void> {
  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM support_ticket_message
      WHERE author_id = $1 AND author_side = 'customer'
        AND created_at > now() - interval '1 hour'`, [userId])
  if (r.rows[0]!.n >= NACHRICHTEN_JE_STUNDE) throw tooManyRequests(3600)
}

async function anhaengeSchreiben(
  client: PoolClient, ticketId: number, accountId: number, messageId: number, anhaenge: Anhang[]
): Promise<void> {
  if (anhaenge.length === 0) return
  await client.query(
    `INSERT INTO support_ticket_attachment
       (ticket_id, account_id, message_id, file_name, mime, byte_count, bytes)
     SELECT $1, $2, $3, x.name, x.mime, octet_length(x.bytes), x.bytes
       FROM unnest($4::text[], $5::text[], $6::bytea[]) AS x(name, mime, bytes)`,
    [ticketId, accountId, messageId, anhaenge.map(a => a.name), anhaenge.map(a => a.mime),
     anhaenge.map(a => a.bytes)])
}

/** Hinweis an unser Postfach. Der Kundenname kommt aus `account`, im Kontext des Kunden. */
async function hinweisAnUns(
  client: PoolClient, ticketId: number, accountId: number, neu: boolean, dringend: boolean
): Promise<void> {
  const a = await client.query<{ name: string }>(
    `SELECT name FROM account WHERE id = $1`, [accountId])
  const text = renderTicketNotice({
    ticketId, accountName: a.rows[0]?.name ?? `#${accountId}`, neu, dringend,
    link: `${config.publicAppUrl}/?screen=admin&ticket=${ticketId}`
  })
  await client.query(
    `INSERT INTO platform_email (user_id, kind, to_email, to_name, subject, body_text, body_html)
     VALUES (NULL, 'ticket_notice', $1, NULL, $2, $3, $4)`,
    [config.platformSupportEmail, text.subject, text.text, text.html])
}

export function ticketRoutes(app: FastifyInstance): void {
  // ------------------------------------------------------------ Kundenseite

  registerRoute(app, {
    method: 'GET',
    url: '/v1/support-tickets',
    permission: 'support:ticket',
    summary: 'Eigene Anfragen an den Support, fuer die Kontoverwaltung alle des Betriebs',
    handler: async (req) => {
      const principal = req.principal as Principal
      const ich = mensch(principal)
      const status = String((req.query as { status?: string }).status ?? 'active')
      if (!['active', 'all', ...ZUSTAENDE].includes(status)) {
        throw Errors.validation({ status: ['field.invalid'] })
      }
      const s = sichtbarkeit(principal, 2)
      const r = await tx(req.pool, req, client =>
        client.query<KopfZeile>(
          `SELECT ${KOPF}
            WHERE ${s.sql}
              AND ($1 = 'all' OR ($1 = 'active' AND t.status <> 'closed') OR t.status = $1)
            ORDER BY (t.status = 'waiting_customer') DESC, t.updated_at DESC
            LIMIT 200`, [status, ...s.params]))
      return { tickets: r.rows.map(z => kopfNachAussen(z, ich)) }
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/support-tickets',
    permission: 'support:ticket',
    // Das Haus, aus dem gefragt wird. registerRoute prueft es gegen den Kontext.
    propertyParam: 'propertyId',
    bodyLimit: TICKET_RUMPF_MAX,
    summary: 'Anfrage an den Support stellen',
    handler: async (req, reply) => {
      const principal = req.principal as Principal
      const ich = mensch(principal)
      const b = (req.body ?? {}) as Record<string, unknown>
      const f: Record<string, Meldung[]> = {}
      const betreff = textFeld(b.subject, BETREFF_MAX, 'subject', f)
      const text = textFeld(b.body, TEXT_MAX, 'body', f)
      const art = b.category ?? 'question'
      if (!(TICKET_ARTEN as readonly unknown[]).includes(art)) f.category = ['field.invalid']
      const dringlichkeit = b.urgency ?? 'normal'
      if (!(DRINGLICHKEITEN as readonly unknown[]).includes(dringlichkeit)) {
        f.urgency = ['field.invalid']
      }
      if (Object.keys(f).length > 0) {
        throw Errors.validation(f, { max: f.subject !== undefined ? BETREFF_MAX : TEXT_MAX })
      }
      const anhaenge = anhaengeAusRumpf(b.attachments)

      // Der Betrieb: aus dem Haus, sonst aus der Angabe, sonst der einzige.
      const haus = b.propertyId === undefined || b.propertyId === null
        ? null : Number(b.propertyId)
      let konto: number
      if (haus !== null) {
        const k = principal.propertyAccounts.get(haus)
        if (k === undefined) throw Errors.forbidden('access.propertyOutOfScope')
        konto = k
      } else {
        const angegeben = b.accountId === undefined ? undefined : Number(b.accountId)
        if (angegeben !== undefined && !principal.accountIds.includes(angegeben)) {
          throw Errors.forbidden('access.accountOutOfScope')
        }
        const moeglich = accountsWith(principal, 'support:ticket')
        if (angegeben !== undefined) konto = angegeben
        else if (moeglich.length === 1) konto = moeglich[0]!
        else throw Errors.validation({ accountId: ['field.requiredWithManyAccounts'] })
      }
      if (!canInAccount(principal, 'support:ticket', konto)) {
        throw Errors.forbidden('access.missingPermission', { permission: 'support:ticket' })
      }
      // Wo es geschah. Nur der Schluessel des Bildschirms, nie die Adresse.
      const bildschirm = typeof b.screen === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(b.screen)
        ? b.screen : null
      const version = typeof b.clientVersion === 'string'
        ? b.clientVersion.slice(0, 80) : null

      const id = await tx(req.pool, req, async client => {
        await nachrichtenProStunde(client, ich)
        const t = await client.query<{ id: number }>(
          `INSERT INTO support_ticket (account_id, property_id, created_by, subject, category,
                                       urgency, screen, client_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [konto, haus, ich, betreff, art, dringlichkeit, bildschirm, version])
        const ticketId = t.rows[0]!.id
        const m = await client.query<{ id: number }>(
          `INSERT INTO support_ticket_message (ticket_id, account_id, author_id, author_side, body)
           VALUES ($1,$2,$3,'customer',$4) RETURNING id`, [ticketId, konto, ich, text])
        await anhaengeSchreiben(client, ticketId, konto, m.rows[0]!.id, anhaenge)
        await hinweisAnUns(client, ticketId, konto, true, dringlichkeit === 'down')
        return ticketId
      })
      reply.status(201)
      return { id }
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/support-tickets/:id',
    permission: 'support:ticket',
    summary: 'Eine Anfrage mit Verlauf',
    handler: async (req) => {
      const principal = req.principal as Principal
      const ich = mensch(principal)
      const id = kennung(req)
      const s = sichtbarkeit(principal, 2)
      return tx(req.pool, req, async client => {
        const k = await client.query<KopfZeile>(
          `SELECT ${KOPF} WHERE t.id = $1 AND ${s.sql}`, [id, ...s.params])
        const kopf = k.rows[0]
        if (kopf === undefined) throw Errors.notFound('res.ticket')
        // Interne Notizen blendet die Zeilenrichtlinie aus, nicht diese Abfrage.
        const n = await client.query<{ id: number; author_side: string
                                       author_name: string | null; body: string
                                       created_at: string }>(
          `SELECT m.id, m.author_side,
                  -- Bei uns schreibt "der Support", nicht ein Name: der Kunde
                  -- spricht mit StayGrid, und wer bei uns ausscheidet, soll
                  -- nicht in fremden Faeden stehen bleiben.
                  CASE WHEN m.author_side = 'customer' THEN u.display_name END AS author_name,
                  m.body, m.created_at::text
             FROM support_ticket_message m
             LEFT JOIN app_user u ON u.id = m.author_id
            WHERE m.ticket_id = $1 ORDER BY m.id`, [id])
        const a = await client.query<{ id: number; message_id: number; file_name: string | null
                                       mime: string; byte_count: number }>(
          `SELECT id, message_id, file_name, mime, byte_count
             FROM support_ticket_attachment WHERE ticket_id = $1 ORDER BY id`, [id])
        const sitz = await client.query<{ id: number; level: string; requested_at: string
                                          granted_at: string | null; expires_at: string
                                          revoked_at: string | null }>(
          `SELECT id, level, requested_at::text, granted_at::text, expires_at::text,
                  revoked_at::text
             FROM support_session WHERE ticket_id = $1 AND account_id = $2 ORDER BY id`,
          [id, kopf.account_id])
        const freigeben = canInAccount(principal, 'settings:account', kopf.account_id)
        return {
          ...kopfNachAussen(kopf, ich),
          messages: n.rows.map(m => ({
            id: m.id, side: m.author_side, authorName: m.author_name, body: m.body,
            createdAt: m.created_at,
            attachments: a.rows.filter(x => x.message_id === m.id).map(x => ({
              id: x.id, name: x.file_name, mime: x.mime, size: x.byte_count }))
          })),
          sessions: sitz.rows.map(z => ({
            id: z.id, level: z.level, requestedAt: z.requested_at, grantedAt: z.granted_at,
            expiresAt: z.expires_at, state: sitzungsZustand(z)
          })),
          // Ob dieser Benutzer eine Sitzung aus dem Faden freigeben kann.
          // Sonst stuende dort ein Knopf, der nur mit 403 antwortet.
          canGrant: freigeben
        }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/support-tickets/:id/messages',
    permission: 'support:ticket',
    bodyLimit: TICKET_RUMPF_MAX,
    summary: 'Auf eine Anfrage antworten; oeffnet eine geschlossene wieder',
    handler: async (req, reply) => {
      const principal = req.principal as Principal
      const ich = mensch(principal)
      const id = kennung(req)
      const b = (req.body ?? {}) as Record<string, unknown>
      const f: Record<string, Meldung[]> = {}
      const text = textFeld(b.body, TEXT_MAX, 'body', f)
      if (Object.keys(f).length > 0) throw Errors.validation(f, { max: TEXT_MAX })
      const anhaenge = anhaengeAusRumpf(b.attachments)
      const s = sichtbarkeit(principal, 2)
      await tx(req.pool, req, async client => {
        const k = await client.query<{ account_id: number; urgency: string }>(
          `SELECT t.account_id, t.urgency FROM support_ticket t
            WHERE t.id = $1 AND ${s.sql} FOR UPDATE`, [id, ...s.params])
        const kopf = k.rows[0]
        if (kopf === undefined) throw Errors.notFound('res.ticket')
        await nachrichtenProStunde(client, ich)
        const m = await client.query<{ id: number }>(
          `INSERT INTO support_ticket_message (ticket_id, account_id, author_id, author_side, body)
           VALUES ($1,$2,$3,'customer',$4) RETURNING id`, [id, kopf.account_id, ich, text])
        await anhaengeSchreiben(client, id, kopf.account_id, m.rows[0]!.id, anhaenge)
        // Eine Antwort des Kunden legt das Ticket wieder zu uns -- auch ein
        // geschlossenes: wer nachfragt, ist nicht fertig.
        await client.query(
          `UPDATE support_ticket
              SET status = 'open', closed_at = NULL, last_customer_at = now(), updated_at = now()
            WHERE id = $1`, [id])
        await hinweisAnUns(client, id, kopf.account_id, false, kopf.urgency === 'down')
      })
      reply.status(201)
      return { id }
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/support-tickets/:id/close',
    permission: 'support:ticket',
    summary: 'Anfrage als erledigt schliessen',
    handler: async (req) => {
      const principal = req.principal as Principal
      mensch(principal)
      const id = kennung(req)
      const s = sichtbarkeit(principal, 2)
      await tx(req.pool, req, async client => {
        const r = await client.query(
          `UPDATE support_ticket t
              SET status = 'closed', closed_at = COALESCE(t.closed_at, now()), updated_at = now()
            WHERE t.id = $1 AND ${s.sql}`, [id, ...s.params])
        if (r.rowCount === 0) throw Errors.notFound('res.ticket')
      })
      return { id, status: 'closed' }
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/support-tickets/:id/attachments/:attachmentId',
    permission: 'support:ticket',
    summary: 'Anhang einer Anfrage',
    handler: async (req, reply) => {
      const principal = req.principal as Principal
      mensch(principal)
      const id = kennung(req)
      const anhang = kennung(req, 'attachmentId')
      const s = sichtbarkeit(principal, 3)
      const r = await tx(req.pool, req, client =>
        client.query<{ mime: string; bytes: Buffer; file_name: string | null }>(
          `SELECT x.mime, x.bytes, x.file_name
             FROM support_ticket_attachment x
             JOIN support_ticket t ON t.id = x.ticket_id
            WHERE x.id = $1 AND x.ticket_id = $2 AND ${s.sql}`, [anhang, id, ...s.params]))
      const z = r.rows[0]
      if (z === undefined) throw Errors.notFound('res.ticket')
      return belegSenden(reply, { mime: z.mime, bytes: z.bytes,
                                  name: z.file_name ?? `anhang-${anhang}` })
    }
  })

  // --------------------------------------------------------- Plattformseite

  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/tickets',
    permission: 'platform:tickets',
    summary: 'Eingang der Anfragen aller Kunden',
    handler: async (req) => {
      const status = String((req.query as { status?: string }).status ?? 'active')
      if (!['active', 'all', ...ZUSTAENDE].includes(status)) {
        throw Errors.validation({ status: ['field.invalid'] })
      }
      const r = await tx(req.pool, req, client =>
        client.query<PlattformZeile>(
          `SELECT * FROM platform_tickets($1)`, [status === 'all' ? null : status]))
      return { tickets: r.rows.map(plattformNachAussen) }
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/tickets/:id',
    permission: 'platform:tickets',
    summary: 'Eine Anfrage mit Verlauf und internen Notizen',
    handler: async (req) => {
      const id = kennung(req)
      return tx(req.pool, req, async client => {
        const k = await client.query<PlattformZeile>(
          `SELECT * FROM platform_tickets(NULL, $1)`, [id])
        const kopf = k.rows[0]
        if (kopf === undefined) throw Errors.notFound('res.ticket')
        const n = await client.query<{ id: number; author_side: string
                                       author_name: string | null; internal: boolean
                                       body: string; created_at: string }>(
          `SELECT id, author_side, author_name, internal, body, created_at::text
             FROM platform_ticket_messages($1)`, [id])
        const a = await client.query<{ id: number; message_id: number; file_name: string | null
                                       mime: string; byte_count: number }>(
          `SELECT * FROM platform_ticket_attachments($1)`, [id])
        const sitz = await client.query<{ id: number; staff_name: string; level: string
                                          requested_at: string; granted_at: string | null
                                          expires_at: string; revoked_at: string | null }>(
          `SELECT id, staff_name, level, requested_at::text, granted_at::text,
                  expires_at::text, revoked_at::text
             FROM platform_ticket_sessions($1)`, [id])
        return {
          ...plattformNachAussen(kopf),
          messages: n.rows.map(m => ({
            id: m.id, side: m.author_side, authorName: m.author_name, internal: m.internal,
            body: m.body, createdAt: m.created_at,
            attachments: a.rows.filter(x => x.message_id === m.id).map(x => ({
              id: x.id, name: x.file_name, mime: x.mime, size: x.byte_count }))
          })),
          sessions: sitz.rows.map(z => ({
            id: z.id, staffName: z.staff_name, level: z.level, requestedAt: z.requested_at,
            grantedAt: z.granted_at, expiresAt: z.expires_at, state: sitzungsZustand(z)
          }))
        }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/tickets/:id/messages',
    permission: 'platform:tickets',
    summary: 'Dem Kunden antworten oder eine interne Notiz schreiben',
    handler: async (req, reply) => {
      const id = kennung(req)
      const b = (req.body ?? {}) as Record<string, unknown>
      const f: Record<string, Meldung[]> = {}
      const text = textFeld(b.body, TEXT_MAX, 'body', f)
      if (Object.keys(f).length > 0) throw Errors.validation(f, { max: TEXT_MAX })
      const intern = b.internal === true
      await tx(req.pool, req, async client => {
        const r = await client.query<{ id: number | null }>(
          `SELECT platform_ticket_reply($1, $2, $3) AS id`, [id, text, intern])
        if (r.rows[0]?.id === null || r.rows[0]?.id === undefined) {
          throw Errors.notFound('res.ticket')
        }
        if (intern) return
        /*
         * Hinweis an den, der gefragt hat. app_user traegt keine
         * Zeilenrichtlinie; den Verfasser nennt platform_tickets().
         */
        const k = await client.query<{ created_by: number }>(
          `SELECT created_by FROM platform_tickets(NULL, $1)`, [id])
        const u = await client.query<{ id: number; email: string | null; display_name: string
                                       status: string }>(
          `SELECT id, email, display_name, status FROM app_user WHERE id = $1`,
          [k.rows[0]!.created_by])
        const wer = u.rows[0]
        if (wer === undefined || wer.email === null || wer.status !== 'active') return
        const mail = renderTicketReplyEmail({
          userName: wer.display_name, ticketId: id,
          link: `${config.publicAppUrl}/?screen=support&ticket=${id}`
        })
        await client.query(
          `INSERT INTO platform_email (user_id, kind, to_email, to_name, subject, body_text,
                                       body_html)
           VALUES ($1, 'ticket_reply', $2, $3, $4, $5, $6)`,
          [wer.id, wer.email, wer.display_name, mail.subject, mail.text, mail.html])
      })
      reply.status(201)
      return { id }
    }
  })

  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/platform/tickets/:id',
    permission: 'platform:tickets',
    summary: 'Zustand setzen oder sich die Anfrage nehmen',
    handler: async (req) => {
      const id = kennung(req)
      const b = (req.body ?? {}) as { status?: unknown; assign?: unknown }
      const f: Record<string, Meldung[]> = {}
      if (b.status !== undefined && !(ZUSTAENDE as readonly unknown[]).includes(b.status)) {
        f.status = ['field.invalid']
      }
      if (b.assign !== undefined && b.assign !== 'me' && b.assign !== 'none') {
        f.assign = ['field.invalid']
      }
      if (Object.keys(f).length > 0) throw Errors.validation(f)
      return tx(req.pool, req, async client => {
        const r = await client.query<{ ok: boolean }>(
          `SELECT platform_ticket_set($1, $2, $3) AS ok`,
          [id, b.status ?? null, b.assign ?? null])
        if (r.rows[0]?.ok !== true) throw Errors.notFound('res.ticket')
        const k = await client.query<PlattformZeile>(
          `SELECT * FROM platform_tickets(NULL, $1)`, [id])
        return plattformNachAussen(k.rows[0]!)
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/tickets/:id/attachments/:attachmentId',
    permission: 'platform:tickets',
    summary: 'Anhang einer Anfrage, Plattformseite',
    handler: async (req, reply) => {
      const id = kennung(req)
      const anhang = kennung(req, 'attachmentId')
      const r = await tx(req.pool, req, client =>
        client.query<{ mime: string; bytes: Buffer; file_name: string | null }>(
          `SELECT * FROM platform_ticket_attachment($1, $2)`, [id, anhang]))
      const z = r.rows[0]
      if (z === undefined) throw Errors.notFound('res.ticket')
      return belegSenden(reply, { mime: z.mime, bytes: z.bytes,
                                  name: z.file_name ?? `anhang-${anhang}` })
    }
  })
}

interface PlattformZeile {
  id: number; account_id: number; account_name: string; property_name: string | null
  created_by: number; created_by_name: string; subject: string; category: string
  urgency: string; status: string; assigned_to: number | null; assigned_name: string | null
  screen: string | null; client_version: string | null
  created_at: Date; updated_at: Date; last_customer_at: Date; last_staff_at: Date | null
  closed_at: Date | null; messages: string
}

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString()
}

function plattformNachAussen(z: PlattformZeile): Record<string, unknown> {
  return {
    id: z.id, accountId: z.account_id, accountName: z.account_name,
    propertyName: z.property_name, createdByName: z.created_by_name,
    subject: z.subject, category: z.category, urgency: z.urgency, status: z.status,
    assignedTo: z.assigned_to, assignedName: z.assigned_name,
    screen: z.screen, clientVersion: z.client_version,
    createdAt: iso(z.created_at), updatedAt: iso(z.updated_at),
    lastCustomerAt: iso(z.last_customer_at), lastStaffAt: iso(z.last_staff_at),
    closedAt: iso(z.closed_at), messages: Number(z.messages)
  }
}
