/**
 * Der Zahlungsstand einer Reservierung, abgeleitet und nie gespeichert.
 *
 * **Warum abgeleitet.** Ein gespeichertes "bezahlt" liefe auseinander,
 * sobald nach der Zahlung eine Minibar gebucht wird -- es stuende dann
 * weiter da, und niemand haette es falsch gesetzt. Gerechnet wird deshalb
 * bei jeder Anfrage aus dem, was ohnehin die Wahrheit ist: Positionen
 * (`charge`), Zahlungsvermerke (`settlement`), Anzahlungsjournal
 * (`deposit_ledger`), offene Zahlungslinks (`payment_intent`) und die bei
 * der Buchung eingefrorenen, noch nicht gebuchten Naechte
 * (`reservation_night`).
 *
 * **Der Massstab ist der ganze Aufenthalt, nicht der Saldo des Folios.**
 * Fuer eine frische Buchung gibt es noch keine Position -- die Logis bucht
 * erst der Nachtlauf, Nacht fuer Nacht. Der Saldo ist dann null, und "Saldo
 * <= 0" hiesse "bezahlt": eine plausibel aussehende falsche Aussage ueber
 * jede kuenftige Reservierung im Plan. Verglichen wird deshalb mit dem
 * erwarteten Betrag, also dem Gebuchten plus den noch nicht gebuchten
 * Naechten. Nach der letzten Nacht ist beides dasselbe.
 *
 * **Was "offen" vor dem ersten Nachtlauf heisst: nichts.** Solange weder
 * gebucht noch gezahlt noch angefordert ist, schuldet der Gast nichts --
 * in Deutschland zahlt man ueblicherweise bei der Abreise. Ein rotes
 * "offen" an jeder kuenftigen Buchung waere Laerm, und Laerm wird
 * uebersehen; deshalb `none`, und der erwartete Betrag steht im Titel.
 * Ob eine Anzahlung **verlangt** ist, weiss das Datenmodell nicht: es gibt
 * keine Anzahlungsregel am Ratenplan und keine Frist an einer Anforderung.
 * Ein Zustand "Anzahlung ueberfaellig" waere deshalb erfunden; was es gibt,
 * ist der offene Zahlungslink (`requested`).
 */

export type PaymentState =
  /** Nichts gebucht, nichts gezahlt, nichts angefordert. */
  | 'none'
  /** Ein Zahlungslink ist verschickt und noch nicht eingeloest. */
  | 'requested'
  /** Positionen gebucht, nichts gezahlt. */
  | 'open'
  /** Gezahlt, aber weniger als erwartet, und es ist schon etwas gebucht. */
  | 'partial'
  /** Vor der ersten Position schon Geld eingegangen, aber nicht alles. */
  | 'deposit'
  /** Mindestens der erwartete Betrag ist eingegangen. */
  | 'paid'

export const PAYMENT_STATES: readonly PaymentState[] =
  ['none', 'requested', 'open', 'partial', 'deposit', 'paid']

export interface PaymentFigures {
  /** Summe der Positionen auf dem Folio, Gegenbuchungen eingerechnet. */
  chargedCent: number
  /** Summe der Zahlungsvermerke, Erstattungen eingerechnet. */
  settledCent: number
  /**
   * Noch nicht gebuchte Naechte zum eingefrorenen Preis. Null, wenn die
   * Logis auf ein anderes Konto umgeleitet wird: dann schuldet sie nicht
   * dieser Gast.
   */
  unpostedCent: number
  /** Offene Zahlungslinks. */
  requestedCent: number
}

export interface PaymentSummary extends PaymentFigures {
  state: PaymentState
  /** Gebucht plus noch nicht gebucht: der Aufenthalt, soweit bekannt. */
  expectedCent: number
  /** Saldo des Folios **jetzt**: gebucht minus gezahlt. */
  balanceCent: number
}

/**
 * Den Zustand aus den Summen ableiten.
 *
 * Die Reihenfolge ist eine Rangfolge: was zuerst greift, ist die Aussage,
 * auf die jemand am Plan handeln soll. `paid` zuerst, weil ein gedeckter
 * Betrag jede andere Lage erledigt -- auch einen Link, der noch offen
 * steht. Danach `requested`: wer Geld angefordert hat, wartet darauf, und
 * das ist die Auskunft, nach der gefragt wird, auch wenn schon ein Teil
 * da ist.
 */
export function paymentState(f: PaymentFigures): PaymentSummary {
  const expectedCent = f.chargedCent + f.unpostedCent
  const balanceCent = f.chargedCent - f.settledCent
  const state: PaymentState =
    f.settledCent > 0 && f.settledCent >= expectedCent ? 'paid'
    : f.requestedCent > 0 ? 'requested'
    : f.settledCent <= 0 && balanceCent > 0 ? 'open'
    : f.settledCent > 0 && f.chargedCent > 0 ? 'partial'
    : f.settledCent > 0 ? 'deposit'
    : 'none'
  return { ...f, state, expectedCent, balanceCent }
}
