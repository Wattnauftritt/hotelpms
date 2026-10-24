import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { MessageLocale } from '@hotelpms/contracts'
import lader from 'virtual:sprachpaket/oberflaeche'
import meldungsLader from 'virtual:sprachpaket/meldungen'
import { einsetzen, Sprachpakete, useSprachpakete } from '../sprachpaket.js'
import type { TextKey } from './katalog.js'

/**
 * Deutsch und Englisch von Anfang an (AP 12).
 *
 * Nachträglich zu übersetzen heißt, jede Zeichenkette einzeln aus dem Code
 * zu ziehen, und dabei wird die Hälfte vergessen. Hier gibt es deshalb von
 * Beginn an keinen Text im Code, nur Schlüssel.
 *
 * Die Sprache des Hauses steht an der Property, die des Gastes am Profil.
 * Beides ist nicht dasselbe: ein deutsches Haus schreibt einem
 * niederländischen Gast auf Englisch und führt die Oberfläche auf Deutsch.
 *
 * **Ein Bündel je Bereich, nicht eine Datei für alles.** Der Grund ist nicht
 * Ordnungsliebe, sondern Arbeitsteilung: an einer einzigen Textdatei
 * arbeiten drei Bearbeiter zwangsläufig an derselben Stelle, und jeder Merge
 * wird zur Handarbeit. So berührt ein neuer Bildschirm seine eigene Datei
 * und **eine** Zeile in `katalog.ts`.
 *
 * Wer einen Bereich hinzufügt: Datei daneben legen, in `katalog.ts`
 * importieren und dort in `TextKey` und `texts` eintragen.
 *
 * **Ausgeliefert wird je Sprache ein Paket, nicht der Katalog.** Diese
 * Datei importiert die Bereiche nicht; der Bau schreibt aus `katalog.ts`
 * eine Datei je Sprache, und der Browser holt genau die, die gilt
 * (`<Sprache>` unten, `lib/sprachpaket.ts`).
 *
 * **Die Sprachen stehen je Schlüssel beieinander, nicht in Blöcken.** Ein
 * Bereich hatte früher einen `de`- und einen `en`-Block; wer einen Satz
 * änderte, musste zweihundert Zeilen weiter unten den zweiten finden. Ab der
 * dritten Sprache liest das niemand mehr ab. Nebeneinander fällt die Lücke
 * beim Hinsehen auf — und `satisfies Record<string, LocalizedText>` in jeder
 * Bereichsdatei macht aus einer vergessenen Sprache einen Typfehler an
 * genau dem Schlüssel, dem sie fehlt, statt einer kryptischen Meldung hier.
 * Der Meldungskatalog der Schnittstelle ist aus demselben Grund so gebaut.
 */
/**
 * Die Sprachen kommen aus dem Vertrag, nicht von hier.
 *
 * Sonst stuenden sie an zwei Stellen: in `contracts/messages.ts` fuer die
 * Meldungen der Schnittstelle und hier fuer die Beschriftungen. Zwei Listen
 * laufen auseinander, und das Ergebnis waere eine Sprache, die man waehlen
 * kann und in der die Fehlermeldungen deutsch bleiben.
 */
export { LOCALES, SPRACHNAMEN, sprachKuerzel } from '@hotelpms/contracts'
export { dokumentSprache } from '../dokumentSprache.js'
export type Locale = MessageLocale

/**
 * Wie eine Sprache Zahlen, Geld und Wochentage schreibt.
 *
 * **Warum das eine Tabelle ist und keine Bedingung.** Hier stand
 * `locale === 'de' ? 'de-DE' : 'en-GB'`. Das ist richtig, solange es genau
 * zwei Sprachen gibt, und wird beim Hinzufuegen der dritten still falsch:
 * ein niederlaendischer Betrag bekaeme britisches Trennzeichen, und eine
 * Fehlermeldung gibt es dafuer nicht -- nur eine Zahl, die plausibel
 * aussieht und um den Faktor tausend danebenliegt.
 *
 * Als `Record<Locale, ...>` kann das nicht passieren: wer eine Sprache
 * hinzufuegt und diese Zeile vergisst, bekommt einen Typfehler.
 */
const INTL_TAG: Record<Locale, string> = {
  de: 'de-DE',
  en: 'en-GB',
  nl: 'nl-NL',
  da: 'da-DK',
  sv: 'sv-SE',
  nb: 'nb-NO',
  fi: 'fi-FI',
  is: 'is-IS',
  pl: 'pl-PL',
  cs: 'cs-CZ',
  sk: 'sk-SK',
  sl: 'sl-SI',
  hu: 'hu-HU',
  ro: 'ro-RO',
  bg: 'bg-BG',
  hr: 'hr-HR',
  // Lateinische Schrift: die Uebersetzung ist lateinisch geschrieben, und
  // ohne `Latn` schriebe `Intl` Monatsnamen kyrillisch daneben.
  sr: 'sr-Latn-RS',
  mk: 'mk-MK',
  sq: 'sq-AL',
  el: 'el-GR',
  lt: 'lt-LT',
  lv: 'lv-LV',
  et: 'et-EE',
  fr: 'fr-FR',
  it: 'it-IT',
  es: 'es-ES',
  pt: 'pt-PT',
  tr: 'tr-TR',
  ru: 'ru-RU',
  uk: 'uk-UA',
  // `-u-nu-latn`: arabische Ziffern wie ueberall. Mit den ostarabischen
  // Ziffern, die `ar` sonst je nach Browser waehlt, staenden Betraege auf
  // der Rechnung anders da als auf dem Bildschirm daneben.
  ar: 'ar-u-nu-latn',
  zh: 'zh-CN',
  ko: 'ko-KR'
}

/**
 * Der Sprachschluessel fuer `Intl`, fuer Aufrufer ausserhalb dieser Datei.
 *
 * Ausgefuehrt, weil das Preisraster sich sein eigenes
 * `locale === 'de' ? 'de-DE' : 'en-GB'` gehalten hatte -- genau die
 * Bedingung, gegen die diese Tabelle gebaut ist. Wer die Zuordnung
 * braucht, holt sie hier, statt sie ein zweites Mal zu treffen.
 */
export function intlTag(locale: Locale): string {
  return INTL_TAG[locale]
}

/**
 * Wie eine Sprache ein Kalenderdatum schreibt.
 *
 * Bewusst eine eigene Angabe und nicht `Intl`: Englisch steht hier
 * absichtlich auf ISO und nicht auf `01/10/2026`. Ein Datum mit
 * Schraegstrichen ist zwischen britischer und amerikanischer Lesart
 * mehrdeutig, und an einer Rezeption liest es beides -- `2026-10-01` nicht.
 */
export type Datumsform = 'tag-zuerst' | 'iso'
const DATUMSFORM: Record<Locale, Datumsform> = {
  de: 'tag-zuerst',
  en: 'iso',
  // Schwedisch schreibt Kalendertage selbst als 2026-10-01; die anderen mit
  // dem Tag zuerst. Punkte statt ihrer Schraegstriche oder Bindestriche
  // (Frankreich 01/10/2026, Niederlande 01-10-2026) sind dort ueberall
  // lesbar und vor allem eindeutig -- anders als die Schraegstriche des
  // Englischen ist bei Tag-zuerst nichts zu verwechseln.
  nl: 'tag-zuerst',
  da: 'tag-zuerst',
  sv: 'iso',
  nb: 'tag-zuerst',
  fi: 'tag-zuerst',
  is: 'tag-zuerst',
  pl: 'tag-zuerst',
  cs: 'tag-zuerst',
  sk: 'tag-zuerst',
  sl: 'tag-zuerst',
  // Ungarisch, Litauisch, Chinesisch und Koreanisch schreiben das Jahr
  // zuerst. Tag zuerst waere dort die fremde Reihenfolge; ISO ist ihre
  // eigene und bleibt eindeutig.
  hu: 'iso',
  ro: 'tag-zuerst',
  bg: 'tag-zuerst',
  hr: 'tag-zuerst',
  sr: 'tag-zuerst',
  mk: 'tag-zuerst',
  sq: 'tag-zuerst',
  el: 'tag-zuerst',
  lt: 'iso',
  lv: 'tag-zuerst',
  et: 'tag-zuerst',
  fr: 'tag-zuerst',
  it: 'tag-zuerst',
  es: 'tag-zuerst',
  pt: 'tag-zuerst',
  // Tuerkisch schreibt 01.10.2026, mit Punkten und Tag zuerst -- wie Deutsch.
  tr: 'tag-zuerst',
  ru: 'tag-zuerst',
  uk: 'tag-zuerst',
  ar: 'tag-zuerst',
  zh: 'iso',
  ko: 'iso'
}

export type { TextKey } from './katalog.js'

/**
 * Die Pakete der Oberflaeche und der Meldungen der Schnittstelle, je
 * Sprache eines (`lib/sprachpaket.ts`). Beide gehoeren zu jedem Bildschirm
 * und werden deshalb immer zusammen geholt.
 */
export const oberflaechenTexte = new Sprachpakete<Locale>(lader)
export const meldungsTexte = new Sprachpakete<Locale>(meldungsLader)
const PAKETE = [oberflaechenTexte, meldungsTexte]

export const I18nContext = createContext<Locale>('de')

/**
 * Die Sprache fuer alles darunter, mit ihren Paketen.
 *
 * An die Stelle von `<I18nContext.Provider>`: der Kontext nennt erst eine
 * Sprache, wenn ihre Saetze da sind. Beim ersten Aufbau steht deshalb einen
 * Augenblick nichts da; beim Umstellen bleibt die bisherige Sprache stehen,
 * bis die neue geladen ist. `zusaetzlich` holt weitere Kataloge in derselben
 * Sprache mit -- das Terminal braucht die Saetze der Gaestemappe.
 */
export function Sprache(props: {
  locale: Locale
  zusaetzlich?: ReadonlyArray<Sprachpakete<Locale>>
  children?: ReactNode
}): JSX.Element | null {
  const aktiv = useSprachpakete(
    props.zusaetzlich === undefined ? PAKETE : [...PAKETE, ...props.zusaetzlich],
    props.locale, 'de')
  if (aktiv === null) return null
  return createElement(I18nContext.Provider, { value: aktiv }, props.children)
}

/**
 * Ein Satz ohne React, in einer geladenen Sprache.
 *
 * Fehlt das Paket -- die Bildschirmtastatur fragt nach der Sprache des
 * Feldes, und die kann eine andere sein als die des Rahmens --, steht der
 * deutsche Satz da, und ohne den der Schluessel. Eine leere Taste waere
 * schlimmer als eine in der falschen Sprache.
 */
export function textFor(
  key: TextKey, locale: Locale, params?: Record<string, string | number>
): string {
  const satz = oberflaechenTexte.paket(locale)?.[key]
    ?? oberflaechenTexte.paket('de')?.[key] ?? key
  return einsetzen(satz, params)
}

/**
 * Ein Text der Oberflaeche, mit eingesetzten Werten.
 *
 * Platzhalter stehen in geschweiften Klammern, wie im Meldungskatalog der
 * Schnittstelle: `{haus}`. Einen Satz stattdessen aus Stuecken
 * zusammenzusetzen -- "Dieses Konto hat in " + name + " keine Rechte" --
 * geht in jeder Sprache schief, in der die Wortstellung eine andere ist.
 */
export function useT(): (key: TextKey, params?: Record<string, string | number>)
  => string {
  const locale = useContext(I18nContext)
  return (key, params) => textFor(key, locale, params)
}

export function useLocale(): Locale {
  return useContext(I18nContext)
}

/**
 * Die Formatierer, gemerkt.
 *
 * **Warum das nötig ist.** `new Intl.NumberFormat(...)` ist nicht billig:
 * es baut jedes Mal die Regeln einer Sprache auf. Auf einer Liste fällt das
 * nicht auf, im Preisraster schon — 400 Tage mal zehn Ratenpläne sind
 * sechzehnhundert Zellen, und bei jeder Mausbewegung entstand für jede ein
 * eigenes Objekt. Gemessen waren das 328 ms je Zug mit der Maus; das Raster
 * hing spürbar am Zeiger.
 *
 * Spur B hat sich deshalb eine Zeit lang einen eigenen Formatierer gehalten.
 * Das gehört nicht in eine Spur, sondern hierher: die Kombinationen sind
 * abzählbar (die Sprachen mal den Währungen des Hauses), der Schlüssel ist
 * genau das Paar, und ein Formatierer ist unveränderlich und damit gefahrlos
 * zu teilen.
 */
const formatierer = new Map<string, Intl.NumberFormat>()

/**
 * Der gemerkte Formatierer selbst. Für heiße Pfade, die ihn behalten und
 * durchreichen wollen — seine Identität bleibt über Neuzeichnen hinweg
 * gleich und trägt deshalb durch ein `memo` hindurch.
 */
export function geldFormatierer(locale: Locale, currency = 'EUR'): Intl.NumberFormat {
  const schluessel = `${locale}|${currency}`
  let f = formatierer.get(schluessel)
  if (f === undefined) {
    f = new Intl.NumberFormat(INTL_TAG[locale], { style: 'currency', currency })
    formatierer.set(schluessel, f)
  }
  return f
}

/** Cent als Betrag in der Sprache des Betrachters. */
export function formatMoney(cent: number, locale: Locale, currency = 'EUR'): string {
  return geldFormatierer(locale, currency).format(cent / 100)
}

/** Aufenthaltsdaten sind Kalenderdaten, keine Zeitpunkte. Nie als Date parsen. */
export function formatDate(iso: string, locale: Locale): string {
  const [y, m, d] = iso.split('-')
  return DATUMSFORM[locale] === 'tag-zuerst' ? `${d}.${m}.${y}` : `${y}-${m}-${d}`
}

/**
 * Tag und Monat ohne Jahr, fuer eine Reihe von Tagen im selben Aufenthalt.
 * In ISO bleibt das Jahr stehen: `10-13` liest niemand sicher als Datum.
 */
export function formatDayMonth(iso: string, locale: Locale): string {
  if (DATUMSFORM[locale] !== 'tag-zuerst') return formatDate(iso, locale)
  const [, m, d] = iso.split('-')
  return `${d}.${m}.`
}

const wochentage = new Map<Locale, Intl.DateTimeFormat>()

/**
 * Das Kürzel eines Wochentags.
 *
 * Gemerkt aus demselben Grund wie der Geldformatierer: dieselbe Zeile steht
 * im Preisraster, im Verfügbarkeitsraster und im Zimmerplan, und in allen
 * dreien einmal **je Tagesspalte**. Bei 400 Tagen entstanden 400 Objekte,
 * nur um dreimal „Mo" zu schreiben.
 */
export function weekdayShort(iso: string, locale: Locale): string {
  let f = wochentage.get(locale)
  if (f === undefined) {
    f = new Intl.DateTimeFormat(INTL_TAG[locale],
      { weekday: 'short', timeZone: 'UTC' })
    wochentage.set(locale, f)
  }
  return f.format(new Date(`${iso}T00:00:00Z`))
}
