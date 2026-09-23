import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { preisFelder, abgeleitet, alsGesamt, LEERER_PREIS } from '../lib/preisEingabe.js'

/**
 * Zwei Felder fuer einen Preis: je Nacht **oder** insgesamt.
 *
 * Verhandelt wird mal so, mal so -- ein Einzelgast hoert "89 die Nacht",
 * eine Gruppe vereinbart "2.400 fuer alles". Wer nur eines der beiden
 * Felder anbietet, laesst die Rezeption im Kopf dividieren, und genau dort
 * entsteht der Betrag, der neben der Zusage liegt.
 *
 * Geprueft wird die Rechnung, nicht die Darstellung: welcher der beiden
 * Betraege hinausgeht, und ob der angezeigte andere stimmt.
 */
describe('Preis je Nacht und Gesamtpreis', () => {
  it('schickt nur das Feld, in das getippt wurde', () => {
    expect(preisFelder({ modus: 'nacht', text: '89,00' })).toEqual({ priceCent: 8900 })
    expect(preisFelder({ modus: 'gesamt', text: '267,00' })).toEqual({ totalCent: 26_700 })
  })

  it('schickt gar nichts, wenn nichts dasteht', () => {
    // Leer heisst "kein Preis vereinbart" -- dann gilt der Ratenplan. Das
    // ist etwas anderes als null Euro.
    expect(preisFelder(LEERER_PREIS)).toBeNull()
    expect(preisFelder({ modus: 'gesamt', text: '   ' })).toBeNull()
  })

  it('rechnet den Tausenderpunkt richtig, nicht als Dezimaltrenner', () => {
    /*
     * Der alte Weg war `Number(text.replace(',', '.')) * 100`. Aus
     * "1.234,50" wurde damit `Number('1.234.50')`, also `NaN` -- und an
     * einer deutschen Rezeption wird der Tausenderpunkt getippt.
     */
    expect(preisFelder({ modus: 'gesamt', text: '1.234,50' })).toEqual({ totalCent: 123_450 })
  })

  it('rechnet vom Preis je Nacht auf den Gesamtpreis', () => {
    expect(abgeleitet({ modus: 'nacht', text: '89,00' }, 3))
      .toEqual({ text: '267,00', restCent: 0 })
  })

  it('zeigt beim Weg zurueck die erste Nacht, nicht den abgerundeten Wert', () => {
    /*
     * 100,00 EUR auf drei Naechte sind 33,34 / 33,33 / 33,33. Das
     * abgerundete 33,33 anzuzeigen waere um einen Cent falsch, und zwar an
     * genau der Zeile, die oben auf dem Beleg steht.
     */
    expect(abgeleitet({ modus: 'gesamt', text: '100,00' }, 3))
      .toEqual({ text: '33,34', restCent: 1 })
  })

  it('legt den ganzen Rest auf die erste Nacht, nicht einen Cent davon', () => {
    // 1.000,01 EUR auf drei Naechte: 333,35 / 333,33 / 333,33. Genau so
    // teilt `preisJeNacht` auf dem Server.
    expect(abgeleitet({ modus: 'gesamt', text: '1000,01' }, 3))
      .toEqual({ text: '333,35', restCent: 2 })
  })

  it('bleibt stumm, solange der Zeitraum keine Nacht hat', () => {
    expect(abgeleitet({ modus: 'nacht', text: '89,00' }, 0))
      .toEqual({ text: '', restCent: 0 })
  })

  it('macht aus einem Preis je Nacht den Gesamtpreis eines Zimmers', () => {
    // Der Vertrag kennt je Zimmer nur `totalCent`. Multiplizieren und auf
    // dem Server wieder teilen geht in dieser Reihenfolge ohne Rest auf.
    expect(alsGesamt({ modus: 'nacht', text: '80,00' }, 3)).toBe(24_000)
    expect(alsGesamt({ modus: 'gesamt', text: '240,00' }, 3)).toBe(24_000)
    expect(alsGesamt(LEERER_PREIS, 3)).toBeUndefined()
  })
})

/**
 * Die Masken selbst: geprueft wird, dass sie genau **ein** Feld schicken.
 * Beide zugleich weist die Schnittstelle ab -- zwei Preise fuer dieselbe
 * Buchung sind keine Angabe, sondern eine Frage.
 */
describe('Die Masken schicken einen Preis, nicht zwei', () => {
  const einzeln = readFileSync(
    new URL('../components/BookingDialog.tsx', import.meta.url), 'utf8')
  const gruppe = readFileSync(
    new URL('../components/GroupBookingDialog.tsx', import.meta.url), 'utf8')

  it('setzt in der Reservierungsmaske genau das getippte Feld', () => {
    expect(einzeln).toContain('...preisFelder(preis)')
    // Der alte Weg ueber Fliesskomma ist weg, nicht nur ueberdeckt.
    expect(einzeln).not.toContain("Number(preis.replace(',', '.'))")
  })

  it('laesst in der Gruppenmaske zwischen Gruppen- und Zimmerpreis waehlen', () => {
    expect(gruppe).toContain('...(jeZimmer ? {} : preisFelder(gruppenPreis))')
    expect(gruppe).toContain('totalCent: jeZimmer')
  })

  it('schickt die Aufteilung nicht mit, sondern nur den Gruppenpreis', () => {
    /*
     * Die Maske **zeigt** seit der Preisvorschau, was aus einem
     * Gruppenpreis je Zimmer wird -- geschickt wird er trotzdem als
     * Gruppenpreis. Geteilt wird auf dem Server, ein einziges Mal; sonst
     * gaebe es zwei Stellen, an denen der Rest-Cent liegen kann, und der
     * Unterschied fiele erst auf, wenn Vorschau und Rechnung
     * nebeneinanderliegen.
     */
    expect(gruppe).toContain('totalCent: jeZimmer')
    expect(gruppe).not.toContain('gruppeAufteilen')
    expect(einzeln).not.toContain('preisJeNacht')
  })

  it('rechnet die Vorschau mit der Funktion des Servers', () => {
    // Eine eigene Fassung hier waere die naheliegende und die teure
    // Loesung: sie laege bei jedem Betrag, der nicht glatt aufgeht, einen
    // Cent neben dem Ergebnis.
    const vorschau = readFileSync(
      new URL('../lib/gruppenPreis.ts', import.meta.url), 'utf8')
    expect(vorschau).toContain("from '@hotelpms/domain/groupPrice'")
  })
})
