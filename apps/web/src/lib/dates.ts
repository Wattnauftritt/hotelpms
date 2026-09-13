/**
 * Kalenderdaten, keine Zeitpunkte.
 *
 * Ein Aufenthalt vom 1. bis 4. Oktober ist derselbe Aufenthalt, egal ob die
 * Rezeption in Husum oder der Gast in Sydney darauf sieht. Sobald ein
 * Aufenthaltsdatum durch `new Date(iso)` läuft, wird es ortszeitabhängig und
 * springt je nach Zeitzone um einen Tag. Deshalb Zeichenketten, und für
 * Rechnungen ausschließlich UTC-Mitternacht.
 */
export type IsoDate = string

export function today(): IsoDate {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`
       + `-${String(n.getDate()).padStart(2, '0')}`
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = []
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d)
  return out
}

export function isWeekend(date: IsoDate): boolean {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay()
  return wd === 0 || wd === 6
}
