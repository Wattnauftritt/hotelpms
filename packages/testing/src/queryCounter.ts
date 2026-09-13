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

  anyPool.connect = async (...args: unknown[]) => {
    const client = await originalConnect(...args)
    if (!client.__counted) {
      client.__counted = true
      const originalQuery = client.query.bind(client)
      client.query = (...qargs: unknown[]) => {
        const first = qargs[0]
        const text = typeof first === 'string'
          ? first
          : (first as { text?: string })?.text ?? ''
        if (!NOISE.test(text.trim())) statements.push(text.trim().replace(/\s+/g, ' '))
        return originalQuery(...qargs)
      }
    }
    return client
  }

  try {
    const result = await fn()
    return { result, report: { count: statements.length, statements } }
  } finally {
    anyPool.connect = originalConnect
  }
}
