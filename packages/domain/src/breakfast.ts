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
 * Eine Nacht in Logis, Speisen und Getraenke.
 *
 * Das Fruehstueck ist Preis mal Personen, aber nie mehr als die Nacht
 * selbst: ein Ratenpreis unter dem Fruehstueckswert ist eine Frage an die
 * Stammdaten, kein Grund, eine negative Logis zu buchen. Gerundet wird
 * einmal, beim Getraenkeanteil; die Speisen sind der Rest, damit die drei
 * Teile immer genau den Nachtpreis ergeben.
 */
export function splitNight(input: {
  priceCent: Cent
  breakfastCent: Cent | null
  persons: number
}): NightSplit {
  const preis = Math.max(input.priceCent, 0)
  const fruehstueck = input.breakfastCent === null
    ? 0
    : Math.min(input.breakfastCent * Math.max(input.persons, 1), preis)
  const getraenke = roundHalfUp((fruehstueck * BREAKFAST_DRINKS_SHARE_BP) / 10_000)
  return {
    lodgingCent: preis - fruehstueck,
    foodCent: fruehstueck - getraenke,
    drinksCent: getraenke
  }
}
