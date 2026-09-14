import type { Cent, BasisPoints } from './money.js'
import { netFromGross, taxFromNet } from './money.js'

/**
 * Die Aufteilung einer Anzahlung auf die Steuersaetze (Aufgabe 3, B4 in
 * Dokument 13 -- dort als der Punkt genannt, der "nicht trivial" ist).
 *
 * **Warum sie noetig ist.** Eine Anzahlung ist ein pauschaler Betrag, die
 * spaetere Leistung ist es nicht: die Uebernachtung traegt den ermaessigten
 * Satz, das Fruehstueck teilt sich in Speisen und Getraenke. Die
 * Anzahlungsrechnung muss die Steuer aber schon jetzt je Satz ausweisen
 * (§ 14 Abs. 5 UStG). Wer pauschal den vollen Satz nimmt, weist zu viel aus
 * und muss jede Schlussrechnung korrigieren; wer pauschal den ermaessigten
 * nimmt, weist zu wenig aus und schuldet die Differenz.
 *
 * Aufgeteilt wird deshalb **im Verhaeltnis der erwarteten Leistung**.
 */

/** Ein Bruttobetrag, der zu genau einem Steuersatz gehoert. */
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
function largestRemainder(total: Cent, weights: readonly number[]): Cent[] {
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
 * Fasst die erwartete Leistung zu Bruttobetraegen je Steuersatz zusammen.
 *
 * Ein Posten mit Aufteilung zerfaellt dabei in zwei: 12,00 Euro Fruehstueck
 * mit 30 Prozent Getraenkeanteil sind 8,40 Euro zum ermaessigten und 3,60
 * Euro zum vollen Satz. Gerundet wird auf den Cent, und der Rest bleibt beim
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
 * Die Summe der Teile ist **immer** der vereinnahmte Betrag. Das ist keine
 * Feinheit: die Anzahlungsrechnung weist diese Teile aus, und eine Differenz
 * zwischen ausgewiesener Summe und Zahlungseingang ist genau die Art Fehler,
 * die erst der Betriebspruefer findet.
 *
 * Ohne erwartete Leistung gibt es nichts zu verteilen; dann muss der
 * Aufrufer den Satz selbst angeben.
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

/** Eine Position der Anzahlungsrechnung: Nettobetrag zu einem Satz. */
export interface DepositLine {
  rateBp: BasisPoints
  netCent: Cent
}

/** Was die Rechnung aus diesen Nettobetraegen als Brutto ausweisen wird. */
function ausgewiesen(lines: readonly DepositLine[]): Cent {
  return lines.reduce((s, l) => s + l.netCent + taxFromNet(l.netCent, l.rateBp), 0)
}

/**
 * Die Nettobetraege der Anzahlungsrechnung, so gewaehlt, dass die Rechnung
 * den **vereinnahmten Betrag** ausweist.
 *
 * Warum das nicht von selbst aufgeht: die Steuer wird je Satzgruppe aus der
 * Nettosumme gerechnet -- so verlangt es die Norm (BR-CO-14) und so rechnet
 * das ganze Haus. Netto und Steuer sind aber beide gerundet, und damit ist
 * nicht jeder Bruttobetrag darstellbar: zu 7 Prozent gibt es kein Netto, das
 * 250,00 Euro ergibt, sondern nur 249,99 oder 250,01. Der naive Weg --
 * Netto aus dem Brutto herausrechnen und die Steuer wieder daraufschlagen --
 * verfehlt den Betrag bei jeder fuenfzehnten Anzahlung um einen Cent.
 *
 * Getroffen wird er deshalb absichtlich: ausgehend vom herausgerechneten
 * Netto wird um je einen Cent nachgestellt, solange das naeher an den
 * vereinnahmten Betrag fuehrt. Bei mehreren Saetzen geht das fast immer auf,
 * weil die Saetze verschieden runden; bleibt am Ende ein Cent, ist er
 * mathematisch nicht vermeidbar, und dann ist es der kleinstmoegliche.
 */
export function depositLines(
  depositGross: Cent, parts: readonly RateGroupAmount[]
): DepositLine[] {
  const lines = parts.map(p => ({ rateBp: p.rateBp, netCent: netFromGross(p.grossCent, p.rateBp) }))

  // Hoechstens so viele Schritte, wie es Positionen gibt, plus einer: jeder
  // Schritt verkleinert den Abstand, sonst wird abgebrochen.
  for (let schritt = 0; schritt <= lines.length; schritt++) {
    const abstand = depositGross - ausgewiesen(lines)
    if (abstand === 0) break

    const richtung = abstand > 0 ? 1 : -1
    let beste: { index: number; abstand: number } | null = null
    for (const [i, l] of lines.entries()) {
      const probe = [...lines]
      probe[i] = { rateBp: l.rateBp, netCent: l.netCent + richtung }
      const neu = Math.abs(depositGross - ausgewiesen(probe))
      if (beste === null || neu < beste.abstand) beste = { index: i, abstand: neu }
    }
    if (beste === null || beste.abstand >= Math.abs(abstand)) break
    lines[beste.index] = {
      rateBp: lines[beste.index]!.rateBp,
      netCent: lines[beste.index]!.netCent + richtung
    }
  }
  return lines
}
