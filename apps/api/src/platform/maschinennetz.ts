import type { Pool } from '@hotelpms/db'
import { withTransaction } from '@hotelpms/db'
import { sicherheitsereignisMelden } from '@hotelpms/domain'
import { loadConfig } from './config.js'

const config = loadConfig()

/**
 * Ein gueltiges Geheimnis oder Token aus einem Netz, das der Betrieb fuer
 * diesen Zugang nicht nennt (Migration 0212). Das ist kein Tippfehler,
 * sondern ein Geheimnis, das woanders liegt als beim Umsystem -- der
 * Betrieb und wir sollen es sofort wissen.
 *
 * Einmal je Zugang und Stunde. Wer mit einem abgeflossenen Token
 * weiterklopft, soll keine Zeile je Anfrage erzeugen; dass es weitergeht,
 * zeigt das Protokoll mit Adresse.
 */
export async function fremdesNetzMelden(
  pool: Pool, accountId: number, clientRef: string, origin: string | null, weg: 'token' | 'request'
): Promise<void> {
  const kontext = { accountIds: [accountId], propertyIds: [], userId: null }
  await withTransaction(pool, kontext, async c => {
    const schon = await c.query(
      `SELECT 1 FROM security_event
        WHERE kind = 'client_origin_denied' AND actor_ref = $1
          AND created_at > now() - interval '1 hour' LIMIT 1`, [clientRef])
    if (schon.rowCount !== 0) return
    await sicherheitsereignisMelden(c, {
      kind: 'client_origin_denied', accountId,
      detail: { clientRef, weg }, hint: origin ?? clientRef
    }, { kind: 'client', userId: null, ref: clientRef }, origin, config.platformNoticeEmail)
  })
}
