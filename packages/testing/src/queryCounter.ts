import type { Pool } from '@hotelpms/db'

export interface QueryReport {
  count: number
  statements: string[]
}

const NOISE = /^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i

/*
 * Wohin eine umhuellte Verbindung gerade zaehlt. Modulweit und nicht je
 * Aufruf, aus einem Grund, der zweimal still schiefging:
 *
 * Der Pool gibt Verbindungen zurueck und verleiht sie wieder. Eine einmal
 * umhuellte Verbindung behielt frueher die Liste des Aufrufs, in dem sie
 * zuerst ausgeliehen wurde -- ein zweites `countQueries` im selben Test sah
 * deshalb von ihr nichts und meldete zu wenige Anweisungen, im Zweifel null.
 * Und `pool.query()` leiht im Rueckrufstil aus; der Umschlag erwartete ein
 * Versprechen und brach dort mit "Cannot read properties of undefined" ab.
 * Gefunden beim Messen der Preissteuerung (Dokument 32), die genau das
 * braucht: zwei Messungen hintereinander ueber dieselbe API.
 */
let sammlung: string[] | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function umhuellen(client: any): void {
  if (client === undefined || client === null || client.__counted) return
  client.__counted = true
  const originalQuery = client.query.bind(client)
  client.query = (...qargs: unknown[]) => {
    const first = qargs[0]
    const text = typeof first === 'string'
      ? first
      : (first as { text?: string })?.text ?? ''
    if (sammlung !== null && !NOISE.test(text.trim())) {
      sammlung.push(text.trim().replace(/\s+/g, ' '))
    }
    return originalQuery(...qargs)
  }
}

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
  const eigene = Object.prototype.hasOwnProperty.call(anyPool, 'connect')
  const originalConnect = anyPool.connect
  const vorher = sammlung
  sammlung = statements

  anyPool.connect = (...args: unknown[]) => {
    const rueckruf = args[args.length - 1]
    if (typeof rueckruf === 'function') {
      return originalConnect.call(pool, (err: unknown, client: unknown, release: unknown) => {
        umhuellen(client)
        ;(rueckruf as (e: unknown, c: unknown, r: unknown) => void)(err, client, release)
      })
    }
    return (originalConnect.call(pool, ...args) as Promise<unknown>).then(client => {
      umhuellen(client)
      return client
    })
  }

  try {
    const result = await fn()
    return { result, report: { count: statements.length, statements } }
  } finally {
    if (eigene) anyPool.connect = originalConnect
    else delete anyPool.connect
    sammlung = vorher
  }
}
