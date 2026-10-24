import { createContext, createElement, useContext, type ReactNode } from 'react'
import { SPRACHNAMEN, STAFF_LOCALES, sprachKuerzel, type StaffLocale } from '@hotelpms/contracts'
import lader from 'virtual:sprachpaket/personal'
import { ApiError } from '../lib/api.js'
import { einsetzen, Sprachpakete, useSprachpakete } from '../lib/sprachpaket.js'
import type { texte } from './katalog.js'

/**
 * Die Saetze der Personal-App, je Sprache ein Paket aus `katalog.ts`. Auf
 * dem Telefon der Kraft liegt damit ihre eine Sprache, nicht alle
 * dreiunddreissig.
 */
export type PersonalKey = keyof typeof texte
export const personalTexte = new Sprachpakete<StaffLocale>(lader)

/** Wie sich eine Sprache selbst nennt; die Tabelle steht im Vertrag. */
export const SPRACHNAME: Record<StaffLocale, string> = SPRACHNAMEN

/**
 * Die Sprache, in der die App startet: die am Benutzer gespeicherte, sonst
 * die des Telefons, sonst Deutsch. Eine gespeicherte Sprache, die diese App
 * nicht spricht, faellt auf das Telefon zurueck und nicht gleich auf
 * Deutsch.
 */
export function startSprache(
  gespeichert: string | null | undefined, telefon: string
): StaffLocale {
  const passt = (s: string | null | undefined): s is StaffLocale =>
    typeof s === 'string' && (STAFF_LOCALES as readonly string[]).includes(s)
  if (passt(gespeichert)) return gespeichert
  const kurz = sprachKuerzel(telefon)
  return passt(kurz) ? kurz : 'de'
}

export const SpracheContext = createContext<StaffLocale>('de')

/**
 * Die Sprache der App mit ihrem Paket; an der Stelle von
 * `<SpracheContext.Provider>`. Beim Umstellen bleibt die bisherige stehen,
 * bis die neue da ist.
 */
export function PersonalSprache(
  props: { locale: StaffLocale; children?: ReactNode }
): JSX.Element | null {
  const aktiv = useSprachpakete([personalTexte], props.locale, 'de')
  if (aktiv === null) return null
  return createElement(SpracheContext.Provider, { value: aktiv }, props.children)
}

/** Ein Satz in einer geladenen Sprache; ohne Paket der deutsche, sonst der Schluessel. */
export function text(
  key: PersonalKey, locale: StaffLocale, params?: Record<string, string | number>
): string {
  const satz = personalTexte.paket(locale)?.[key] ?? personalTexte.paket('de')?.[key] ?? key
  return einsetzen(satz, params)
}

export function usePT(): (key: PersonalKey, params?: Record<string, string | number>)
  => string {
  const locale = useContext(SpracheContext)
  return (key, params) => text(key, locale, params)
}

/**
 * Ein Fehler der Schnittstelle als Satz in der Sprache des Personals.
 *
 * Bekannte Schluessel bekommen ihren Satz von hier, auch an einem Feld
 * (`errorKeys` bei 422). Alles andere wird zum allgemeinen Satz -- nicht
 * zum deutschen Text der Schnittstelle: wer kein Deutsch liest, hat von
 * einem genauen Satz, den er nicht versteht, weniger als von einem
 * ungenauen in seiner Sprache. Auf Deutsch steht der genaue Satz da.
 */
export function fehlerText(e: unknown, locale: StaffLocale): string {
  if (!(e instanceof ApiError)) return text('error.generic', locale)
  const p = e.problem
  const schluessel = [p.code, ...Object.values(p.errorKeys ?? {}).flat()]
  const params = (p.params ?? {}) as Record<string, string | number>
  for (const k of schluessel) {
    if (k === undefined) continue
    const eigen = `error.${k}`
    const paket = personalTexte.paket(locale) ?? personalTexte.paket('de') ?? {}
    if (Object.prototype.hasOwnProperty.call(paket, eigen)) {
      return text(eigen as PersonalKey, locale, params)
    }
  }
  if (locale === 'de') return p.detail ?? p.title
  return text('error.generic', locale)
}
