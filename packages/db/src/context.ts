import type { PoolClient, Pool } from './pool.js'

/**
 * Mandanten- und Benutzerkontext einer Transaktion.
 * Wird transaktionslokal gesetzt (set_config mit true), damit PgBouncer im
 * Transaction Mode die Verbindung nicht verschmutzt (S1, Dokument 12).
 * Der Kontext kommt aus dem Token, nie aus einem Parameter des Clients.
 */
export interface DbContext {
  accountIds: readonly number[]
  propertyIds: readonly number[]
  userId: number | null
  supportSessionId?: number | null
  /**
   * Ein gekoppeltes Gaesteterminal (Migration 0071). Steht im Kontext, damit
   * der Audit-Trigger es als Handelnden eintraegt: eine Unterschrift am
   * Terminal soll im Protokoll nicht aussehen wie eine Aenderung ohne
   * Urheber (Migration 0072).
   */
  terminalDeviceId?: number | null
}

export const SYSTEM_CONTEXT: DbContext = {
  accountIds: [],
  propertyIds: [],
  userId: null
}

async function applyContext(client: PoolClient, ctx: DbContext): Promise<void> {
  await client.query(
    `SELECT set_config('app.account_ids',  $1, true),
            set_config('app.property_ids', $2, true),
            set_config('app.user_id',      $3, true),
            set_config('app.support_session_id', $4, true),
            set_config('app.terminal_device_id', $5, true)`,
    [
      ctx.accountIds.join(','),
      ctx.propertyIds.join(','),
      ctx.userId === null ? '' : String(ctx.userId),
      ctx.supportSessionId == null ? '' : String(ctx.supportSessionId),
      ctx.terminalDeviceId == null ? '' : String(ctx.terminalDeviceId)
    ]
  )
}

/**
 * Was eine Transaktion die Datenbank gekostet hat.
 *
 * **Wozu.** Der Abfragezaehler aus `@hotelpms/testing` faengt jedes N+1 in
 * dem Moment ab, in dem es entsteht -- aber nur das, was ein Test auch
 * aufruft. Im Betrieb gab es dafuer nichts: eine Antwort in 300 ms sah
 * genauso aus, ob sie aus einer Abfrage kam oder aus vierhundert (Befund
 * P9, Dokument 29). Jetzt steht beides im Protokoll derselben Zeile.
 *
 * `BEGIN`, `COMMIT` und das Setzen des Kontexts zaehlen nicht mit: sie sind
 * konstant und je Anfrage gleich, und mitgezaehlt verschoeben sie jede
 * Schwelle um denselben Betrag.
 */
export interface TxBericht {
  anweisungen: number
  /** Nur die Zeit **in** der Datenbank, ohne das Rechnen drumherum. */
  dauerMs: number
}

const RAHMEN = /^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i

/**
 * Fuehrt eine Arbeitseinheit in einer Transaktion mit gesetztem Kontext aus.
 * Jede Anfrage laeuft in einer Transaktion; sonst greift die Zeilenrichtlinie
 * nicht, weil der transaktionslokale Kontext fehlt.
 *
 * `bericht` ist freiwillig: ohne ihn wird nichts gemessen und nichts
 * umhuellt. Die API gibt ihn immer mit, der Worker nicht -- dort ist die
 * Zahl der Anweisungen keine Frage, weil niemand darauf wartet.
 */
export async function withTransaction<T>(
  pool: Pool,
  ctx: DbContext,
  fn: (client: PoolClient) => Promise<T>,
  bericht?: (b: TxBericht) => void
): Promise<T> {
  const client = await pool.connect()
  let anweisungen = 0
  let dauerMs = 0
  if (bericht !== undefined) {
    /*
     * Umhuellt wird der ausgeliehene Client, nicht der Pool: die Huelle
     * faellt mit `release()` weg und kann die naechste Anfrage nicht
     * treffen. Ein umhuellter Pool muesste sich merken, welchen Client er
     * schon angefasst hat -- genau die Buchfuehrung, die bei
     * gleichzeitigen Anfragen schiefgeht.
     */
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const roh = client as unknown as { query: (...args: any[]) => any }
    const original = roh.query.bind(client)
    roh.query = (...args: any[]) => {
      const erste = args[0]
      const text: string = typeof erste === 'string'
        ? erste : (erste as { text?: string })?.text ?? ''
      if (RAHMEN.test(text.trim())) return original(...args)
      anweisungen++
      const start = performance.now()
      const ergebnis = original(...args)
      // Nur ein Versprechen laesst sich messen; der Rueckruf-Stil von
      // node-postgres wird hier nirgends benutzt und bliebe sonst stehen.
      return ergebnis instanceof Promise
        ? ergebnis.finally(() => { dauerMs += performance.now() - start })
        : ergebnis
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
  try {
    await client.query('BEGIN')
    await applyContext(client, ctx)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* Verbindung bereits tot */ }
    throw err
  } finally {
    client.release()
    bericht?.({ anweisungen, dauerMs })
  }
}
