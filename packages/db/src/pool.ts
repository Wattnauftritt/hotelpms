import pg from 'pg'
import { dbUrl } from './config.js'

// Geldbetraege sind bigint in Cent. node-postgres liefert bigint als string;
// wir wandeln in number, weil Cent-Betraege weit unter 2^53 liegen.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v))

// Dasselbe fuer bigint[]: rate_day.price_cent haelt den Preis je Belegung als
// Feld. Ohne diesen Parser kaeme aus derselben Spaltenart einmal 9000 und
// einmal "9000", je nachdem ob sie skalar oder als Feld gelesen wird, und
// jede Rechnung darauf waere eine Zeichenkettenverkettung.
// Die Typdefinition von pg kennt nur die skalaren Typ-IDs; 1016 ist die
// OID von bigint[] und steht so im Katalog von PostgreSQL.
const INT8_ARRAY = 1016
const types = pg.types as unknown as {
  getTypeParser: (oid: number) => (v: string) => string[]
  setTypeParser: (oid: number, fn: (v: string) => unknown) => void
}
const defaultArrayParser = types.getTypeParser(INT8_ARRAY)
types.setTypeParser(INT8_ARRAY, (v: string) => defaultArrayParser(v).map(Number))

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
