import { withTransaction, SYSTEM_CONTEXT, type Pool } from '@hotelpms/db'

/**
 * Eine ALARM-Zeile als Mail an das Sicherheitspostfach (Bedrohungsanalyse
 * 23.10.2026, E4; Begruendung am Logger in `worker.ts`).
 *
 * Nur ab Stufe `error` und nur, wenn der Text mit "ALARM" beginnt. In die
 * Mail kommen Zahlen, Wahrheitswerte und kurze Zeichenketten aus dem
 * Objekt, nie ein Fehlerobjekt: dessen Text kann eine Zeile mit Gastnamen
 * tragen (N10, Audit 11.10.2026). Gleicher Text binnen einer Stunde ist
 * eine Mail (`platform_alert_enqueue`).
 *
 * `true`, wenn eingereiht wurde.
 */
export async function alarmEinreihen(
  pool: Pool, an: string, args: unknown[], level: number
): Promise<boolean> {
  if (level < 50) return false
  const text = args.find((a): a is string => typeof a === 'string')
  if (text === undefined || !text.startsWith('ALARM')) return false
  const felder: string[] = []
  const obj = args[0]
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Error)) {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' || typeof v === 'boolean'
          || (typeof v === 'string' && v.length <= 40)) felder.push(`${k}: ${String(v)}`)
    }
  }
  const r = await withTransaction(pool, SYSTEM_CONTEXT, c =>
    c.query<{ ok: boolean }>('SELECT platform_alert_enqueue($1, $2, $3, $4) AS ok',
      [an, `[StayGrid] ${text.slice(0, 120)}`,
       [text, ...felder, `Zeit: ${new Date().toISOString()}`].join('\n'),
       `alarm:${text.slice(0, 120)}`]))
  return r.rows[0]?.ok === true
}
