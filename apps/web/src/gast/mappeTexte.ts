import { createContext, createElement, useContext, type ReactNode } from 'react'
import { FOLDER_LOCALES, sprachKuerzel, type FolderLocale } from '@hotelpms/contracts'
import lader from 'virtual:sprachpaket/mappe'
import { Sprachpakete, useSprachpakete } from '../lib/sprachpaket.js'
import type { texte } from './mappeKatalog.js'

/**
 * Die Saetze der Gaestemappe, je Sprache ein Paket aus `mappeKatalog.ts`.
 * Das Telefon des Gastes holt seine eine Sprache.
 */
export type MappeTextKey = keyof typeof texte
export { FOLDER_LOCALES }
export const mappeTexte = new Sprachpakete<FolderLocale>(lader)

export const MappeSprache = createContext<FolderLocale>('de')

/**
 * Die Sprache der Mappe mit ihrem Paket; an der Stelle von
 * `<MappeSprache.Provider>`. Ohne Paket faellt sie auf Englisch zurueck,
 * wie `startSprache`.
 */
export function MappeSpracheRahmen(
  props: { locale: FolderLocale; children?: ReactNode }
): JSX.Element | null {
  const aktiv = useSprachpakete([mappeTexte], props.locale, 'en')
  if (aktiv === null) return null
  return createElement(MappeSprache.Provider, { value: aktiv }, props.children)
}

/** Die Sprache, mit der die Mappe beginnt: die des Telefons, sonst Englisch. */
export function startSprache(browser: string): FolderLocale {
  const b = sprachKuerzel(browser)
  return (FOLDER_LOCALES as readonly string[]).includes(b) ? b as FolderLocale : 'en'
}

/**
 * Ein Satz in einer Sprache, ohne React -- auch fuer die gedruckte
 * Zimmerkarte. Die Sprache muss geladen sein (`mappeTexte.laden`); fehlt
 * sie, steht der englische Satz da, sonst der Schluessel.
 */
export function mappeText(
  k: MappeTextKey, l: FolderLocale, werte: Record<string, string> = {}
): string {
  let s: string = mappeTexte.paket(l)?.[k] ?? mappeTexte.paket('en')?.[k] ?? k
  for (const [n, v] of Object.entries(werte)) s = s.replaceAll(`{${n}}`, v)
  return s
}

export function useMappeT(): (k: MappeTextKey, werte?: Record<string, string>) => string {
  const l = useContext(MappeSprache)
  return (k, werte) => mappeText(k, l, werte)
}
