/**
 * Wo ein Aufenthalt im Belegungsplan liegt -- in Pixeln.
 *
 * **Von Tagesmitte zu Tagesmitte, nicht von Spaltenkante zu Spaltenkante.**
 * Das ist keine Verzierung, sondern der Tag, wie er an der Rezeption
 * ablaeuft: der abreisende Gast raeumt das Zimmer mittags, der anreisende
 * bekommt es nachmittags. Am Wechseltag gehoert das Zimmer also **beiden**
 * -- der eine vormittags, der andere nachmittags.
 *
 * Vorher begann ein Balken an der linken Kante seiner Anreisespalte. Zwei
 * Aufenthalte hintereinander stiessen dann an der Kante zwischen dem 24.
 * und dem 25. aneinander, und die Spalte "25." sah aus, als gehoere sie
 * ganz dem neuen Gast. Wer den Plan las, sah den Wechseltag nicht: er sah
 * einen Tag, an dem einer anreist, und musste sich denken, dass am selben
 * Morgen noch jemand drin lag. Mit dem halben Versatz steht es da -- links
 * der Rest des einen, rechts der Anfang des anderen.
 *
 * Steht hier und nicht in der Komponente, damit es sich nachrechnen laesst.
 * Die Darstellung selbst wird nicht getestet; diese Umrechnung schon, denn
 * ein halber Tag daneben sieht im Plan genauso richtig aus wie vorher.
 */

/** Pixel je Tag. */
export const SPALTE = 44

/**
 * Die Luecke am rechten Ende eines Balkens.
 *
 * Ohne sie beruehren sich zwei aufeinanderfolgende Aufenthalte genau in der
 * Tagesmitte und sehen aus wie einer. Rechts und nicht auf beide Seiten
 * verteilt: die linke Kante ist der Anreisezeitpunkt und soll genau dort
 * sitzen, wo er hingehoert.
 */
export const LUECKE = 4

export interface Kasten { left: number; width: number }

/**
 * Aus zwei Tagesindizes ein Kasten, beschnitten auf den sichtbaren
 * Ausschnitt.
 *
 * `vonTag` ist der Anreisetag, `bisTag` der Abreisetag -- also der Tag
 * **nach** der letzten Nacht, dieselbe Rechnung wie ueberall sonst. Beide
 * duerfen ausserhalb des Ausschnitts liegen; dann endet der Kasten an
 * dessen Rand, und dass es weitergeht, sieht man daran, dass er bis an die
 * Kante laeuft.
 */
export function spanne(vonTag: number, bisTag: number, spalten: number): Kasten {
  const start = Math.max(0, vonTag + 0.5)
  const ende = Math.min(spalten, bisTag + 0.5)
  return {
    left: start * SPALTE,
    // Nie negativ: ein Aufenthalt, der ganz vor oder hinter dem Ausschnitt
    // liegt, ergibt sonst eine Breite von -4, und was der Browser daraus
    // macht, ist nirgends verabredet.
    width: Math.max(0, (ende - start) * SPALTE - LUECKE)
  }
}
