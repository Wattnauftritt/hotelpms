import { withTransaction, SYSTEM_CONTEXT, type Pool } from '@hotelpms/db'
import { sicherheitsereignisMelden, type Taeter } from '@hotelpms/domain'

/**
 * Mengenalarm (Migration 0210, Bedrohungsanalyse 23.10.2026, E2).
 *
 * Einmal je Stunde: die abgeschlossene Stunde gegen die vierzehn Tage davor.
 * Was auffaellt, wird ein Sicherheitsereignis `access_volume` -- mit
 * Hinweis an die Leitung des Betriebs und Meldung an uns, wie jede andere
 * kritische Handlung. Gesucht wird der Abfluss mit gueltigem Zugang: ein
 * Token, das sonst tausend Reservierungen je Nacht holt und ploetzlich
 * zwanzigtausend, oder eine Rezeptionssitzung, die um drei Uhr die
 * Gaesteliste durchblaettert.
 *
 * Die Grenzen sind bewusst grob. Ein Alarm zu viel kostet eine Mail; einer
 * zu wenig die Gaestedatei.
 */
export const MENGE_MIN = 500
export const MENGE_FAKTOR = 5
export const NACHT_MIN = 100

interface Ausreisser {
  principal_key: string; account_id: number | null; rows_returned: number
  requests: number; baseline: number; origin: string | null; reason: 'volume' | 'night'
}

function taeterAus(key: string): Taeter {
  const [art, rest = ''] = key.split(':', 2) as [string, string | undefined]
  if (art === 'user') return { kind: 'user', userId: Number(rest), ref: null }
  if (art === 'client') return { kind: 'client', userId: null, ref: rest }
  return { kind: 'system', userId: null, ref: key.slice(0, 64) }
}

export async function pruefeAbrufmengen(
  pool: Pool, alarmAn: string, stunde: Date
): Promise<number> {
  const r = await withTransaction(pool, SYSTEM_CONTEXT, c =>
    c.query<Ausreisser>('SELECT * FROM access_volume_outliers($1, $2, $3, $4)',
      [stunde.toISOString(), MENGE_MIN, MENGE_FAKTOR, NACHT_MIN]))
  for (const a of r.rows) {
    // Im Kontext genau dieses Betriebs: security_event_record schreibt nur
    // in einen Account, der im Kontext steht.
    const kontext = { accountIds: a.account_id === null ? [] : [a.account_id],
                      propertyIds: [], userId: null }
    await withTransaction(pool, kontext, c => sicherheitsereignisMelden(c, {
      kind: 'access_volume', accountId: a.account_id,
      detail: { grund: a.reason, datensaetze: a.rows_returned, anfragen: a.requests,
                bisherHoechstens: a.baseline, stunde: stunde.toISOString() },
      hint: a.reason === 'night'
        ? `${a.rows_returned} Datensaetze in der Nacht`
        : `${a.rows_returned} Datensaetze in einer Stunde, sonst hoechstens ${a.baseline}`
    }, taeterAus(a.principal_key), a.origin, alarmAn))
  }
  return r.rows.length
}
