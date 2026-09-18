import { createContext, useContext } from 'react'
import type { LocalizedText, MessageLocale } from '@hotelpms/contracts'
import { common } from './common.js'
import { tagesgeschaeft } from './tagesgeschaeft.js'
import { housekeeping } from './housekeeping.js'
import { einrichtung } from './einrichtung.js'
import { folio } from './folio.js'
import { gruppen } from './gruppen.js'
import { plan } from './plan.js'
import { berichte } from './berichte.js'
import { einstellungen } from './einstellungen.js'
import { schnittstellen } from './schnittstellen.js'
import { preise } from './preise.js'
import { gaeste } from './gaeste.js'
import { rechnung } from './rechnung.js'
import { zugang } from './zugang.js'
import { support } from './support.js'
import { admin } from './admin.js'

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
 * und **eine** Zeile hier.
 *
 * Wer einen Bereich hinzufügt: Datei daneben legen, hier importieren, unten
 * in `texts` eintragen. Der Typ `TextKey` wächst von allein mit.
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
export { LOCALES } from '@hotelpms/contracts'
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
  tr: 'tr-TR'
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
  // Tuerkisch schreibt 01.10.2026, mit Punkten und Tag zuerst -- wie Deutsch.
  tr: 'tag-zuerst'
}

const texts = {
  ...common,
  ...tagesgeschaeft,
  ...housekeeping,
  ...einrichtung,
  ...folio,
  ...gruppen,
  ...plan,
  ...berichte,
  ...einstellungen,
  ...schnittstellen,
  ...preise,
  ...gaeste,
  ...rechnung,
  ...zugang,
  ...support,
  ...admin
} as const satisfies Record<string, LocalizedText>

export type TextKey = keyof typeof texts

/** Alle Schluessel. Ein Test prueft damit jede Sprache durch. */
export function textKeys(): TextKey[] {
  return Object.keys(texts) as TextKey[]
}

/** Ein Text ohne React, fuer Tests und fuer den Aufruf ausserhalb einer Komponente. */
export function textFor(key: TextKey, locale: Locale): string {
  return texts[key][locale]
}

export const I18nContext = createContext<Locale>('de')

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
  return (key, params) => {
    const text: string = texts[key][locale]
    if (params === undefined) return text
    return text.replace(/\{(\w+)\}/g, (ganz, name: string) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : ganz)
  }
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
