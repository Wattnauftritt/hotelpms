import type { Cent, BasisPoints } from './money.js'
import { taxFromGross } from './money.js'

/**
 * Anzahlungen und ihre Steuerpflicht (Aufgabe 3, B4 in Dokument 13).
 *
 * **Warum eine Anzahlung nicht einfach ein Zahlungsvermerk ist.** Nach
 * § 13 Abs. 1 Nr. 1a UStG entsteht die Umsatzsteuer auf eine Anzahlung mit
 * der **Vereinnahmung**, nicht mit der Leistung. Das Haus schuldet die
 * Steuer also im Monat des Geldeingangs, Monate bevor der Gast anreist.
 * Ein `settlement` ohne Rechnung waere nur ein negativer Saldo und
 * steuerlich unsichtbar; das Finanzamt saehe die Anzahlung nie.
 *
 * **Warum die Aufteilung auf die Saetze das eigentliche Problem ist.** Eine
 * Anzahlung ist ein pauschaler Betrag, die spaetere Leistung ist es nicht:
 * die Uebernachtung traegt 7 Prozent, das Fruehstueck teilt sich in Speisen
 * und Getraenke. Die Anzahlungsrechnung muss die Steuer aber schon jetzt je
 * Satz ausweisen (§ 14 Abs. 5 UStG). Wer pauschal den vollen Satz nimmt,
 * weist zu viel aus und muss jede Schlussrechnung korrigieren; wer pauschal
 * den ermaessigten nimmt, weist zu wenig aus und schuldet die Differenz.
 *
 * Aufgeteilt wird deshalb **im Verhaeltnis der erwarteten Leistung**.
 */

/** Ein Betrag, der zu genau einem Steuersatz gehoert. */
export interface RateGroupAmount {
  rateBp: BasisPoints
  grossCent: Cent
}

/**
 * Ein Posten der erwarteten Leistung.
 *
 * `splitShareBp` und `splitRateBp` bilden den Posten ab, der **selbst** zwei
 * Saetze traegt: das Fruehstuecksbuffet. Speisen in der Gastronomie sind
 * ermaessigt, Getraenke nicht, und ein Buffet ist beides in einem Preis.
 * Das Haus legt das Verhaeltnis fest -- ueblich sind 30 Prozent Getraenke.
 */
export interface ExpectedItem {
  grossCent: Cent
  rateBp: BasisPoints
  /** Anteil am Bruttobetrag, der zum zweiten Satz gehoert. 3000 = 30 %. */
  splitShareBp?: number | null
  splitRateBp?: BasisPoints | null
}

/** Verteilt Restcents dorthin, wo der Bruchteil am groessten war. */
function largestRemainder(
  total: Cent, weights: readonly number[]
): Cent[] {
  const summe = weights.reduce((s, w) => s + w, 0)
  if (summe <= 0) return weights.map(() => 0)

  const roh = weights.map(w => (total * w) / summe)
  const abgerundet = roh.map(v => Math.floor(v))
  let rest = total - abgerundet.reduce((s, v) => s + v, 0)

  // Nach dem groessten Bruchteil, bei Gleichstand nach der Reihenfolge:
  // sonst haengt das Ergebnis von der Sortierung der Eingabe ab und zwei
  // gleiche Anzahlungen ergaeben verschiedene Zahlen.
  const reihenfolge = roh
    .map((v, i) => ({ i, bruch: v - Math.floor(v) }))
    .sort((a, b) => b.bruch - a.bruch || a.i - b.i)

  const ergebnis = [...abgerundet]
  for (const { i } of reihenfolge) {
    if (rest <= 0) break
    ergebnis[i] = ergebnis[i]! + 1
    rest -= 1
  }
  return ergebnis
}

/**
 * Fasst die erwartete Leistung zu Betraegen je Steuersatz zusammen.
 *
 * Ein Posten mit Aufteilung zerfaellt dabei in zwei: 12,00 Euro Fruehstueck
 * mit 30 Prozent Getraenkeanteil sind 8,40 Euro zu 7 und 3,60 Euro zu
 * 19 Prozent. Gerundet wird auf den Cent, und der Rest bleibt beim
 * Hauptsatz -- die Summe der Teile ist immer der Ausgangsbetrag.
 */
export function expectedRateMix(items: readonly ExpectedItem[]): RateGroupAmount[] {
  const nachSatz = new Map<BasisPoints, Cent>()
  const dazu = (rateBp: BasisPoints, grossCent: Cent): void => {
    if (grossCent === 0) return
    nachSatz.set(rateBp, (nachSatz.get(rateBp) ?? 0) + grossCent)
  }

  for (const item of items) {
    const anteil = item.splitShareBp ?? 0
    const zweiterSatz = item.splitRateBp
    if (anteil > 0 && zweiterSatz !== null && zweiterSatz !== undefined) {
      const zweiter = Math.round((item.grossCent * anteil) / 10_000)
      dazu(zweiterSatz, zweiter)
      dazu(item.rateBp, item.grossCent - zweiter)
    } else {
      dazu(item.rateBp, item.grossCent)
    }
  }

  return [...nachSatz.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rateBp, grossCent]) => ({ rateBp, grossCent }))
}

/**
 * Teilt eine pauschale Anzahlung im Verhaeltnis der erwarteten Leistung auf
 * die Steuersaetze auf.
 *
 * Die Summe der Teile ist **immer** der Anzahlungsbetrag. Das ist keine
 * Feinheit: die Anzahlungsrechnung weist diese Teile aus, und ein Cent
 * Differenz zwischen ausgewiesener Summe und vereinnahmtem Betrag ist genau
 * die Art Fehler, die erst der Betriebspruefer findet.
 *
 * Ohne erwartete Leistung gibt es nichts zu verteilen; dann muss der
 * Aufrufer die Saetze selbst angeben.
 */
export function splitDeposit(
  depositGross: Cent, mix: readonly RateGroupAmount[]
): RateGroupAmount[] {
  if (mix.length === 0) return []
  if (mix.length === 1) return [{ rateBp: mix[0]!.rateBp, grossCent: depositGross }]

  const teile = largestRemainder(depositGross, mix.map(m => m.grossCent))
  return mix
    .map((m, i) => ({ rateBp: m.rateBp, grossCent: teile[i]! }))
    .filter(t => t.grossCent !== 0)
}

export interface DepositTaxGroup {
  rateBp: BasisPoints
  netCent: Cent
  taxCent: Cent
  grossCent: Cent
}

/**
 * Rechnet die aufgeteilte Anzahlung in Netto und Steuer um.
 *
 * Brutto herein, weil eine Anzahlung als Bruttobetrag vereinbart wird: der
 * Gast ueberweist 200 Euro, nicht 186,92 plus Steuer.
 */
export function depositTaxGroups(
  parts: readonly RateGroupAmount[]
): DepositTaxGroup[] {
  return parts.map(p => {
    const taxCent = taxFromGross(p.grossCent, p.rateBp)
    return { rateBp: p.rateBp, netCent: p.grossCent - taxCent, taxCent, grossCent: p.grossCent }
  })
}

/**
 * Der Betrag, der nach Anrechnung der Anzahlungen offen bleibt.
 * Eine Anzahlung mindert die Schlussrechnung, sie mindert nicht die
 * Leistung: die Schlussrechnung lautet weiter ueber den vollen Betrag
 * (§ 14 Abs. 5 Satz 2 UStG).
 */
export function openAfterDeposits(invoiceGross: Cent, depositsGross: Cent): Cent {
  return invoiceGross - depositsGross
}
