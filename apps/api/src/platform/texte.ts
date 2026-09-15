import { renderMessage, type MessageKey, type MessageParams }
  from '@hotelpms/contracts'

/**
 * Die Sprache der Schnittstelle.
 *
 * Die API antwortet **deutsch**, und zwar immer. Sie handelt keine Sprache
 * aus: ein Protokolleintrag, eine Antwort in einem Skript und ein Fehler im
 * Postfach des Betriebs sollen ohne Katalog lesbar sein. Wer uebersetzen
 * will, nimmt den Schluessel, der neben jedem Satz steht -- die Oberflaeche
 * tut genau das, in der Sprache des Personals.
 */
const API_LOCALE = 'de'

/** Ein Schluessel aus dem Katalog -- oder, noch, ein deutscher Satz. */
export type Meldung = MessageKey | (string & {})

export function apiText(key: Meldung, params?: MessageParams): string {
  return renderMessage(key, API_LOCALE, params)
}

/**
 * Ein Hinweis, der neben einer Antwort steht.
 *
 * Denselben Weg wie eine Fehlermeldung: die Antwort traegt den deutschen
 * Satz **und** den Schluessel daneben. Nur den Schluessel zu schicken waere
 * sauberer und wuerde jedes Skript brechen, das die Antwort ausgibt.
 */
export const hinweisText = apiText
