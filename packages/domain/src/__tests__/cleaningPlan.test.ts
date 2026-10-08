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
  type Z = { minutes: number; kind: 'departure' | 'stayover' }
  const a = (minutes = 30): Z => ({ minutes, kind: 'departure' })
  const b = (minutes = 10): Z => ({ minutes, kind: 'stayover' })
  const je = <S>(rooms: Z[], plan: Array<S | null>, s: S) => ({
    abreisen: rooms.filter((r, i) => plan[i] === s && r.kind === 'departure').length,
    bleiber: rooms.filter((r, i) => plan[i] === s && r.kind === 'stayover').length,
    minuten: rooms.reduce((sum, r, i) => sum + (plan[i] === s ? r.minutes : 0), 0)
  })

  it('gibt jeder Kraft gleich viele Abreisen, auch wenn Bleiber das ausgleichen koennten', () => {
    // Nach Minuten allein bekaeme eine Kraft sechs Abreisen und die andere
    // zwei Abreisen und zwoelf Bleiber -- gleich lang, aber nicht gerecht.
    const rooms = [...Array.from({ length: 8 }, () => a()), ...Array.from({ length: 12 }, () => b())]
    const plan = suggestCleaningPlan(rooms, ['x', 'y'])
    expect(je(rooms, plan, 'x')).toEqual({ abreisen: 4, bleiber: 6, minuten: 180 })
    expect(je(rooms, plan, 'y')).toEqual({ abreisen: 4, bleiber: 6, minuten: 180 })
  })

  it('gleicht laengere Abreisen mit weniger Bleibern aus', () => {
    // x hat das Zimmer mit 60 Minuten: 90 gegen 60, also bekommt y drei
    // Bleiber mehr, bevor x wieder dran ist.
    const rooms = [a(60), a(30), b(), b(), b(), b(), b()]
    const plan = suggestCleaningPlan(rooms, ['x', 'y'])
    expect(je(rooms, plan, 'x')).toEqual({ abreisen: 1, bleiber: 1, minuten: 70 })
    expect(je(rooms, plan, 'y')).toEqual({ abreisen: 1, bleiber: 4, minuten: 70 })
  })

  it('haelt Abreisen und Bleiber je Kraft am Stueck, die erste vorne', () => {
    const rooms = [a(), b(), a(), b(), a(), b(), a(), b()]
    expect(suggestCleaningPlan(rooms, ['x', 'y']))
      .toEqual(['x', 'x', 'x', 'x', 'y', 'y', 'y', 'y'])
  })

  it('weicht bei Abreisen hoechstens um eine ab', () => {
    const rooms = Array.from({ length: 7 }, () => a())
    const plan = suggestCleaningPlan(rooms, ['x', 'y', 'z'])
    expect(['x', 'y', 'z'].map(s => je(rooms, plan, s).abreisen)).toEqual([3, 2, 2])
  })

  it('kommt mit mehr Kraeften als Zimmern und ohne Kraft zurecht', () => {
    expect(suggestCleaningPlan([a(), b()], ['x', 'y', 'z'])).toEqual(['x', 'y'])
    expect(suggestCleaningPlan([a(), b()], [])).toEqual([null, null])
    expect(suggestCleaningPlan([], ['x'])).toEqual([])
  })
})
