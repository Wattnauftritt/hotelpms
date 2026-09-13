/**
 * Geld ist immer eine ganze Zahl in Cent. Nie Fliesskomma.
 * Steuersaetze in Basispunkten: 700 = 7 %, 1900 = 19 %.
 */
export type Cent = number
export type BasisPoints = number

export const VAT_ACCOMMODATION: BasisPoints = 700
export const VAT_STANDARD: BasisPoints = 1900

/** Kaufmaennisch runden, symmetrisch um null. */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

/** Steuer aus einem Bruttobetrag herausrechnen. */
export function taxFromGross(gross: Cent, rateBp: BasisPoints): Cent {
  return roundHalfUp((gross * rateBp) / (10_000 + rateBp))
}

/** Steuer auf einen Nettobetrag aufschlagen. */
export function taxFromNet(net: Cent, rateBp: BasisPoints): Cent {
  return roundHalfUp((net * rateBp) / 10_000)
}

export function netFromGross(gross: Cent, rateBp: BasisPoints): Cent {
  return gross - taxFromGross(gross, rateBp)
}

export interface TaxGroupTotal {
  rateBp: BasisPoints
  netCent: Cent
  taxCent: Cent
  grossCent: Cent
}

export interface InvoiceTotals {
  groups: TaxGroupTotal[]
  netCent: Cent
  taxCent: Cent
  grossCent: Cent
}

/**
 * Summiert Positionen zu Rechnungssummen.
 *
 * Entscheidend: die Steuer wird **je Satzgruppe aus der Nettosumme**
 * berechnet, nicht als Summe der je Zeile gerundeten Steuerbetraege.
 * Zwanzig Fruehstuecke zu 8,40 Euro ergeben sonst einen anderen Betrag als
 * 168,00 Euro mal 19 Prozent, und ein Betriebspruefer findet die Differenz
 * (B5, Dokument 13).
 */
export function sumInvoice(
  lines: ReadonlyArray<{ netCent: Cent; rateBp: BasisPoints }>
): InvoiceTotals {
  const byRate = new Map<BasisPoints, Cent>()
  for (const l of lines) {
    byRate.set(l.rateBp, (byRate.get(l.rateBp) ?? 0) + l.netCent)
  }
  const groups: TaxGroupTotal[] = [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rateBp, netCent]) => {
      const taxCent = taxFromNet(netCent, rateBp)
      return { rateBp, netCent, taxCent, grossCent: netCent + taxCent }
    })
  return {
    groups,
    netCent: groups.reduce((s, g) => s + g.netCent, 0),
    taxCent: groups.reduce((s, g) => s + g.taxCent, 0),
    grossCent: groups.reduce((s, g) => s + g.grossCent, 0)
  }
}

/**
 * Teilt einen Paketpreis auf Logis und Zusatzleistungen auf.
 * In Deutschland gilt 7 Prozent auf die Uebernachtung und 19 Prozent auf
 * Leistungen, die nicht unmittelbar der Vermietung dienen. Ein Zimmerpreis
 * mit Fruehstueck muss daher aufgeteilt werden.
 *
 * Die Zusatzleistungen werden mit ihrem festen Bruttowert angesetzt, der
 * Rest ist Logis. Das ist das in der Praxis uebliche Verfahren.
 */
export interface PackageSplitPart {
  code: string
  grossCent: Cent
  rateBp: BasisPoints
}

export function splitPackage(
  totalGross: Cent,
  extras: ReadonlyArray<{ code: string; grossCent: Cent; rateBp: BasisPoints }>
): PackageSplitPart[] {
  const extrasSum = extras.reduce((s, e) => s + e.grossCent, 0)
  if (extrasSum > totalGross) {
    throw new Error('Zusatzleistungen uebersteigen den Paketpreis')
  }
  return [
    { code: 'accommodation', grossCent: totalGross - extrasSum, rateBp: VAT_ACCOMMODATION },
    ...extras.map(e => ({ code: e.code, grossCent: e.grossCent, rateBp: e.rateBp }))
  ]
}
