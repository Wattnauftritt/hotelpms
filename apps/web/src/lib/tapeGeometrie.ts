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

/**
 * Die schmalste Spalte, die noch lesbar ist.
 *
 * Sie ist eine **Untergrenze**, keine feste Breite: der Plan ist der
 * Bildschirm, auf den die Rezeption den ganzen Tag sieht, und er soll die
 * Breite nehmen, die da ist. Bei 44 Pixeln fest blieben auf einem
 * gewoehnlichen Bildschirm neben dreissig Tagen vierhundert Pixel leer --
 * und ein Balken ueber zwei Naechte war 88 Pixel breit, zu wenig fuer
 * einen Namen. Erst wenn der Zeitraum so lang wird, dass auch die
 * Untergrenze nicht mehr hineinpasst, wird gescrollt.
 */
export const SPALTE_MIN = 44

/**
 * Wie breit eine Tagesspalte auf diesem Bildschirm sein darf.
 *
 * Ohne Obergrenze, und das ist Absicht: wer vierzehn Tage waehlt, will
 * vierzehn Tage gross sehen. Eine Deckelung liesse rechts genau die Luecke
 * stehen, wegen der es diese Funktion gibt.
 *
 * Abgerundet, damit die Spaltenlinien auf ganzen Pixeln sitzen. Die
 * hoechstens `tage - 1` Pixel, die dabei uebrig bleiben, sieht niemand;
 * eine Linie, die mal ein und mal zwei Pixel breit ist, schon.
 */
export function spaltenBreite(verfuegbar: number, tage: number): number {
  if (tage <= 0) return SPALTE_MIN
  return Math.max(SPALTE_MIN, Math.floor(verfuegbar / tage))
}

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
 *
 * `breite` ist die Spaltenbreite dieses Bildschirms (`spaltenBreite`) und
 * kein fester Wert -- sonst laegen die Balken neben den Spalten, sobald
 * das Fenster eine andere Groesse hat.
 */
export function spanne(vonTag: number, bisTag: number, spalten: number,
                       breite: number): Kasten {
  const start = Math.max(0, vonTag + 0.5)
  const ende = Math.min(spalten, bisTag + 0.5)
  return {
    left: start * breite,
    // Nie negativ: ein Aufenthalt, der ganz vor oder hinter dem Ausschnitt
    // liegt, ergibt sonst eine Breite von -4, und was der Browser daraus
    // macht, ist nirgends verabredet.
    width: Math.max(0, (ende - start) * breite - LUECKE)
  }
}
