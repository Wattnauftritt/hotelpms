import { describe, it, expect } from 'vitest'
import { groupInvoiceLines, type InvoiceLineSource } from '../invoiceLines.js'

/** Drei Naechte wie aus dem Nachtlauf: je Nacht Logis, Speisen, Getraenke. */
function nacht(tag: string, logis: number, gast?: string): InvoiceLineSource[] {
  const datum = `2026-10-${tag}`
  const de = `${tag}.10.2026`
  return [
    { description: `Übernachtung ${de}`, businessDate: datum, quantity: 1, netCent: logis,
      rateBp: 700, unitCode: 'DAY', rank: 0, guest: gast },
    { description: `Frühstück Speisen ${de}`, businessDate: datum, quantity: 1, netCent: 360,
      rateBp: 700, unitCode: 'C62', rank: 1, guest: gast },
    { description: `Frühstück Getränke ${de}`, businessDate: datum, quantity: 1, netCent: 139,
      rateBp: 1900, unitCode: 'C62', rank: 2, guest: gast }
  ]
}

describe('Positionen je Leistung zusammenfassen', () => {
  it('fasst die Naechte zusammen und stellt die Uebernachtung vor das Fruehstueck', () => {
    // Wie sie vom Folio kommen: Fruehstueck zuerst gebucht.
    const quellen = [...nacht('08', 7859), ...nacht('09', 7860), ...nacht('10', 7860)]
      .sort((a, b) => b.rank - a.rank)
    expect(groupInvoiceLines(quellen)).toEqual([
      { name: 'Übernachtung 08.10.–10.10.2026', quantity: 3, unitCode: 'DAY',
        netCent: 23_579, rateBp: 700, averagePrice: true },
      { name: 'Frühstück Speisen 08.10.–10.10.2026', quantity: 3, unitCode: 'C62',
        netCent: 1_080, rateBp: 700 },
      { name: 'Frühstück Getränke 08.10.–10.10.2026', quantity: 3, unitCode: 'C62',
        netCent: 417, rateBp: 1900 }
    ])
  })

  /** Menge mal Durchschnitt verfehlt die Summe um einen Cent; das Blatt sagt es. */
  it('kennzeichnet einen Einzelpreis nur dann als Durchschnitt, wenn er einer ist', () => {
    const l = groupInvoiceLines([...nacht('08', 7859), ...nacht('09', 7860)])
    expect(l.map(x => x.averagePrice ?? false)).toEqual([true, false, false])
  })

  it('laesst eine einzelne Nacht stehen, wie sie gebucht wurde', () => {
    expect(groupInvoiceLines(nacht('08', 7859)).map(l => l.name)).toEqual(
      ['Übernachtung 08.10.2026', 'Frühstück Speisen 08.10.2026', 'Frühstück Getränke 08.10.2026'])
  })

  /** Zwei Aufenthalte: ein Zeitraum ueber die Luecke behauptete Naechte, die es nicht gab. */
  it('beginnt nach einer Luecke eine neue Zeile', () => {
    const l = groupInvoiceLines([...nacht('01', 8000), ...nacht('02', 8000),
                                 ...nacht('05', 8000)]).filter(x => x.unitCode === 'DAY')
    expect(l.map(x => [x.name, x.quantity])).toEqual([
      ['Übernachtung 01.10.–02.10.2026', 2], ['Übernachtung 05.10.2026', 1]])
  })

  it('haelt die Zimmer einer Sammelrechnung auseinander, jedes mit Uebernachtung zuerst', () => {
    const a = 'Zimmer 101, Anna Berger'
    const b = 'Zimmer 102, Jan Petersen'
    const l = groupInvoiceLines([...nacht('08', 8000, a), ...nacht('08', 9000, b),
                                 ...nacht('09', 8000, a), ...nacht('09', 9000, b)])
    expect(l.map(x => x.name)).toEqual([
      `Übernachtung 08.10.–09.10.2026 – ${a}`,
      `Frühstück Speisen 08.10.–09.10.2026 – ${a}`,
      `Frühstück Getränke 08.10.–09.10.2026 – ${a}`,
      `Übernachtung 08.10.–09.10.2026 – ${b}`,
      `Frühstück Speisen 08.10.–09.10.2026 – ${b}`,
      `Frühstück Getränke 08.10.–09.10.2026 – ${b}`])
    expect(l[3]!.netCent).toBe(18_000)
  })

  it('fasst nichts zusammen, dessen Text nicht auf sein Datum endet', () => {
    const minibar = { description: 'Minibar', businessDate: '2026-10-08', quantity: 2,
                      netCent: 500, rateBp: 1900, rank: 4 }
    const l = groupInvoiceLines([minibar, { ...minibar, businessDate: '2026-10-09' },
                                 ...nacht('08', 8000)])
    expect(l.map(x => x.name)).toEqual(['Übernachtung 08.10.2026', 'Frühstück Speisen 08.10.2026',
      'Frühstück Getränke 08.10.2026', 'Minibar', 'Minibar'])
  })

  it('haelt eine Gegenbuchung von der Buchung getrennt und die Summe gleich', () => {
    const q = [...nacht('08', 8000), ...nacht('09', 8000)]
    const storno = { ...q[3]!, netCent: -8000 }
    const l = groupInvoiceLines([...q, storno])
    expect(l.filter(x => x.unitCode === 'DAY').map(x => x.netCent)).toEqual([16_000, -8000])
    const summe = (xs: Array<{ netCent: number }>): number => xs.reduce((s, x) => s + x.netCent, 0)
    expect(summe(l)).toBe(summe([...q, storno]))
  })

  it('schreibt den Zeitraum ueber den Jahreswechsel mit beiden Jahren', () => {
    const l = groupInvoiceLines([['31.12.2026', '2026-12-31'], ['01.01.2027', '2027-01-01']]
      .map(([de, iso]) => ({
        description: `Übernachtung ${de!}`, businessDate: iso!, quantity: 1,
        netCent: 8000, rateBp: 700, unitCode: 'DAY', rank: 0 })))
    expect(l[0]!.name).toBe('Übernachtung 31.12.2026–01.01.2027')
  })
})
