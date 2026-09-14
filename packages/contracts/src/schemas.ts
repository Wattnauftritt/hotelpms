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
  label: Type.String(),
  hint: Type.String()
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
    occupants: Type.Integer()
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
  balanceCent: Cent
})
export type FolioView = Static<typeof FolioView>

export const PaymentMethod = Type.Object({
  code: Type.String(),
  name: Type.String(),
  isExternal: Type.Boolean()
})
export type PaymentMethod = Static<typeof PaymentMethod>

// ------------------------------------------------------------------ Buchung

export const CreateBooking = Type.Object({
  propertyId: Type.Integer(),
  categoryId: Type.Integer(),
  arrival: IsoDate,
  departure: IsoDate,
  ratePlanId: Type.Optional(Type.Integer()),
  guestId: Type.Optional(Type.Integer()),
  source: Type.Optional(Type.String()),
  externalReference: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  /** Abruf aus einem Kontingent statt aus dem freien Verkauf. */
  blockRef: Type.Optional(Type.String())
  // Es gibt bewusst kein Feld fuer Kartendaten. Eine Garantie laeuft ueber
  // Pay-by-Link oder das virtuelle Terminal des Zahlungsdienstleisters,
  // damit keine Kartendaten durch dieses System laufen (E8, Dokument 13).
})
export type CreateBooking = Static<typeof CreateBooking>

export const BookingCreated = Type.Object({
  bookingRef: Type.String(),
  reservationRef: Type.String(),
  arrival: IsoDate,
  departure: IsoDate,
  nights: Type.Integer(),
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
  hinweis: Type.String()
})
export type AccommodationStatistics = Static<typeof AccommodationStatistics>

// ------------------------------------------------------------------ Fehler

/** Fehlerdarstellung nach RFC 9457. */
export const Problem = Type.Object({
  type: Type.String(),
  title: Type.String(),
  status: Type.Integer(),
  detail: Type.Optional(Type.String()),
  instance: Type.Optional(Type.String()),
  errors: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String())))
})
export type Problem = Static<typeof Problem>
