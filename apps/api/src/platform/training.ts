import { Errors } from './errors.js'
import { apiText, type Meldung } from './texte.js'
import type { PoolClient } from '@hotelpms/db'

/**
 * Schulungs- und Testbetrieb (C11, Dokument 13).
 *
 * **Das Problem.** Jedes Haus schult neue Mitarbeiter, und ohne einen dafür
 * vorgesehenen Ort schult es auf den Produktivdaten. Dann stehen erfundene
 * Reservierungen im echten Belegungsplan, erfundene Rechnungen in der echten
 * Nummernfolge, und erfundene Übernachtungen in der Beherbergungsstatistik,
 * die an das Statistische Landesamt geht.
 *
 * **Die Lösung ist eine eigene Property mit `is_training`.** Sie hat ihren
 * eigenen Bestand, ihre eigenen Zimmer und ihre eigene Nummernfolge — das
 * ergibt sich schon aus der Mandantentrennung. Was hinzukommt, sind drei
 * Dinge, die sich nicht von selbst ergeben:
 *
 * 1. **Die Rechnungsnummer trägt ein sichtbares Kürzel.** Eine Übungsrechnung
 *    muss man als solche erkennen, wenn sie ausgedruckt auf dem Tresen liegt.
 * 2. **Buchhaltungs- und Behördenexporte werden verweigert.** Ein
 *    DATEV-Stapel aus Übungsdaten landet in der echten Buchhaltung, und eine
 *    Beherbergungsstatistik aus Übungsdaten ist eine falsche Meldung an eine
 *    Behörde. Beides ist schwerer zu korrigieren als zu verhindern.
 * 3. **Die Oberfläche zeigt es dauerhaft an.** Wer nicht sieht, dass er übt,
 *    übt irgendwann versehentlich am echten Haus.
 */

export const TRAINING_PREFIX = 'UEBUNG-'

/** Liest das Kennzeichen. Eine Abfrage, im Mandantenkontext. */
export async function isTrainingProperty(
  client: PoolClient, propertyId: number
): Promise<boolean> {
  const { rows } = await client.query<{ is_training: boolean }>(
    `SELECT is_training FROM property WHERE id = $1`, [propertyId])
  return rows[0]?.is_training ?? false
}

/**
 * Weist Exporte ab, die aus einem Übungshaus nach draußen gingen.
 *
 * Bewusst eine harte Absage und keine Warnung: eine Warnung wird geklickt.
 */
export async function assertNotTraining(
  client: PoolClient, propertyId: number, was: Meldung
): Promise<void> {
  if (await isTrainingProperty(client, propertyId)) {
    // `was` ist selbst ein Schluessel und wird zuerst aufgeloest: die
    // Meldung setzt einen Satzteil ein, keinen Schluessel.
    throw Errors.unprocessable('training.notPossible',
      { was: apiText(was) })
  }
}
