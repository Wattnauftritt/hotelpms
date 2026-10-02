import type { FastifyRequest } from 'fastify'
import { withTransaction, SYSTEM_CONTEXT, type PoolClient } from '@hotelpms/db'
import { hashToken } from '@hotelpms/domain'
import { CHECKIN_TOKEN_HEADER, type OnlineCheckinStatus } from '@hotelpms/contracts'
import { Errors } from './errors.js'
import { can, type Principal } from './context.js'

/**
 * Online-Check-in: wie eine Anfrage ohne Anmeldung an genau eine
 * Reservierung kommt (Dokument 30).
 */

export interface CheckinKontext {
  tokenId: number
  propertyId: number
  accountId: number
  reservationId: number
  channel: 'mail' | 'terminal'
  expiresOn: string
  /** Der offene Geschaeftstag des Hauses, gegen ihn laufen alle Fristen. */
  businessDate: string
}

/**
 * Das Token aus der Kopfzeile, ohne es irgendwo abzulegen.
 *
 * Fehlt es oder hat es nicht die Form eines Tokens, wird gar nicht erst die
 * Datenbank gefragt -- und die Antwort ist dieselbe wie fuer ein falsches:
 * ein Link, den es nicht gibt.
 */
function tokenAusAnfrage(req: FastifyRequest): string {
  const roh = req.headers[CHECKIN_TOKEN_HEADER]
  const token = Array.isArray(roh) ? roh[0] : roh
  if (token === undefined || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw Errors.notFound('res.checkinLink')
  }
  return token
}

/**
 * Eine Transaktion im Kontext des Links.
 *
 * **Warum nicht `tx(req.pool, req, ...)`.** `tx` setzt den Kontext aus dem
 * angemeldeten Aufrufer. Hier gibt es keinen -- oder es gibt einen, der
 * damit nichts zu tun hat: die Station im Haus ist angemeldet und oeffnet
 * die Gastseite trotzdem fuer genau einen Gast. Der Kontext kommt deshalb
 * aus dem Link, und zwar in der Datenbank (`checkin_token_open`, Migration
 * 0061): sie beginnt mit leerem Kontext, loest den Hash ein und setzt ihn
 * auf genau dieses eine Haus. Alles danach laeuft unter der
 * Zeilenrichtlinie wie jede andere Anfrage, in **einer** Transaktion --
 * zwischen Einloesen und Schreiben kann der Link nicht widerrufen werden.
 *
 * Die Kosten zaehlen wie bei `tx` in die Protokollzeile der Anfrage.
 */
export function checkinTx<T>(
  req: FastifyRequest,
  fn: (client: PoolClient, k: CheckinKontext) => Promise<T>
): Promise<T> {
  const hash = hashToken(tokenAusAnfrage(req))
  return withTransaction(req.pool, SYSTEM_CONTEXT, async client => {
    const r = await client.query<{
      out_token_id: number; out_property_id: number; out_account_id: number
      out_reservation_id: number; out_channel: 'mail' | 'terminal'
      out_expires_on: string; out_business_date: string; out_state: string }>(
      `SELECT out_token_id, out_property_id, out_account_id, out_reservation_id,
              out_channel, out_expires_on::text, out_business_date::text, out_state
         FROM checkin_token_open($1)`, [hash])
    const z = r.rows[0]
    if (z === undefined) throw Errors.notFound('res.checkinLink')
    if (z.out_state === 'revoked') throw Errors.gone('checkin.linkRevoked')
    if (z.out_state === 'expired') throw Errors.gone('checkin.linkExpired')
    if (z.out_state !== 'valid') throw Errors.gone('checkin.reservationClosed')
    return fn(client, {
      tokenId: z.out_token_id, propertyId: z.out_property_id,
      accountId: z.out_account_id, reservationId: z.out_reservation_id,
      channel: z.out_channel, expiresOn: z.out_expires_on,
      businessDate: z.out_business_date
    })
  }, b => {
    req.dbKosten.anweisungen += b.anweisungen
    req.dbKosten.dauerMs += b.dauerMs
  })
}

/**
 * Der Stand an einer Reservierung, fuer das Seitenfenster der Rezeption.
 *
 * Eine Anweisung, damit das Seitenfenster ein Aufruf bleibt (CLAUDE.md,
 * "Ein Aufruf je Bildschirm").
 */
export async function onlineCheckinStand(
  client: PoolClient, reservationId: number, principal: Principal
): Promise<OnlineCheckinStatus> {
  const { rows } = await client.query<{
    property_id: number
    invited_at: string | null; invitation_status: string | null
    completed_at: string | null; source: OnlineCheckinStatus['source']
    signature_pending: boolean | null; active_links: number }>(
    `SELECT r.property_id,
            e.created_at  AS invited_at,
            e.status      AS invitation_status,
            CASE WHEN reg.source IN ('online','terminal') THEN reg.created_at END
                          AS completed_at,
            reg.source,
            (reg.signature_required AND reg.signed_at IS NULL) AS signature_pending,
            (SELECT count(*) FROM checkin_token t
              WHERE t.reservation_id = $1 AND t.revoked_at IS NULL
                AND t.completed_at IS NULL
                -- Gegen den Geschaeftstag, wie checkin_token_open.
                AND t.expires_on >= COALESCE(
                      (SELECT max(b.date) FROM business_day b
                        WHERE b.property_id = t.property_id AND b.status = 'open'),
                      current_date))::int AS active_links
       FROM reservation r
       LEFT JOIN LATERAL (
              SELECT created_at, status FROM outbound_email
               WHERE reservation_id = r.id AND kind = 'checkin_invitation'
               ORDER BY id DESC LIMIT 1) e ON true
       LEFT JOIN registration reg
              ON reg.reservation_id = r.id AND reg.group_registration_id IS NULL
      WHERE r.id = $1`,
    [reservationId])
  const z = rows[0]!
  return {
    invitedAt: z.invited_at === null ? null : new Date(z.invited_at).toISOString(),
    invitationStatus: z.invitation_status,
    completedAt: z.completed_at === null ? null : new Date(z.completed_at).toISOString(),
    source: z.source,
    signaturePending: z.signature_pending === true,
    activeLinks: z.active_links,
    mayLink: can(principal, 'reservation:checkin', z.property_id),
    maySend: can(principal, 'email:send', z.property_id)
  }
}
