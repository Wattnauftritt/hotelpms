import { Type, type Static } from '@sinclair/typebox'

/**
 * Geteilte Schemata zwischen API und Oberfläche.
 *
 * Der Sinn ist **eine** Definition, nicht zwei, die auseinanderlaufen. Die
 * API prüft eingehende Rümpfe dagegen, die Oberfläche leitet ihre Typen
 * daraus ab. Eine handgeschriebene Schnittstellendefinition im Frontend ist
 * nach dem dritten Feld falsch, und der Fehler zeigt sich erst zur Laufzeit.
 */

export const IsoDate = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: 'Kalenderdatum in der Zeitzone der Property, YYYY-MM-DD'
})

/** Geld ist immer eine ganze Zahl in Cent. Nie Fliesskomma. */
export const Cent = Type.Integer({ description: 'Betrag in Cent' })

export const ReservationStatus = Type.Union([
  Type.Literal('Optional'), Type.Literal('Confirmed'), Type.Literal('InHouse'),
  Type.Literal('CheckedOut'), Type.Literal('Canceled'), Type.Literal('NoShow')
])
export type ReservationStatus = Static<typeof ReservationStatus>

export const HousekeepingState = Type.Union([
  Type.Literal('dirty'), Type.Literal('clean'),
  Type.Literal('inspected'), Type.Literal('occupied')
])
export type HousekeepingState = Static<typeof HousekeepingState>

// --------------------------------------------------------------- Inventar

export const Category = Type.Object({
  id: Type.Integer(),
  categoryRef: Type.String(),
  code: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  maxOccupancy: Type.Integer(),
  sortOrder: Type.Integer(),
  overbookingLimit: Type.Integer(),
  timeUnit: Type.String(),
  active: Type.Boolean(),
  activeRooms: Type.Integer(),
  inactiveRooms: Type.Integer()
})
export type Category = Static<typeof Category>

export const Room = Type.Object({
  id: Type.Integer(),
  code: Type.String(),
  floor: Type.Union([Type.String(), Type.Null()]),
  attributes: Type.Array(Type.String()),
  active: Type.Boolean(),
  categoryId: Type.Integer(),
  categoryCode: Type.String(),
  categoryName: Type.String(),
  outOfOrderBlocks: Type.Integer()
})
export type Room = Static<typeof Room>

export const CreateCategory = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 20 }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.String()),
  maxOccupancy: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
  sortOrder: Type.Optional(Type.Integer()),
  overbookingLimit: Type.Optional(Type.Integer({ minimum: 0 }))
})
export type CreateCategory = Static<typeof CreateCategory>

/**
 * Zimmerserie. Der Vorsatz trägt auch Namen ohne Nummernlogik, etwa
 * "Wohnung " mit Nachsatz " Nord". Ohne `commit` ist der Aufruf eine
 * Vorschau, die nichts schreibt.
 */
export const RoomSeries = Type.Object({
  propertyId: Type.Integer(),
  categoryId: Type.Integer(),
  prefix: Type.Optional(Type.String({ maxLength: 20 })),
  from: Type.Integer({ minimum: 0 }),
  to: Type.Integer({ minimum: 0 }),
  pad: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
  suffix: Type.Optional(Type.String({ maxLength: 20 })),
  floor: Type.Optional(Type.String({ maxLength: 20 })),
  attributes: Type.Optional(Type.Array(Type.String())),
  skip: Type.Optional(Type.Array(Type.Integer())),
  commit: Type.Optional(Type.Boolean())
})
export type RoomSeries = Static<typeof RoomSeries>

export const RoomSeriesReport = Type.Object({
  dryRun: Type.Boolean(),
  planned: Type.Integer(),
  created: Type.Integer(),
  skipped: Type.Integer(),
  rooms: Type.Array(Type.Object({
    code: Type.String(),
    exists: Type.Boolean(),
    reason: Type.Optional(Type.String())
  }))
})
export type RoomSeriesReport = Static<typeof RoomSeriesReport>

export const SetupStep = Type.Object({
  key: Type.String(),
  done: Type.Boolean(),
  count: Type.Integer(),
  /** Deutsch, wie die ganze Schnittstelle. Zum Uebersetzen `labelKey`. */
  label: Type.String(),
  hint: Type.String(),
  labelKey: Type.String(),
  hintKey: Type.String(),
  /** Nur wo der Hinweis einen Wert nennt, etwa das Datum des Horizonts. */
  hintParams: Type.Optional(Type.Record(Type.String(),
    Type.Union([Type.String(), Type.Number()])))
})
export const SetupStatus = Type.Object({
  bookable: Type.Boolean(),
  complete: Type.Boolean(),
  steps: Type.Array(SetupStep),
  nextStep: Type.Union([Type.String(), Type.Null()])
})
export type SetupStatus = Static<typeof SetupStatus>

// ----------------------------------------------------------- Verfuegbarkeit

export const AvailabilityDay = Type.Object({
  category_id: Type.Integer(),
  date: Type.String(),
  capacity: Type.Integer(),
  sold: Type.Integer(),
  blocked: Type.Integer(),
  overbooking: Type.Integer(),
  available: Type.Integer()
})
export type AvailabilityDay = Static<typeof AvailabilityDay>

export const TapeChart = Type.Object({
  from: IsoDate,
  to: IsoDate,
  units: Type.Array(Type.Object({
    id: Type.Integer(),
    code: Type.String(),
    floor: Type.Union([Type.String(), Type.Null()]),
    category_id: Type.Integer(),
    category_name: Type.String(),
    /** Kurz genug, um auf einen Balken zu passen. */
    category_code: Type.String(),
    /** Traegt die Warnung beim Verschieben in eine kleinere Zimmergruppe. */
    max_occupancy: Type.Integer(),
    sort_order: Type.Integer()
  })),
  reservations: Type.Array(Type.Object({
    id: Type.Integer(),
    public_ref: Type.String(),
    resource_id: Type.Union([Type.Integer(), Type.Null()]),
    category_id: Type.Integer(),
    arrival: Type.String(),
    departure: Type.String(),
    status: ReservationStatus,
    last_name: Type.Union([Type.String(), Type.Null()]),
    first_name: Type.Union([Type.String(), Type.Null()]),
    source: Type.String(),
    external_reference: Type.Union([Type.String(), Type.Null()]),
    rate_code: Type.Union([Type.String(), Type.Null()]),
    occupants: Type.Integer(),
    /** Plaetze der **gebuchten** Zimmergruppe, nicht des zugewiesenen Zimmers. */
    category_max_occupancy: Type.Integer(),
    /** Merkmal fuer den Balken: "Balkon", "1. Stock", "Spaetanreise". */
    short_note: Type.Union([Type.String(), Type.Null()]),
    /** Der Vorgang. Nur im Titel und im Seitenfenster, nie auf dem Balken. */
    notes: Type.Union([Type.String(), Type.Null()])
  })),
  blocks: Type.Array(Type.Object({
    resource_id: Type.Integer(),
    from_date: Type.String(),
    to_date: Type.String(),
    kind: Type.String(),
    reason: Type.String()
  }))
})
export type TapeChart = Static<typeof TapeChart>

// ------------------------------------------------------------ Tagesgeschaeft

const DailyRow = Type.Object({
  reservationRef: Type.String(),
  /** Verweis auf das Gastfolio. Null, solange keines angelegt ist. */
  folioRef: Type.Union([Type.String(), Type.Null()]),
  arrival: Type.String(),
  departure: Type.String(),
  status: ReservationStatus,
  roomCode: Type.Union([Type.String(), Type.Null()]),
  categoryCode: Type.String(),
  lastName: Type.Union([Type.String(), Type.Null()]),
  firstName: Type.Union([Type.String(), Type.Null()]),
  occupants: Type.Integer()
})

export const DailySheet = Type.Object({
  date: Type.String(),
  arrivals: Type.Array(Type.Composite([
    DailyRow, Type.Object({ registered: Type.Boolean() })])),
  departures: Type.Array(Type.Composite([
    DailyRow, Type.Object({ balanceCent: Type.Union([Cent, Type.Null()]) })])),
  inHouse: Type.Array(DailyRow)
})
export type DailySheet = Static<typeof DailySheet>

export const HousekeepingRoom = Type.Object({
  resourceId: Type.Integer(),
  code: Type.String(),
  categoryCode: Type.String(),
  status: HousekeepingState,
  assignedTo: Type.Union([Type.Integer(), Type.Null()]),
  updatedAt: Type.Union([Type.String(), Type.Null()]),
  taskKind: Type.Union([Type.String(), Type.Null()]),
  taskStatus: Type.Union([Type.String(), Type.Null()]),
  taskId: Type.Union([Type.Integer(), Type.Null()]),
  departureRef: Type.Union([Type.String(), Type.Null()]),
  departureDate: Type.Union([Type.String(), Type.Null()]),
  arrivalRef: Type.Union([Type.String(), Type.Null()]),
  openTickets: Type.Integer()
})
export type HousekeepingRoom = Static<typeof HousekeepingRoom>

export const HousekeepingBoard = Type.Object({
  date: Type.Union([Type.String(), Type.Null()]),
  rooms: Type.Array(HousekeepingRoom)
})
export type HousekeepingBoard = Static<typeof HousekeepingBoard>

// ------------------------------------------------------------------- Folio

export const Charge = Type.Object({
  id: Type.Integer(),
  business_date: Type.String(),
  description: Type.String(),
  quantity: Type.Integer(),
  net_cent: Cent,
  tax_cent: Cent,
  gross_cent: Cent,
  tax_rate_bp: Type.Integer(),
  revenue_account: Type.String(),
  /** Gesetzt, sobald die Position auf einer Rechnung steht. Dann unveraenderlich. */
  invoice_id: Type.Union([Type.Integer(), Type.Null()]),
  /** Verweis auf die Position, die diese Zeile storniert. */
  reverses_id: Type.Union([Type.Integer(), Type.Null()])
})
export type Charge = Static<typeof Charge>

export const Settlement = Type.Object({
  id: Type.Integer(),
  business_date: Type.String(),
  amount_cent: Cent,
  method: Type.String(),
  /**
   * Verweis auf die Aufzeichnung ausserhalb dieses Systems: Bonnummer der
   * Kasse, Vorgang des Portals, Verwendungszweck der Ueberweisung. Macht
   * sichtbar, dass die massgebliche Aufzeichnung woanders liegt.
   */
  external_reference: Type.Union([Type.String(), Type.Null()]),
  reverses_id: Type.Union([Type.Integer(), Type.Null()])
})
export type Settlement = Static<typeof Settlement>

/**
 * Wer die Rechnung dieses Folios bekommt.
 *
 * Die Firma geht vor dem Gast. `guestRef` am Folio ist **nicht** der Gast
 * des Aufenthalts -- der steht an der Reservierung; hier steht, an wen
 * abgerechnet wird, und das kann jemand anderes sein.
 *
 * `hasAddress` sagt, ob Anschrift und Ort da sind. Ohne sie weist das
 * Festschreiben die Rechnung ab (Paragraph 14 Abs. 4 Nr. 1 UStG), und die
 * Maske soll das vorher sagen statt hinterher.
 */
export const InvoiceRecipient = Type.Object({
  kind: Type.Union([
    Type.Literal('company'), Type.Literal('guest'), Type.Literal('none')]),
  name: Type.String(),
  guestRef: Type.Union([Type.String(), Type.Null()]),
  companyRef: Type.Union([Type.String(), Type.Null()]),
  hasAddress: Type.Boolean()
})
export type InvoiceRecipient = Static<typeof InvoiceRecipient>

export const FolioView = Type.Object({
  folio: Type.Object({
    id: Type.Integer(),
    public_ref: Type.String(),
    property_id: Type.Integer(),
    reservation_id: Type.Union([Type.Integer(), Type.Null()]),
    kind: Type.String(),
    status: Type.String(),
    label: Type.Union([Type.String(), Type.Null()])
  }),
  charges: Type.Array(Charge),
  settlements: Type.Array(Settlement),
  balanceCent: Cent,
  recipient: InvoiceRecipient
})
export type FolioView = Static<typeof FolioView>

export const PaymentMethod = Type.Object({
  id: Type.Integer(),
  code: Type.String(),
  name: Type.String(),
  /** Die Abwicklung liegt ausser Haus. Keine Buchungsregel, nur eine Angabe. */
  isExternal: Type.Boolean(),
  sortOrder: Type.Integer(),
  /**
   * Stillgelegt statt geloescht. An einer Zahlungsart haengen Verrechnungen,
   * und `settlement` ist Haertegrad 1: geloescht bliebe ein Beleg zurueck,
   * dessen Zahlungsweg niemand mehr benennen kann.
   */
  active: Type.Boolean()
})
export type PaymentMethod = Static<typeof PaymentMethod>

// ------------------------------------------------------------------ Buchung

/**
 * Ein Zimmer einer Gruppenbuchung.
 *
 * Die Zimmergruppe steht hier und nicht nur oben, weil eine Reisegruppe
 * selten in einer einzigen Gruppe liegt: zwei Suiten, sechs Doppelzimmer.
 * `resourceId` ist frei -- wer im Belegungsplan ueber konkrete Zeilen
 * aufzieht, meint genau diese Zimmer; wer nur die Anzahl kennt, laesst es
 * weg und weist spaeter zu.
 */
export const CreateBookingRoom = Type.Object({
  categoryId: Type.Integer(),
  resourceId: Type.Optional(Type.Integer())
})
export type CreateBookingRoom = Static<typeof CreateBookingRoom>

export const CreateBooking = Type.Object({
  propertyId: Type.Integer(),
  /**
   * Die Zimmergruppe der einen Reservierung. Entfaellt, wenn `rooms` die
   * Zimmer einzeln nennt -- dann steht die Gruppe je Zimmer.
   */
  categoryId: Type.Optional(Type.Integer()),
  /**
   * Mehrere Zimmer in **einer** Buchung: die Gruppenbuchung.
   *
   * Nicht mehrere Buchungen nebeneinander, sondern eine mit mehreren
   * Reservierungen -- so, wie das Datenmodell es ohnehin vorsieht
   * (`booking` 1:n `reservation`). Der Unterschied ist nicht kosmetisch: die
   * Gruppe hat einen Besteller, eine Herkunft und eine Rechnung, und wer sie
   * als acht einzelne Buchungen anlegt, hat acht Vorgaenge, die nichts mehr
   * verbindet.
   *
   * Der Zeitraum gilt fuer alle Zimmer gemeinsam. Wer fuer ein Zimmer
   * abweichende Tage braucht, aendert danach dessen Aufenthalt; ein Feld je
   * Zimmer haette den Abruf aus einem Kontingent unentscheidbar gemacht,
   * das immer ueber den ganzen Zeitraum laeuft.
   */
  rooms: Type.Optional(Type.Array(CreateBookingRoom)),
  arrival: IsoDate,
  departure: IsoDate,
  ratePlanId: Type.Optional(Type.Integer()),
  guestId: Type.Optional(Type.Integer()),
  source: Type.Optional(Type.String()),
  externalReference: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  /**
   * Verbindlich oder unverbindlich. Ohne Angabe verbindlich, wie bisher.
   *
   * `Optional` verlangt `optionExpiresAt`: der Nachtlauf laesst eine Option
   * am Fristende verfallen und gibt den Platz frei. Ohne Frist verfaellt
   * sie nie und haelt Bestand, den niemand mehr abruft -- still, und in
   * einem vollen Haus teuer.
   */
  status: Type.Optional(Type.Union([
    Type.Literal('Confirmed'), Type.Literal('Optional')])),
  optionExpiresAt: Type.Optional(Type.String()),
  /**
   * Preis **je Nacht** in Cent, statt des Preises aus dem Ratenplan.
   *
   * Je Nacht und nicht als Summe: `reservation_night.price_cent` ist je
   * Nacht, und eine Summe muesste hier durch die Naechte geteilt werden.
   * Bei drei Naechten und 100,00 EUR gaebe das dreimal 33,33 und einen Cent,
   * der irgendwo landen muss. Wer eine Summe vereinbart hat, rechnet sie
   * einmal im Kopf; das System soll nicht so tun, als ginge es auf.
   */
  priceCent: Type.Optional(Type.Integer({ minimum: 0 })),
  /**
   * Wie viele Personen anreisen. Ohne Angabe gilt, was verkauft wurde --
   * die Belegung der Zimmergruppe (Migration 0054).
   */
  guestCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 99 })),
  /**
   * Merkmal fuer den Balken im Belegungsplan. Vierzig Zeichen, und die
   * Grenze ist der Zweck: ein Merkmal, kein Satz. Der Vorgang gehoert in
   * `notes`.
   */
  shortNote: Type.Optional(Type.String({ maxLength: 40 })),
  /** Abruf aus einem Kontingent statt aus dem freien Verkauf. */
  blockRef: Type.Optional(Type.String())
  // Es gibt bewusst kein Feld fuer Kartendaten. Eine Garantie laeuft ueber
  // Pay-by-Link oder das virtuelle Terminal des Zahlungsdienstleisters,
  // damit keine Kartendaten durch dieses System laufen (E8, Dokument 13).
})
export type CreateBooking = Static<typeof CreateBooking>

export const BookingCreatedRoom = Type.Object({
  reservationRef: Type.String(),
  categoryId: Type.Integer(),
  resourceId: Type.Union([Type.Integer(), Type.Null()]),
  totalCent: Cent
})
export type BookingCreatedRoom = Static<typeof BookingCreatedRoom>

export const BookingCreated = Type.Object({
  bookingRef: Type.String(),
  /**
   * Die **erste** Reservierung der Buchung.
   *
   * Bleibt, weil die weitaus meisten Buchungen genau eine haben und jeder
   * bestehende Aufrufer dieses Feld liest. Wer die Gruppe meint, nimmt
   * `reservations` -- dort steht sie vollstaendig, auch im Einzelfall.
   */
  reservationRef: Type.String(),
  reservations: Type.Array(BookingCreatedRoom),
  arrival: IsoDate,
  departure: IsoDate,
  nights: Type.Integer(),
  /** Ueber alle Zimmer der Buchung, nicht nur ueber das erste. */
  totalCent: Cent
})
export type BookingCreated = Static<typeof BookingCreated>

// ------------------------------------------------------- Kontingent / Gruppe

/**
 * Ein Kontingent haelt Zimmer einer Kategorie, ohne sie zu verkaufen. Ein
 * Abruf ist eine Reservierung dagegen: der Platz wandert von `blocked` nach
 * `sold`, die Summe bleibt gleich.
 */
export const BlockPickup = Type.Object({
  reservationRef: Type.String(),
  status: ReservationStatus,
  arrival: IsoDate,
  departure: IsoDate,
  guest: Type.String()
})
export type BlockPickup = Static<typeof BlockPickup>

export const Block = Type.Object({
  blockRef: Type.String(),
  name: Type.String(),
  categoryId: Type.Integer(),
  categoryName: Type.String(),
  companyName: Type.Union([Type.String(), Type.Null()]),
  fromDate: IsoDate,
  toDate: IsoDate,
  quantity: Type.Integer(),
  pickedUp: Type.Integer(),
  /** Noch nicht abgerufen und damit weiterhin gehalten. */
  remaining: Type.Integer(),
  releaseDate: Type.Union([IsoDate, Type.Null()]),
  status: Type.Union([
    Type.Literal('active'), Type.Literal('released'), Type.Literal('closed')]),
  pickups: Type.Array(BlockPickup)
})
export type Block = Static<typeof Block>

export const CreateBlock = Type.Object({
  name: Type.String({ minLength: 1 }),
  categoryId: Type.Integer(),
  fromDate: IsoDate,
  toDate: IsoDate,
  quantity: Type.Integer({ minimum: 1 }),
  companyId: Type.Optional(Type.Integer()),
  ratePlanId: Type.Optional(Type.Integer()),
  /** Ab diesem Tag gibt der Nachtlauf den nicht abgerufenen Rest frei. */
  releaseDate: Type.Optional(IsoDate)
})
export type CreateBlock = Static<typeof CreateBlock>

// -------------------------------------------------------------------- Gast

export const Guest = Type.Object({
  guestRef: Type.String(),
  lastName: Type.String(),
  firstName: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  birthDate: Type.Union([Type.String(), Type.Null()]),
  nationality: Type.Union([Type.String(), Type.Null()]),
  language: Type.String(),
  address: Type.Object({
    line1: Type.Union([Type.String(), Type.Null()]),
    postalCode: Type.Union([Type.String(), Type.Null()]),
    city: Type.Union([Type.String(), Type.Null()]),
    country: Type.Union([Type.String(), Type.Null()])
  }),
  idDocumentType: Type.Union([Type.String(), Type.Null()]),
  hasIdDocumentNumber: Type.Boolean(),
  preferences: Type.Record(Type.String(), Type.Unknown()),
  status: Type.String()
})
export type Guest = Static<typeof Guest>

export const CreateGuest = Type.Object({
  accountId: Type.Optional(Type.Integer()),
  lastName: Type.String({ minLength: 1 }),
  firstName: Type.Optional(Type.String()),
  email: Type.Optional(Type.String()),
  phone: Type.Optional(Type.String()),
  birthDate: Type.Optional(IsoDate),
  nationality: Type.Optional(Type.String()),
  language: Type.Optional(Type.String()),
  addressLine1: Type.Optional(Type.String()),
  postalCode: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
  country: Type.Optional(Type.String()),
  idDocumentType: Type.Optional(Type.Union([
    Type.Literal('passport'), Type.Literal('id_card'), Type.Literal('other')])),
  idDocumentNumber: Type.Optional(Type.String())
})
export type CreateGuest = Static<typeof CreateGuest>

/** Antwort auf das Anlegen: das Profil, dazu moegliche Dubletten. */
export const GuestCreated = Type.Composite([
  Guest,
  Type.Object({
    possibleDuplicates: Type.Array(Type.Object({
      guestRef: Type.String(), score: Type.Number(), reason: Type.String()
    }))
  })
])
export type GuestCreated = Static<typeof GuestCreated>

// ------------------------------------------------------------------- Firma

export const Company = Type.Object({
  companyRef: Type.String(),
  name: Type.String(),
  vatId: Type.Union([Type.String(), Type.Null()]),
  addressLine1: Type.Union([Type.String(), Type.Null()]),
  postalCode: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  country: Type.String(),
  paymentTermsDays: Type.Integer(),
  invoiceEmail: Type.Union([Type.String(), Type.Null()]),
  active: Type.Boolean()
})
export type Company = Static<typeof Company>

export const CreateCompany = Type.Object({
  accountId: Type.Optional(Type.Integer()),
  name: Type.String({ minLength: 1 }),
  vatId: Type.Optional(Type.String()),
  addressLine1: Type.Optional(Type.String()),
  postalCode: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
  country: Type.Optional(Type.String()),
  paymentTermsDays: Type.Optional(Type.Integer({ minimum: 0 })),
  invoiceEmail: Type.Optional(Type.String())
})
export type CreateCompany = Static<typeof CreateCompany>

// ------------------------------------------------------------- Reservierung

/**
 * Eine Reservierung, vollständig: Gast, Zimmer, Ratenplan, Nächte mit
 * Preisen, Mitreisende, Folio und Kontingent in einem Aufruf. Das ist die
 * Antwort auf einen angeklickten Balken im Belegungsplan (Aufgabe A1).
 */
export const ReservationNight = Type.Object({
  date: Type.String(),
  priceCent: Cent,
  ratePlanId: Type.Union([Type.Integer(), Type.Null()])
})

export const ReservationOccupant = Type.Object({
  ageAtArrival: Type.Union([Type.Integer(), Type.Null()]),
  isPrimary: Type.Boolean(),
  guestRef: Type.Union([Type.String(), Type.Null()]),
  name: Type.Union([Type.String(), Type.Null()])
})

export const ReservationDetail = Type.Object({
  reservationRef: Type.String(),
  bookingRef: Type.String(),
  status: ReservationStatus,
  arrival: Type.String(),
  departure: Type.String(),
  notes: Type.Union([Type.String(), Type.Null()]),
  categoryId: Type.Integer(),
  categoryCode: Type.String(),
  categoryName: Type.String(),
  resourceId: Type.Union([Type.Integer(), Type.Null()]),
  roomCode: Type.Union([Type.String(), Type.Null()]),
  floor: Type.Union([Type.String(), Type.Null()]),
  ratePlanId: Type.Union([Type.Integer(), Type.Null()]),
  ratePlanCode: Type.Union([Type.String(), Type.Null()]),
  guestRef: Type.Union([Type.String(), Type.Null()]),
  guestName: Type.Union([Type.String(), Type.Null()]),
  guestEmail: Type.Union([Type.String(), Type.Null()]),
  guestLanguage: Type.Union([Type.String(), Type.Null()]),
  companyRef: Type.Union([Type.String(), Type.Null()]),
  companyName: Type.Union([Type.String(), Type.Null()]),
  blockRef: Type.Union([Type.String(), Type.Null()]),
  blockName: Type.Union([Type.String(), Type.Null()]),
  source: Type.String(),
  externalReference: Type.Union([Type.String(), Type.Null()]),
  checkedInAt: Type.Union([Type.String(), Type.Null()]),
  checkedOutAt: Type.Union([Type.String(), Type.Null()]),
  canceledAt: Type.Union([Type.String(), Type.Null()]),
  folioRef: Type.Union([Type.String(), Type.Null()]),
  nights: Type.Array(ReservationNight),
  occupants: Type.Array(ReservationOccupant),
  totalCent: Cent
})
export type ReservationDetail = Static<typeof ReservationDetail>

// ------------------------------------------------------- Haus und Betrieb

export const MaintenanceBlock = Type.Object({
  /**
   * `out_of_order` senkt die Kapazitaet, `out_of_service` nicht. Der
   * Unterschied ist die ganze Aussage: ein defektes Zimmer ist nicht
   * verkaeuflich, ein abgenutztes schon.
   */
  kind: Type.Union([Type.Literal('out_of_order'), Type.Literal('out_of_service')]),
  from: IsoDate,
  to: IsoDate,
  reason: Type.String()
})
export type MaintenanceBlock = Static<typeof MaintenanceBlock>

export const MaintenanceTicket = Type.Object({
  id: Type.Integer(),
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  priority: Type.Union([
    Type.Literal('low'), Type.Literal('normal'), Type.Literal('high')]),
  status: Type.Union([
    Type.Literal('open'), Type.Literal('in_progress'), Type.Literal('done')]),
  createdAt: Type.String(),
  closedAt: Type.Union([Type.String(), Type.Null()]),
  resourceId: Type.Union([Type.Integer(), Type.Null()]),
  roomCode: Type.Union([Type.String(), Type.Null()]),
  /** Laufende Sperrungen des Zimmers. Kommen mit, nicht je Zeile nachgeladen. */
  blocks: Type.Array(MaintenanceBlock)
})
export type MaintenanceTicket = Static<typeof MaintenanceTicket>

export const CreateMaintenanceTicket = Type.Object({
  propertyId: Type.Integer(),
  title: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  resourceId: Type.Optional(Type.Integer()),
  priority: Type.Optional(Type.Union([
    Type.Literal('low'), Type.Literal('normal'), Type.Literal('high')])),
  block: Type.Optional(Type.Object({
    from: IsoDate, to: IsoDate,
    kind: Type.Optional(Type.Union([
      Type.Literal('out_of_order'), Type.Literal('out_of_service')]))
  }))
})
export type CreateMaintenanceTicket = Static<typeof CreateMaintenanceTicket>

export const EmailSettings = Type.Object({
  fromName: Type.Union([Type.String(), Type.Null()]),
  fromEmail: Type.Union([Type.String(), Type.Null()]),
  replyTo: Type.Union([Type.String(), Type.Null()]),
  bccEmail: Type.Union([Type.String(), Type.Null()]),
  enabled: Type.Boolean(),
  updatedAt: Type.Union([Type.String(), Type.Null()])
})
export type EmailSettings = Static<typeof EmailSettings>

/**
 * Ein DNS-Eintrag, wie ihn das Haus bei seinem Domainanbieter abtippt.
 * `ok` kommt vom Versandanbieter, nicht aus einer eigenen Abfrage: was wir
 * selbst aufloesen wuerden, koennte aus einem Zwischenspeicher stammen und
 * dem Haus ein "steht" zeigen, mit dem der Anbieter nicht einverstanden ist.
 */
export const DnsRecord = Type.Object({
  host: Type.String(),
  type: Type.String(),
  value: Type.String(),
  ok: Type.Boolean()
})
export type DnsRecord = Static<typeof DnsRecord>

export const EmailDomain = Type.Object({
  mode: Type.Union([Type.Literal('own'), Type.Literal('relay'), Type.Null()]),
  domain: Type.Union([Type.String(), Type.Null()]),
  localPart: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([
    Type.Literal('requested'), Type.Literal('rejected'),
    Type.Literal('dns_pending'), Type.Literal('active'), Type.Null()]),
  verified: Type.Boolean(),
  authenticated: Type.Boolean(),
  dnsRecords: Type.Array(DnsRecord),
  requestedAt: Type.Union([Type.String(), Type.Null()]),
  decidedAt: Type.Union([Type.String(), Type.Null()]),
  decisionNote: Type.Union([Type.String(), Type.Null()]),
  checkedAt: Type.Union([Type.String(), Type.Null()]),
  /** Nur mitgeliefert, solange nichts beantragt ist: der Weg fuer Haeuser
   *  ohne eigene Domain. */
  relayDomain: Type.Optional(Type.String())
})
export type EmailDomain = Static<typeof EmailDomain>

/** Ein Antrag, wie ihn das Adminpanel sieht. Kein Gast, keine Buchung. */
export const EmailDomainRequest = Type.Object({
  propertyId: Type.Integer(),
  propertyName: Type.String(),
  accountId: Type.Integer(),
  accountName: Type.String(),
  mode: Type.Union([Type.Literal('own'), Type.Literal('relay')]),
  domain: Type.String(),
  localPart: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  verified: Type.Boolean(),
  authenticated: Type.Boolean(),
  dnsRecords: Type.Array(DnsRecord),
  requestedByName: Type.Union([Type.String(), Type.Null()]),
  requestedAt: Type.String(),
  decidedByName: Type.Union([Type.String(), Type.Null()]),
  decidedAt: Type.Union([Type.String(), Type.Null()]),
  decisionNote: Type.Union([Type.String(), Type.Null()]),
  checkedAt: Type.Union([Type.String(), Type.Null()])
})
export type EmailDomainRequest = Static<typeof EmailDomainRequest>

export const CreatePaymentMethod = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 20 }),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  isExternal: Type.Optional(Type.Boolean()),
  sortOrder: Type.Optional(Type.Integer())
})
export type CreatePaymentMethod = Static<typeof CreatePaymentMethod>

// ---------------------------------------------------------------- Berichte

export const KpiDay = Type.Object({
  date: IsoDate,
  capacity: Type.Integer(),
  sold: Type.Integer(),
  /** Kapazitaet abzueglich gesperrter Einheiten. Bezugsgroesse fuer RevPAR. */
  available: Type.Integer(),
  occupancyPercent: Type.Number(),
  roomRevenueCent: Cent,
  adrCent: Cent,
  revparCent: Cent,
  /**
   * `aufgezeichnet` kommt aus `business_day_stat`, `auf den Buechern` aus dem
   * laufenden Zaehler. Der Unterschied gehoert an den Bildschirm: das eine
   * ist festgehalten, das andere aendert sich noch.
   */
  source: Type.String()
})
export type KpiDay = Static<typeof KpiDay>

export const KpiTotal = Type.Object({
  sold: Type.Integer(),
  available: Type.Integer(),
  roomRevenueCent: Cent,
  occupancyPercent: Type.Number(),
  adrCent: Cent,
  revparCent: Cent
})
export type KpiTotal = Static<typeof KpiTotal>

export const KpiReport = Type.Object({
  from: IsoDate,
  to: IsoDate,
  days: Type.Array(KpiDay),
  total: KpiTotal,
  /** Nur bei `compare=previous-year`. Derselbe Zeitraum ein Jahr zurueck. */
  comparison: Type.Optional(Type.Object({
    from: IsoDate, to: IsoDate, days: Type.Array(KpiDay), total: KpiTotal
  }))
})
export type KpiReport = Static<typeof KpiReport>

export const NightAuditStep = Type.Object({
  step: Type.String(),
  completedAt: Type.String(),
  count: Type.Union([Type.Integer(), Type.Null()])
})
export type NightAuditStep = Static<typeof NightAuditStep>

export const NightAuditDay = Type.Object({
  date: IsoDate,
  status: Type.Union([Type.Literal('open'), Type.Literal('closed')]),
  closedAt: Type.Union([Type.String(), Type.Null()]),
  steps: Type.Array(NightAuditStep),
  sold: Type.Union([Type.Integer(), Type.Null()]),
  arrivals: Type.Union([Type.Integer(), Type.Null()]),
  departures: Type.Union([Type.Integer(), Type.Null()]),
  roomRevenueCent: Type.Union([Cent, Type.Null()])
})
export type NightAuditDay = Static<typeof NightAuditDay>

export const NightAuditStatus = Type.Object({
  /** Geschaeftsdatum der Property, nicht der Kalendertag des Betrachters. */
  businessDate: IsoDate,
  openDate: Type.Union([IsoDate, Type.Null()]),
  daysBehind: Type.Union([Type.Integer(), Type.Null()]),
  overdue: Type.Boolean(),
  expectedSteps: Type.Array(Type.String()),
  days: Type.Array(NightAuditDay)
})
export type NightAuditStatus = Static<typeof NightAuditStatus>

export const AccommodationStatistics = Type.Object({
  month: Type.String(),
  rooms: Type.Integer(),
  beds: Type.Integer(),
  /** Meldepflichtig ab zehn Schlafgelegenheiten. */
  reportingRequired: Type.Boolean(),
  byCountry: Type.Array(Type.Object({
    country: Type.Union([Type.String(), Type.Null()]),
    arrivals: Type.Integer(),
    nights: Type.Integer()
  })),
  totals: Type.Object({ arrivals: Type.Integer(), nights: Type.Integer() }),
  hinweis: Type.String(),
  hinweisKey: Type.String()
})
export type AccommodationStatistics = Static<typeof AccommodationStatistics>

// ------------------------------------------------------------ Schnittstellen

export const WebhookSubscription = Type.Object({
  subscriptionRef: Type.String(),
  url: Type.String(),
  eventTypes: Type.Array(Type.String()),
  /** Leer gespeichert heisst alle. Die Antwort sagt es ausdruecklich. */
  allEventTypes: Type.Boolean(),
  propertyIds: Type.Array(Type.Integer()),
  allProperties: Type.Boolean(),
  status: Type.String(),
  disabledAt: Type.Union([Type.String(), Type.Null()]),
  /** Warum stillgelegt. Gehoert an die Zeile, nicht in ein Protokoll. */
  disabledReason: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String()
})
export type WebhookSubscription = Static<typeof WebhookSubscription>

export const WebhookAttempt = Type.Object({
  attempt: Type.Integer(),
  statusCode: Type.Union([Type.Integer(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  durationMs: Type.Union([Type.Integer(), Type.Null()]),
  attemptedAt: Type.String()
})
export type WebhookAttempt = Static<typeof WebhookAttempt>

export const WebhookDelivery = Type.Object({
  eventRef: Type.String(),
  eventType: Type.String(),
  status: Type.String(),
  attempts: Type.Integer(),
  lastStatusCode: Type.Union([Type.Integer(), Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
  occurredAt: Type.String(),
  nextAttemptAt: Type.Union([Type.String(), Type.Null()]),
  deliveredAt: Type.Union([Type.String(), Type.Null()]),
  attemptLog: Type.Array(WebhookAttempt)
})
export type WebhookDelivery = Static<typeof WebhookDelivery>

export const OAuthClient = Type.Object({
  clientId: Type.String(),
  name: Type.String(),
  scopes: Type.Array(Type.String()),
  propertyIds: Type.Array(Type.Integer()),
  status: Type.String(),
  createdAt: Type.String(),
  activeTokens: Type.Integer(),
  lastUsedAt: Type.Union([Type.String(), Type.Null()])
})
export type OAuthClient = Static<typeof OAuthClient>

export const ChannelConnection = Type.Object({
  connectionRef: Type.String(),
  provider: Type.String(),
  name: Type.String(),
  status: Type.String(),
  lastUsedAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String()
})
export type ChannelConnection = Static<typeof ChannelConnection>

export const PropertyRole = Type.Object({
  key: Type.String(),
  name: Type.String(),
  level: Type.String(),
  isSystem: Type.Boolean(),
  /**
   * Die Rechte, wie die API sie liefert. Die Oberflaeche zeigt sie und
   * schliesst nicht aus dem Rollennamen auf sie -- sonst liegt sie bei der
   * ersten eigenen Rolle eines Kunden falsch, und zwar still.
   */
  permissions: Type.Array(Type.String())
})
export type PropertyRole = Static<typeof PropertyRole>

export const PropertyUser = Type.Object({
  userRef: Type.String(),
  displayName: Type.String(),
  email: Type.String(),
  status: Type.String(),
  lastLoginAt: Type.Union([Type.String(), Type.Null()]),
  roles: Type.Array(Type.Object({ key: Type.String(), name: Type.String() })),
  permissions: Type.Array(Type.String()),
  /** Gesperrt bei diesem Betrieb. Rollen stehen noch, wirken nicht (0040). */
  blocked: Type.Boolean(),
  lockedUntil: Type.Union([Type.String(), Type.Null()]),
  /** Rollen fuer den ganzen Betrieb; nur mit settings:account anzufassen. */
  accountRoles: Type.Array(Type.Object({ key: Type.String(), name: Type.String() })),
  isSelf: Type.Boolean()
})
export type PropertyUser = Static<typeof PropertyUser>

// ------------------------------------------------------------------ Raten

export const RatePlan = Type.Object({
  id: Type.Integer(),
  ratePlanRef: Type.String(),
  code: Type.String(),
  name: Type.String(),
  categoryId: Type.Integer(),
  categoryCode: Type.String(),
  /** Gesetzt bei einer abgeleiteten Rate: die Basis, aus der sie entsteht. */
  baseRatePlanId: Type.Union([Type.Integer(), Type.Null()]),
  deriveKind: Type.Union([Type.Literal('amount'), Type.Literal('percent'), Type.Null()]),
  deriveValue: Type.Union([Type.Integer(), Type.Null()]),
  active: Type.Boolean()
})
export type RatePlan = Static<typeof RatePlan>

/**
 * Eine Zelle des Preisrasters: ein Ratenplan an einem Tag.
 *
 * `priceCent` ist ein Preis **je Belegung**, Index 0 ist eine Person. Ein
 * Doppelzimmer kostet einzeln belegt anders als zu zweit, und beides gehoert
 * an denselben Tag desselben Plans. `null` heisst: fuer diesen Tag ist kein
 * Preis gepflegt -- nicht null Euro.
 */
export const RateGridCell = Type.Object({
  ratePlanId: Type.Integer(),
  ratePlanCode: Type.String(),
  date: IsoDate,
  priceCent: Type.Union([Type.Array(Cent), Type.Null()]),
  minLos: Type.Union([Type.Integer(), Type.Null()]),
  maxLos: Type.Union([Type.Integer(), Type.Null()]),
  closed: Type.Boolean(),
  closedToArrival: Type.Boolean(),
  closedToDeparture: Type.Boolean()
})
export type RateGridCell = Static<typeof RateGridCell>

export const RateGrid = Type.Object({
  from: IsoDate,
  to: IsoDate,
  cells: Type.Array(RateGridCell)
})
export type RateGrid = Static<typeof RateGrid>

/** Wochentage, Montag = 0. Ohne Angabe gilt die Aenderung fuer alle. */
export const Weekdays = Type.Array(Type.Integer({ minimum: 0, maximum: 6 }))

export const SetRates = Type.Object({
  propertyId: Type.Integer(),
  ratePlanId: Type.Integer(),
  from: IsoDate,
  to: IsoDate,
  weekdays: Type.Optional(Weekdays),
  /** Ersetzt den ganzen Preisvektor des Tages, Index 0 ist eine Person. */
  priceCent: Type.Array(Cent)
})
export type SetRates = Static<typeof SetRates>

export const SetRestrictions = Type.Object({
  propertyId: Type.Integer(),
  ratePlanId: Type.Integer(),
  from: IsoDate,
  to: IsoDate,
  weekdays: Type.Optional(Weekdays),
  minLos: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  maxLos: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  closed: Type.Optional(Type.Boolean()),
  closedToArrival: Type.Optional(Type.Boolean()),
  closedToDeparture: Type.Optional(Type.Boolean())
})
export type SetRestrictions = Static<typeof SetRestrictions>

// ------------------------------------------------------------- Rechnungen

/**
 * Eine Zeile der Rechnungsliste.
 *
 * `settledCent` ist die Summe der Zahlungsvermerke, die dieser Rechnung
 * zugeordnet sind. Zahlungen, die vor der Einfuehrung der Zuordnung
 * vermerkt wurden, traegt sie nicht -- solche Rechnungen stehen als offen
 * da, obwohl sie bezahlt sind, und der Saldo des Folios ist dann die
 * Wahrheit.
 */
export const InvoiceListItem = Type.Object({
  invoiceRef: Type.String(),
  number: Type.String(),
  issuedOn: IsoDate,
  businessDate: IsoDate,
  kind: Type.Union([
    Type.Literal('final'), Type.Literal('interim'),
    Type.Literal('deposit'), Type.Literal('credit_note')]),
  currency: Type.String(),
  grossCent: Cent,
  /** Was die Rechnung fordert: Bruttosumme samt Rundungsausgleich (BT-115). */
  payableCent: Cent,
  /** Davon zugeordnet vermerkt. Der Rest ist offen. */
  settledCent: Cent,
  recipient: Type.String(),
  folioRef: Type.String(),
  /** Der Beleg entsteht nach dem Festschreiben im Worker. */
  documentReady: Type.Boolean(),
  /** Nicht jede gueltige Rechnung ist ein EN-16931-Beleg (Kleinbetrag). */
  hasXml: Type.Boolean(),
  mailStatus: Type.Union([Type.String(), Type.Null()])
})
export type InvoiceListItem = Static<typeof InvoiceListItem>

export const InvoiceList = Type.Object({
  from: IsoDate,
  to: IsoDate,
  limit: Type.Integer(),
  invoices: Type.Array(InvoiceListItem)
})
export type InvoiceList = Static<typeof InvoiceList>

// ------------------------------------------------------ Vorauszahlung

/** Eine Satzgruppe einer Anzahlungsrechnung. */
export const DepositGroup = Type.Object({
  rateBp: Type.Integer(),
  grossCent: Cent,
  taxCent: Cent
})
export type DepositGroup = Static<typeof DepositGroup>

/**
 * Eine Anzahlungsrechnung mit ihrem Verrechnungsstand.
 *
 * `appliedInvoiceNumber` bleibt null, solange nicht verrechnet ist. Das
 * unterscheidet "angezahlt" von "abgerechnet", und die Verrechnung steht
 * als Position auf der Schlussrechnung, nicht als Kopfangabe.
 */
export const DepositInvoice = Type.Object({
  invoiceRef: Type.String(),
  number: Type.String(),
  issuedOn: IsoDate,
  settlementId: Type.Union([Type.Integer(), Type.Null()]),
  amountGrossCent: Cent,
  taxCent: Cent,
  groups: Type.Array(DepositGroup),
  appliedInvoiceNumber: Type.Union([Type.String(), Type.Null()]),
  appliedInvoiceRef: Type.Union([Type.String(), Type.Null()]),
  appliedOn: Type.Union([IsoDate, Type.Null()])
})
export type DepositInvoice = Static<typeof DepositInvoice>

/**
 * Ein Zahlungslink.
 *
 * **Die Adresse steht hier nicht.** Sie wird bei der Anlage einmal
 * ausgegeben und nicht gespeichert -- ein Link, der in der Datenbank liegt,
 * ist ein Link, den jeder mit Lesezugriff einloesen kann. Wer ihn noch
 * einmal braucht, erzeugt einen neuen.
 */
export const PaymentLink = Type.Object({
  id: Type.Integer(),
  createdAt: Type.String(),
  amountCent: Cent,
  status: Type.Union([
    Type.Literal('pending'), Type.Literal('succeeded'), Type.Literal('failed')]),
  settledAt: Type.Union([Type.String(), Type.Null()]),
  /** Erst mit dem Zahlungsvermerk ist aus dem Link Geld geworden. */
  hasSettlement: Type.Boolean()
})
export type PaymentLink = Static<typeof PaymentLink>

/** Ein Zahlungsvermerk in der Sicht der Vorauszahlung. */
export const PrepaymentSettlement = Type.Object({
  id: Type.Integer(),
  businessDate: IsoDate,
  amountCent: Cent,
  method: Type.String(),
  externalReference: Type.Union([Type.String(), Type.Null()]),
  /** Gesetzt heisst: zu diesem Vermerk gibt es schon eine Anzahlungsrechnung. */
  depositInvoiceRef: Type.Union([Type.String(), Type.Null()]),
  depositInvoiceNumber: Type.Union([Type.String(), Type.Null()])
})
export type PrepaymentSettlement = Static<typeof PrepaymentSettlement>

export const PrepaymentView = Type.Object({
  folioRef: Type.String(),
  /**
   * Ohne Reservierung fehlt der Leistungszeitraum (Paragraph 14 Abs. 4
   * Nr. 6 UStG), und ein geschlossenes Folio nimmt nichts mehr an.
   */
  canIssueDeposit: Type.Boolean(),
  settlements: Type.Array(PrepaymentSettlement),
  deposits: Type.Array(DepositInvoice),
  paymentLinks: Type.Array(PaymentLink)
})
export type PrepaymentView = Static<typeof PrepaymentView>

// --------------------------------------------- Sicht des Channel Managers

/** Ein Tag je Kategorie, genau wie `GET /v1/channel/ari/availability`. */
export const ChannelAvailabilityDay = Type.Object({
  categoryCode: Type.String(),
  date: IsoDate,
  capacity: Type.Integer(),
  sold: Type.Integer(),
  blocked: Type.Integer(),
  overbooking: Type.Integer(),
  available: Type.Integer(),
  updatedAt: Type.String()
})
export type ChannelAvailabilityDay = Static<typeof ChannelAvailabilityDay>

/**
 * Ein Tag je Ratenplan, genau wie `GET /v1/channel/ari/rates`.
 *
 * `priceCent: null` ist kein Fehler: der Tag ist ungepflegt und wird
 * drueben nicht verkauft. Genau das ist der haeufigste Grund dafuer, dass
 * bei einem Portal nichts oder etwas anderes steht.
 */
export const ChannelRateCell = Type.Object({
  categoryCode: Type.String(),
  ratePlanCode: Type.String(),
  date: IsoDate,
  /**
   * Preis **je Belegung**: Index 0 ist eine Person, Index 1 sind zwei.
   * Hinaus geht die ganze Reihe, nicht ein Preis -- welchen ein Portal
   * anzeigt, haengt daran, wie viele Personen gesucht werden.
   */
  priceCent: Type.Union([Type.Array(Cent), Type.Null()]),
  minLos: Type.Union([Type.Integer(), Type.Null()]),
  maxLos: Type.Union([Type.Integer(), Type.Null()]),
  closed: Type.Boolean(),
  closedToArrival: Type.Boolean(),
  closedToDeparture: Type.Boolean(),
  updatedAt: Type.Union([Type.String(), Type.Null()])
})
export type ChannelRateCell = Static<typeof ChannelRateCell>

export const ChannelView = Type.Object({
  from: IsoDate,
  to: IsoDate,
  generatedAt: Type.String(),
  days: Type.Array(ChannelAvailabilityDay),
  cells: Type.Array(ChannelRateCell)
})
export type ChannelView = Static<typeof ChannelView>

// ------------------------------------------------------------------ Fehler

/**
 * Fehlerdarstellung nach RFC 9457.
 *
 * `title`, `detail` und `errors` sind **deutsch** -- die Sprache der
 * Schnittstelle. Wer uebersetzen will, nimmt `code`, `params` und
 * `errorKeys`: das sind stabile Schluessel aus `messages.ts`, die sich
 * nicht aendern, wenn jemand einen Satz umformuliert.
 *
 * Beides steht nebeneinander, weil beides gebraucht wird. Ein Protokoll und
 * ein Skript, das eine Antwort ausgibt, sollen ohne Katalog lesbar bleiben;
 * die Oberflaeche soll den Satz in der Sprache des Personals zeigen.
 */
export const Problem = Type.Object({
  type: Type.String(),
  title: Type.String(),
  status: Type.Integer(),
  detail: Type.Optional(Type.String()),
  instance: Type.Optional(Type.String()),
  errors: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
  /** Schluessel der Meldung in `detail`, sonst der des Titels. */
  code: Type.Optional(Type.String()),
  /** Werte fuer die Platzhalter von `code` und `errorKeys`. */
  params: Type.Optional(Type.Record(Type.String(),
    Type.Union([Type.String(), Type.Number()]))),
  /** Dieselben Feldfehler wie `errors`, als Schluessel. */
  errorKeys: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String())))
})
export type Problem = Static<typeof Problem>
