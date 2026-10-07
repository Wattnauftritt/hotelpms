import { describe, it, expect } from 'vitest'
import { resolveCleaningMinutes, suggestCleaningPlan, type CleaningNorm }
  from '../cleaningPlan.js'

describe('Sollminuten', () => {
  const norms: CleaningNorm[] = [
    { kind: 'departure', categoryId: null, resourceId: null, minutes: 30 },
    { kind: 'departure', categoryId: 7, resourceId: null, minutes: 20 },
    { kind: 'departure', categoryId: null, resourceId: 8, minutes: 60 },
    { kind: 'stayover', categoryId: null, resourceId: null, minutes: 12 }
  ]

  it('nimmt Zimmer vor Kategorie vor Haus', () => {
    expect(resolveCleaningMinutes(norms, { resourceId: 8, categoryId: 7 }, 'departure')).toBe(60)
    expect(resolveCleaningMinutes(norms, { resourceId: 9, categoryId: 7 }, 'departure')).toBe(20)
    expect(resolveCleaningMinutes(norms, { resourceId: 9, categoryId: 1 }, 'departure')).toBe(30)
    expect(resolveCleaningMinutes(norms, { resourceId: 8, categoryId: 7 }, 'stayover')).toBe(12)
  })

  it('faellt ohne Eintrag auf die Vorgabe der alten App', () => {
    expect(resolveCleaningMinutes([], { resourceId: 1, categoryId: 1 }, 'departure')).toBe(30)
    expect(resolveCleaningMinutes([], { resourceId: 1, categoryId: 1 }, 'stayover')).toBe(10)
  })
})

describe('Vorschlag der Zuteilung', () => {
  const m = (...minuten: number[]): Array<{ minutes: number }> =>
    minuten.map(x => ({ minutes: x }))

  it('teilt in zusammenhaengende Abschnitte mit kleinster Hoechstlast', () => {
    // 30+30 | 60 | 10+10+10+30 -- jede Kraft 60.
    expect(suggestCleaningPlan(m(30, 30, 60, 10, 10, 10, 30), ['a', 'b', 'c']))
      .toEqual(['a', 'a', 'b', 'c', 'c', 'c', 'c'])
  })

  it('haelt jede Kraft an einem Stueck', () => {
    const plan = suggestCleaningPlan(m(...Array.from({ length: 40 }, (_, i) => 10 + (i % 3) * 10)),
      ['a', 'b', 'c', 'd'])
    const wechsel = plan.filter((s, i) => i > 0 && s !== plan[i - 1]).length
    expect(wechsel).toBe(3)
    const last = (s: string): number =>
      plan.reduce((sum, x, i) => sum + (x === s ? 10 + (i % 3) * 10 : 0), 0)
    const lasten = ['a', 'b', 'c', 'd'].map(last)
    expect(Math.max(...lasten) - Math.min(...lasten)).toBeLessThanOrEqual(30)
  })

  it('kommt mit mehr Kraeften als Zimmern und ohne Kraft zurecht', () => {
    expect(suggestCleaningPlan(m(30, 10), ['a', 'b', 'c'])).toEqual(['a', 'b'])
    expect(suggestCleaningPlan(m(30, 10), [])).toEqual([null, null])
    expect(suggestCleaningPlan([], ['a'])).toEqual([])
  })
})
