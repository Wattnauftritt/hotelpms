import type { Kassenzeile, Kassenbeleg } from './queries/kassenbuch.js'

/**
 * Eine Zeile des Monats, wie die Oberflaeche sie zeigt: eine Buchung allein
 * oder eine Gastbuchung mit allen ihren Zeilen (Sven, 07.10.2026: "zusammen-
 * gehoerende sollten immer gruppiert sein").
 */
export interface Kassenblock {
  kopf: Kassenzeile
  mitglieder: Kassenzeile[]
  /** Was die Gruppe zum Bestand beitraegt; ganz storniert die Summe aller Zeilen. */
  summeCent: number
  /** Bestand nach der letzten wirksamen Zeile der Gruppe. */
  bestandCent: number | null
  belege: Kassenbeleg[]
}

/**
 * Fasst aufeinanderfolgende Zeilen einer Gruppe zusammen. Der Server liefert
 * eine Gruppe geschlossen unter ihrer ersten Zeile; ein Mitglied, dessen
 * erste Zeile nicht direkt davor steht (anderer Tag, anderer Monat), bleibt
 * fuer sich -- lieber eine einzelne Zeile als eine falsch zugeordnete.
 */
export function kassenbloecke(zeilen: readonly Kassenzeile[]): Kassenblock[] {
  const bloecke: Kassenblock[] = []
  for (const z of zeilen) {
    const letzter = bloecke.at(-1)
    if (letzter !== undefined && z.groupNo !== null && z.groupNo === letzter.kopf.entryNo) {
      letzter.mitglieder.push(z)
    } else {
      bloecke.push({ kopf: z, mitglieder: [], summeCent: 0, bestandCent: null, belege: [] })
    }
  }
  for (const b of bloecke) {
    const alle = [b.kopf, ...b.mitglieder]
    // Wirksam ist, was einen Bestand traegt; eine stornierte Zeile zaehlt
    // nicht mit, sonst stuende neben einer aufgehobenen Gruppe ein Betrag,
    // der im Bestand nie ankam.
    const wirksam = alle.filter(z => z.balanceAfterCent !== null)
    b.summeCent = (wirksam.length > 0 ? wirksam : alle).reduce((s, z) => s + z.amountCent, 0)
    b.bestandCent = wirksam.at(-1)?.balanceAfterCent ?? null
    b.belege = alle.flatMap(z => z.receipts)
  }
  return bloecke
}
