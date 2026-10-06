import { roundHalfUp, taxFromGross, type BasisPoints, type Cent } from './money.js'

/**
 * Fachlogik des Kassenbuchs (Migration 0095), ohne Datenbank.
 *
 * Die Regeln sind die des Adminpanels, aus dessen Code uebernommen
 * (`TaxCalculationService`, `KassenbuchService`), nur in Cent statt in
 * PHP-float. Eine Gastbuchung, die dort 87,50 EUR in drei Zeilen zerlegt,
 * muss hier dieselben drei Zeilen ergeben, sonst stimmt nach der Uebernahme
 * der Monat nicht mehr mit dem Adminpanel ueberein.
 */

export const CASHBOOK_KINDS = [
  'lodging', 'breakfast_food', 'breakfast_drinks', 'city_tax',
  'cash_in', 'bank_deposit', 'expense', 'other', 'legacy_guest'
] as const
export type CashbookKind = (typeof CASHBOOK_KINDS)[number]

/** Was an der Rezeption einzeln gebucht werden kann; die Gastbuchung zerlegt sich selbst. */
export const CASHBOOK_SINGLE_KINDS = ['city_tax', 'cash_in', 'bank_deposit', 'expense', 'other'] as const
export type CashbookSingleKind = (typeof CASHBOOK_SINGLE_KINDS)[number]

export const CASHBOOK_TAX_RATES: readonly BasisPoints[] = [0, 700, 1900]

export interface CashbookLine {
  kind: CashbookKind
  amountCent: Cent
  taxRateBp: BasisPoints
}

/**
 * Eine Gastbuchung in ihre Zeilen.
 *
 * Der Gesamtpreis enthaelt das Fruehstueck. Fruehstueck = Anzahl x Preis,
 * davon Speisen (7 %) und Getraenke (19 %) nach dem Anteil des Hauses, je
 * fuer sich gerundet; die Uebernachtung (7 %) ist der Rest, nie negativ.
 * Die Kurtaxe kommt obendrauf und steht mit 7 % wie im Adminpanel. Zeilen
 * mit null entfallen.
 */
export function splitGuestBooking(input: {
  totalCent: Cent
  breakfasts: number
  breakfastPriceCent: Cent
  breakfastFoodShareBp: BasisPoints
  cityTaxCent: Cent
}): CashbookLine[] {
  const fruehstueck = input.breakfasts * input.breakfastPriceCent
  const speisen = roundHalfUp((fruehstueck * input.breakfastFoodShareBp) / 10_000)
  const getraenke = roundHalfUp((fruehstueck * (10_000 - input.breakfastFoodShareBp)) / 10_000)
  const uebernachtung = Math.max(0, input.totalCent - speisen - getraenke)
  const zeilen: CashbookLine[] = [
    { kind: 'lodging', amountCent: uebernachtung, taxRateBp: 700 },
    { kind: 'breakfast_food', amountCent: speisen, taxRateBp: 700 },
    { kind: 'breakfast_drinks', amountCent: getraenke, taxRateBp: 1900 },
    { kind: 'city_tax', amountCent: input.cityTaxCent, taxRateBp: 700 }
  ]
  return zeilen.filter(z => z.amountCent > 0)
}

/**
 * Das Vorzeichen einer Einzelbuchung. Eingegeben wird ein Betrag, wie er
 * auf dem Beleg steht; was die Lade verliert, steht danach negativ.
 * `other` traegt das Vorzeichen der Eingabe, wie "Manuell" im Adminpanel.
 */
export function signedAmount(kind: CashbookSingleKind, inputCent: Cent): Cent {
  switch (kind) {
    case 'bank_deposit':
    case 'expense':
      return -Math.abs(inputCent)
    case 'cash_in':
    case 'city_tax':
      return Math.abs(inputCent)
    case 'other':
      return inputCent
  }
}

/** Der Steuersatz, den eine Art fest hat, oder `null`, wenn er frei ist. */
export function fixedTaxRate(kind: CashbookSingleKind): BasisPoints | null {
  switch (kind) {
    case 'city_tax': return 700
    case 'cash_in':
    case 'bank_deposit': return 0
    case 'expense':
    case 'other': return null
  }
}

export interface CashbookTaxGroup {
  rateBp: BasisPoints
  grossCent: Cent
  netCent: Cent
  taxCent: Cent
}

/**
 * Steuer je Satzgruppe aus der Summe, nicht als Summe je Zeile gerundeter
 * Betraege (CLAUDE.md, Geld und Datum). Vorzeichen bleiben: Ausgaben mindern
 * die Gruppe. Satz 0 erscheint nur, wenn es Zeilen dazu gibt.
 */
export function cashbookTaxGroups(lines: ReadonlyArray<{ amountCent: Cent; taxRateBp: BasisPoints }>
): CashbookTaxGroup[] {
  const summen = new Map<BasisPoints, Cent>()
  for (const l of lines) summen.set(l.taxRateBp, (summen.get(l.taxRateBp) ?? 0) + l.amountCent)
  return [...summen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rateBp, grossCent]) => {
      const taxCent = taxFromGross(grossCent, rateBp)
      return { rateBp, grossCent, netCent: grossCent - taxCent, taxCent }
    })
}
