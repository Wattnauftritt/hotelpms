import { describe, it, expect } from 'vitest'
import { folderNameMatches } from '../folderUnlock.js'

/**
 * Welche Namensteile die Gaestemappe oeffnen (Audit 19.10., M4): Teile erst
 * ab vier Zeichen und nie ein Partikel, der ganze Nachname aber auch kurz.
 */
describe('folderNameMatches', () => {
  it('oeffnet nicht mit einem Partikel oder Namenszusatz', () => {
    expect(folderNameMatches('von', ['von Hohenberg'])).toBe(false)
    expect(folderNameMatches('van', ['van der Berg'])).toBe(false)
    expect(folderNameMatches('der', ['van der Berg'])).toBe(false)
    expect(folderNameMatches('de', ['De la Cruz'])).toBe(false)
    expect(folderNameMatches('la', ['De la Cruz'])).toBe(false)
    expect(folderNameMatches('da', ['Da Silva'])).toBe(false)
    expect(folderNameMatches('al', ['Al-Masri'])).toBe(false)
    expect(folderNameMatches('zu', ['zu Guttenberg'])).toBe(false)
    expect(folderNameMatches('dos', ['dos Santos'])).toBe(false)
    expect(folderNameMatches('della', ['della Valle'])).toBe(false)
    expect(folderNameMatches('freiherr', ['Freiherr von Hohenberg'])).toBe(false)
    expect(folderNameMatches('Gräfin', ['Gräfin von Berg'])).toBe(false)
  })

  it('oeffnet nicht mit einem Teil unter vier Zeichen', () => {
    expect(folderNameMatches('ng', ['Ng-Müller'])).toBe(false)
    expect(folderNameMatches('kim', ['Kim Schulte'])).toBe(false)
  })

  it('oeffnet mit dem ganzen Nachnamen, auch wenn er kurz ist', () => {
    expect(folderNameMatches('Li', ['Li'])).toBe(true)
    expect(folderNameMatches('ng', ['Ng'])).toBe(true)
    expect(folderNameMatches('Öz', ['Oz'])).toBe(true)
    expect(folderNameMatches('de', ['De'])).toBe(true)
    expect(folderNameMatches('von hohenberg', ['von Hohenberg'])).toBe(true)
    expect(folderNameMatches('ng muller', ['Ng-Müller'])).toBe(true)
  })

  it('oeffnet mit einem Teil ab vier Zeichen, der kein Partikel ist', () => {
    expect(folderNameMatches('Hohenberg', ['von Hohenberg'])).toBe(true)
    expect(folderNameMatches('cruz', ['De la Cruz'])).toBe(true)
    expect(folderNameMatches('silva', ['Da Silva'])).toBe(true)
    expect(folderNameMatches('masri', ['Al-Masri'])).toBe(true)
    expect(folderNameMatches('hansen', ['Schmidt-Hansen'])).toBe(true)
    expect(folderNameMatches('Sch', ['Schmidt'])).toBe(false)
  })
})
