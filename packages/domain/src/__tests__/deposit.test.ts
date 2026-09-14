import { describe, it, expect } from 'vitest'
import { expectedRateMix, splitDeposit, depositTaxGroups, openAfterDeposits,
         type ExpectedItem } from '../deposit.js'
import { VAT_ACCOMMODATION, VAT_STANDARD } from '../money.js'

/**
 * Die Aufteilung einer pauschalen Anzahlung auf die Steuersätze ist der
 * Kern von Aufgabe 3 — und laut Dokument 13 der Punkt, der „nicht trivial"
 * ist. Gerechnet wird hier, geprüft auch: ohne Datenbank, ohne Rechnung,
 * nur Zahlen.
 *
 * Die Vorgabe des Hauses: Übernachtung 7 Prozent, Frühstück anteilig —
 * beim Buffet 70 Prozent Speisen zum ermäßigten und 30 Prozent Getränke
 * zum vollen Satz.
 */

/** Ein Frühstücksbuffet: ein Preis, zwei Steuersätze. */
const buffet = (grossCent: number): ExpectedItem => ({
  grossCent, rateBp: VAT_ACCOMMODATION, splitShareBp: 3000, splitRateBp: VAT_STANDARD
})

describe('Erwartete Leistung nach Steuersaetzen', () => {
  it('fasst die Uebernachtung zum ermaessigten Satz zusammen', () => {
    const mix = expectedRateMix([
      { grossCent: 15_000, rateBp: VAT_ACCOMMODATION },
      { grossCent: 15_000, rateBp: VAT_ACCOMMODATION }
    ])
    expect(mix).toEqual([{ rateBp: 700, grossCent: 30_000 }])
  })

  /**
   * 12,00 Euro Frühstück mit 30 Prozent Getränkeanteil: 3,60 Euro zu 19
   * und 8,40 Euro zu 7 Prozent. Die Teile ergeben wieder den Preis.
   */
  it('zerlegt ein Buffet in Speisen und Getraenke', () => {
    const mix = expectedRateMix([buffet(1_200)])
    expect(mix).toEqual([
      { rateBp: 700, grossCent: 840 },
      { rateBp: 1900, grossCent: 360 }
    ])
    expect(mix.reduce((s, g) => s + g.grossCent, 0)).toBe(1_200)
  })

  it('laesst den Rest beim Hauptsatz, wenn es nicht aufgeht', () => {
    // 10,01 Euro: 30 Prozent sind 3,003, gerundet 3,00. Der Rest bleibt
    // bei den Speisen, nicht im Nichts.
    const mix = expectedRateMix([buffet(1_001)])
    expect(mix).toEqual([
      { rateBp: 700, grossCent: 701 },
      { rateBp: 1900, grossCent: 300 }
    ])
    expect(mix.reduce((s, g) => s + g.grossCent, 0)).toBe(1_001)
  })

  it('behandelt ein Fruehstueck ohne Aufteilung als einen Satz', () => {
    // Ein Haus, das nicht aufteilt, weil es kein Buffet hat.
    const mix = expectedRateMix([{ grossCent: 1_200, rateBp: VAT_STANDARD }])
    expect(mix).toEqual([{ rateBp: 1900, grossCent: 1_200 }])
  })

  it('laesst ein kostenfrei enthaltenes Fruehstueck weg', () => {
    // Kostenfrei inklusive heisst: kein eigener Betrag, der Preis steckt
    // in der Uebernachtung und teilt deren Satz.
    const mix = expectedRateMix([
      { grossCent: 30_000, rateBp: VAT_ACCOMMODATION },
      buffet(0)
    ])
    expect(mix).toEqual([{ rateBp: 700, grossCent: 30_000 }])
  })
})

describe('Aufteilung der Anzahlung', () => {
  /**
   * Der Fall aus dem Abnahmekriterium: 200 Euro Anzahlung auf einen
   * Aufenthalt von 500 Euro.
   */
  it('teilt im Verhaeltnis der erwarteten Leistung', () => {
    const mix = expectedRateMix([
      { grossCent: 44_000, rateBp: VAT_ACCOMMODATION },   // vier Naechte
      buffet(6_000)                                        // Fruehstueck
    ])
    expect(mix).toEqual([
      { rateBp: 700, grossCent: 48_200 },
      { rateBp: 1900, grossCent: 1_800 }
    ])

    const anzahlung = splitDeposit(20_000, mix)
    expect(anzahlung).toEqual([
      { rateBp: 700, grossCent: 19_280 },
      { rateBp: 1900, grossCent: 720 }
    ])
    expect(anzahlung.reduce((s, t) => s + t.grossCent, 0)).toBe(20_000)
  })

  /**
   * Die Summe der Teile muss **immer** der Anzahlungsbetrag sein. Ein Cent
   * Differenz zwischen ausgewiesener Summe und vereinnahmtem Betrag ist
   * genau die Art Fehler, die erst der Betriebsprüfer findet.
   */
  it('trifft den Betrag auf den Cent, auch wenn es nicht aufgeht', () => {
    const mix = [
      { rateBp: 700, grossCent: 10_000 },
      { rateBp: 1900, grossCent: 10_000 },
      { rateBp: 0, grossCent: 10_000 }
    ]
    for (const betrag of [1, 2, 100, 3_333, 9_999, 100_001]) {
      const teile = splitDeposit(betrag, mix)
      expect(teile.reduce((s, t) => s + t.grossCent, 0), `Betrag ${betrag}`).toBe(betrag)
    }
  })

  it('gibt bei einem einzigen Satz alles diesem Satz', () => {
    expect(splitDeposit(20_000, [{ rateBp: 700, grossCent: 50_000 }]))
      .toEqual([{ rateBp: 700, grossCent: 20_000 }])
  })

  it('verteilt Restcents nach dem groessten Bruchteil und nicht nach Zufall', () => {
    const mix = [
      { rateBp: 700, grossCent: 1 },
      { rateBp: 1900, grossCent: 2 }
    ]
    // Ein Cent auf 1 zu 2: der groessere Bruchteil liegt beim zweiten.
    expect(splitDeposit(1, mix)).toEqual([{ rateBp: 1900, grossCent: 1 }])
    // Zweimal gerechnet ist zweimal dasselbe.
    expect(splitDeposit(1, mix)).toEqual(splitDeposit(1, mix))
  })

  it('gibt nichts zurueck, wenn nichts erwartet wird', () => {
    expect(splitDeposit(20_000, [])).toEqual([])
  })
})

describe('Steuer der Anzahlung', () => {
  it('rechnet brutto in netto und Steuer, je Satz', () => {
    const gruppen = depositTaxGroups([
      { rateBp: 700, grossCent: 19_280 },
      { rateBp: 1900, grossCent: 720 }
    ])
    expect(gruppen).toEqual([
      { rateBp: 700, netCent: 18_019, taxCent: 1_261, grossCent: 19_280 },
      { rateBp: 1900, netCent: 605, taxCent: 115, grossCent: 720 }
    ])
    // Die Bruttosumme bleibt der vereinbarte Betrag.
    expect(gruppen.reduce((s, g) => s + g.grossCent, 0)).toBe(20_000)
  })

  /**
   * § 14 Abs. 5 Satz 2 UStG: die Schlussrechnung lautet über den vollen
   * Betrag, die Anzahlung wird abgesetzt. Sie mindert die Rechnung, nicht
   * die Leistung.
   */
  it('laesst 300 Euro offen, wenn 200 auf 500 angezahlt wurden', () => {
    expect(openAfterDeposits(50_000, 20_000)).toBe(30_000)
  })
})
