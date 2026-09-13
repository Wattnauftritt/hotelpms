/**
 * Aufenthaltsdaten sind Kalenderdaten in der Zeitzone der Property, keine
 * Zeitstempel. Zeitzonenaufloesung ist teuer und darf nie je Zeile passieren,
 * sondern einmal je Anfrage (P12, Dokument 12).
 */
export type IsoDate = string   // YYYY-MM-DD

export function isIsoDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function nightsBetween(arrival: IsoDate, departure: IsoDate): number {
  const a = Date.parse(`${arrival}T00:00:00Z`)
  const d = Date.parse(`${departure}T00:00:00Z`)
  return Math.round((d - a) / 86_400_000)
}

export function eachNight(arrival: IsoDate, departure: IsoDate): IsoDate[] {
  const out: IsoDate[] = []
  for (let d = arrival; d < departure; d = addDays(d, 1)) out.push(d)
  return out
}

/** Geschaeftsdatum einer Property zu einem Zeitpunkt. */
export function businessDateFor(
  now: Date, timezone: string, rolloverTime: string
): IsoDate {
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now)
  const get = (t: string) => local.find(p => p.type === t)?.value ?? '00'
  const date = `${get('year')}-${get('month')}-${get('day')}`
  const time = `${get('hour')}:${get('minute')}`
  // Vor dem Tageswechsel gehoert die Zeit noch zum Vortag.
  return time < rolloverTime.slice(0, 5) ? addDays(date, -1) : date
}
