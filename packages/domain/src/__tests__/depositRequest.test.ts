import { describe, it, expect } from 'vitest'
import { depositFromPercent, depositRequestState, depositRequestOpenCent,
         type DepositRequestFacts } from '../depositRequest.js'

/**
 * Betrag und Zustand einer Anzahlungsanforderung.
 *
 * Beides rechnet die API beim Festschreiben und die Oberflaeche beim Tippen
 * mit derselben Funktion. Was hier steht, gilt deshalb fuer beide.
 */

describe('Anzahlung in Prozent', () => {
  it('rundet ab, auf den ganzen Cent', () => {
    // 30 % von 333,33 EUR sind 99,999 -- gefordert werden 99,99.
    expect(depositFromPercent(33_333, 3_000)).toBe(9_999)
    // Ohne Rest bleibt es genau.
    expect(depositFromPercent(30_000, 3_000)).toBe(9_000)
    // 12,5 % in Basispunkten.
    expect(depositFromPercent(10_001, 1_250)).toBe(1_250)
  })

  it('fordert bei 100 Prozent genau den Aufenthalt, nie mehr', () => {
    for (const preis of [1, 99, 33_333, 123_457, 9_999_999]) {
      expect(depositFromPercent(preis, 10_000)).toBe(preis)
    }
  })

  it('ueberschreitet den vereinbarten Anteil fuer keinen Preis', () => {
    // Die Eigenschaft, um die es bei der Rundung geht: die Forderung liegt
    // nie ueber Preis mal Satz. Ganzzahlig geprueft, ohne Fliesskomma.
    for (let preis = 1; preis < 5_000; preis += 7) {
      for (const bp of [1, 333, 1_000, 2_500, 3_333, 5_000, 9_999]) {
        const betrag = depositFromPercent(preis, bp)
        expect(betrag * 10_000).toBeLessThanOrEqual(preis * bp)
        expect((betrag + 1) * 10_000).toBeGreaterThan(preis * bp)
      }
    }
  })

  it('gibt fuer Unsinn null zurueck statt einer Zahl, die nach etwas aussieht', () => {
    expect(depositFromPercent(0, 3_000)).toBe(0)
    expect(depositFromPercent(10_000, 0)).toBe(0)
    expect(depositFromPercent(10_000, 10_001)).toBe(0)
    expect(depositFromPercent(10_000, 30.5)).toBe(0)
    expect(depositFromPercent(100.5, 3_000)).toBe(0)
  })
})

describe('Zustand einer Anforderung', () => {
  const basis: DepositRequestFacts = {
    amountCent: 10_000, receivedCent: 0, dueDate: '2026-10-05',
    businessDate: '2026-10-01', openLink: false, canceled: false
  }

  it('ist am Faelligkeitstag noch nicht ueberfaellig, am Tag danach schon', () => {
    expect(depositRequestState({ ...basis, businessDate: '2026-10-05' })).toBe('requested')
    expect(depositRequestState({ ...basis, businessDate: '2026-10-06' })).toBe('overdue')
    // Ueber einen Monatswechsel als Zeichenkette verglichen, ohne Date.
    expect(depositRequestState({ ...basis, dueDate: '2026-09-30',
                                 businessDate: '2026-10-01' })).toBe('overdue')
  })

  it('folgt der Reihenfolge zurueckgezogen, bezahlt, ueberfaellig, teilweise, Link', () => {
    expect(depositRequestState({ ...basis, openLink: true })).toBe('link_sent')
    expect(depositRequestState({ ...basis, receivedCent: 4_000, openLink: true }))
      .toBe('partial')
    expect(depositRequestState({ ...basis, receivedCent: 4_000,
                                 businessDate: '2026-10-06' })).toBe('overdue')
    expect(depositRequestState({ ...basis, receivedCent: 10_000,
                                 businessDate: '2026-10-06' })).toBe('received')
    // Mehr als gefordert ist bezahlt, nicht "minus offen".
    expect(depositRequestState({ ...basis, receivedCent: 12_000 })).toBe('received')
    expect(depositRequestOpenCent(10_000, 12_000)).toBe(0)
    expect(depositRequestState({ ...basis, canceled: true,
                                 businessDate: '2026-10-06' })).toBe('canceled')
  })
})
