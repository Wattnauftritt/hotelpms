/**
 * Reinigungsplan: Sollminuten und Vorschlag der Zuteilung (Aufgabe 18,
 * Baustein 2).
 *
 * **Sollminuten sind die Abrechnungsgrundlage, keine Schaetzung.** Das
 * Personal kommt von einer Zeitarbeitsfirma und wird vertraglich nach
 * Pauschalminuten je Zimmer abgerechnet (Sven, 07.10.2026). Die alte App
 * hatte sie im Code stehen (Abreise 30, Bleiber 10, einzelne Zimmer mehr);
 * hier stehen sie je Haus in `cleaning_norm`, und diese Datei sagt nur, was
 * gilt, wenn das Haus nichts eingetragen hat.
 */

export const CLEANING_KINDS = ['departure', 'stayover'] as const
export type CleaningKind = (typeof CLEANING_KINDS)[number]

/** Die Vorgabe der alten App, wenn ein Haus nichts eingetragen hat. */
export const DEFAULT_CLEANING_MINUTES: Record<CleaningKind, number> = {
  departure: 30,
  stayover: 10
}

/** Mehr als ein Arbeitstag fuer ein Zimmer ist ein Tippfehler. */
export const CLEANING_MINUTES_MAX = 480

export interface CleaningNorm {
  kind: CleaningKind
  /** Gilt fuer alle Zimmer der Kategorie, wenn kein Zimmer genannt ist. */
  categoryId: number | null
  /** Gilt fuer genau dieses Zimmer. Schlaegt die Kategorie. */
  resourceId: number | null
  minutes: number
}

/**
 * Die Sollminuten eines Zimmers: Zimmer vor Kategorie vor Haus vor Vorgabe.
 *
 * Das Zimmer gewinnt, weil es die Ausnahme ist, die jemand bewusst
 * eingetragen hat ("Zimmer 8 hat zwei Baeder"); die Kategorie ist die Regel
 * ("Gaestehaus 20 Minuten").
 */
export function resolveCleaningMinutes(
  norms: readonly CleaningNorm[], room: { resourceId: number; categoryId: number },
  kind: CleaningKind
): number {
  const passend = norms.filter(n => n.kind === kind)
  return passend.find(n => n.resourceId === room.resourceId)?.minutes
    ?? passend.find(n => n.resourceId === null && n.categoryId === room.categoryId)?.minutes
    ?? passend.find(n => n.resourceId === null && n.categoryId === null)?.minutes
    ?? DEFAULT_CLEANING_MINUTES[kind]
}

/**
 * Zimmer auf Kraefte verteilen, so gleich wie moeglich und am Stueck.
 *
 * Die Zimmer kommen in der Reihenfolge, in der man durchs Haus geht
 * (Gebaeude, Etage, Nummer). Jede Kraft bekommt einen **zusammenhaengenden
 * Abschnitt** dieser Reihe -- eine Etage oder ein Flur, nicht jedes dritte
 * Zimmer quer durchs Haus. Unter dieser Bedingung ist die Aufteilung
 * optimal: die laengste Einzellast ist so klein wie moeglich (lineare
 * Partition, dynamische Programmierung; bei 250 Zimmern und zehn Kraeften
 * gut eine halbe Million Schritte).
 *
 * Gleichmaessig nach Minuten und nicht nach Zimmerzahl: zwei Abreisen sind
 * mehr Arbeit als sechs Bleiber, und abgerechnet wird nach Minuten.
 *
 * Ergebnis: je Zimmer die Kraft, in der Reihenfolge der Eingabe. Gibt es
 * keine Kraft, bleibt alles unzugeteilt.
 */
export function suggestCleaningPlan<S>(
  rooms: ReadonlyArray<{ minutes: number }>, staff: readonly S[]
): Array<S | null> {
  const n = rooms.length
  const k = Math.min(staff.length, n)
  if (k === 0) return rooms.map(() => null)

  const summe = [0]
  for (const r of rooms) summe.push(summe[summe.length - 1]! + r.minutes)
  const last = (von: number, bis: number): number => summe[bis]! - summe[von]!

  // best[j][i]: kleinste Hoechstlast, wenn die ersten i Zimmer auf j Kraefte
  // gehen. schnitt[j][i]: wo der letzte Abschnitt beginnt.
  const best: number[][] = []
  const schnitt: number[][] = []
  best[1] = []
  schnitt[1] = []
  for (let i = 0; i <= n; i++) { best[1]![i] = last(0, i); schnitt[1]![i] = 0 }
  for (let j = 2; j <= k; j++) {
    best[j] = []
    schnitt[j] = []
    for (let i = 0; i <= n; i++) {
      let wert = Infinity
      let wo = 0
      for (let p = j - 1; p <= i; p++) {
        const w = Math.max(best[j - 1]![p]!, last(p, i))
        // Bei Gleichstand der fruehere Schnitt: die vorderen Kraefte
        // bekommen nicht weniger als die hinteren.
        if (w < wert) { wert = w; wo = p }
      }
      if (i < j - 1) { wert = best[j - 1]![i]!; wo = i }
      best[j]![i] = wert
      schnitt[j]![i] = wo
    }
  }

  const ergebnis: Array<S | null> = rooms.map(() => null)
  let ende = n
  for (let j = k; j >= 1; j--) {
    const beginn = schnitt[j]![ende]!
    for (let i = beginn; i < ende; i++) ergebnis[i] = staff[j - 1]!
    ende = beginn
  }
  return ergebnis
}
