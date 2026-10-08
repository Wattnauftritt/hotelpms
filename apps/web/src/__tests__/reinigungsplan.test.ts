import { describe, it, expect } from 'vitest'
import { stunden, summen } from '../routes/Reinigungsplan.js'
import type { PlanZimmer } from '../lib/queries/reinigungsplan.js'

/**
 * Die Summen der Karten im Reinigungsplan. Sie muessen dieselbe Zahl
 * zeigen, nach der abgerechnet wird: ein nicht gereinigtes Zimmer zaehlt
 * nicht, ein Bereich wie das Bad zaehlt als Abreise.
 */
const zimmer = (teil: Partial<PlanZimmer>): PlanZimmer => ({
  propertyId: 1, resourceId: null, areaId: null, code: '1', categoryId: null,
  categoryCode: null, building: null, floor: null, due: null, departureCheckedOut: false,
  arrivalToday: false, taskId: null, kind: null, assignedTo: null, minutes: 0,
  taskStatus: null, source: null, waived: false, water: false, kindChanged: false, ...teil })

describe('Summen je Kraft', () => {
  it('trennt Abreisen und Bleiber und zaehlt nicht Gereinigtes mit null', () => {
    const liste = [
      zimmer({ resourceId: 1, due: 'departure', minutes: 30 }),
      zimmer({ resourceId: 2, due: 'departure', minutes: 30, taskStatus: 'skipped' }),
      zimmer({ areaId: 1, kind: 'departure', minutes: 20 }),
      zimmer({ resourceId: 3, due: 'stayover', minutes: 10, taskStatus: 'done' }),
      zimmer({ resourceId: 4, due: 'stayover', minutes: 10 })
    ]
    const entwurf = new Map<string, number | null>([
      ['r1', 7], ['r2', 7], ['a1', 7], ['r3', 7], ['r4', null]])
    expect(summen(liste, entwurf).get(7))
      .toEqual({ abreisen: 3, abreiseMinuten: 50, bleiber: 1, bleiberMinuten: 10 })
    expect(summen(liste, entwurf).size).toBe(1)
  })

  // Sven, 08.10.2026: verzichtet der Gast, ist das Zimmer auch zugeteilt
  // ungezaehlt; was vor dem Verzicht schon gereinigt war, zaehlt weiter.
  it('zaehlt ein Zimmer nicht, dessen Gast verzichtet', () => {
    const liste = [
      zimmer({ resourceId: 1, due: 'stayover', minutes: 10, waived: true }),
      zimmer({ resourceId: 2, due: 'stayover', minutes: 10, waived: true, taskStatus: 'done' }),
      zimmer({ resourceId: 3, due: 'stayover', minutes: 10 })
    ]
    const entwurf = new Map<string, number | null>([['r1', 7], ['r2', 7], ['r3', 7]])
    expect(summen(liste, entwurf).get(7))
      .toEqual({ abreisen: 0, abreiseMinuten: 0, bleiber: 2, bleiberMinuten: 20 })
  })

  it('schreibt Minuten als Stunden', () => {
    expect(stunden(0)).toBe('0:00')
    expect(stunden(65)).toBe('1:05')
    expect(stunden(410)).toBe('6:50')
  })
})
