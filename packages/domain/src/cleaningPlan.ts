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
 * Zimmer auf Kraefte verteilen: zuerst gleich viele Abreisen, dann so
 * viele Bleiber, dass die Gesamtzeit gleich wird.
 *
 * Die Regel ist die der Hausdame (Sven, 08.10.2026): "Mitarbeiter sollten
 * gleich viel Abreisen bekommen und danach moeglichst auch gleich viele
 * Bleiber, damit die Gesamtzeit gleich ist. Aber gleich viel Abreisen ist
 * wichtiger, weil das am schwersten ist und am laengsten dauert." Eine
 * reine Verteilung nach Minuten, wie sie hier vorher stand, gab einer Kraft
 * sechs Abreisen und einer anderen zwei Abreisen und zwanzig Bleiber --
 * auf dem Papier gleich lang, am Ende des Tages nicht.
 *
 * 1. Die Abreisen (Bereiche wie das Bad zaehlen dazu) gehen in
 *    gleich grossen Stuecken, hoechstens eine Abreise Unterschied; die
 *    vorderen Kraefte bekommen die eine mehr.
 * 2. Die Bleiber gehen einzeln an die Kraft mit der bisher kleinsten
 *    Gesamtzeit. Haben alle gleich lange Abreisen, sind das gleich viele
 *    Bleiber; hat eine ein Zimmer mit 60 Minuten erwischt, bekommt sie
 *    weniger.
 * 3. Welche Zimmer: jede Kraft bekommt ihre Abreisen und ihre Bleiber je
 *    als **zusammenhaengendes Stueck** der Reihe, in der man durchs Haus
 *    geht (Gebaeude, Etage, Nummer), und die erste Kraft vorne -- eine
 *    Etage oder ein Flur, nicht jedes dritte Zimmer quer durchs Haus.
 *
 * Ergebnis: je Zimmer die Kraft, in der Reihenfolge der Eingabe. Gibt es
 * keine Kraft, bleibt alles unzugeteilt.
 */
export function suggestCleaningPlan<S>(
  rooms: ReadonlyArray<{ minutes: number; kind: CleaningKind }>, staff: readonly S[]
): Array<S | null> {
  const k = staff.length
  const ergebnis: Array<S | null> = rooms.map(() => null)
  if (k === 0) return ergebnis

  const abreisen = rooms.flatMap((r, i) => r.kind === 'departure' ? [i] : [])
  const bleiber = rooms.flatMap((r, i) => r.kind === 'stayover' ? [i] : [])

  // 1. Gleich viele Abreisen, die vorderen Kraefte die eine mehr.
  const anzahlAbreisen = staff.map((_, j) =>
    Math.floor(abreisen.length / k) + (j < abreisen.length % k ? 1 : 0))
  const minuten = staff.map(() => 0)
  let pos = 0
  for (let j = 0; j < k; j++) {
    for (const i of abreisen.slice(pos, pos + anzahlAbreisen[j]!)) {
      ergebnis[i] = staff[j]!
      minuten[j]! += rooms[i]!.minutes
    }
    pos += anzahlAbreisen[j]!
  }

  // 2. Wie viele Bleiber: einzeln an die bisher kuerzeste Gesamtzeit; bei
  // Gleichstand an die mit weniger Bleibern, dann an die vordere.
  const anzahlBleiber = staff.map(() => 0)
  for (const i of bleiber) {
    let wer = 0
    for (let j = 1; j < k; j++) {
      if (minuten[j]! < minuten[wer]!
          || (minuten[j] === minuten[wer] && anzahlBleiber[j]! < anzahlBleiber[wer]!)) wer = j
    }
    minuten[wer]! += rooms[i]!.minutes
    anzahlBleiber[wer]! += 1
  }

  // 3. Welche Bleiber: am Stueck in Hausreihenfolge, die erste Kraft vorne.
  pos = 0
  for (let j = 0; j < k; j++) {
    for (const i of bleiber.slice(pos, pos + anzahlBleiber[j]!)) ergebnis[i] = staff[j]!
    pos += anzahlBleiber[j]!
  }
  return ergebnis
}
