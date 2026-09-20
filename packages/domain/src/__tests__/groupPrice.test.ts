import { describe, it, expect } from 'vitest'
import { aufteilen, preisJeNacht, gruppeAufteilen } from '../groupPrice.js'

/**
 * Die Probe ist immer dieselbe: **die Summe der Teile ist der Betrag.**
 *
 * Alles andere an einer Aufteilung ist Geschmack -- ob der Rest vorn oder
 * hinten liegt, merkt niemand. Ein fehlender Cent dagegen wird in der
 * Buchhaltung zu einer Differenz ohne Ursache, und die sucht jemand.
 */
describe('Einen Betrag aufteilen', () => {
  it('teilt glatt, wenn es aufgeht', () => {
    expect(aufteilen(900, [1, 1, 1])).toEqual([300, 300, 300])
  })

  it('legt den Rest auf das erste Teil', () => {
    // 100,00 EUR auf drei Naechte: dreimal 33,33 waeren 99,99.
    expect(preisJeNacht(10_000, 3)).toEqual([3334, 3333, 3333])
  })

  it('geht auf, egal wie krumm der Betrag ist', () => {
    for (const betrag of [1, 7, 99, 1234, 99_999, 1_000_001]) {
      for (const n of [1, 2, 3, 7, 13]) {
        const teile = preisJeNacht(betrag, n)
        expect(teile).toHaveLength(n)
        expect(teile.reduce((s, t) => s + t, 0)).toBe(betrag)
      }
    }
  })

  it('gewichtet nach Personen', () => {
    // Zwei Doppelzimmer und ein Einzelzimmer, 500,00 EUR: fuenf Personen,
    // also 100,00 je Person. Gleichmaessig waere das Einzelzimmer so teuer
    // wie das Doppelzimmer.
    expect(gruppeAufteilen(50_000, [{ personen: 2 }, { personen: 2 }, { personen: 1 }]))
      .toEqual([20_000, 20_000, 10_000])
  })

  it('legt auch bei der Gruppe den Rest auf das erste Zimmer', () => {
    // 100,00 EUR auf drei gleiche Zimmer.
    const teile = gruppeAufteilen(10_000, [{ personen: 2 }, { personen: 2 }, { personen: 2 }])
    expect(teile).toEqual([3334, 3333, 3333])
    expect(teile.reduce((s, t) => s + t, 0)).toBe(10_000)
  })

  it('rechnet ein Zimmer ohne Personen als eines', () => {
    /*
     * Ein Gewicht von null hiesse ein Zimmer zum Nulltarif. Das ist eine
     * Entscheidung, die niemand durch ein leeres Feld treffen soll -- und
     * bei lauter Nullen waere die Summe der Gewichte null und die Rechnung
     * eine Division durch null.
     */
    expect(gruppeAufteilen(300, [{ personen: 0 }, { personen: 0 }]))
      .toEqual([150, 150])
  })

  it('bleibt bei einem Teil das Ganze', () => {
    expect(preisJeNacht(9999, 1)).toEqual([9999])
  })

  it('gibt bei null Teilen nichts zurueck, statt zu rechnen', () => {
    // Ein Aufenthalt ohne Nacht kommt nicht vor -- `departure > arrival`
    // ist an jeder Stelle geprueft. Aber eine Division durch null als
    // Antwort auf eine leere Liste waere ein Absturz an der falschen Stelle.
    expect(preisJeNacht(1000, 0)).toEqual([])
    expect(gruppeAufteilen(1000, [])).toEqual([])
  })

  it('verteilt auch grosse Betraege genau', () => {
    // Ueber Fliesskomma gerechnet laege das hier daneben.
    const teile = aufteilen(99_999_999_99, [3, 5, 7, 11])
    expect(teile.reduce((s, t) => s + t, 0)).toBe(99_999_999_99)
  })
})
