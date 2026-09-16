import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { auswahlZeitraum, gruppenAuswahl } from '../lib/tapeSelection.js'

/**
 * Was eine aufgezogene Auswahl im Belegungsplan bedeutet.
 *
 * Der Plan ist das Werkzeug, an dem die Rezeption den ganzen Tag sitzt, und
 * die Rechnerei dahinter ist die einzige Stelle, an der ein Fehler still
 * Geld kostet: aus Rasterindizes werden Kalenderdaten. Ein Tag daneben ist
 * eine Nacht zu viel auf der Rechnung und sieht im Plan genauso richtig aus
 * wie vorher.
 */

const TAGE = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']
const ZIMMER = [
  { id: 11, category_id: 1 },
  { id: 12, category_id: 1 },
  { id: 13, category_id: 2 },
  { id: 14, category_id: 2 }
]

describe('Zeitraum einer aufgezogenen Auswahl', () => {
  it('macht aus einem markierten Tag eine Nacht', () => {
    // Markiert ist der 1., also die Nacht vom 1. auf den 2.
    expect(auswahlZeitraum(TAGE, 0, 0))
      .toEqual({ arrival: '2026-10-01', departure: '2026-10-02' })
  })

  it('zaehlt die Abreise einen Tag hinter den letzten markierten', () => {
    // Am Abreisetag ist das Zimmer ab mittags wieder frei; ein Balken, der
    // bis in ihn hineinreicht, laesst ein verkaeufliches Zimmer belegt
    // aussehen.
    expect(auswahlZeitraum(TAGE, 0, 2))
      .toEqual({ arrival: '2026-10-01', departure: '2026-10-04' })
  })

  it('versteht Aufziehen von rechts nach links', () => {
    expect(auswahlZeitraum(TAGE, 2, 0)).toEqual(auswahlZeitraum(TAGE, 0, 2))
  })

  /**
   * Der Fehler, den diese Zeile verhindert: am rechten Rand gibt es den
   * Abreisetag im Raster nicht mehr. Wer ihn nachschlaegt statt ihn zu
   * rechnen, bekommt `undefined` -- oder, schlimmer, den letzten
   * sichtbaren Tag, und die Buchung endet eine Nacht zu frueh.
   */
  it('rechnet die Abreise am rechten Rand, statt sie nachzuschlagen', () => {
    expect(auswahlZeitraum(TAGE, 3, 3))
      .toEqual({ arrival: '2026-10-04', departure: '2026-10-05' })
  })
})

describe('Mehrfachauswahl wird eine Gruppe', () => {
  it('nimmt alle Zeilen zwischen Anfang und Ende', () => {
    const a = gruppenAuswahl(ZIMMER, TAGE, { startIndex: 0, index: 2, startDay: 0, day: 1 })
    expect(a.rooms).toEqual([
      { resourceId: 11, categoryId: 1 },
      { resourceId: 12, categoryId: 1 },
      { resourceId: 13, categoryId: 2 }
    ])
    expect(a).toMatchObject({ arrival: '2026-10-01', departure: '2026-10-03' })
  })

  it('versteht Aufziehen von unten nach oben', () => {
    const rauf = gruppenAuswahl(ZIMMER, TAGE, { startIndex: 3, index: 1, startDay: 1, day: 0 })
    const runter = gruppenAuswahl(ZIMMER, TAGE, { startIndex: 1, index: 3, startDay: 0, day: 1 })
    expect(rauf).toEqual(runter)
  })

  /**
   * Eine Gruppe liegt selten in einer Zimmergruppe: zwei Suiten, sechs
   * Doppelzimmer. Die Kategorie gehoert deshalb an jedes Zimmer, nicht
   * einmal an die Buchung.
   */
  it('behaelt die Zimmergruppe je Zimmer', () => {
    const a = gruppenAuswahl(ZIMMER, TAGE, { startIndex: 1, index: 2, startDay: 0, day: 0 })
    expect(a.rooms.map(r => r.categoryId)).toEqual([1, 2])
  })

  it('bleibt bei einer Zeile eine Auswahl aus einem Zimmer', () => {
    const a = gruppenAuswahl(ZIMMER, TAGE, { startIndex: 2, index: 2, startDay: 0, day: 0 })
    expect(a.rooms).toEqual([{ resourceId: 13, categoryId: 2 }])
  })
})

/**
 * Das Verschieben gab es lange und wurde nicht benutzt: der Zeiger blieb
 * ein Pfeil, und nichts am Balken sagte, dass er anfassbar ist. Eine
 * Funktion, die niemand findet, ist keine -- deshalb steht der Hinweis
 * hier als Test und nicht nur als Kommentar.
 */
describe('Die Gesten sind zu sehen', () => {
  const quelle = readFileSync(
    new URL('../components/TapeChart.tsx', import.meta.url), 'utf8')

  it('zeigt am Balken, dass er sich ziehen laesst', () => {
    expect(quelle).toContain('cursor-move')
  })

  it('zeigt auf freier Flaeche, dass sich dort aufziehen laesst', () => {
    expect(quelle).toContain('cursor-crosshair')
  })

  it('wertet die Modifikatortaste fuer die Mehrfachauswahl aus', () => {
    // Umschalt steht daneben, weil es auf jeder Tastatur dieselbe Taste
    // ist -- Strg und ⌘ sind es nicht.
    expect(quelle).toMatch(/e\.ctrlKey \|\| e\.metaKey \|\| e\.shiftKey/)
  })
})
