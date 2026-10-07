/**
 * Arbeitszeit (Migration 0111): was die Personal-App und der Bildschirm
 * der Leitung teilen. Hier und nicht in `personal/`, damit die Rezeption
 * nicht die Personal-App mitlaedt.
 */

export interface Eintrag {
  id: number
  date: string
  kind: 'extra' | 'kitchen' | 'correction'
  description: string | null
  minutes: number
  start: string | null
  end: string | null
  withdrawn: boolean
  /** Deutsch, sobald uebersetzt (0112); `null`, wenn schon deutsch. */
  translationDe: string | null
  translationManual: boolean
}
export interface Tag { date: string; roomMinutes: number; rooms: number; entries: Eintrag[]
                       total: number }
export interface Monat {
  month: string; closed: boolean; today: string; days: Tag[]
  totals: { rooms: number; extra: number; kitchen: number; correction: number; total: number }
}

/** `2:05` -- Stunden und Minuten, in jeder Sprache gleich lesbar. */
export function hm(minuten: number): string {
  const v = minuten < 0 ? '-' : ''
  const a = Math.abs(minuten)
  return `${v}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`
}

/** Ein Monat vor oder zurueck, ohne `Date` und ohne Zeitzone. */
export function monatPlus(month: string, n: number): string {
  const [j, m] = month.split('-').map(Number) as [number, number]
  const i = j * 12 + (m - 1) + n
  return `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`
}
