import { BESTAETIGUNG_FEHLT } from '@hotelpms/contracts'

/**
 * Die Bruecke zwischen der Schnittstelle und dem Bestaetigungsdialog
 * (Migration 0208, Bedrohungsanalyse 23.10.2026, T3).
 *
 * Eine kritische Handlung -- IBAN, Stripe, Maschinenzugang, Leitungsrolle,
 * Gaestedatei -- antwortet ohne frische Bestaetigung mit 403 und dem Typ
 * `confirmation_required`. Jeder Bildschirm muesste das sonst selbst
 * abfangen, und der zehnte vergaesse es: der Benutzer saehe eine Meldung
 * statt der Frage nach dem Kennwort. Deshalb fragt `request()` hier, der
 * Dialog in der `Shell` antwortet, und die Anfrage laeuft danach **einmal**
 * erneut.
 *
 * Mehrere Anfragen zugleich teilen sich eine Frage: wer zwei Exporte
 * nacheinander anstoesst, tippt das Kennwort einmal.
 */

type Frage = () => Promise<boolean>

let frage: Frage | null = null
let offen: Promise<boolean> | null = null

/** Vom Dialog gesetzt, solange er eingehaengt ist. */
export function bestaetigungAnmelden(f: Frage): () => void {
  frage = f
  return () => { if (frage === f) frage = null }
}

/** Ist das die Antwort "erst bestaetigen"? */
export function verlangtBestaetigung(status: number, problem: unknown): boolean {
  return status === 403 && typeof problem === 'object' && problem !== null
    && (problem as { type?: unknown }).type === BESTAETIGUNG_FEHLT
}

/**
 * Den Benutzer fragen. `false`, wenn er abbricht oder kein Dialog da ist --
 * dann bleibt es bei der Meldung der Schnittstelle, die sagt, was fehlt.
 */
export function bestaetigen(): Promise<boolean> {
  if (frage === null) return Promise.resolve(false)
  offen ??= frage().finally(() => { offen = null })
  return offen
}
