/**
 * Geld ist immer eine ganze Zahl in Cent. Nie Fliesskomma.
 * Steuersaetze in Basispunkten: 700 = 7 %, 1900 = 19 %.
 */
export type Cent = number
export type BasisPoints = number

export const VAT_ACCOMMODATION: BasisPoints = 700
export const VAT_STANDARD: BasisPoints = 1900

/**
 * 123456 wird zu 1.234,56. Ganzzahlig gerechnet, nie ueber Fliesskomma:
 * `(cent / 100).toFixed(2)` ist bei grossen Betraegen nicht mehr genau, und
 * bei Geld faellt das als fehlender Cent auf, nicht als Rundungsfehler.
 *
 * Liegt hier und nicht im PDF-Blatt, weil inzwischen auch die Gastpost
 * Betraege schreibt. Zwei Formatierer fuer dieselbe Waehrung laufen
 * auseinander, und der Unterschied faellt erst auf, wenn Rechnung und
 * Anschreiben nebeneinander liegen.
 */
export function formatCent(cent: Cent): string {
  const negativ = cent < 0
  const abs = Math.abs(Math.trunc(cent))
  const ganz = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${negativ ? '-' : ''}${ganz},${String(abs % 100).padStart(2, '0')}`
}

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
 * Gleicht die Nettobetraege der Positionen so aus, dass jede Satzgruppe
 * der Rechnung genau das Brutto ergibt, das gebucht wurde.
 *
 * **Warum.** Jede Buchung rundet ihre Steuer fuer sich: eine Nacht zu
 * 89,33 brutto wird 78,35 Logis + 3,60 Speisen + 1,39 Getraenke netto, und
 * jede der drei Steuern ist auf den Cent gerundet. Die Rechnung rechnet die
 * Steuer dagegen je Satzgruppe aus der Nettosumme (BR-CO-14). Ueber drei
 * Naechte summierten sich die Rundungen der Zeilen zu drei Cent, und die
 * Rechnung forderte 268,03 statt der gebuchten und bezahlten 268,00 -- der
 * Ausgleich (BT-114) stand dann als "Rundung -0,03" auf dem Blatt (Sven,
 * 14.10.2026: "kein anderes Hotel arbeitet hier mit Rundungen").
 *
 * Gesucht wird je Gruppe das Netto N, fuer das N + Steuer(N) das gebuchte
 * Brutto trifft, so nah wie moeglich an der Summe der Zeilen. Den
 * Unterschied traegt die betragsgroesste Zeile der Gruppe -- bei einer
 * Uebernachtung die Logis, deren Netto sich um ein, zwei Cent verschiebt.
 * Die Buchungen selbst bleiben, wie sie sind; nur die Rechnung weist ihr
 * Netto so aus, dass Netto und Steuer zusammen das Brutto ergeben.
 *
 * Nicht jedes Brutto ist so darstellbar (zu 7 Prozent jeder sechzehnte
 * Cent-Betrag). Dann bleibt der naechste darstellbare, und der eine Cent
 * steht weiter als Ausgleich da -- seltener und nie mehr als einer je Satz.
 *
 * `fest` sind Zeilen, die mitzaehlen, aber nichts tragen duerfen
 * (die Verrechnung einer Anzahlung: deren Netto steht auf ihrer eigenen
 * Rechnung).
 */
export function alignLineNets<K>(
  lines: ReadonlyArray<{ key: K; netCent: Cent; grossCent: Cent; rateBp: BasisPoints
                         fest?: boolean }>
): Map<K, Cent> {
  const gruppen = new Map<BasisPoints, typeof lines[number][]>()
  for (const l of lines) {
    gruppen.set(l.rateBp, [...(gruppen.get(l.rateBp) ?? []), l])
  }
  const ausgleich = new Map<K, Cent>()
  for (const [rateBp, zeilen] of gruppen) {
    const netto = zeilen.reduce((s, l) => s + l.netCent, 0)
    const brutto = zeilen.reduce((s, l) => s + l.grossCent, 0)
    const traeger = zeilen.filter(l => !l.fest)
      .reduce<typeof zeilen[number] | null>((b, l) =>
        b === null || Math.abs(l.netCent) > Math.abs(b.netCent) ? l : b, null)
    if (traeger === null || rateBp === 0) continue
    // Jede Zeile hat hoechstens einen halben Cent Steuer verloren oder
    // gewonnen; weiter als die Zahl der Zeilen liegt das Ziel nicht.
    const weite = zeilen.length + 2
    let bestes = netto
    let abstand = Math.abs(netto + taxFromNet(netto, rateBp) - brutto)
    for (let d = 1; d <= weite && abstand > 0; d++) {
      for (const n of [netto - d, netto + d]) {
        const a = Math.abs(n + taxFromNet(n, rateBp) - brutto)
        if (a < abstand) { bestes = n; abstand = a }
      }
    }
    // Die Zeile darf dabei nicht das Vorzeichen wechseln: aus einer
    // Leistung wuerde sonst eine Gutschrift.
    const neu = traeger.netCent + bestes - netto
    if (bestes !== netto && Math.sign(neu) === Math.sign(traeger.netCent)) {
      ausgleich.set(traeger.key, bestes - netto)
    }
  }
  return ausgleich
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
