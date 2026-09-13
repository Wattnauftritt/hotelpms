import { describe, it, expect } from 'vitest'
import { today, addDays, daysBetween, eachDay, isWeekend } from '../lib/dates.js'
import { formatMoney, formatDate, weekdayShort } from '../lib/i18n.js'

/**
 * Geprueft wird hier die Logik, bei der ein Fehler echtes Geld oder echte
 * Zimmer kostet: Datumsrechnung und Geldanzeige. Die Darstellung selbst
 * wird nicht getestet; ein Test, der prueft, dass ein Kasten blau ist,
 * bricht bei jeder Gestaltungsaenderung und faengt nie einen Fehler.
 */

describe('Kalenderdaten', () => {
  it('rechnet ueber Monats- und Jahresgrenzen', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  })

  /**
   * Der Fehler, den diese Zeile verhindert: `new Date('2026-03-29')` ist
   * Mitternacht UTC, und in Europa/Berlin ist das an dem Tag 01:00 vor der
   * Umstellung. Wer mit Ortszeit rechnet, verliert oder gewinnt hier einen
   * Tag, und eine Reservierung verschiebt sich lautlos.
   */
  it('haelt die Sommerzeitumstellung aus', () => {
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29')
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30')
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2)
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25')
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
  })

  it('zaehlt Naechte, nicht Tage', () => {
    // Anreise 1., Abreise 4.: drei Naechte.
    expect(daysBetween('2026-10-01', '2026-10-04')).toBe(3)
    expect(eachDay('2026-10-01', '2026-10-04'))
      .toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
  })

  it('erkennt das Wochenende in UTC, nicht in der Ortszeit', () => {
    expect(isWeekend('2026-10-03')).toBe(true)   // Samstag
    expect(isWeekend('2026-10-04')).toBe(true)   // Sonntag
    expect(isWeekend('2026-10-05')).toBe(false)  // Montag
  })

  it('liefert heute im selben Format', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('Anzeige', () => {
  it('zeigt Cent als Betrag der jeweiligen Sprache', () => {
    // Nicht auf das Trennzeichen festnageln: Intl aendert es zwischen
    // Node-Fassungen. Geprueft wird, dass aus Cent Euro werden.
    expect(formatMoney(11_770, 'de')).toContain('117,70')
    expect(formatMoney(11_770, 'en')).toContain('117.70')
    expect(formatMoney(0, 'de')).toContain('0,00')
    expect(formatMoney(-5_000, 'de')).toContain('50,00')
  })

  it('stellt Datum sprachgerecht dar, ohne es zu verschieben', () => {
    expect(formatDate('2026-10-01', 'de')).toBe('01.10.2026')
    expect(formatDate('2026-10-01', 'en')).toBe('2026-10-01')
    // Auch der 1. Januar bleibt der 1. Januar, egal in welcher Zeitzone
    // der Browser steht.
    expect(formatDate('2026-01-01', 'de')).toBe('01.01.2026')
  })

  it('benennt den Wochentag in beiden Sprachen', () => {
    expect(weekdayShort('2026-10-05', 'de')).toMatch(/Mo/)
    expect(weekdayShort('2026-10-05', 'en')).toMatch(/Mon/)
  })
})
