import pg from 'pg'
import { dbUrl } from './config.js'

// Geldbetraege sind bigint in Cent. node-postgres liefert bigint als string;
// wir wandeln in number, weil Cent-Betraege weit unter 2^53 liegen.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v))
// numeric bleibt string, damit nichts still gerundet wird.

export type Pool = pg.Pool
export type PoolClient = pg.PoolClient

export interface PoolOptions {
  kind?: 'app' | 'direct' | 'owner'
  max?: number
  applicationName?: string
}

export function createPool(opts: PoolOptions = {}): Pool {
  return new pg.Pool({
    connectionString: dbUrl(opts.kind ?? 'app'),
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'hotelpms',
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 10_000
  })
}
