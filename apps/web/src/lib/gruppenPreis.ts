import { gruppeAufteilen, preisJeNacht } from '@hotelpms/domain/groupPrice'
import { centAusEingabe } from './preisraster.js'
import { type Preiseingabe } from './preisEingabe.js'

/**
 * Was ein Gruppenpreis fuer jedes einzelne Zimmer bedeutet -- vor dem
 * Buchen, in der Maske.
 *
 * **Warum das hier steht und nicht im Server bleibt.** Verhandelt wird ein
 * Betrag fuer alles ("2.400 fuer die Gruppe"), und genau in dem Moment will
 * die Rezeption sehen, was daraus je Zimmer wird -- weil der Bus sechs
 * Doppelzimmer und zwei Einzelzimmer hat und der Reiseleiter danach fragt.
 * Bisher stand die Aufteilung erst **nach** dem Buchen da.
 *
 * **Gerechnet wird mit der Funktion des Servers, nicht mit einer zweiten.**
 * `gruppeAufteilen` und `preisJeNacht` kommen aus `@hotelpms/domain`, aus
 * derselben Datei, die die Route benutzt. Eine eigene Fassung hier waere
 * die naheliegende und die teure Loesung: sie laege bei jedem Betrag, der
 * nicht glatt aufgeht, einen Cent neben dem Ergebnis, und der Unterschied
 * fiele erst auf, wenn Vorschau und Rechnung nebeneinanderliegen.
 *
 * **Gezeigt, nicht geschickt.** Was hier herauskommt, geht nicht an die
 * Schnittstelle. Hinaus geht weiterhin nur der Gruppenpreis; geteilt wird
 * auf dem Server, ein einziges Mal. Sonst gaebe es zwei Stellen, an denen
 * der Rest-Cent liegen kann.
 */

export interface Zimmerzeile {
  /** Naechte dieses Zimmers. Sie koennen je Zimmer verschieden sein. */
  naechte: number
  /**
   * Plaetze der Zimmergruppe -- das Gewicht der Aufteilung.
   *
   * Nicht die erfasste Personenzahl: die steht beim Anlegen einer Gruppe
   * noch gar nicht fest, die Namensliste kommt spaeter. Was feststeht, ist
   * das verkaufte Produkt (dieselbe Begruendung wie in `gruppeAufteilen`).
   */
  personen: number
}

export interface Zimmerpreis {
  gesamtCent: number
  /**
   * Die **erste** Nacht, denn dort liegt der Rest. Den abgerundeten Wert zu
   * zeigen waere um einen Cent falsch, und zwar genau an der Zeile, die
   * oben auf dem Beleg steht.
   */
  jeNachtCent: number
}

/**
 * Alle Naechte aller Zimmer zusammen.
 *
 * **Das ist die Zahl, ueber die "je Nacht" und "gesamt" der Gruppe
 * zusammenhaengen -- nicht die Naechte der Buchung.** Vorher rechnete die
 * Maske mit den Naechten des Zeitraums, und bei drei Zimmern ueber zwei
 * Naechte stand neben "100,00 je Nacht" ein Gesamtpreis von 200,00. Die
 * Schnittstelle legt einen Preis je Nacht aber auf **jede** Nacht **jedes**
 * Zimmers; gebucht wurden 600,00. Der Unterschied fiel erst auf der
 * Rechnung auf.
 */
export function zimmernaechte(zimmer: readonly Zimmerzeile[]): number {
  return zimmer.reduce((s, z) => s + Math.max(0, z.naechte), 0)
}

/**
 * Der Preis jedes Zimmers, wenn der Preis fuer die ganze Gruppe gilt.
 *
 * `null` heisst: nichts Brauchbares eingetippt, oder eine Zeile hat keine
 * Nacht -- dann gibt es nichts zu zeigen, und eine Null waere eine Aussage,
 * die niemand gemacht hat.
 */
export function gruppenpreisJeZimmer(
  eingabe: Preiseingabe, zimmer: readonly Zimmerzeile[]
): Zimmerpreis[] | null {
  const cent = centAusEingabe(eingabe.text)
  if (cent === null || zimmer.length === 0) return null
  if (zimmer.some(z => z.naechte <= 0)) return null

  /*
   * Zwei Wege, und sie sind nicht dasselbe -- so rechnet die Route:
   *
   * - **je Nacht**: derselbe Betrag auf jede Nacht jedes Zimmers. Ein
   *   Zimmer mit drei Naechten kostet dann mehr als eines mit zweien, und
   *   das ist richtig so.
   * - **gesamt**: nach Plaetzen der Zimmergruppe aufgeteilt, mit dem
   *   Rest-Cent auf dem ersten Zimmer. Nach Naechten zu gewichten waere
   *   naheliegend und falsch: verhandelt wurde ein Betrag fuer alles.
   */
  const gesamtJeZimmer = eingabe.modus === 'nacht'
    ? zimmer.map(z => cent * z.naechte)
    : gruppeAufteilen(cent, zimmer.map(z => ({ personen: z.personen })))

  return gesamtJeZimmer.map((gesamtCent, i) => ({
    gesamtCent,
    jeNachtCent: preisJeNacht(gesamtCent, zimmer[i]!.naechte)[0]!
  }))
}
