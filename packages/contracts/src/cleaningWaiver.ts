import { Type, type Static } from '@sinclair/typebox'

/**
 * Wie `IsoDate` in `schemas.ts`. Nicht von dort geholt: diese Datei ist
 * herausgeloest, damit `schemas.ts` und `gaestemappe.ts` den Verzicht tragen
 * koennen, ohne einander im Kreis zu laden.
 */
const IsoDate = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: 'Kalenderdatum in der Zeitzone der Property, YYYY-MM-DD'
})

/**
 * Reinigungsverzicht des Gastes (Aufgabe 18, Baustein 10; Migration 0115).
 *
 * Dieselbe Form fuer die Gastseite und das Seitenfenster der Rezeption:
 * beide zeigen die Bleibetage ab heute und ob dort verzichtet ist. Sie kommt
 * mit der Seite, die sie traegt (`CheckinFormView`, `ReservationDetail`),
 * nicht als eigener Aufruf.
 */
export const CleaningWaiverDay = Type.Object({
  date: IsoDate,
  waived: Type.Boolean(),
  /**
   * Die Kraft hat das Zimmer an diesem Tag schon gemeldet (gereinigt,
   * abgelehnt, Wasser hingestellt). Danach aendert der Wunsch nichts mehr --
   * er wuerde nur zeigen, was nicht geschehen ist.
   */
  locked: Type.Boolean()
})
export type CleaningWaiverDay = Static<typeof CleaningWaiverDay>

export const CleaningWaiverView = Type.Object({
  /** Gibt es als Dank eine Flasche Wasser? Steht so auf der Gastseite. */
  waterGift: Type.Boolean(),
  days: Type.Array(CleaningWaiverDay),
  /** Darf der Aufrufer hier setzen? Fuer die Rezeption; der Gast immer. */
  mayEdit: Type.Boolean()
})
export type CleaningWaiverView = Static<typeof CleaningWaiverView>
