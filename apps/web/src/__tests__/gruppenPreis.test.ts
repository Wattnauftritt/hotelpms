import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { gruppenpreisJeZimmer, zimmernaechte } from '../lib/gruppenPreis.js'
import type { Preiseingabe } from '../lib/preisEingabe.js'

/**
 * Die Preisvorschau der Gruppenmaske.
 *
 * Geprueft wird die Rechnung, nicht die Darstellung -- und zwar gegen das,
 * was die Route tatsaechlich tut. Eine Vorschau, die einen Cent neben dem
 * Ergebnis liegt, ist schlechter als keine: sie sieht richtig aus.
 */

const nacht = (text: string): Preiseingabe => ({ modus: 'nacht', text })
const gesamt = (text: string): Preiseingabe => ({ modus: 'gesamt', text })

/** Drei Zimmer, zwei Naechte, unterschiedliche Belegung. */
const DREI = [
  { naechte: 2, personen: 2 },
  { naechte: 2, personen: 2 },
  { naechte: 2, personen: 1 }
]

describe('Zimmernaechte', () => {
  it('zaehlt die Naechte aller Zimmer, nicht die der Buchung', () => {
    /*
     * Der teure Irrtum: bei drei Zimmern ueber zwei Naechte stand neben
     * "100,00 je Nacht" ein Gesamtpreis von 200,00. Die Schnittstelle legt
     * einen Preis je Nacht aber auf **jede** Nacht **jedes** Zimmers --
     * gebucht wurden 600,00, und der Unterschied fiel erst auf der
     * Rechnung auf.
     */
    expect(zimmernaechte(DREI)).toBe(6)
  })

  it('zaehlt eine Zeile ohne Nacht als null, nicht als Minus', () => {
    // Waehrend jemand am Datum tippt, steht die Abreise kurz vor der
    // Anreise. Eine negative Zahl machte daraus einen negativen Preis.
    expect(zimmernaechte([{ naechte: 3, personen: 2 },
                          { naechte: -1, personen: 2 }])).toBe(3)
  })
})

describe('Ein Preis je Nacht fuer die ganze Gruppe', () => {
  it('legt denselben Betrag auf jede Nacht jedes Zimmers', () => {
    const p = gruppenpreisJeZimmer(nacht('100'), DREI)!
    expect(p.map(x => x.jeNachtCent)).toEqual([10000, 10000, 10000])
    expect(p.map(x => x.gesamtCent)).toEqual([20000, 20000, 20000])
  })

  it('rechnet fuer ein Zimmer mit eigenen Tagen dessen Naechte', () => {
    // Das Brautpaar bleibt drei Naechte, die Eltern zwei. Je Nacht heisst
    // je Nacht -- das laengere Zimmer kostet mehr, und das ist richtig so.
    const p = gruppenpreisJeZimmer(nacht('89,50'), [
      { naechte: 3, personen: 2 },
      { naechte: 2, personen: 2 }
    ])!
    expect(p.map(x => x.gesamtCent)).toEqual([26850, 17900])
  })
})

describe('Ein Gesamtpreis fuer die ganze Gruppe', () => {
  it('teilt nach Plaetzen der Zimmergruppe auf', () => {
    /*
     * Zwei Doppelzimmer und ein Einzelzimmer, 1.000,00 EUR: Gewichte
     * 2/2/1. Gleichmaessig zu teilen hiesse, das Einzelzimmer so teuer zu
     * machen wie das Doppelzimmer -- das faellt spaetestens auf, wenn
     * einer der Gaeste doch selbst zahlt.
     */
    const p = gruppenpreisJeZimmer(gesamt('1000'), DREI)!
    expect(p.map(x => x.gesamtCent)).toEqual([40000, 40000, 20000])
  })

  it('legt den Rest-Cent auf das erste Zimmer, damit die Summe stimmt', () => {
    // 100,00 EUR auf drei gleiche Zimmer sind 33,34 / 33,33 / 33,33. Die
    // Summe ist der eingegebene Betrag, auf den Cent -- ein fehlender Cent
    // taucht in der Buchhaltung als Differenz ohne Ursache auf.
    const gleich = [1, 2, 3].map(() => ({ naechte: 1, personen: 2 }))
    const p = gruppenpreisJeZimmer(gesamt('100'), gleich)!
    expect(p.map(x => x.gesamtCent)).toEqual([3334, 3333, 3333])
    expect(p.reduce((s, x) => s + x.gesamtCent, 0)).toBe(10000)
  })

  it('zeigt je Nacht die erste Nacht, denn dort liegt der Rest', () => {
    /*
     * 1.000,01 EUR auf drei Naechte sind 333,35 / 333,33 / 333,33, nicht
     * 333,34. Den abgerundeten Wert zu zeigen waere um einen Cent falsch,
     * und zwar genau an der Zeile, die oben auf dem Beleg steht.
     */
    const p = gruppenpreisJeZimmer(gesamt('1000,01'), [{ naechte: 3, personen: 2 }])!
    expect(p[0]).toEqual({ gesamtCent: 100001, jeNachtCent: 33335 })
  })
})

describe('Wann es nichts zu zeigen gibt', () => {
  it('sagt nichts, solange nichts Brauchbares dasteht', () => {
    // Eine Spalte voller Nullen waere eine Aussage, die niemand gemacht
    // hat: leer heisst "Ratenplan", nicht "null Euro".
    expect(gruppenpreisJeZimmer({ modus: 'nacht', text: '' }, DREI)).toBeNull()
    expect(gruppenpreisJeZimmer(nacht('abc'), DREI)).toBeNull()
  })

  it('sagt nichts, solange eine Zeile keine Nacht hat', () => {
    // Waehrend jemand am Datum tippt. Ein Zimmer ohne Nacht liesse sich
    // nicht aufteilen, und eine halb gefuellte Spalte verwirrt mehr als
    // eine leere.
    expect(gruppenpreisJeZimmer(gesamt('500'), [
      { naechte: 2, personen: 2 },
      { naechte: 0, personen: 2 }
    ])).toBeNull()
  })

  it('sagt nichts ohne Zimmer', () => {
    expect(gruppenpreisJeZimmer(gesamt('500'), [])).toBeNull()
  })
})

describe('Die Maske zeigt die Aufteilung, bevor gebucht wird', () => {
  const gruppe = readFileSync(
    new URL('../components/GroupBookingDialog.tsx', import.meta.url), 'utf8')

  it('zeigt beide Preisspalten in jeder Zeile, nicht nur bei "je Zimmer"', () => {
    // Verhandelt wird ein Betrag fuer alles, und genau dann will die
    // Rezeption sehen, was daraus je Zimmer wird -- der Reiseleiter fragt
    // vor dem Buchen, nicht danach.
    expect(gruppe).toContain("t('group.priceNight')")
    expect(gruppe).toContain('anteil.jeNachtCent')
    expect(gruppe).toContain('anteil.gesamtCent')
  })

  it('verbindet die beiden Gruppenfelder ueber alle Zimmernaechte', () => {
    // Nicht ueber die Naechte der Buchung: sonst zeigt die Maske ein
    // Drittel dessen an, was gebucht wird.
    expect(gruppe).toContain('naechte={naechteGesamt}')
  })

  it('uebernimmt die Aufteilung, wenn auf "je Zimmer" umgeschaltet wird', () => {
    // Sonst stehen acht leere Felder da, obwohl die Zahlen gerade
    // danebenstanden.
    expect(gruppe).toContain('onChange={aufJeZimmer}')
    expect(gruppe).toContain('eingabeAusCent(vorschau[i]!.gesamtCent)')
  })
})
