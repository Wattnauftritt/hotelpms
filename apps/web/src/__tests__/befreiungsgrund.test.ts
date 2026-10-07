import { describe, it, expect } from 'vitest'
import { avsKategorieAus, kuerzelAus } from '../lib/befreiungsgrund.js'

/**
 * Ein Kuerzel mit Grossbuchstaben liess den Speichern-Knopf grau, ohne zu
 * sagen warum, und das Haus legte keinen Befreiungsgrund an (Sven,
 * 06.10.2026). Geprueft wird, dass aus jeder ueblichen Eingabe ein Kuerzel
 * wird, das die Datenbank annimmt.
 */
describe('Kuerzel eines Befreiungsgrunds', () => {
  it('schreibt klein und Umlaute aus', () => {
    expect(kuerzelAus('Behinderung')).toBe('behinderung')
    expect(kuerzelAus('Nur Übernachtungsteuer')).toBe('nur_uebernachtungsteuer')
    expect(kuerzelAus('Großeltern')).toBe('grosseltern')
  })

  it('macht aus einer Bezeichnung ein gueltiges Kuerzel', () => {
    expect(kuerzelAus('100% Behinderung')).toBe('100_behinderung')
    expect(kuerzelAus('Begleitperson (Merkzeichen B)')).toBe('begleitperson_merkzeichen_b')
    expect(kuerzelAus('  Jahres-Kurkarte ')).toBe('jahres_kurkarte')
    expect(kuerzelAus('Café')).toBe('cafe')
  })

  it('bleibt innerhalb von 40 Zeichen und endet nicht auf Unterstrich', () => {
    const k = kuerzelAus('a'.repeat(39) + ' b c')
    expect(k.length).toBeLessThanOrEqual(40)
    expect(k).toMatch(/^[a-z0-9_]{1,40}$/)
    expect(k.endsWith('_')).toBe(false)
  })

  it('ist leer, wenn nichts Brauchbares bleibt', () => {
    expect(kuerzelAus('%%%')).toBe('')
  })
})

describe('AVS-Kategorie', () => {
  it('nimmt leer als keine und 1 bis 99', () => {
    expect(avsKategorieAus('')).toBeNull()
    expect(avsKategorieAus(' 4 ')).toBe(4)
    expect(avsKategorieAus('0')).toBe('ungueltig')
    expect(avsKategorieAus('100')).toBe('ungueltig')
    expect(avsKategorieAus('2,5')).toBe('ungueltig')
  })
})
