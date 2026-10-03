import { describe, it, expect } from 'vitest'
import type { SetupStatus } from '@hotelpms/contracts'
import { hausIstLeer, nutzlast, zeilenLuecken, zimmerNummern,
         type ArtZeile } from '../lib/ersteSchritte.js'

/**
 * Erste Schritte. Geprueft werden die beiden Stellen, an denen ein Fehler
 * nicht wie einer aussieht: wann der Assistent von selbst erscheint, und wie
 * aus der Maske die Nutzlast wird -- vor allem der Preis.
 */

const stand = (zahlen: Record<string, number>): SetupStatus => ({
  bookable: false, complete: false, nextStep: null,
  steps: Object.entries(zahlen).map(([key, count]) => ({
    key, done: count > 0, count, label: key, labelKey: key, hint: '', hintKey: '' }))
} as SetupStatus)

const zeile = (teil: Partial<ArtZeile> = {}): ArtZeile => ({
  code: 'DZ', name: 'Doppelzimmer', personen: 2, anzahl: 3, ab: 201, vorsatz: '',
  preis: '', ...teil })

describe('Wann der Assistent erscheint', () => {
  it('nur im leeren Haus, nicht in einem, dem bloss der Bestand fehlt', () => {
    expect(hausIstLeer(stand({ categories: 0, rooms: 0, rate_plans: 0 }))).toBe(true)
    // Wer schon Zimmer angelegt hat, bekommt keinen Assistenten mehr, der
    // alles von vorn anlegen will -- die Luecken zeigt der Einrichtungsstand.
    expect(hausIstLeer(stand({ categories: 2, rooms: 0 }))).toBe(false)
    expect(hausIstLeer(stand({ categories: 2, rooms: 12, rate_plans: 0 }))).toBe(false)
  })
})

describe('Nutzlast der ersten Einrichtung', () => {
  it('schickt den Preis in Cent, nicht in Euro', () => {
    const b = nutzlast(7, [zeile({ preis: '129,50' })], 'Standardpreis', true, false)
    expect(b.categories[0]!.priceCent).toBe(12950)
    expect(b.ratePlanName).toBe('Standardpreis')
    expect(b.commit).toBe(false)
  })

  it('laesst den Preis weg, wenn das Feld leer ist oder das Recht fehlt', () => {
    expect(nutzlast(7, [zeile()], '', true, true).categories[0]).not.toHaveProperty('priceCent')
    // Ohne rate:write wiese die Schnittstelle sonst die ganze Einrichtung ab.
    expect(nutzlast(7, [zeile({ preis: '99' })], '', false, true).categories[0])
      .not.toHaveProperty('priceCent')
  })

  it('bildet die Nummern so, wie die Schnittstelle sie anlegt', () => {
    expect(zimmerNummern(zeile())).toEqual(['201', '202', '203'])
    expect(zimmerNummern(zeile({ vorsatz: 'App ', ab: 1, anzahl: 2 })))
      .toEqual(['App 1', 'App 2'])
    expect(nutzlast(7, [zeile({ vorsatz: 'App ' })], '', true, false).categories[0]!.rooms)
      .toEqual({ prefix: 'App ', from: 201, count: 3 })
  })

  it('meldet unvollstaendige Zeilen und einen Preis, der keine Zahl ist', () => {
    expect(zeilenLuecken([zeile(), zeile({ name: ' ' }), zeile({ preis: 'zehn' })]))
      .toEqual([1, 2])
  })
})
