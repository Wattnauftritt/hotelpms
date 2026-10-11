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
  return txIm(pool, req, contextFor(req.principal as Principal), fn)
}

/**
 * Wie `tx`, aber mit einem Kontext, der nicht aus der Sitzung kommt -- die
 * Kanalrouten leiten ihn aus dem Verbindungstoken ab (`channelContext`).
 *
 * Sie liefen bisher ueber `withTransaction` ohne Zaehler, und damit war
 * der teuerste Schreibpfad, der Kanal-Push, im Betriebsprotokoll
 * unsichtbar (Performance-Audit 11.10.2026, Befund 14).
 */
export function txIm<T>(
  pool: Pool, req: FastifyRequest, ctx: DbContext, fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  /*
   * Die Kosten summieren, nicht setzen: eine Route darf `tx` mehrmals
   * aufrufen -- der Check-in tut es --, und die Frage ist, was die
   * **Anfrage** gekostet hat, nicht ihre letzte Transaktion.
   */
  return withTransaction(pool, ctx, fn, b => {
    req.dbKosten.anweisungen += b.anweisungen
    req.dbKosten.dauerMs += b.dauerMs
  })
}
