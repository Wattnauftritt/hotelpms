/**
 * Kontrolle als Chips (Sven, 08.10.2026: "Auch dort ist es viel
 * uebersichtlicher mit Chips. Die Chips aendern die Farbe nach Status").
 * Dieselbe Darstellung in der Personal-App und am Rechner; hier steht nur,
 * welcher Zustand welche Farbe hat und wie die Zimmer auf Karten gehen.
 */

export interface KontrollChipZimmer {
  taskId: number
  kind: 'departure' | 'stayover'
  staffName: string | null
  outcome: 'cleaned' | 'declined' | 'was_clean' | null
  inspection: 'passed' | 'rework' | null
  free: boolean
}

/**
 * - `open`: noch nicht gereinigt
 * - `blocked`: Abreise, der Gast ist noch im Zimmer
 * - `toCheck`: gereinigt (oder war sauber), wartet auf die Hausdame
 * - `passed`: abgenommen
 * - `rework`: Nacharbeit, die Kraft ist wieder dran
 * - `declined`: der Gast wollte keine Reinigung, nichts abzunehmen
 */
export type ChipZustand = 'open' | 'blocked' | 'toCheck' | 'passed' | 'rework' | 'declined'

export function chipZustand(z: KontrollChipZimmer): ChipZustand {
  if (z.inspection === 'rework') return 'rework'
  if (z.inspection === 'passed') return 'passed'
  if (z.outcome === 'declined') return 'declined'
  if (z.outcome === 'cleaned' || z.outcome === 'was_clean') return 'toCheck'
  return z.kind === 'departure' && !z.free ? 'blocked' : 'open'
}

/**
 * Gruen mit Haken heisst wie in der alten App "gereinigt"; kraeftig gruen
 * mit Doppelhaken ist, was die Hausdame abgenommen hat. Rot ist nur
 * Nacharbeit -- Abreise und Bleiber unterscheidet der Rahmen der Gruppe,
 * nicht die Farbe des Chips.
 */
export const CHIP_FARBE: Record<ChipZustand, string> = {
  open: 'bg-white border-neutral-300 text-neutral-800',
  blocked: 'bg-neutral-100 border-dashed border-neutral-300 text-neutral-500',
  toCheck: 'bg-green-50 border-green-300 text-green-900',
  passed: 'bg-green-600 border-green-700 text-white',
  rework: 'bg-red-600 border-red-700 text-white',
  declined: 'bg-neutral-100 border-neutral-300 text-neutral-500'
}

export const CHIP_ZEICHEN: Record<ChipZustand, string> = {
  open: '', blocked: '…', toCheck: '✓', passed: '✓✓', rework: '↺', declined: '⊘'
}

/**
 * Je Kraft eine Karte, nach Namen; was niemand hat, zuletzt. Die Zimmer
 * behalten die Reihenfolge der Schnittstelle (Gehreihenfolge).
 */
export function nachKraft<Z extends KontrollChipZimmer>(
  rooms: readonly Z[]
): Array<{ name: string | null; rooms: Z[] }> {
  const m = new Map<string | null, Z[]>()
  for (const z of rooms) m.set(z.staffName, [...(m.get(z.staffName) ?? []), z])
  return [...m].map(([name, liste]) => ({ name, rooms: liste }))
    .sort((a, b) => a.name === null ? 1 : b.name === null ? -1
      : a.name.localeCompare(b.name, 'de'))
}
