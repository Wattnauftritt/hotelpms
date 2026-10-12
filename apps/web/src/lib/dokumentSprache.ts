import { schreibrichtung } from '@hotelpms/contracts'

/**
 * Sprache und Schreibrichtung des Dokuments auf die Wahl setzen.
 *
 * Beides zusammen, weil fuenf Oberflaechen (Rezeption, Personal-App,
 * Terminal, Online-Check-in, Gaestemappe) ihr `lang` selbst setzen und eine,
 * die nur `lang` nachzieht, Arabisch von links nach rechts saetze.
 *
 * Eine eigene Datei und nicht im Katalog der Rezeption: Personal-App und
 * Gaestemappe laden ihn nicht, und fuer zwei Zeilen sollen sie es auch nicht.
 */
export function dokumentSprache(locale: string): void {
  document.documentElement.lang = locale
  document.documentElement.dir = schreibrichtung(locale)
}
