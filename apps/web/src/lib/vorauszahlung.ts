import { centAusEingabe } from './preisraster.js'

/**
 * Die Rechenteile der Vorauszahlungsmaske, ohne React.
 *
 * Hier liegt, was falsch sein kann, ohne dass ein Bildschirm es zeigt: die
 * Aufteilung einer Anzahlung auf Steuersätze und der Zeitraum, den die
 * Kanalsicht abfragt. Beides in der Komponente zu lassen hieße, es nur über
 * die Oberfläche prüfen zu können — und eine Abweichung um einen Cent oder
 * einen Tag sieht man dort nicht.
 */

/** Wie die Steuer einer Anzahlung bestimmt wird. */
export type Steuerart = 'derive' | 'single' | 'split'

export interface Teil { betrag: string; satz: number }
export interface Anzahlungsteil { grossCent: number; taxRateBp: number }

/**
 * Die Teile als Centbeträge, leere Zeilen ausgelassen.
 *
 * Eine leere Zeile ist keine Null: wer ein Feld hinzufügt und nicht füllt,
 * meint sie nicht mit. Mitgeschickt wäre sie eine Position über null Euro
 * auf einem Beleg.
 */
export function anzahlungsteile(teile: readonly Teil[]): Anzahlungsteil[] {
  return teile
    .map(z => ({ grossCent: centAusEingabe(z.betrag) ?? 0, taxRateBp: z.satz }))
    .filter(l => l.grossCent > 0)
}

/** Die Summe der Teile. Grundlage der Anzeige neben der Eingabe. */
export function summeTeile(teile: readonly Teil[]): number {
  return anzahlungsteile(teile).reduce((summe, l) => summe + l.grossCent, 0)
}

/**
 * Darf abgeschickt werden?
 *
 * Bei einer Aufteilung nur, wenn die Teile den vereinnahmten Betrag **auf
 * den Cent** ergeben. Die API prüft das ebenfalls und weist es ab; die
 * Maske prüft es trotzdem, weil die Abweichung beim Tippen auffallen soll
 * und nicht erst beim Abschicken.
 */
export function anzahlungBereit(
  art: Steuerart, teile: readonly Teil[], vermerkCent: number | null
): boolean {
  if (vermerkCent === null) return false
  if (art !== 'split') return true
  return summeTeile(teile) === vermerkCent
}

/**
 * Der Rumpf der Anzahlungsrechnung, ohne den Zahlungsvermerk.
 *
 * `derive` schickt **nichts** mit: die API leitet dann aus dem erwarteten
 * Aufenthalt ab. Ein mitgeschickter Satz — und sei es der voreingestellte —
 * schaltete diese Ableitung aus, und die Übernachtung trüge plötzlich
 * neunzehn Prozent.
 */
export function anzahlungsNutzlast(
  art: Steuerart, satz: number, teile: readonly Teil[]
): { taxRateBp?: number; lines?: Anzahlungsteil[] } {
  if (art === 'single') return { taxRateBp: satz }
  if (art === 'split') return { lines: anzahlungsteile(teile) }
  return {}
}
