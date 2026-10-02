import { describe, it, expect } from 'vitest'
import { steerGrid, steerPrice, type SteerInput } from '@hotelpms/domain'

/**
 * Die Rechnung der Preissteuerung je Belegungsstufe, ohne Datenbank.
 * Dass SQL und diese Fassung Cent fuer Cent uebereinstimmen, prueft
 * `apps/api/.../preissteuerung.test.ts` an vierhundert Eingaben.
 */

const ohne: SteerInput = {
  baseCent: 10000, currentCent: null, percentBp: 0, amountCent: 0,
  minCent: null, maxCent: null, rounding: 'none', maxStepBp: null
}

describe('Raster der Rundung', () => {
  it('rundet kaufmaennisch auf volle Euro', () => {
    expect(steerGrid(10749, 'euro')).toBe(10700)
    expect(steerGrid(10750, 'euro')).toBe(10800)
    expect(steerGrid(10701, 'euro', 'up')).toBe(10800)
    expect(steerGrid(10799, 'euro', 'down')).toBe(10700)
  })

  it('rundet auf ,90', () => {
    expect(steerGrid(10743, 'ninety')).toBe(10790)
    expect(steerGrid(10739, 'ninety')).toBe(10690)
    expect(steerGrid(10691, 'ninety', 'up')).toBe(10790)
    expect(steerGrid(10789, 'ninety', 'down')).toBe(10690)
    // Unter 0,90 gibt es keinen Rasterwert nach unten; null statt negativ.
    expect(steerGrid(50, 'ninety', 'down')).toBe(0)
  })
})

describe('steerPrice', () => {
  it('laesst den Grundpreis ohne Wirkung unangetastet, auch ungerundet', () => {
    expect(steerPrice({ ...ohne, baseCent: 9999, rounding: 'euro' })).toBe(9999)
  })

  it('rechnet Prozent kaufmaennisch auf den Cent, dann auf das Raster', () => {
    // 99,99 + 12,5 % = 112,48875 -> 112,49 -> 112,00
    expect(steerPrice({ ...ohne, baseCent: 9999, percentBp: 1250 })).toBe(11249)
    expect(steerPrice({ ...ohne, baseCent: 9999, percentBp: 1250, rounding: 'euro' }))
      .toBe(11200)
    // Negativ symmetrisch: -0,5 Cent wird -1, nicht 0.
    expect(steerPrice({ ...ohne, baseCent: 5, percentBp: -1000 })).toBe(4)
  })

  it('Leitplanken begrenzen die Wirkung, nicht den Grundpreis', () => {
    expect(steerPrice({ ...ohne, percentBp: 3000, maxCent: 12000 })).toBe(12000)
    expect(steerPrice({ ...ohne, percentBp: -3000, minCent: 9000 })).toBe(9000)
    // Grundpreis schon ueber dem Hoechstpreis: kein Aufschlag, keine Senkung.
    expect(steerPrice({ ...ohne, baseCent: 15000, percentBp: 1000, maxCent: 12000 }))
      .toBe(15000)
    // Ein Rabatt bleibt bei Hoechstpreis unter dem Grundpreis moeglich.
    expect(steerPrice({ ...ohne, baseCent: 15000, percentBp: -1000, maxCent: 12000 }))
      .toBe(13500)
  })

  it('haelt die Leitplanke auch gegen die Rundung', () => {
    // 120,00 Hoechstpreis, auf ,90: 119,90 statt 120,90.
    expect(steerPrice({ ...ohne, percentBp: 5000, maxCent: 12000, rounding: 'ninety' }))
      .toBe(11990)
    // Kein Rasterwert im Band: die Leitplanke gewinnt vor der Rundung.
    expect(steerPrice({ ...ohne, baseCent: 12020, percentBp: 5000, minCent: 12010,
                        maxCent: 12050, rounding: 'euro' })).toBe(12050)
  })

  it('geht in Schritten auf das Ziel zu und bleibt dort', () => {
    let aktuell: number | null = 10000
    const verlauf: number[] = []
    for (let i = 0; i < 6; i++) {
      aktuell = steerPrice({ ...ohne, currentCent: aktuell, percentBp: 2000,
                             rounding: 'euro', maxStepBp: 500 })
      verlauf.push(aktuell)
    }
    expect(verlauf).toEqual([10500, 11000, 11500, 12000, 12000, 12000])
  })

  it('kommt auch mit einer Schrittgrenze unter einem Rasterschritt voran', () => {
    // 1 % von 20 Euro sind 20 Cent -- weniger als ein Euro. Ohne Vorruecken
    // um einen Rasterwert bliebe der Preis fuer immer stehen.
    const n = steerPrice({ ...ohne, baseCent: 2000, currentCent: 2000, percentBp: 5000,
                           rounding: 'euro', maxStepBp: 100 })
    expect(n).toBe(2100)
  })
})
