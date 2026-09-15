import { createContext, useContext } from 'react'
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
 * in `texts` eintragen. Der Typ `TextKey` wächst von allein mit; ein
 * Schlüssel, den es in einer der beiden Sprachen nicht gibt, fällt beim
 * Typecheck auf.
 */
export const LOCALES = ['de', 'en'] as const
export type Locale = (typeof LOCALES)[number]

const texts = {
  de: {
    ...common.de,
    ...tagesgeschaeft.de,
    ...housekeeping.de,
    ...einrichtung.de,
    ...folio.de,
    ...gruppen.de,
    ...plan.de,
    ...berichte.de,
    ...einstellungen.de,
    ...schnittstellen.de,
    ...preise.de,
    ...gaeste.de,
    ...rechnung.de
  },
  en: {
    ...common.en,
    ...tagesgeschaeft.en,
    ...housekeeping.en,
    ...einrichtung.en,
    ...folio.en,
    ...gruppen.en,
    ...plan.en,
    ...berichte.en,
    ...einstellungen.en,
    ...schnittstellen.en,
    ...preise.en,
    ...gaeste.en,
    ...rechnung.en
  }
} as const

export type TextKey = keyof (typeof texts)['de']

/** Alle Schluessel. Ein Test prueft damit beide Sprachen durch. */
export function textKeys(): TextKey[] {
  return Object.keys(texts.de) as TextKey[]
}

/** Ein Text ohne React, fuer Tests und fuer den Aufruf ausserhalb einer Komponente. */
export function textFor(key: TextKey, locale: Locale): string {
  return texts[locale][key] ?? key
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
    const text: string = texts[locale][key] ?? key
    if (params === undefined) return text
    return text.replace(/\{(\w+)\}/g, (ganz, name: string) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : ganz)
  }
}

export function useLocale(): Locale {
  return useContext(I18nContext)
}

/** Cent als Betrag in der Sprache des Betrachters. */
export function formatMoney(cent: number, locale: Locale, currency = 'EUR'): string {
  return new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-GB',
    { style: 'currency', currency }).format(cent / 100)
}

/** Aufenthaltsdaten sind Kalenderdaten, keine Zeitpunkte. Nie als Date parsen. */
export function formatDate(iso: string, locale: Locale): string {
  const [y, m, d] = iso.split('-')
  return locale === 'de' ? `${d}.${m}.${y}` : `${y}-${m}-${d}`
}

export function weekdayShort(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB',
    { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`))
}
