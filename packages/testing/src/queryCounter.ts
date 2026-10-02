import type { Pool } from '@hotelpms/db'

export interface QueryReport {
  count: number
  statements: string[]
}

const NOISE = /^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i

/**
 * Zaehlt die SQL-Anweisungen einer Arbeitseinheit.
 *
 * Der wichtigste Test im Projekt: er faengt jedes versehentlich eingefuehrte
 * N+1 in dem Moment ab, in dem es entsteht, statt Monate spaeter beim ersten
 * grossen Kunden. Transaktionsklammer und Kontextsetzung zaehlen nicht mit,
 * weil sie konstant sind.
 */
export async function countQueries<T>(
  pool: Pool,
  fn: () => Promise<T>
): Promise<{ result: T; report: QueryReport }> {
  const statements: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyPool = pool as any
  const originalConnect = anyPool.connect.bind(pool)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const umwickelt: any[] = []

  /*
   * Je Aufruf neu umwickeln und danach zuruecksetzen.
   *
   * Vorher blieb ein Verbindungsobjekt nach dem ersten Zaehlen markiert und
   * schrieb beim naechsten `countQueries` in die Liste des **ersten**
   * Aufrufs: der zweite Bericht war leer, und ein Test, der zweimal zaehlt
   * und vergleicht, verglich 0 mit 0.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const zaehlen = (client: any): void => {
    if (client === undefined || client === null || client.__zaehler === statements) return
    if (client.__originalQuery === undefined) client.__originalQuery = client.query
    const originalQuery = client.__originalQuery.bind(client)
    client.__zaehler = statements
    client.query = (...qargs: unknown[]) => {
      const first = qargs[0]
      const text = typeof first === 'string'
        ? first
        : (first as { text?: string })?.text ?? ''
      if (!NOISE.test(text.trim())) statements.push(text.trim().replace(/\s+/g, ' '))
      return originalQuery(...qargs)
    }
    umwickelt.push(client)
  }

  /*
   * Beide Formen von `connect`. `pool.query` -- die Anmeldung benutzt es --
   * holt sich seine Verbindung mit einem Rueckruf und nicht ueber das
   * Versprechen; die erste Fassung kannte nur das Versprechen und brach
   * mit "client is undefined" ab, sobald eine ganze Anfrage durch
   * `app.inject` gezaehlt wurde.
   */
  anyPool.connect = (...args: unknown[]) => {
    const rueckruf = args.find(a => typeof a === 'function') as
      ((err: unknown, client: unknown, release: unknown) => void) | undefined
    if (rueckruf !== undefined) {
      return originalConnect((err: unknown, client: unknown, release: unknown) => {
        if (!err) zaehlen(client)
        rueckruf(err, client, release)
      })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return originalConnect().then((client: any) => { zaehlen(client); return client })
  }

  try {
    const result = await fn()
    return { result, report: { count: statements.length, statements } }
  } finally {
    anyPool.connect = originalConnect
    for (const client of umwickelt) {
      client.query = client.__originalQuery
      delete client.__zaehler
    }
  }
}
