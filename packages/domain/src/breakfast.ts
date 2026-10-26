import { roundHalfUp, type BasisPoints, type Cent } from './money.js'

/**
 * Fruehstueck im Zimmerpreis (Migration 0158).
 *
 * Beherbergung traegt 7 %, das Fruehstueck nicht unbedingt denselben Satz:
 * die Speisen seit 2026 ebenfalls 7 %, die Getraenke 19 %. Ein Ratenpreis
 * mit Fruehstueck muss deshalb aufgeteilt werden (Aufteilungsgebot,
 * § 12 Abs. 2 Nr. 11 Satz 2 UStG).
 *
 * Den Getraenkeanteil gibt das BMF pauschal mit 30 % des Fruehstueckspreises
 * vor (Schreiben vom 22.12.2025 zu Kombiangeboten). Er ist ein Wert aus dem
 * Gesetz, keine Einstellung des Hauses: ein Feld dafuer luede dazu ein, ihn
 * "passend" zu setzen. Die Alternative des Schreibens -- 15 % des
 * Paketpreises als Business-Package -- nutzen wir nicht; sie gilt nur fuer
 * Pakete mit nicht naeher bestimmten Nebenleistungen.
 */
export const BREAKFAST_DRINKS_SHARE_BP: BasisPoints = 3000
export const BREAKFAST_FOOD_RATE_BP: BasisPoints = 700
export const BREAKFAST_DRINKS_RATE_BP: BasisPoints = 1900

/** Konten in SKR03; der DATEV-Stapel setzt keinen Steuerschluessel, das Konto traegt den Satz. */
export const BREAKFAST_FOOD_ACCOUNT = '8300'
export const BREAKFAST_DRINKS_ACCOUNT = '8400'

export interface NightSplit {
  lodgingCent: Cent
  foodCent: Cent
  drinksCent: Cent
}

/**
 * Das Fruehstueck einer Nacht, brutto.
 *
 * Kinder zahlen nur dann einen eigenen Preis, wenn die Rate einen hat
 * (`childCent`, 0 heisst frei) **und** die Buchung Erwachsene und Kinder
 * getrennt nennt. Nennt sie nur eine Gesamtzahl, laesst sich nicht ablesen,
 * wer davon Kind ist (Migration 0076); dann zahlen alle den Preis fuer
 * Erwachsene, mindestens eine Person.
 */
export function breakfastPerNight(input: {
  adultCent: Cent | null
  childCent: Cent | null
  persons: number
  adults: number | null
  children: number | null
}): Cent {
  if (input.adultCent === null) return 0
  if (input.childCent !== null && input.adults !== null) {
    return input.adults * input.adultCent + (input.children ?? 0) * input.childCent
  }
  return Math.max(input.persons, 1) * input.adultCent
}

/**
 * Wie viele Fruehstuecke eine Nacht berechnet: die Menge auf Folio und
 * Rechnung (Sven, 26.10.2026: "5 personen mal 2 naechte also 10
 * fruehstuecke"). § 14 Abs. 4 Nr. 5 UStG verlangt den Umfang der Leistung,
 * und ein Arbeitgeber kuerzt die Verpflegungspauschale je gestelltem
 * Fruehstueck (§ 9 Abs. 4a EStG); "2" fuer zwei Naechte zu fuenft sagt
 * beiden das Falsche.
 *
 * Gezaehlt wird, wer bezahlt, nach derselben Regel wie
 * `breakfastPerNight`: ein freies Kinderfruehstueck (`childCent` 0) steht
 * nicht in der Menge, sonst laege der Einzelpreis auf der Rechnung unter
 * dem Preis, den ein Erwachsener zahlt.
 */
export function breakfastCount(input: {
  childCent: Cent | null
  persons: number
  adults: number | null
  children: number | null
}): number {
  if (input.childCent !== null && input.adults !== null) {
    return Math.max(input.adults + (input.childCent > 0 ? input.children ?? 0 : 0), 1)
  }
  return Math.max(input.persons, 1)
}

/**
 * Eine Nacht in Logis, Speisen und Getraenke.
 *
 * Nie mehr Fruehstueck als die Nacht selbst: ein Ratenpreis unter dem
 * Fruehstueckswert ist eine Frage an die Stammdaten, kein Grund, eine
 * negative Logis zu buchen. Gerundet wird einmal, beim Getraenkeanteil; die
 * Speisen sind der Rest, damit die drei Teile immer genau den Nachtpreis
 * ergeben.
 */
export function splitNight(input: { priceCent: Cent; breakfastCent: Cent }): NightSplit {
  const preis = Math.max(input.priceCent, 0)
  const fruehstueck = Math.min(Math.max(input.breakfastCent, 0), preis)
  const getraenke = roundHalfUp((fruehstueck * BREAKFAST_DRINKS_SHARE_BP) / 10_000)
  return {
    lodgingCent: preis - fruehstueck,
    foodCent: fruehstueck - getraenke,
    drinksCent: getraenke
  }
}
