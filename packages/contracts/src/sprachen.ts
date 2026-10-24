/**
 * Die Sprachen und was an ihnen haengt, ohne die Saetze.
 *
 * Getrennt von `messages.ts`, weil die Oberflaeche diese Liste braucht, den
 * Katalog der Meldungen aber nicht mehr mitlaedt: er kommt je Sprache als
 * eigenes Paket (`apps/web/src/lib/sprachpaketBau.ts`). Stuende die Liste
 * im selben Modul, zoege jeder Import von `LOCALES` die 1,5 MB des Katalogs
 * in den Einstieg der Oberflaeche -- `MESSAGE_KEYS` ruft `Object.keys`
 * auf oberster Ebene auf, und Rollup behaelt das Modul deshalb ganz.
 */

/**
 * Die Sprachen, in denen Oberflaeche und Meldungen **vollstaendig**
 * vorliegen.
 *
 * Bewusst hier und nicht in `apps/web`: die Liste ist eine Zusage des
 * Produkts, kein Merkmal eines Bildschirms, und der Test ueber den Katalog
 * braucht sie genauso wie die Oberflaeche. Eine Sprache steht hier erst,
 * wenn jeder Schluessel sie hat -- halb uebersetzt anzubieten heisst, dem
 * Benutzer die Haelfte in einer Sprache zu zeigen, die er nicht gewaehlt
 * hat.
 *
 * **Welche Sprachen** (Sven, 12.10.2026: "alle hier gaengigen Sprachen inkl.
 * russisch, ukrainisch, tuerkisch, alle angrenzenden und grossen Laender"):
 * die Gaeste an der Nordsee kommen aus den Nachbarlaendern und aus
 * Skandinavien, das Personal oft aus Polen, Tschechien, der Tuerkei, Russland
 * und der Ukraine. Rechts nach links (Arabisch) fehlt mit Absicht: das ist
 * nicht eine Sprache mehr, sondern eine gespiegelte Oberflaeche.
 *
 * Die Reihenfolge ist die der Auswahl: Deutsch und Englisch vorn, dann die
 * Nachbarn im Norden und Westen, dann Osten und Sueden.
 */
export const LOCALES = [
  'de', 'en', 'nl', 'da', 'sv', 'nb', 'fi', 'is', 'pl', 'cs', 'sk', 'sl', 'hu',
  'ro', 'bg', 'hr', 'sr', 'mk', 'sq', 'el', 'lt', 'lv', 'et', 'fr', 'it', 'es',
  'pt', 'tr', 'ru', 'uk', 'ar', 'zh', 'ko'
] as const
export type MessageLocale = (typeof LOCALES)[number]

/**
 * Wie sich eine Sprache selbst nennt -- in einer Auswahl steht "Українська",
 * nicht "Ukrainisch": wer seine Sprache sucht, liest die anderen nicht.
 * Eine Tabelle fuer alle Oberflaechen, damit die Gaestemappe nicht "Polski"
 * schreibt und das Terminal "PL".
 */
export const SPRACHNAMEN: { readonly [L in MessageLocale]: string } = {
  de: 'Deutsch',
  en: 'English',
  nl: 'Nederlands',
  da: 'Dansk',
  sv: 'Svenska',
  nb: 'Norsk',
  fi: 'Suomi',
  is: 'Íslenska',
  pl: 'Polski',
  cs: 'Čeština',
  sk: 'Slovenčina',
  sl: 'Slovenščina',
  hu: 'Magyar',
  ro: 'Română',
  bg: 'Български',
  hr: 'Hrvatski',
  sr: 'Srpski',
  mk: 'Македонски',
  sq: 'Shqip',
  el: 'Ελληνικά',
  lt: 'Lietuvių',
  lv: 'Latviešu',
  et: 'Eesti',
  fr: 'Français',
  it: 'Italiano',
  es: 'Español',
  pt: 'Português',
  tr: 'Türkçe',
  ru: 'Русский',
  uk: 'Українська',
  ar: 'العربية',
  zh: '中文',
  ko: '한국어'
}

/**
 * Die Sprachen, in denen **Gastpost** entsteht.
 *
 * Eine eigene Liste neben `LOCALES`, auch wenn sie heute dieselbe ist: die
 * eine folgt dem Personal am Bildschirm, die andere dem Gast an seinem
 * Profil. Bis zum 12.10.2026 waren es verschiedene (die Post schrieb
 * Niederlaendisch, die Oberflaeche Tuerkisch); seit alle Kataloge alle
 * Sprachen tragen, fallen sie zusammen. Getrennt benannt bleiben sie, weil
 * die Gastmaske genau diese Liste anbietet und eine Sprache der Oberflaeche,
 * in der die Post nicht schreibt, dort nichts verloren haette.
 *
 * Bewusst hier und nicht in `packages/domain`, wo die Vorlagen stehen:
 * die Gastmaske bietet diese Sprachen zur Auswahl an und braucht dafuer
 * nur die Liste. Sie ueber die Domaene zu holen zog deren Barrel in das
 * Buendel der Oberflaeche -- mit `node:crypto` darin, das ein Browser
 * nicht hat.
 */
export const EMAIL_LANGUAGES = LOCALES
export type EmailLanguage = (typeof EMAIL_LANGUAGES)[number]

/**
 * In welche Richtung eine Sprache schreibt.
 *
 * Arabisch ist die einzige von rechts nach links. Mehr als `dir="rtl"` am
 * Wurzelelement braucht es dafuer nicht: die Oberflaeche ordnet mit Flex und
 * Grid, und beide spiegeln sich mit der Richtung von selbst. Eine Liste und
 * kein `=== 'ar'` an fuenf Stellen, damit eine zweite solche Sprache
 * (Hebraeisch, Persisch) eine Zeile hier ist und nicht eine Suche.
 */
const VON_RECHTS: ReadonlySet<string> = new Set(['ar'])
export function schreibrichtung(locale: string): 'rtl' | 'ltr' {
  return VON_RECHTS.has(locale) ? 'rtl' : 'ltr'
}

/**
 * Die Sprachen der **Personal-App** (Migration 0105).
 *
 * Eine eigene Liste aus demselben Grund wie die Gastpost: die Personal-App
 * hat ihren eigenen kleinen Katalog, und **in ihm** ist jede dieser Sprachen
 * vollstaendig; er prueft das mit demselben Typ-Trick wie der grosse. Seit
 * dem 12.10.2026 spricht sie alle Sprachen der Rezeption.
 */
export const STAFF_LOCALES = LOCALES
export type StaffLocale = (typeof STAFF_LOCALES)[number]

/**
 * Was am Benutzer als Sprache stehen darf: jede, die eine der Oberflaechen
 * anbietet. Die Datenbank prueft dieselbe Liste (Migration 0144).
 */
export const BENUTZERSPRACHEN = LOCALES

/**
 * Das Sprachkuerzel aus einer Angabe wie `en-GB`, `nb-NO` oder `no`.
 *
 * Nur die ersten beiden Zeichen: am Profil steht mal `en`, mal `en-GB`.
 * Norwegisch ist die Ausnahme: ein Browser meldet es als `nb`, `no` oder
 * (Nynorsk) `nn`, und alle drei lesen Bokmaal. Ohne diese Zeile bekaeme ein
 * norwegisches Telefon mit `no` Deutsch.
 */
export function sprachKuerzel(angabe: string | null | undefined): string {
  const kurz = (angabe ?? '').trim().slice(0, 2).toLowerCase()
  return kurz === 'no' || kurz === 'nn' ? 'nb' : kurz
}

/**
 * Die Sprache eines Gastes auf eine Sprache abbilden, in der wir schreiben.
 *
 * Gegen die Liste und nicht gegen eine einzelne Sprache: mit
 * `code === 'en' ? 'en' : 'de'` bekaeme jede neue Sprache stillschweigend
 * deutsche Post, und aufgefallen waere es dem Gast, nicht uns.
 *
 * Nur die ersten beiden Zeichen: am Profil steht mal `en`, mal `en-GB`.
 * Einen Gast deutsch anzuschreiben, weil sein Profil die Region mitfuehrt,
 * waere eine seltsame Art, genau zu sein.
 */
export function emailLanguage(code: string | null | undefined): EmailLanguage {
  const kurz = sprachKuerzel(code)
  return (EMAIL_LANGUAGES as readonly string[]).includes(kurz)
    ? (kurz as EmailLanguage)
    : 'de'
}

/**
 * Ein Eintrag: ein Satz je Sprache.
 *
 * Bewusst benannte Felder und keine Liste. Bei zwei Sprachen waere eine
 * Liste knapper; ab der dritten liest niemand mehr ab, welcher Satz zu
 * welcher Sprache gehoert, und eine vertauschte Reihenfolge faellt keinem
 * Typ auf. Ein fehlendes Feld dagegen bricht den Build.
 *
 * Ausgefuehrt, weil die Beschriftungen der Oberflaeche dieselbe Form haben.
 * Zweimal dieselbe Zeile zu schreiben hiesse, sie beim Hinzufuegen einer
 * Sprache an zwei Stellen zu aendern -- und eine davon zu vergessen.
 */
export type LocalizedText = { readonly [L in MessageLocale]: string }
