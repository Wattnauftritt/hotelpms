import type { Cent } from './money.js'

export type FeeKind = 'none' | 'first_night' | 'percent' | 'amount'

export interface CancellationPolicy {
  freeUntilHours: number
  feeKind: FeeKind
  feeValue: number
}

export interface StayForFee {
  arrival: Date
  nightPricesCent: readonly Cent[]
}

/**
 * Stornogebuehr. Vor Ablauf der Frist kostenlos, danach nach Regel.
 * `now` wird uebergeben, damit die Berechnung testbar bleibt und nicht von
 * der Systemuhr abhaengt.
 */
export function cancellationFee(
  policy: CancellationPolicy, stay: StayForFee, now: Date
): Cent {
  const hoursUntilArrival = (stay.arrival.getTime() - now.getTime()) / 3_600_000
  if (hoursUntilArrival >= policy.freeUntilHours) return 0

  const total = stay.nightPricesCent.reduce((s, p) => s + p, 0)
  switch (policy.feeKind) {
    case 'none':        return 0
    case 'first_night': return stay.nightPricesCent[0] ?? 0
    case 'percent':     return Math.round((total * policy.feeValue) / 100)
    case 'amount':      return policy.feeValue
  }
}
