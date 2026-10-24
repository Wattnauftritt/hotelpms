import type { FastifyRequest } from 'fastify'
import { withTransaction } from '@hotelpms/db'
import { sicherheitsereignisMelden } from '@hotelpms/domain'
import { loadConfig } from './config.js'

const config = loadConfig()

/**
 * Jemand hat einen Koeder benutzt (Migration 0213). Einmal je Koeder und
 * Stunde, wie beim fremden Netz: wer weiterklopft, steht ohnehin mit
 * Adresse im Protokoll.
 */
async function koederMelden(
  req: FastifyRequest, accountId: number, art: string, ref: string
): Promise<void> {
  const kontext = { accountIds: [accountId], propertyIds: [], userId: null }
  await withTransaction(req.pool, kontext, async c => {
    const schon = await c.query(
      `SELECT 1 FROM security_event
        WHERE kind = 'honeytoken' AND detail ->> 'ref' = $1
          AND created_at > now() - interval '1 hour' LIMIT 1`, [ref])
    if (schon.rowCount !== 0) return
    await sicherheitsereignisMelden(c, {
      kind: 'honeytoken', accountId, detail: { art, ref }, hint: art
    }, { kind: 'client', userId: null, ref }, req.ip || null,
    config.platformNoticeEmail)
  })
}

/** Wurde die Kennung eines Koederzugangs vorgelegt? Dann gemeldet und `true`. */
export async function koederZugangBenutzt(req: FastifyRequest, clientRef: string): Promise<boolean> {
  const { rows } = await req.pool.query<{ a: number | null }>(
    'SELECT decoy_client_account($1) AS a', [clientRef])
  const account = rows[0]?.a ?? null
  if (account === null) return false
  await koederMelden(req, Number(account), 'decoy_client', clientRef)
  return true
}
