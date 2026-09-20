import { centAusEingabe, eingabeAusCent } from './preisraster.js'

/**
 * Zwei Felder fuer einen Preis: je Nacht **oder** insgesamt.
 *
 * **Warum beides.** Verhandelt wird mal so, mal so. Ein Einzelgast hoert
 * "89 Euro die Nacht", eine Gruppe vereinbart "2.400 fuer alles". Wer nur
 * eines der beiden Felder anbietet, laesst die andere Haelfte der
 * Rezeption im Kopf dividieren -- und genau dort entsteht der Betrag, der
 * am Ende einen Euro neben der Zusage liegt.
 *
 * **Eines ist die Wahrheit, nicht beide.** Welches, entscheidet der letzte
 * Griff: wer den Gesamtpreis tippt, hat den Gesamtpreis vereinbart, und das
 * andere Feld ist dann eine Anzeige. Beide gleichzeitig als Eingabe zu
 * fuehren hiesse, sich bei jeder Datumsaenderung entscheiden zu muessen,
 * welcher der beiden Betraege nun nachgibt.
 *
 * Deshalb geht auch nur **einer** an die Schnittstelle (`priceCent` oder
 * `totalCent`); beide zugleich weist sie ab. Geteilt wird auf dem Server,
 * an einer Stelle, mit dem Rest-Cent auf der ersten Nacht.
 */

export type Preismodus = 'nacht' | 'gesamt'

export interface Preiseingabe {
  /** Welches Feld zuletzt angefasst wurde. Es gilt. */
  modus: Preismodus
  /** Der Text dieses Feldes, so wie er dasteht. */
  text: string
}

export const LEERER_PREIS: Preiseingabe = { modus: 'nacht', text: '' }

/**
 * Was an die Schnittstelle geht. `null` heisst: kein Preis vereinbart --
 * dann gilt der Ratenplan, und das ist nicht dasselbe wie null Euro.
 */
export function preisFelder(
  e: Preiseingabe
): { priceCent: number } | { totalCent: number } | null {
  const cent = centAusEingabe(e.text)
  if (cent === null) return null
  return e.modus === 'nacht' ? { priceCent: cent } : { totalCent: cent }
}

export interface Abgeleitet {
  /** Der berechnete Betrag als Text, leer wenn die Eingabe nichts hergibt. */
  text: string
  /**
   * Wie viele Cent nicht aufgehen -- nur beim Weg vom Gesamtpreis zur
   * Nacht. Null heisst: die Division geht auf.
   *
   * Die Zahl wird angezeigt, nicht verschwiegen. Drei Naechte zu 100,00
   * EUR stehen auf der Rechnung als 33,34 / 33,33 / 33,33, und wer das
   * nicht erwartet, sucht den Fehler bei sich. Aufgeteilt wird trotzdem
   * auf dem Server; hier steht nur, was dabei herauskommt.
   */
  restCent: number
}

/**
 * Der jeweils andere Betrag.
 *
 * Bei `modus: 'gesamt'` ist das der Preis der **ersten** Nacht, denn dort
 * liegt der Rest. Den abgerundeten Wert zu zeigen waere um einen Cent
 * falsch, und zwar genau an der Zeile, die oben auf dem Beleg steht.
 */
export function abgeleitet(e: Preiseingabe, naechte: number): Abgeleitet {
  const cent = centAusEingabe(e.text)
  if (cent === null || naechte <= 0) return { text: '', restCent: 0 }
  if (e.modus === 'nacht') return { text: eingabeAusCent(cent * naechte), restCent: 0 }
  // Der ganze Rest liegt auf der ersten Nacht, nicht ein Cent davon:
  // 1.000,01 EUR auf drei Naechte sind 333,35 / 333,33 / 333,33, nicht
  // 333,34. Genau so teilt `preisJeNacht` auf dem Server.
  const rest = cent % naechte
  return { text: eingabeAusCent(Math.floor(cent / naechte) + rest), restCent: rest }
}

/**
 * Derselbe Betrag, immer als Gesamtpreis des Aufenthalts.
 *
 * Fuer ein Zimmer einer Gruppe: der Vertrag kennt dort nur `totalCent`.
 * Das ist Absicht -- je Zimmer je Nacht waere eine Matrix, und was eine
 * Gruppe verhandelt, ist der Zimmerpreis, nicht das Raster. Wer trotzdem
 * je Nacht tippt, bekommt seine Zahl hier mit den Naechten multipliziert;
 * geteilt wird sie danach auf dem Server wieder, und weil Multiplikation
 * und Division in dieser Reihenfolge stehen, geht das ohne Rest auf.
 *
 * `undefined` heisst: kein Preis vereinbart. Das Feld faellt damit aus dem
 * Aufruf heraus, statt als null Euro darin zu stehen.
 */
export function alsGesamt(e: Preiseingabe, naechte: number): number | undefined {
  const cent = centAusEingabe(e.text)
  if (cent === null) return undefined
  return e.modus === 'gesamt' ? cent : cent * naechte
}
