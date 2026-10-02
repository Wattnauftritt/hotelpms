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

  /*
   * Der Pool gibt dieselben Clients wieder aus. Einmal umwickelt, schrieb
   * ein Client bisher fuer immer in die Liste der **ersten** Zaehlung --
   * eine zweite Zaehlung im selben Test sah dann null Anweisungen, und ein
   * Vergleich "vorher gleich nachher" waere bei 0 = 0 still durchgegangen.
   * Gewickelt wird deshalb einmal, geschrieben wird in die Liste, die der
   * Client gerade traegt.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const beruehrt = new Set<any>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const zaehlen = (client: any): void => {
    if (client === undefined || client === null) return
    client.__senke = statements
    beruehrt.add(client)
    if (client.__counted) return
    client.__counted = true
    const originalQuery = client.query.bind(client)
    client.query = (...qargs: unknown[]) => {
      const first = qargs[0]
      const text = typeof first === 'string'
        ? first
        : (first as { text?: string })?.text ?? ''
      const senke = client.__senke as string[] | null
      if (senke && !NOISE.test(text.trim())) senke.push(text.trim().replace(/\s+/g, ' '))
      return originalQuery(...qargs)
    }
  }

  /*
   * Zwei Aufrufformen, und beide muessen gezaehlt werden. `pool.query()`
   * holt sich seinen Client ueber `connect(callback)` und bekommt dann
   * **kein** Versprechen zurueck; die Fassung, die nur `await` kannte,
   * las daraus `undefined` und brach ab, sobald eine Anfrage durch die
   * Anmeldung lief statt direkt durch `withTransaction`.
   */
  anyPool.connect = (...args: unknown[]) => {
    const letztes = args.at(-1)
    if (typeof letztes === 'function') {
      return originalConnect(...args.slice(0, -1),
        (err: unknown, client: unknown, release: unknown) => {
          if (!err) zaehlen(client)
          ;(letztes as (...a: unknown[]) => void)(err, client, release)
        })
    }
    return (originalConnect(...args) as Promise<unknown>).then(client => {
      zaehlen(client)
      return client
    })
  }

  try {
    const result = await fn()
    return { result, report: { count: statements.length, statements } }
  } finally {
    anyPool.connect = originalConnect
    for (const c of beruehrt) c.__senke = null
  }
}
