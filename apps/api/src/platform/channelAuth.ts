import { verify as argonVerify } from '@node-rs/argon2'
import type { Pool, DbContext } from '@hotelpms/db'
import { Errors } from './errors.js'

/**
 * Maschinenauthentifizierung fuer Channel-Manager-Aufrufe.
 *
 * Aufgabe 2 (OAuth-Autorisierungsserver) ist noch nicht gebaut; diese Pruefung
 * haengt bewusst nicht davon ab. Der Token traegt vor dem Punkt die
 * oeffentliche Kennung der Verbindung, danach das Geheimnis - der
 * Mandantenkontext kommt damit weiterhin ausschliesslich aus dem Token
 * (CLAUDE.md), nur eben nicht aus einer Sitzung.
 */
export interface ChannelPrincipal {
  connectionId: number
  propertyId: number
  accountId: number
  provider: string
}

export function channelContext(p: ChannelPrincipal): DbContext {
  return { accountIds: [p.accountId], propertyIds: [p.propertyId], userId: null }
}

// Verbraucht Rechenzeit auch fuer eine unbekannte Kennung, aus demselben
// Grund wie beim Anmelden (auth.ts): sonst unterscheidet die Antwortzeit
// eine gueltige von einer erfundenen Verbindungskennung.
const BLIND_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsemVzYWx6ZXNhbHplcw$'
  + 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYg'

export async function authenticateChannel(
  pool: Pool, authorization: string | undefined
): Promise<ChannelPrincipal> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  const [publicRef, secret] = token.split('.', 2)
  if (!publicRef || !secret) throw Errors.unauthorized()

  // Bewusst kein Join auf property: property hat eine Zeilenrichtlinie, und
  // dieser Aufruf laeuft vor jedem Mandantenkontext. account_id liegt daher
  // direkt auf channel_connection (bei der Anlage einmalig aus der Property
  // gelesen, dort mit Kontext) - nie ohne Kontext aus einer Tabelle mit
  // Zeilenrichtlinie lesen, auch nicht ueber einen Join (CLAUDE.md).
  const { rows } = await pool.query<{
    id: number; property_id: number; account_id: number; provider: string
    token_hash: string; status: string
  }>(
    `SELECT id, property_id, account_id, provider, token_hash, status
       FROM channel_connection WHERE public_ref = $1`, [publicRef])
  const row = rows[0]

  const passt = await argonVerify(row?.token_hash ?? BLIND_HASH, secret).catch(() => false)
  if (!passt || row === undefined || row.status !== 'active') throw Errors.unauthorized()

  await pool.query(`UPDATE channel_connection SET last_used_at = now() WHERE id = $1`, [row.id])
  return { connectionId: row.id, propertyId: row.property_id, accountId: row.account_id,
           provider: row.provider }
}
