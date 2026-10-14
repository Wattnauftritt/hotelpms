import { describe, it, expect } from 'vitest'
import { alignLineNets, sumInvoice, taxFromGross, taxAdjustToGross } from '../money.js'

/**
 * Positionsausgleich (alignLineNets). Der Fall ist Svens Rechnung
 * H-2026-00001 vom 14.10.2026: drei Naechte, je Logis, Fruehstueck Speisen
 * und Getraenke, zusammen 268,00 gebucht und bezahlt. Ohne Ausgleich ergab
 * die Rechnung 268,03 und eine "Rundung -0,03".
 */

/** Eine Zeile so, wie der Nachtlauf sie bucht: Netto aus dem Brutto. */
const zeile = (key: string, brutto: number, rateBp: number) =>
  ({ key, grossCent: brutto, rateBp, netCent: brutto - taxFromGross(brutto, rateBp) })

const naechte = [8933, 8933, 8934].flatMap((nacht, i) => [
  zeile(`logis${i}`, nacht - 385 - 165, 700),
  zeile(`speisen${i}`, 385, 700),
  zeile(`getraenke${i}`, 165, 1900)
])

describe('Positionsausgleich', () => {
  it('ohne ihn verfehlt die Rechnung das gebuchte Brutto um drei Cent', () => {
    expect(sumInvoice(naechte).grossCent).toBe(26_803)
  })

  it('trifft mit ihm das gebuchte Brutto genau, je Satzgruppe', () => {
    const a = alignLineNets(naechte)
    const neu = naechte.map(l => ({ ...l, netCent: l.netCent + (a.get(l.key) ?? 0) }))
    const s = sumInvoice(neu)
    expect(s.grossCent).toBe(26_800)
    for (const g of s.groups) {
      expect(g.grossCent).toBe(naechte.filter(l => l.rateBp === g.rateBp)
        .reduce((x, l) => x + l.grossCent, 0))
    }
    // Getragen von je einer Zeile, um wenige Cent.
    expect([...a.values()].every(d => Math.abs(d) <= 3)).toBe(true)
    expect(a.size).toBeLessThanOrEqual(2)
  })

  it('laesst eine Rechnung in Ruhe, die schon aufgeht', () => {
    expect(alignLineNets([zeile('a', 10_700, 700)]).size).toBe(0)
  })

  it('belastet keine feste Zeile', () => {
    const a = alignLineNets([
      { key: 'anzahlung', fest: true, netCent: 10_000, grossCent: 10_700, rateBp: 700 },
      ...naechte.filter(l => l.rateBp === 700)
    ])
    expect(a.has('anzahlung')).toBe(false)
  })
})

describe('Steuer traegt den letzten Cent (taxAdjustToGross)', () => {
  it('trifft jedes Brutto zu 7 und 19 Prozent, mit hoechstens einem Cent', () => {
    // Herausrechnen statt Rundungszeile (Sven, 14.10.2026). Ueber alle
    // Betraege bis 1 000 Euro: nach Ausgleich bleibt nie ein Rest.
    for (const rateBp of [700, 1900]) {
      for (let brutto = 1; brutto <= 100_000; brutto++) {
        const zeilen = [zeile('a', brutto, rateBp)]
        const a = alignLineNets(zeilen)
        const neu = zeilen.map(l => ({ ...l, netCent: l.netCent + (a.get(l.key) ?? 0) }))
        const korrektur = taxAdjustToGross(sumInvoice(neu).groups, new Map([[rateBp, brutto]]))
        expect(Math.abs(korrektur[String(rateBp)] ?? 0)).toBeLessThanOrEqual(1)
        expect(sumInvoice(neu, korrektur).grossCent).toBe(brutto)
      }
    }
  })

  it('250,00 zu 7 Prozent ist 233,64 netto und 16,36 Steuer', () => {
    const s = sumInvoice([{ netCent: 23_364, rateBp: 700 }],
      taxAdjustToGross(sumInvoice([{ netCent: 23_364, rateBp: 700 }]).groups,
                       new Map([[700, 25_000]])))
    expect(s.groups[0]).toEqual({ rateBp: 700, netCent: 23_364, taxCent: 1_636, grossCent: 25_000 })
  })

  it('traegt nichts zu 0 Prozent und nichts ueber einen Cent', () => {
    const g = sumInvoice([{ netCent: 1_000, rateBp: 0 }, { netCent: 10_000, rateBp: 1900 }]).groups
    expect(taxAdjustToGross(g, new Map([[0, 1_001], [1900, 11_905]]))).toEqual({})
  })
})
