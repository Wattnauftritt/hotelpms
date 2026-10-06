import { describe, it, expect } from 'vitest'
import { splitGuestBooking, signedAmount, cashbookTaxGroups } from '../cashbook.js'

/*
 * Die Werte sind mit der Rechnung des Adminpanels nachgerechnet
 * (TaxCalculationService, round(..., 2, HALF_UP)). Weicht eine Zeile ab,
 * stimmt nach der Uebernahme der Monat nicht mehr.
 */
describe('Gastbuchung im Kassenbuch', () => {
  const haus = { breakfastPriceCent: 550, breakfastFoodShareBp: 7000 }

  it('zerlegt Gesamtpreis mit Fruehstueck und Kurtaxe wie das Adminpanel', () => {
    expect(splitGuestBooking({ ...haus, totalCent: 10_000, breakfasts: 2, cityTaxCent: 600 }))
      .toEqual([
        { kind: 'lodging', amountCent: 8_900, taxRateBp: 700 },
        { kind: 'breakfast_food', amountCent: 770, taxRateBp: 700 },
        { kind: 'breakfast_drinks', amountCent: 330, taxRateBp: 1900 },
        { kind: 'city_tax', amountCent: 600, taxRateBp: 700 }
      ])
  })

  it('rundet Speisen und Getraenke je fuer sich kaufmaennisch', () => {
    // 3 x 5,55 = 16,65; 70 % = 11,655 -> 11,66; 30 % = 4,995 -> 5,00
    const z = splitGuestBooking({ breakfastPriceCent: 555, breakfastFoodShareBp: 7000,
      totalCent: 5_000, breakfasts: 3, cityTaxCent: 0 })
    expect(z.map(l => l.amountCent)).toEqual([3_334, 1_166, 500])
  })

  it('laesst Zeilen mit null weg und die Uebernachtung nie negativ werden', () => {
    expect(splitGuestBooking({ ...haus, totalCent: 0, breakfasts: 0, cityTaxCent: 300 }))
      .toEqual([{ kind: 'city_tax', amountCent: 300, taxRateBp: 700 }])
    const nurFruehstueck = splitGuestBooking({ ...haus, totalCent: 500, breakfasts: 2, cityTaxCent: 0 })
    expect(nurFruehstueck.find(l => l.kind === 'lodging')).toBeUndefined()
  })
})

describe('Vorzeichen einer Einzelbuchung', () => {
  it('fuehrt Ausgabe und Bankeinzahlung als Abgang, Einlage und Kurtaxe als Zugang', () => {
    expect(signedAmount('expense', 1_250)).toBe(-1_250)
    expect(signedAmount('bank_deposit', 50_000)).toBe(-50_000)
    expect(signedAmount('cash_in', -2_000)).toBe(2_000)
    expect(signedAmount('city_tax', 300)).toBe(300)
    expect(signedAmount('other', -99)).toBe(-99)
  })
})

describe('Steuer je Satzgruppe', () => {
  it('rechnet aus der Summe der Gruppe, nicht aus gerundeten Zeilen', () => {
    // Je Zeile: 1,00 brutto bei 19 % = 0,16 Steuer, dreimal 0,48.
    // Aus der Summe: 3,00 -> 0,48 ... und 7 x 0,10 bei 7 %: je Zeile 0,01
    // (0,0065 -> 0,01), sieben Zeilen 0,07; aus der Summe 0,70 -> 0,05.
    const g = cashbookTaxGroups(Array.from({ length: 7 }, () => ({ amountCent: 10, taxRateBp: 700 })))
    expect(g).toEqual([{ rateBp: 700, grossCent: 70, netCent: 65, taxCent: 5 }])
  })
})
