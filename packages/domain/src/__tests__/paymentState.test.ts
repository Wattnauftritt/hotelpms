import { describe, it, expect } from 'vitest'
import { paymentState, type PaymentFigures } from '../paymentState.js'

/**
 * Der Zahlungsstand im Belegungsplan, als reine Regel.
 *
 * Die Faelle, um die es geht, sind die, in denen eine falsche Antwort
 * plausibel aussieht: eine frische Buchung ist nicht "bezahlt", nur weil
 * ihr Saldo null ist, und ein Gast, der die ersten zwei von fuenf Naechten
 * beglichen hat, ist es auch nicht.
 */

const leer: PaymentFigures = { chargedCent: 0, settledCent: 0, unpostedCent: 0, requestedCent: 0 }

describe('paymentState', () => {
  it('sagt nichts, solange weder gebucht noch gezahlt noch angefordert ist', () => {
    const s = paymentState({ ...leer, unpostedCent: 30_000 })
    expect(s.state).toBe('none')
    // Der erwartete Betrag steht trotzdem bereit -- fuer den Titel.
    expect(s.expectedCent).toBe(30_000)
    expect(s.balanceCent).toBe(0)
  })

  it('nennt eine frische Buchung mit Saldo null nicht bezahlt', () => {
    expect(paymentState({ ...leer, unpostedCent: 30_000 }).state).not.toBe('paid')
  })

  it('nennt gebuchte, unbezahlte Positionen offen', () => {
    expect(paymentState({ ...leer, chargedCent: 10_000, unpostedCent: 20_000 }).state)
      .toBe('open')
  })

  it('misst teilweise am ganzen Aufenthalt, nicht am Saldo von heute', () => {
    // Zwei Naechte gebucht und bezahlt, drei stehen noch aus: Saldo null,
    // aber nicht bezahlt.
    const s = paymentState({ ...leer, chargedCent: 20_000, settledCent: 20_000,
                             unpostedCent: 30_000 })
    expect(s.balanceCent).toBe(0)
    expect(s.state).toBe('partial')
  })

  it('nennt Geld vor der ersten Position eine Anzahlung', () => {
    expect(paymentState({ ...leer, settledCent: 10_000, unpostedCent: 30_000 }).state)
      .toBe('deposit')
  })

  it('nennt den gedeckten Aufenthalt bezahlt, auch vor der Anreise', () => {
    expect(paymentState({ ...leer, settledCent: 30_000, unpostedCent: 30_000 }).state)
      .toBe('paid')
  })

  it('faellt nach einer Minibar von bezahlt auf teilweise zurueck', () => {
    const vorher = paymentState({ ...leer, chargedCent: 30_000, settledCent: 30_000 })
    const nachher = paymentState({ ...leer, chargedCent: 30_450, settledCent: 30_000 })
    expect(vorher.state).toBe('paid')
    expect(nachher.state).toBe('partial')
    expect(nachher.balanceCent).toBe(450)
  })

  it('stellt einen offenen Zahlungslink vor die Teilzahlung', () => {
    expect(paymentState({ ...leer, settledCent: 10_000, unpostedCent: 30_000,
                          requestedCent: 20_000 }).state).toBe('requested')
  })

  it('laesst einen gedeckten Betrag vor dem offenen Link gelten', () => {
    expect(paymentState({ ...leer, settledCent: 30_000, unpostedCent: 30_000,
                          requestedCent: 30_000 }).state).toBe('paid')
  })

  it('zaehlt eine Erstattung nicht als Zahlung', () => {
    expect(paymentState({ ...leer, chargedCent: 10_000, settledCent: -2_000 }).state)
      .toBe('open')
  })

  it('rechnet in ganzen Cent ohne Rundung', () => {
    const s = paymentState({ chargedCent: 10_001, settledCent: 3_333,
                             unpostedCent: 6_667, requestedCent: 0 })
    expect(s.expectedCent).toBe(16_668)
    expect(s.balanceCent).toBe(6_668)
    expect(Number.isInteger(s.expectedCent)).toBe(true)
  })
})
