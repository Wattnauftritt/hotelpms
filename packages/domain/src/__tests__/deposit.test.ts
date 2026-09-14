import { describe, it, expect } from 'vitest'
import { expectedRateMix, splitDeposit, depositLines, type ExpectedItem,
         type DepositLine } from '../deposit.js'
import { VAT_ACCOMMODATION, VAT_STANDARD, netFromGross, taxFromNet } from '../money.js'

/** Was die Rechnung aus diesen Positionen als Brutto ausweist. */
const ausgewiesen = (lines: readonly DepositLine[]): number =>
  lines.reduce((s, l) => s + l.netCent + taxFromNet(l.netCent, l.rateBp), 0)

/**
 * Die Aufteilung einer pauschalen Anzahlung auf die Steuersätze ist der
 * Kern von Aufgabe 3 — und laut Dokument 13 der Punkt, der „nicht trivial"
 * ist. Gerechnet wird hier, geprüft auch: ohne Datenbank, ohne Rechnung,
 * nur Zahlen.
 *
 * Die Vorgabe des Hauses: Übernachtung ermäßigt, Frühstück anteilig — beim
 * Buffet 70 Prozent Speisen zum ermäßigten und 30 Prozent Getränke zum
 * vollen Satz.
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
   * Vier Nächte zu 110 Euro und 60 Euro Frühstück: 482,00 Euro erwartete
   * Leistung zum ermäßigten und 18,00 Euro zum vollen Satz. In diesem
   * Verhältnis wird die Anzahlung geteilt.
   */
  it('teilt im Verhaeltnis der erwarteten Leistung', () => {
    const mix = expectedRateMix([
      { grossCent: 44_000, rateBp: VAT_ACCOMMODATION },
      buffet(6_000)
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
   * Differenz zwischen ausgewiesener Summe und Zahlungseingang ist genau
   * die Art Fehler, die erst der Betriebsprüfer findet.
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

describe('Positionen der Anzahlungsrechnung', () => {
  /**
   * Bei einem einzigen Satz ist nicht jeder Betrag darstellbar: zu 7
   * Prozent gibt es kein Netto, dessen aufgeschlagene Steuer genau 250,00
   * Euro ergibt — 233,64 plus 16,35 sind 249,99, 233,65 plus 16,36 sind
   * 250,01. Dann wird der nächstliegende genommen, nicht irgendeiner.
   */
  it('nimmt den naechstliegenden Betrag, wenn keiner genau passt', () => {
    expect(netFromGross(25_000, 700)).toBe(23_364)
    expect(taxFromNet(23_364, 700)).toBe(1_635)

    const lines = depositLines(25_000, [{ rateBp: 700, grossCent: 25_000 }])
    expect(Math.abs(ausgewiesen(lines) - 25_000)).toBe(1)
  })

  /**
   * Bei zwei Sätzen geht es fast immer auf, weil die Sätze verschieden
   * runden: der Cent wird dorthin gelegt, wo er die Summe trifft. Naiv
   * gerechnet wären es hier 200,01 Euro für eine Anzahlung von 200,00.
   */
  it('trifft den vereinnahmten Betrag bei zwei Saetzen', () => {
    const teile = [
      { rateBp: 700, grossCent: 18_400 },
      { rateBp: 1900, grossCent: 1_600 }
    ]
    // Naiv herausgerechnet weist die Rechnung 200,01 Euro aus, obwohl
    // 200,00 Euro vereinnahmt wurden.
    expect(ausgewiesen(teile.map(t => (
      { rateBp: t.rateBp, netCent: netFromGross(t.grossCent, t.rateBp) })))).toBe(20_001)

    expect(ausgewiesen(depositLines(20_000, teile))).toBe(20_000)
    expect(depositLines(20_000, teile).map(l => l.rateBp)).toEqual([700, 1900])
  })

  /**
   * Wo die Norm den Betrag nicht hergibt, ist die Abweichung höchstens ein
   * Cent — und der ist mathematisch nicht vermeidbar: zu 7 Prozent gibt es
   * kein Netto, dessen aufgeschlagene Steuer genau 250,00 Euro ergibt.
   */
  it('weicht nie um mehr als einen Cent ab', () => {
    for (const satz of [700, 1900]) {
      for (let betrag = 1; betrag <= 5_000; betrag++) {
        const lines = depositLines(betrag, [{ rateBp: satz, grossCent: betrag }])
        expect(Math.abs(ausgewiesen(lines) - betrag),
          `${betrag} Cent zu ${satz / 100}%`).toBeLessThanOrEqual(1)
      }
    }
  })
})
