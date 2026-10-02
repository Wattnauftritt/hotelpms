import { Type, type Static } from '@sinclair/typebox'
import { IsoDate } from './schemas.js'

/**
 * Die Antwort der Suche (`GET /v1/properties/:propertyId/search`).
 *
 * Eine eigene Datei und nicht ans Ende von `schemas.ts`: dort haengen
 * mehrere Bearbeiter gleichzeitig an, und das Ende einer Datei ist die
 * Stelle, an der sie sich zuverlaessig in die Quere kommen.
 *
 * Jede Zeile traegt, was die Trefferliste zeigt -- Zimmer, Zeitraum,
 * Zustand, Begleitpersonen, Zahl der Aufenthalte. Eine Zeile, die erst
 * nachladen muss, um sich zu zeigen, ist ein Aufruf je Treffer und
 * Tastendruck.
 */

export const SearchScope = Type.Union([
  Type.Literal('all'), Type.Literal('reservation'), Type.Literal('customer')
])
export type SearchScope = Static<typeof SearchScope>

export const SearchReservationHit = Type.Object({
  reservationRef: Type.String(),
  bookingRef: Type.String(),
  /** Die Nummer des Kanals (Booking.com, Expedia), falls die Buchung von dort kam. */
  externalReference: Type.Union([Type.String(), Type.Null()]),
  /**
   * Der Zustand, wie er gespeichert ist. `Inquired` steht im Datenmodell
   * (Migration 0009), auch wenn heute keine Route eine Anfrage anlegt --
   * eine importierte koennte es tun, und die Suche soll sie dann zeigen
   * statt an ihr zu scheitern.
   */
  status: Type.Union([
    Type.Literal('Inquired'), Type.Literal('Optional'), Type.Literal('Confirmed'),
    Type.Literal('InHouse'), Type.Literal('CheckedOut'), Type.Literal('Canceled'),
    Type.Literal('NoShow')
  ]),
  arrival: IsoDate,
  departure: IsoDate,
  /**
   * Die Abreise liegt am offenen Geschaeftstag oder davor. Gemessen am
   * Geschaeftstag des Hauses und nicht an der Uhr des Rechners: zwischen
   * Mitternacht und Tagesabschluss ist der Gast, der heute abreist, noch
   * nicht Vergangenheit.
   */
  past: Type.Boolean(),
  /** Woran der Treffer hing: an der Nummer, am Gast oder an einer Begleitperson. */
  matchedBy: Type.Union([
    Type.Literal('number'), Type.Literal('guest'), Type.Literal('companion')
  ]),
  lastName: Type.Union([Type.String(), Type.Null()]),
  firstName: Type.Union([Type.String(), Type.Null()]),
  /** Null heisst: noch kein Zimmer -- die Buchung liegt im Band oben im Plan. */
  roomCode: Type.Union([Type.String(), Type.Null()]),
  categoryCode: Type.String(),
  /** Die weiteren Belegten mit Namen, ohne den Hauptgast, ohne anonymisierte. */
  companions: Type.Array(Type.String())
})
export type SearchReservationHit = Static<typeof SearchReservationHit>

export const SearchCustomerHit = Type.Object({
  kind: Type.Union([Type.Literal('guest'), Type.Literal('company')]),
  /** `guestRef` bzw. `companyRef`. */
  ref: Type.String(),
  /** Nachname des Gastes oder Name der Firma. */
  name: Type.String(),
  firstName: Type.Union([Type.String(), Type.Null()]),
  /** Beim Gast die Mailadresse, bei der Firma die fuer Rechnungen. */
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  /**
   * Reservierungen **in diesem Haus** -- als Hauptgast, als Begleitperson
   * oder, bei einer Firma, als Bucher. Nicht accountweit: wer nur ein Haus
   * sieht, soll ueber die Suche nicht erfahren, wer in einem anderen wohnt.
   */
  reservations: Type.Integer(),
  /** Gerade eingecheckt, in diesem Haus. */
  inHouse: Type.Boolean()
})
export type SearchCustomerHit = Static<typeof SearchCustomerHit>

export const SearchResult = Type.Object({
  reservations: Type.Array(SearchReservationHit),
  /** Es gibt mehr als die gezeigten. Die Zahl nennt die Suche bewusst nicht. */
  moreReservations: Type.Boolean(),
  customers: Type.Array(SearchCustomerHit),
  moreCustomers: Type.Boolean()
})
export type SearchResult = Static<typeof SearchResult>
