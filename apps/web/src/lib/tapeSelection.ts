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
