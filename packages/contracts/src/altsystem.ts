import { Type, type Static } from '@sinclair/typebox'
import { IsoDate } from './schemas.js'

/**
 * Uebernahme aus KWHotel: Anfrage und Bericht von
 * `POST /v1/imports/legacy/kwhotel`.
 *
 * Im Vertrag, weil Oberflaeche und Schnittstelle sich ueber die Zuordnung
 * der Zimmer einig sein muessen: die Maske zeigt, was die Schnittstelle
 * zugeordnet hat, und schickt die Korrektur genau in dieser Form zurueck.
 */

export const KwhotelImportRequest = Type.Object({
  propertyId: Type.Integer(),
  /** Der Abzug als Text, so wie KWHotel ihn als `.bak` ablegt. */
  data: Type.String(),
  /** Ohne `true` ein Trockenlauf: alles geprueft, nichts geschrieben. */
  commit: Type.Optional(Type.Boolean()),
  /**
   * Gastnamen, deren Zeilen keine Buchungen sind. KWHotel-Haeuser merken
   * sich damit etwa ungereinigte Zimmer. Verglichen ohne Gross- und
   * Kleinschreibung und ohne Leerzeichen.
   */
  excludeGuestNames: Type.Optional(Type.Array(Type.String({ maxLength: 200 }),
    { maxItems: 50 })),
  /** KWHotel-Statuscodes, die eine gueltige Buchung bedeuten. */
  activeStatus: Type.Optional(Type.Array(Type.Integer(), { maxItems: 100 })),
  /** KWHotel-Statuscodes, die eine Stornierung bedeuten. */
  canceledStatus: Type.Optional(Type.Array(Type.Integer(), { maxItems: 100 })),
  /**
   * KWHotel-Zimmernummer (`PokojID`) auf StayGrid-Zimmer. Ohne Eintrag
   * ordnet der Import ueber die Zimmernummer zu; `null` heisst: die Zeilen
   * dieses Zimmers nicht uebernehmen.
   */
  roomMap: Type.Optional(Type.Record(Type.String(),
    Type.Union([Type.Integer(), Type.Null()]))),
  /** Nur Aufenthalte, die an oder nach diesem Tag noch andauern. */
  fromDate: Type.Optional(IsoDate)
})
export type KwhotelImportRequest = Static<typeof KwhotelImportRequest>

export const KwhotelFinding = Type.Object({
  level: Type.Union([Type.Literal('error'), Type.Literal('warning')]),
  /** Der deutsche Satz, wie jede Meldung der Schnittstelle. */
  message: Type.String(),
  messageKey: Type.String(),
  params: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()])),
  /** KWHotel-Nummer der Zeile, wo es um eine einzelne geht. */
  reference: Type.Optional(Type.String())
})
export type KwhotelFinding = Static<typeof KwhotelFinding>

export const KwhotelRoomMatch = Type.Object({
  kwRoomId: Type.String(),
  name: Type.String(),
  /** Uebernehmbare Zeilen auf diesem Zimmer, nach Platzhaltern und Zeitraum. */
  reservations: Type.Integer(),
  resourceId: Type.Union([Type.Integer(), Type.Null()]),
  roomCode: Type.Union([Type.String(), Type.Null()]),
  /** `auto` ueber die Nummer, `manual` aus `roomMap`, `skipped` bewusst weggelassen. */
  match: Type.Union([Type.Literal('auto'), Type.Literal('manual'),
                     Type.Literal('skipped'), Type.Literal('none')])
})
export type KwhotelRoomMatch = Static<typeof KwhotelRoomMatch>

export const KwhotelImportReport = Type.Object({
  dryRun: Type.Boolean(),
  hotelName: Type.Union([Type.String(), Type.Null()]),
  /** Gegen diesen Tag wurde entschieden, was abgereist, im Haus oder kuenftig ist. */
  businessDate: IsoDate,
  /** Zeilen im Abzug. */
  rows: Type.Integer(),
  imported: Type.Integer(),
  skipped: Type.Integer(),
  counts: Type.Object({
    placeholder: Type.Integer(),
    beforeFrom: Type.Integer(),
    alreadyImported: Type.Integer(),
    roomSkipped: Type.Integer(),
    confirmed: Type.Integer(),
    inHouse: Type.Integer(),
    checkedOut: Type.Integer(),
    canceled: Type.Integer(),
    bookings: Type.Integer(),
    groupBookings: Type.Integer(),
    guests: Type.Integer(),
    /** Zeilen mit mehr als einem Gast; uebernommen wird der Hauptgast. */
    multiGuest: Type.Integer()
  }),
  statusCodes: Type.Array(Type.Object({
    code: Type.Integer(),
    count: Type.Integer(),
    group: Type.Union([Type.Literal('active'), Type.Literal('canceled'), Type.Null()])
  })),
  rooms: Type.Array(KwhotelRoomMatch),
  /**
   * Die haeufigsten Gastnamen. Ein Platzhalter faellt hier auf, bevor er
   * als neunhundert Buchungen im Plan steht.
   */
  frequentNames: Type.Array(Type.Object({ name: Type.String(), count: Type.Integer(),
                                          excluded: Type.Boolean() })),
  range: Type.Union([Type.Object({ from: IsoDate, to: IsoDate }), Type.Null()]),
  findings: Type.Array(KwhotelFinding)
})
export type KwhotelImportReport = Static<typeof KwhotelImportReport>
