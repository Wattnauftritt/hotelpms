import type { FastifyRequest } from 'fastify'
import { withTransaction, type Pool, type PoolClient, type DbContext } from '@hotelpms/db'
import { propertyIds, type Principal } from './context.js'

/**
 * Datenbankkontext aus dem Aufrufer ableiten.
 * Jede Anfrage laeuft in einer Transaktion, sonst greift die
 * Zeilenrichtlinie nicht: der Kontext ist transaktionslokal gesetzt.
 */
export function contextFor(principal: Principal): DbContext {
  return {
    accountIds: principal.accountIds,
    propertyIds: propertyIds(principal),
    userId: principal.userId,
    supportSessionId: principal.supportSessionId,
    terminalDeviceId: principal.terminalDeviceId
  }
}

export function tx<T>(
  pool: Pool, req: FastifyRequest, fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  /*
   * Die Kosten summieren, nicht setzen: eine Route darf `tx` mehrmals
   * aufrufen -- der Check-in tut es --, und die Frage ist, was die
   * **Anfrage** gekostet hat, nicht ihre letzte Transaktion.
   */
  return withTransaction(pool, contextFor(req.principal as Principal), fn, b => {
    req.dbKosten.anweisungen += b.anweisungen
    req.dbKosten.dauerMs += b.dauerMs
  })
}
