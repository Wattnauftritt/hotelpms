import { describe, it, expect } from 'vitest'
import type { RateGridCell } from '@hotelpms/contracts'
import { centAusEingabe, eingabeAusCent, wochentagIndex, betroffeneTage,
         preisVorschau, preisNutzlast, restriktionsNutzlast,
         restriktionsZeichen, wochentagKuerzel } from '../lib/preisraster.js'
import { tageInklusive } from '../lib/queries/rates.js'
import { SCREENS, visibleScreens } from '../screens.js'

/**
 * Geprüft wird, wo ein Fehler Geld kostet: die Umrechnung einer Eingabe in
 * ganze Cent, die Auswahl der betroffenen Tage und die Nutzlast, die zur
 * API geht. Ein Preis, der um einen Cent danebenliegt, oder ein Zeitraum,
 * der einen Tag zu kurz ist, fällt sonst erst auf, wenn die ersten
 * Buchungen zum falschen Preis hereinkommen — und rückwirkend ändern geht
 * nicht.
 */

describe('Geld aus einer Eingabe', () => {
  it('rechnet auf den Ziffern, nicht über Fließkomma', () => {
    expect(centAusEingabe('89,95')).toBe(8_995)
    expect(centAusEingabe('89.95')).toBe(8_995)
    // parseFloat('89.95') * 100 ist 8994.999999999999.
    expect(centAusEingabe('89.95')).not.toBe(Math.round(parseFloat('89.95') * 100) - 1)
    expect(centAusEingabe('0,05')).toBe(5)
    expect(centAusEingabe('120')).toBe(12_000)
    expect(centAusEingabe('7,5')).toBe(750)
  })

  it('nimmt Komma und Punkt, und den Tausenderpunkt nur eindeutig', () => {
    expect(centAusEingabe('1.234,56')).toBe(123_456)
    expect(centAusEingabe('1,234.56')).toBe(123_456)
    expect(centAusEingabe(' 99,00 €')).toBe(9_900)
    // Ein einzelner Punkt ist der Dezimaltrenner. „1.234" waere damit 1,234
    // und ist keine gueltige Eingabe -- besser abgewiesen als still als
    // 1234 Euro gelesen.
    expect(centAusEingabe('1.234')).toBeNull()
  })

  it('weist ab, was kein Preis ist', () => {
    expect(centAusEingabe('')).toBeNull()
    expect(centAusEingabe('   ')).toBeNull()
    expect(centAusEingabe('abc')).toBeNull()
    expect(centAusEingabe('-5,00')).toBeNull()
    expect(centAusEingabe('1,2,3')).toBeNull()
  })

  it('zeigt Cent wieder als Eingabetext', () => {
    expect(eingabeAusCent(8_995)).toBe('89,95')
    expect(eingabeAusCent(5)).toBe('0,05')
    expect(eingabeAusCent(12_000)).toBe('120,00')
    // Was hinausgeht, kommt unveraendert zurueck.
    expect(centAusEingabe(eingabeAusCent(123_456))).toBe(123_456)
  })
})

describe('Tage des Rasters', () => {
  /**
   * Der Unterschied zu `eachDay`: ein Preisraster zählt Tage, kein
   * Aufenthalt Nächte. Der letzte Tag trägt einen Preis und darf nicht
   * fehlen — sonst steht an Silvester nichts.
   */
  it('zählt den letzten Tag mit', () => {
    expect(tageInklusive('2026-12-29', '2026-12-31'))
      .toEqual(['2026-12-29', '2026-12-30', '2026-12-31'])
    expect(tageInklusive('2026-10-01', '2026-10-01')).toEqual(['2026-10-01'])
  })

  it('läuft über die Zeitumstellung, ohne einen Tag zu verlieren', () => {
    expect(tageInklusive('2026-03-28', '2026-03-30'))
      .toEqual(['2026-03-28', '2026-03-29', '2026-03-30'])
    expect(tageInklusive('2026-10-24', '2026-10-26'))
      .toEqual(['2026-10-24', '2026-10-25', '2026-10-26'])
  })

  it('trägt ein ganzes Jahr', () => {
    expect(tageInklusive('2026-01-01', '2026-12-31')).toHaveLength(365)
  })
})

describe('Wochentage', () => {
  it('zählt Montag als null, wie die API', () => {
    // 5. Januar 2026 ist ein Montag.
    expect(wochentagIndex('2026-01-05')).toBe(0)
    expect(wochentagIndex('2026-01-10')).toBe(5)   // Samstag
    expect(wochentagIndex('2026-01-11')).toBe(6)   // Sonntag
  })

  /**
   * Die Kürzel werden aus einer bekannten Woche gebaut, und beim
   * Zusammensetzen des Datums ist genau das schiefgegangen, was dieser
   * Test festhält: mit einer führenden Null im Textbaustein wird aus Index
   * 5 der „2026-01-010", ein ungültiges Datum, und `Intl` wirft darauf.
   * Der Bildschirm stürzte beim ersten Klick ab — an Typprüfung, Lint und
   * den übrigen Tests vorbei.
   */
  it('hat für jeden der sieben Tage ein Kürzel', () => {
    const de = [0, 1, 2, 3, 4, 5, 6].map(i => wochentagKuerzel(i, 'de'))
    expect(de).toHaveLength(7)
    for (const k of de) expect(k).not.toMatch(/Invalid/i)
    expect(de[0]).toMatch(/^Mo/)
    expect(de[6]).toMatch(/^So/)
    expect(wochentagKuerzel(6, 'en')).toMatch(/^Sun/)
    // Jeder Tag ein eigenes Kuerzel: waere einer falsch gerechnet, staenden
    // zwei gleiche nebeneinander.
    expect(new Set(de).size).toBe(7)
  })

  /**
   * Der Grund, warum die Vorschau gebraucht wird: „alle Freitage und
   * Samstage" sind aus 92 Sommertagen 26 und nicht 92. Wer das nicht
   * sieht, ändert 92.
   */
  it('filtert den Zeitraum auf die gewählten Tage', () => {
    const sommer = tageInklusive('2026-06-01', '2026-08-31')
    expect(sommer).toHaveLength(92)
    expect(betroffeneTage(sommer, [4, 5])).toHaveLength(26)
    expect(betroffeneTage(sommer, [0, 1, 2, 3, 4, 5, 6])).toHaveLength(92)
    expect(betroffeneTage(sommer, null)).toHaveLength(92)
    expect(betroffeneTage(sommer, [])).toHaveLength(0)
  })
})

const zelle = (
  ratePlanId: number, date: string, priceCent: number[] | null,
  extra: Partial<RateGridCell> = {}
): RateGridCell => ({
  ratePlanId, ratePlanCode: 'STD', date, priceCent,
  minLos: null, maxLos: null, closed: false,
  closedToArrival: false, closedToDeparture: false, ...extra
})

describe('Vorschau', () => {
  it('zählt, was sich wirklich ändert', () => {
    const tage = ['2026-06-01', '2026-06-02', '2026-06-03']
    const zellen = [
      zelle(1, '2026-06-01', [8_000, 9_000]),
      zelle(1, '2026-06-02', [7_000, 9_000]),
      zelle(1, '2026-06-03', null)
    ]
    const v = preisVorschau(tage, zellen, 1, [8_000, 9_000])
    expect(v.tage).toBe(3)
    expect(v.unveraendert).toBe(1)
    expect(v.geaendert).toBe(2)
    expect(v.erster).toBe('2026-06-01')
    expect(v.letzter).toBe('2026-06-03')
  })

  it('sieht nur den eigenen Ratenplan an', () => {
    const zellen = [
      zelle(1, '2026-06-01', [8_000]),
      zelle(2, '2026-06-01', [9_999])
    ]
    expect(preisVorschau(['2026-06-01'], zellen, 2, [9_999]).unveraendert).toBe(1)
    expect(preisVorschau(['2026-06-01'], zellen, 2, [8_000]).unveraendert).toBe(0)
  })

  /**
   * Ein Tag ohne gepflegten Preis ist nicht ein Tag mit null Euro. Wer das
   * verwechselt, hält eine Massenänderung für wirkungslos und lässt sie
   * weg.
   */
  it('behandelt einen ungepflegten Tag als Änderung', () => {
    const v = preisVorschau(['2026-06-03'], [zelle(1, '2026-06-03', null)], 1, [0])
    expect(v.geaendert).toBe(1)
  })

  it('unterscheidet Preisvektoren verschiedener Länge', () => {
    const zellen = [zelle(1, '2026-06-01', [8_000])]
    expect(preisVorschau(['2026-06-01'], zellen, 1, [8_000, 9_000]).geaendert).toBe(1)
  })
})

describe('Nutzlast an die API', () => {
  const basis = {
    propertyId: 7, ratePlanId: 3, from: '2026-06-01', to: '2026-08-31'
  }

  /**
   * Alle Tage heißt für die API „ohne Angabe". Eine Liste mit allen sieben
   * wäre dasselbe, aber eine **leere** Liste hieße „keine" — und dann
   * schriebe ein Aufruf nichts, ohne dass jemand einen Fehler sieht.
   */
  it('lässt den Wochentagsfilter weg, wenn er alle Tage umfasst', () => {
    const alle = preisNutzlast({
      ...basis, weekdays: [0, 1, 2, 3, 4, 5, 6], priceCent: [8_000] })
    expect(alle).not.toHaveProperty('weekdays')
    expect(preisNutzlast({ ...basis, weekdays: null, priceCent: [8_000] }))
      .not.toHaveProperty('weekdays')
  })

  it('schickt den Filter mit, wenn er einschränkt', () => {
    expect(preisNutzlast({ ...basis, weekdays: [4, 5], priceCent: [8_000] }))
      .toEqual({ ...basis, weekdays: [4, 5], priceCent: [8_000] })
  })

  /**
   * Der Aufruf ersetzt den **ganzen** Preisvektor des Tages. Wer nur die
   * zweite Stufe schickte, löschte die erste — deshalb trägt die Maske
   * alle Stufen und die Nutzlast auch.
   */
  it('trägt alle Belegungsstufen', () => {
    const n = preisNutzlast({
      ...basis, weekdays: null, priceCent: [7_000, 9_000, 11_000] })
    expect(n.priceCent).toEqual([7_000, 9_000, 11_000])
  })

  it('schickt eine nicht gesetzte Grenze ausdrücklich als null', () => {
    const n = restriktionsNutzlast({
      ...basis, weekdays: null, minLos: 2, maxLos: null,
      closed: false, closedToArrival: true, closedToDeparture: false })
    expect(n).toEqual({
      ...basis, minLos: 2, maxLos: null,
      closed: false, closedToArrival: true, closedToDeparture: false })
  })
})

describe('Restriktionen am Raster', () => {
  it('zeigt an der Zelle, was gilt', () => {
    expect(restriktionsZeichen(zelle(1, '2026-06-01', null))).toBe('')
    expect(restriktionsZeichen(zelle(1, '2026-06-01', null, { closed: true }))).toBe('G')
    expect(restriktionsZeichen(zelle(1, '2026-06-01', null,
      { closedToArrival: true, minLos: 3 }))).toBe('A3')
    // Ein Mindestaufenthalt von einer Nacht ist keine Einschraenkung und
    // waere als Zeichen nur Rauschen.
    expect(restriktionsZeichen(zelle(1, '2026-06-01', null, { minLos: 1 }))).toBe('')
  })
})

describe('Der Bildschirm im Verzeichnis', () => {
  it('haengt am Leserecht für Raten', () => {
    const eintrag = SCREENS.find(s => s.key === 'rates')
    expect(eintrag?.permission).toBe('rate:read')
  })

  /**
   * Ein Konto, das keine Preise sehen darf, sieht den Eintrag nicht — statt
   * ihn zu sehen, zu klicken und eine 403 zu bekommen.
   */
  it('bleibt einem Housekeeping-Konto verborgen', () => {
    expect(visibleScreens(['housekeeping:read']).map(s => s.key)).not.toContain('rates')
    expect(visibleScreens(['rate:read']).map(s => s.key)).toContain('rates')
  })
})
