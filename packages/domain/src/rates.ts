import type { Cent } from './money.js'

export interface Derivation {
  kind: 'amount' | 'percent'
  value: number
}

/**
 * Abgeleitete Rate. Ein Basispreis plus Betrag oder Prozent.
 * Spart Pflegeaufwand und verhindert Fehler durch manuelles Kopieren.
 */
export function derivePrice(basePrice: Cent, d: Derivation): Cent {
  const result = d.kind === 'amount'
    ? basePrice + d.value
    : Math.round(basePrice * (1 + d.value / 100))
  return Math.max(result, 0)
}

export interface Restriction {
  minLos?: number | null
  maxLos?: number | null
  closed?: boolean
  closedToArrival?: boolean
  closedToDeparture?: boolean
}

export type RestrictionViolation =
  | 'closed' | 'closed_to_arrival' | 'closed_to_departure' | 'min_los' | 'max_los'

/**
 * Prueft die Restriktionen eines Aufenthalts.
 * `byDate` enthaelt je Nacht die Regel; die Abreisenacht selbst zaehlt nicht,
 * wohl aber closed_to_departure am Abreisetag.
 */
export function checkRestrictions(
  nights: ReadonlyArray<{ date: string; restriction: Restriction }>,
  departureRestriction: Restriction | undefined,
  lengthOfStay: number
): RestrictionViolation[] {
  const violations: RestrictionViolation[] = []
  const first = nights[0]

  for (const n of nights) {
    if (n.restriction.closed) { violations.push('closed'); break }
  }
  if (first?.restriction.closedToArrival) violations.push('closed_to_arrival')
  if (departureRestriction?.closedToDeparture) violations.push('closed_to_departure')
  if (first?.restriction.minLos != null && lengthOfStay < first.restriction.minLos) {
    violations.push('min_los')
  }
  if (first?.restriction.maxLos != null && lengthOfStay > first.restriction.maxLos) {
    violations.push('max_los')
  }
  return violations
}
