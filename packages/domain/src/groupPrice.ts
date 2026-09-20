import type { Cent } from './money.js'

/**
 * Einen Gesamtpreis auf Teile verteilen, ohne dass ein Cent verlorengeht.
 *
 * **Warum das eine eigene Datei ist.** Dieselbe Frage stellt sich an zwei
 * Stellen -- ein Gesamtpreis auf die Naechte eines Aufenthalts, ein
 * Gruppenpreis auf die Zimmer der Gruppe -- und beide Male ist die
 * Versuchung dieselbe: durch die Anzahl teilen und fertig. Drei Naechte zu
 * 100,00 EUR ergeben dann dreimal 33,33, in Summe 99,99. Der fehlende Cent
 * taucht nicht als Rundungsfehler auf, sondern als Rechnung, die einen Cent
 * neben der Zusage liegt -- und in der Buchhaltung als Differenz ohne
 * Ursache.
 *
 * **Der Rest liegt vorn, nicht hinten.** Er muss irgendwo liegen, und vorn
 * ist die Stelle, die man findet: die erste Nacht steht oben auf dem Beleg,
 * das erste Zimmer oben in der Gruppe. Hinten waere er der letzte Posten
 * einer langen Liste, den niemand nachrechnet.
 *
 * Fuer die Gruppe ist die Aufteilung ohnehin eine Annahme -- meistens zahlt
 * einer fuer alle. Sie muss nicht gerecht sein, sie muss **aufgehen**: die
 * Summe der Teile ist der eingegebene Betrag, auf den Cent.
 */

/**
 * Einen Betrag in `n` Teile, gewichtet.
 *
 * Ohne Gewichte gleichmaessig. Die Gewichte muessen positiv sein; ein
 * Gewicht von null hiesse ein Zimmer zum Nulltarif, und das ist eine
 * Entscheidung, die niemand durch eine leere Personenzahl treffen soll.
 *
 * Gerechnet wird ganzzahlig: `Math.floor` je Teil, und der Rest --
 * hoechstens `n - 1` Cent -- geht auf das erste. Ueber Fliesskomma zu
 * gehen und am Ende zu runden waere die Bauform, die bei grossen Betraegen
 * still danebenliegt.
 */
export function aufteilen(gesamt: Cent, gewichte: readonly number[]): Cent[] {
  if (gewichte.length === 0) return []
  const summe = gewichte.reduce((s, g) => s + g, 0)
  if (summe <= 0) throw new Error('Gewichte muessen zusammen positiv sein')
  const teile = gewichte.map(g => Math.floor((gesamt * g) / summe))
  const rest = gesamt - teile.reduce((s, t) => s + t, 0)
  teile[0] = teile[0]! + rest
  return teile
}

/**
 * Ein Gesamtpreis auf die Naechte eines Aufenthalts.
 *
 * Gespeichert wird je Nacht (`reservation_night.price_cent`) -- das ist
 * die Wahrheit, aus der Rechnung, Storno und Statistik rechnen. Ein
 * Gesamtpreis ist eine Eingabehilfe und muss deshalb hier, einmal, in
 * Naechte zerfallen.
 */
export function preisJeNacht(gesamt: Cent, naechte: number): Cent[] {
  return aufteilen(gesamt, Array.from({ length: naechte }, () => 1))
}

/**
 * Der Gesamtpreis einer Gruppe auf ihre Zimmer, nach Personenzahl.
 *
 * **Warum nach Personen und nicht gleichmaessig.** Eine Gruppe aus sechs
 * Doppelzimmern und zwei Einzelzimmern zu gleichen Teilen aufzuteilen hiesse,
 * das Einzelzimmer so teuer zu machen wie das Doppelzimmer. Das faellt
 * spaetestens auf, wenn einer der Gaeste doch selbst zahlt.
 *
 * **Warum die Belegung der Zimmergruppe und nicht die erfasste
 * Personenzahl.** Die steht beim Anlegen einer Gruppe noch gar nicht fest --
 * die Namensliste kommt spaeter. Was feststeht, ist das verkaufte Produkt:
 * ein Doppelzimmer ist fuer zwei verkauft.
 *
 * Genau ist das nicht, und das ist in Ordnung. Der Gruppenpreis ist eine
 * Verhandlung, kein Summand; das System muss mit **irgendeiner** Aufteilung
 * arbeiten, und diese ist die, die ein Mensch nachvollziehen kann.
 */
export function gruppeAufteilen(
  gesamt: Cent, zimmer: ReadonlyArray<{ personen: number }>
): Cent[] {
  return aufteilen(gesamt, zimmer.map(z => Math.max(1, z.personen)))
}
