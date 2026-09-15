/**
 * Die Kennwortregel.
 *
 * **Warum hier und nicht in der Fachlogik.** Beide Enden muessen sich einig
 * sein: die Schnittstelle weist ein zu kurzes Kennwort ab, die Oberflaeche
 * sagt vorher, wie lang es sein muss. Stuende die Zahl an zwei Stellen,
 * liefe sie irgendwann auseinander -- und der Befund waere ein Benutzer, dem
 * die Maske zwoelf Zeichen nennt und die Antwort vierzehn verlangt. Der
 * Meldungstext dazu ('auth.passwordTooShort') liegt eine Datei weiter; die
 * Zahl gehoert daneben.
 */

/** Mindestlaenge eines Kennworts. */
export const KENNWORT_MIN = 12

/**
 * Prueft ein Kennwort auf Laenge, sonst nichts.
 *
 * **Keine Regeln ueber Zeichenarten.** Die Vorgabe "ein Grossbuchstabe, eine
 * Ziffer, ein Sonderzeichen" erzeugt `Passwort1!` und sonst nichts; das NIST
 * hat sie 2017 gestrichen (SP 800-63B), und das BSI empfiehlt seit 2020
 * Laenge statt Zusammensetzung. Was wirklich hilft, ist Laenge -- und dass
 * niemand gezwungen wird, sich etwas Unmerkbares auszudenken und dann
 * aufzuschreiben.
 *
 * Gezaehlt wird ueber den Spreizoperator, nicht mit `.length`: ein Emoji
 * oder ein zusammengesetztes Zeichen zaehlt dort als zwei, und ein Kennwort
 * abzulehnen, das die Regel erfuellt, ist schwer zu erklaeren.
 */
export function kennwortZuKurz(kennwort: string): boolean {
  return [...kennwort].length < KENNWORT_MIN
}
