import { createHash, timingSafeEqual } from 'node:crypto'
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

/**
 * Das Geheimnis eines Kanalzugangs als SHA-256, nicht als Argon2
 * (Bedrohungsanalyse 23.10.2026, T6).
 *
 * Argon2 ist fuer Kennwoerter da: ein Mensch waehlt eines, das sich
 * durchprobieren laesst, und die teure Rechnung macht jeden Versuch teuer.
 * Dieses Geheimnis waehlt niemand, es sind 24 Zufallsbytes -- 192 Bit, die
 * sich auch mit einer schnellen Pruefsumme nicht durchprobieren lassen.
 * Die teure Rechnung traf hier deshalb nur einen: uns. Jede Anfrage an den
 * Kanal, auch jede gefaelschte, band 19 MB Speicher und zwei Durchlaeufe,
 * und ein Programm, das mit erfundenen Geheimnissen auf eine bekannte
 * Kennung feuert, legte damit die Schnittstelle lahm, bevor es abgewiesen
 * wurde. Dasselbe Verfahren wie beim Maschinenzugang (`hashToken`).
 *
 * **Alte Zugaenge** tragen noch Argon2. Sie werden einmal so geprueft und
 * beim ersten gelungenen Aufruf umgeschrieben; danach gibt es fuer sie
 * keinen teuren Weg mehr. Eine unbekannte Kennung kostet nichts: sie
 * vergleicht gegen einen Hash, den es nicht gibt.
 */
const SHA = 'sha256:'

export function kanalGeheimnisHash(secret: string): string {
  return SHA + createHash('sha256').update(secret).digest('hex')
}

const NIEMAND = kanalGeheimnisHash('niemand')

async function geheimnisPasst(
  hash: string, secret: string
): Promise<{ passt: boolean; umschreiben: boolean }> {
  if (hash.startsWith(SHA)) {
    const a = Buffer.from(hash)
    const b = Buffer.from(kanalGeheimnisHash(secret))
    return { passt: a.length === b.length && timingSafeEqual(a, b), umschreiben: false }
  }
  const passt = await argonVerify(hash, secret).catch(() => false)
  return { passt, umschreiben: passt }
}

export async function authenticateChannel(
  pool: Pool, authorization: string | undefined
): Promise<ChannelPrincipal> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  const [publicRef, secret] = token.split('.', 2)
  if (!publicRef || !secret) throw Errors.unauthorized()

  // Der Status von Account und Haus kommt aus einer SECURITY-DEFINER-Funktion
  // (Migration 0181): property hat eine Zeilenrichtlinie, und dieser Aufruf
  // laeuft vor jedem Mandantenkontext -- nie ohne Kontext aus einer Tabelle
  // mit Zeilenrichtlinie lesen, auch nicht ueber einen Join (CLAUDE.md).
  // Gesperrter Account oder archiviertes Haus kommen als eigener Status
  // zurueck und werden unten abgewiesen wie ein falsches Geheimnis (Audit
  // 19.10.2026, M7).
  const { rows } = await pool.query<{
    id: number; property_id: number; account_id: number; provider: string
    token_hash: string; status: string
  }>(
    `SELECT id, property_id, account_id, provider, token_hash, status
       FROM channel_connection_for_auth($1)`, [publicRef])
  const row = rows[0]

  const { passt, umschreiben } = await geheimnisPasst(row?.token_hash ?? NIEMAND, secret)
  if (!passt || row === undefined || row.status !== 'active') throw Errors.unauthorized()

  await pool.query(
    `UPDATE channel_connection
        SET last_used_at = now(), token_hash = COALESCE($2, token_hash)
      WHERE id = $1`,
    [row.id, umschreiben ? kanalGeheimnisHash(secret) : null])
  return { connectionId: row.id, propertyId: row.property_id, accountId: row.account_id,
           provider: row.provider }
}
