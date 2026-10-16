/**
 * Arbeitszeit (Migration 0111): was die Personal-App und der Bildschirm
 * der Leitung teilen. Hier und nicht in `personal/`, damit die Rezeption
 * nicht die Personal-App mitlaedt.
 */

export interface Eintrag {
  id: number
  /** Das Haus des Eintrags; in der Ansicht ueber alle Haeuser zaehlt es. */
  propertyId?: number
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
  /** Was die Kraft eingetragen hatte, bevor die Leitung anpasste (0118). */
  originalMinutes: number | null
  adjustedBy: string | null
  /** Wer zurueckzog, wenn es nicht die Kraft selbst war. */
  withdrawnBy: string | null
}
export interface Tag { date: string; roomMinutes: number; rooms: number; entries: Eintrag[]
                       total: number
                       /** Die Summe des Tages je Haus, Schluessel ist die Property-ID. */
                       byHouse?: Record<number, number> }
/** Ein Haus der Ansicht mit seiner Monatssumme. */
export interface HausSumme { propertyId: number; name: string; total: number; closed: boolean }
export interface Haelfte { from: string; to: string; total: number }
export interface Monat {
  month: string; closed: boolean; today: string; days: Tag[]
  /** Ueber welche Haeuser gerechnet wurde; mehr als eines nur mit `scope=all`. */
  houses?: HausSumme[]
  totals: { rooms: number; extra: number; kitchen: number; correction: number; total: number }
  /** 1. bis 15. und 16. bis Monatsende -- die Zeitarbeitsfirma zahlt halbmonatlich. */
  halves: [Haelfte, Haelfte]
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

/**
 * Summen 1.–15. und 16.–Monatsende aus den Tagessummen einer Kraft. Die
 * Uebersicht aller Kraefte liefert nur Tage; dieselbe Grenze wie die
 * Schnittstelle (`halves`), damit beide Bildschirme dieselbe Zahl zeigen.
 */
export function haelften(month: string, days: Record<string, number>): [number, number] {
  let a = 0
  let b = 0
  for (const [d, min] of Object.entries(days)) {
    if (!d.startsWith(month)) continue
    if (d <= `${month}-15`) a += min
    else b += min
  }
  return [a, b]
}
