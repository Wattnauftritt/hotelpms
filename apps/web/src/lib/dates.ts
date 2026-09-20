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

/**
 * Monate addieren, ohne über das Monatsende zu rutschen.
 *
 * `setUTCMonth` allein reicht nicht: der 31. Januar plus ein Monat ergibt
 * dort den 3. März, weil der Februar keinen 31. hat und JavaScript
 * stillschweigend weiterzählt. Wer im Belegungsplan vom 31. Januar einen
 * Monat vorblättert, will den 28. Februar sehen und nicht den März.
 *
 * Dieselbe Funktion trägt auch den Jahressprung (`months: 12`): ein Jahr
 * ist zwölf Monate, und der 29. Februar eines Schaltjahres wird so zum
 * 28. Februar statt zum 1. März.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const [j, m, t] = date.split('-').map(Number)
  const ziel = new Date(Date.UTC(j!, m! - 1 + months, 1))
  // Letzter Tag des Zielmonats: Tag 0 des Folgemonats.
  const letzter = new Date(Date.UTC(
    ziel.getUTCFullYear(), ziel.getUTCMonth() + 1, 0)).getUTCDate()
  ziel.setUTCDate(Math.min(t!, letzter))
  return ziel.toISOString().slice(0, 10)
}
