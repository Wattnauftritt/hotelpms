import { addDays } from './dates.js'

/**
 * Was eine aufgezogene Auswahl im Belegungsplan bedeutet.
 *
 * Steht hier und nicht in der Komponente, weil es die einzige Stelle des
 * Plans ist, an der ein Fehler still teuer wird: aus zwei Rasterindizes
 * werden Anreise und Abreise, und beides sind **Kalenderdaten**. Ein Tag
 * daneben heisst eine Nacht zu viel oder zu wenig auf der Rechnung, und im
 * Plan sieht das genauso richtig aus wie vorher.
 *
 * Ausserdem laesst es sich so pruefen. Die Oberflaeche selbst wird nicht
 * getestet -- ein Test, der prueft, dass ein Kasten blau ist, bricht bei
 * jeder Gestaltungsaenderung und faengt nie einen Fehler.
 */

export interface Zeitraum { arrival: string; departure: string }

/**
 * Aus zwei Tagesindizes ein Aufenthalt.
 *
 * **Rueckwaerts aufziehen ist erlaubt.** Wer von rechts nach links zieht,
 * meint denselben Zeitraum; `Math.min`/`Math.max` statt einer Bedingung,
 * die den Fall vergisst.
 *
 * **Der letzte sichtbare Tag ist eine Anreise, keine Abreise.** Die Abreise
 * liegt einen Tag hinter dem letzten markierten -- am Abreisetag ist das
 * Zimmer ab mittags wieder frei. Wer bis an den rechten Rand zieht, hat
 * diesen Tag im Raster nicht mehr; deshalb wird er gerechnet und nicht
 * nachgeschlagen. Ohne das endete jede Buchung am Rand einen Tag zu frueh.
 */
export function auswahlZeitraum(tage: string[], startDay: number, day: number): Zeitraum {
  const von = Math.max(0, Math.min(startDay, day))
  const bis = Math.min(tage.length - 1, Math.max(startDay, day)) + 1
  return {
    arrival: tage[von]!,
    departure: bis < tage.length ? tage[bis]! : addDays(tage[tage.length - 1]!, 1)
  }
}

export interface AuswahlZimmer { resourceId: number; categoryId: number }

/**
 * Aus einem aufgezogenen Rechteck die Zimmer einer Gruppenbuchung.
 *
 * Die Zeilen kommen als Index, nicht als id: aufgezogen wird ueber die
 * sichtbare Reihenfolge, und was dazwischenliegt, weiss nur sie. Auch hier
 * gilt beides -- von unten nach oben ist dieselbe Auswahl.
 */
export function gruppenAuswahl(
  units: Array<{ id: number; category_id: number }>,
  tage: string[],
  d: { startIndex: number; index: number; startDay: number; day: number }
): Zeitraum & { rooms: AuswahlZimmer[] } {
  const vonZeile = Math.max(0, Math.min(d.startIndex, d.index))
  const bisZeile = Math.min(units.length - 1, Math.max(d.startIndex, d.index))
  return {
    ...auswahlZeitraum(tage, d.startDay, d.day),
    rooms: units.slice(vonZeile, bisZeile + 1)
      .map(u => ({ resourceId: u.id, categoryId: u.category_id }))
  }
}

/**
 * Passt diese Buchung in dieses Zimmer?
 *
 * **Drei Zustände, und die Mitte ist der Punkt.** Eine andere Zimmergruppe
 * ist für sich kein Fehler: der Gast hat ein Doppelzimmer gebucht und
 * bekommt die Juniorsuite, abgerechnet wird, was gebucht wurde -- deshalb
 * laesst die API es zu (`assertUnitAssignable` prueft die Gruppe bewusst
 * nicht). Falsch ist erst die andere Richtung, und die faellt sonst
 * niemandem auf: zwei Personen in einem Einzelzimmer merkt der Gast.
 *
 * Steht hier und nicht in der Komponente, weil dieselbe Frage an zwei
 * Stellen gestellt wird -- die Zeile faerbt sich danach, und der Dialog
 * warnt danach. Zweimal formuliert liefen die beiden auseinander, und der
 * Befund waere eine rot markierte Zeile, die beim Loslassen nichts sagt.
 */
export type Passung = 'passt' | 'andere' | 'zuKlein'

/**
 * Wie viele Plaetze das Zielzimmer mindestens haben muss.
 *
 * **Warum nicht die Personenzahl.** Die war der erste Versuch und ist
 * falsch: eine Buchung aus dem Channel Manager traegt genau einen
 * Belegten -- den Bucher --, auch wenn zwei anreisen; die weiteren Namen
 * stehen erst beim Check-in fest. Gerechnet mit der Personenzahl waere
 * jedes Doppelzimmer aus dem Channel "eine Person" und damit im
 * Einzelzimmer unauffaellig gross genug. Genau dort, im Band der
 * unzugewiesenen Buchungen, ist die Warnung aber gebraucht.
 *
 * Was feststeht, ist das verkaufte Produkt: ein Doppelzimmer ist fuer zwei
 * verkauft, ob der zweite Name bekannt ist oder nicht. Sind schon mehr
 * Personen erfasst als die Zimmergruppe fasst -- drei in einer Ferienwohnung
 * fuer vier ist gewoehnlich, vier in einem Doppelzimmer mit Aufbettung
 * kommt vor --, zaehlt die groessere der beiden Zahlen.
 */
export function platzbedarf(
  buchung: { occupants: number; categoryMaxOccupancy: number }
): number {
  return Math.max(buchung.occupants, buchung.categoryMaxOccupancy, 1)
}

export function zimmerPassung(
  zimmer: { category_id: number; max_occupancy: number },
  buchung: { categoryId: number; occupants: number; categoryMaxOccupancy: number }
): Passung {
  if (zimmer.category_id === buchung.categoryId) return 'passt'
  return zimmer.max_occupancy < platzbedarf(buchung) ? 'zuKlein' : 'andere'
}
