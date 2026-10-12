import { STAFF_LOCALES, sprachKuerzel, type StaffLocale } from '@hotelpms/contracts'

/**
 * Uebersetzung freier Texte des Personals (Aufgabe 18, Baustein 7).
 *
 * Nur das Reine: welche Sprache DeepL wie nennt, wann ein Auftrag noch
 * einmal versucht wird und welche Antwort eine Wiederholung lohnt. Der
 * Netzaufruf steht im Worker.
 */

/**
 * Alle Sprachen der Personal-App; DeepL uebersetzt in jede davon. Die
 * Datenbank prueft dieselbe Liste (Migration 0144).
 */
export const STAFF_TEXT_LANGS = STAFF_LOCALES
export type StaffTextLang = StaffLocale

/** Danach gilt ein Auftrag als gescheitert; das Original bleibt lesbar. */
export const TRANSLATION_MAX_ATTEMPTS = 6

/**
 * Zielsprache, wie DeepL sie haben will. Englisch braucht eine Variante,
 * sonst lehnt DeepL das Ziel ab; britisch, weil die Haeuser in Europa sind.
 * Portugiesisch europaeisch aus demselben Grund und weil die Oberflaeche es
 * so spricht (`pt-PT`); Chinesisch in Kurzzeichen wie ihr Katalog.
 */
const DEEPL_ZIEL: Readonly<Record<string, string>> = { en: 'EN-GB', pt: 'PT-PT', zh: 'ZH-HANS' }
export function deeplTargetCode(lang: string): string {
  return DEEPL_ZIEL[lang] ?? lang.toUpperCase()
}

/**
 * Erkannte Ausgangssprache aus der Antwort, auf unsere abgebildet.
 * Alles andere ist `null`: uebersetzt ist es trotzdem, nur laesst sich
 * nicht sagen, ob das Ziel schon die Ausgangssprache war.
 */
export function staffLangFromDeepl(code: string | null | undefined): StaffTextLang | null {
  const k = sprachKuerzel(code)
  return (STAFF_TEXT_LANGS as readonly string[]).includes(k) ? k as StaffTextLang : null
}

/**
 * Schluessel des kostenlosen Zugangs enden auf `:fx` und gehoeren an einen
 * anderen Rechner. Mit dem falschen antwortet DeepL 403, und das sieht aus
 * wie ein ungueltiger Schluessel.
 */
export function deeplEndpoint(apiKey: string): string {
  return apiKey.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate'
}

/** Abstand bis zum naechsten Versuch: eine Minute, dann verdoppelt. */
export function translationRetryDelaySeconds(attempt: number, baseSeconds = 60): number {
  return baseSeconds * 2 ** Math.max(0, attempt - 1)
}
