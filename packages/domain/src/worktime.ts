/**
 * Arbeitszeit des Personals (Aufgabe 18, Baustein 6).
 *
 * Keine Stempeluhr: die Zeit eines Tages sind die Pauschalminuten der
 * gereinigten Zimmer plus Zusatzarbeiten, Kueche und Korrekturen (Migration
 * 0111). Hier steht, was dabei ohne Datenbank zu rechnen ist.
 */

/** `YYYY-MM`, ein echter Monat. */
export function isMonth(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)
}

/** `HH:MM` von 00:00 bis 23:59. */
export function isClockTime(v: unknown): v is string {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
}

/**
 * Minuten von Beginn bis Ende. Liegt das Ende vor dem Beginn, ist es am
 * naechsten Morgen -- eine Fruehschicht beginnt nie vor Mitternacht und
 * endet danach, eine Spaetschicht schon. Gleich ist kein Dienst, sondern
 * ein Tippfehler: `null`.
 */
export function minutesBetween(start: string, end: string): number | null {
  const m = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const d = m(end) - m(start)
  if (d === 0) return null
  return d > 0 ? d : d + 1440
}

/** Erster und letzter Tag eines Monats, als Kalenderdaten. */
export function monthRange(month: string): { from: string; to: string } {
  const [j, m] = month.split('-').map(Number) as [number, number]
  const letzter = new Date(Date.UTC(j, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(letzter).padStart(2, '0')}` }
}
