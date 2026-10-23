import { describe, it, expect } from 'vitest'
import { verkauftAlsStrecken, kategorieImZimmer } from '../lib/verkauftAls.js'

/*
 * Die Tage "verkauft als" (0197) im Plan: aus einem Tag je Zeile werden
 * Strecken, und eine neue Buchung im Zimmer bekommt die verkaufte Kategorie
 * nur, wenn jede ihrer Naechte so verkauft ist.
 */
const tag = (resource_id: number, date: string, category_id: number) =>
  ({ resource_id, date, category_id, category_code: `K${category_id}`,
     category_name: `Kategorie ${category_id}` })

describe('verkauftAlsStrecken', () => {
  it('fasst aufeinanderfolgende Tage derselben Kategorie zusammen, ueber den Monat', () => {
    const m = verkauftAlsStrecken([
      tag(4, '2026-11-01', 1), tag(4, '2026-10-31', 1), tag(4, '2026-11-03', 1),
      tag(4, '2026-11-04', 2), tag(5, '2026-11-01', 1)])
    expect(m.get(4)!.map(s => [s.from, s.to, s.categoryId])).toEqual([
      ['2026-10-31', '2026-11-02', 1],
      ['2026-11-03', '2026-11-04', 1],
      ['2026-11-04', '2026-11-05', 2]])
    expect(m.get(5)!.length).toBe(1)
  })
})

describe('kategorieImZimmer', () => {
  const s = verkauftAlsStrecken([tag(4, '2026-11-01', 1), tag(4, '2026-11-02', 1)]).get(4)

  it('nimmt die verkaufte Kategorie, wenn jede Nacht so verkauft ist', () => {
    expect(kategorieImZimmer(s, 2, '2026-11-01', '2026-11-03')).toBe(1)
    expect(kategorieImZimmer(s, 2, '2026-11-02', '2026-11-03')).toBe(1)
  })

  it('bleibt bei der eigenen, wenn eine Nacht nicht dazugehoert', () => {
    expect(kategorieImZimmer(s, 2, '2026-11-01', '2026-11-04')).toBe(2)
    expect(kategorieImZimmer(s, 2, '2026-10-31', '2026-11-02')).toBe(2)
    expect(kategorieImZimmer(undefined, 2, '2026-11-01', '2026-11-02')).toBe(2)
  })
})
