import { Type, type Static } from '@sinclair/typebox'
import { LOCALES } from './messages.js'
import { CleaningWaiverView } from './cleaningWaiver.js'

/**
 * Digitale Gaestemappe: der Vertrag zwischen der Seite des Gastes, den
 * Einstellungen des Hauses, der Zimmerkarte und der Schnittstelle
 * (Migration 0143).
 *
 * Wie beim Online-Check-in (`checkin.ts`): die Referenz des Zimmers steht im
 * **Fragment** der Adresse auf der Karte und reist in einer **Kopfzeile** zur
 * Schnittstelle, nie im Pfad und nie in der Abfragezeichenfolge. So steht
 * sie in keinem Zugriffsprotokoll, und wer ein Protokoll liest, oeffnet
 * damit keine Mappe.
 */

export const FOLDER_ROOM_HEADER = 'x-staygrid-folder-room'

/** Der Pfad der Mappe in der Oberflaeche. */
export const FOLDER_PATH = '/mappe'

/**
 * Das Cookie der Freischaltung (0147). Nur an die Routen der Mappe
 * (`Path=/v1/mappe`), nie an die Anwendung: ein Telefon, das ein Gast
 * weitergibt, soll damit nichts anderes erreichen.
 */
export const FOLDER_SESSION_COOKIE = 'hp_mappe'

/**
 * Die Sprachen der Mappe (Sven, 11.10.2026): dieselben wie die der
 * Gastpost, weil es dieselben Gaeste sind -- seit dem 12.10.2026 alle
 * vierzehn. Eine eigene Liste neben `EMAIL_LANGUAGES`, weil die Mappe ihren
 * eigenen Katalog hat, in dem jede Sprache vollstaendig sein muss -- die
 * Gastpost kann eine Sprache dazu nehmen, ohne dass die Mappe halb
 * uebersetzt erscheint.
 */
export const FOLDER_LOCALES = LOCALES
export type FolderLocale = (typeof FOLDER_LOCALES)[number]

/** Die Adresse im QR-Code der Zimmerkarte. */
export function folderLink(baseUrl: string, roomRef: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${FOLDER_PATH}#${roomRef}`
}

/**
 * Die Referenz aus dem Fragment, oder null.
 *
 * Streng auf die Form von `generate_public_ref()` (Migration 0001): zwoelf
 * Zeichen aus dessen Alphabet. Was abweicht, fragt gar nicht erst die
 * Datenbank.
 */
export function folderRefAusFragment(hash: string): string | null {
  const ref = hash.replace(/^#/, '').trim().toUpperCase()
  return /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(ref) ? ref : null
}

export const WifiSecurity = Type.Union([
  Type.Literal('WPA'), Type.Literal('WEP'), Type.Literal('nopass')])
export type WifiSecurity = Static<typeof WifiSecurity>

export const FolderWifi = Type.Object({
  ssid: Type.String({ minLength: 1, maxLength: 32 }),
  /** Leer bei einem offenen Netz. */
  password: Type.Union([Type.String({ maxLength: 63 }), Type.Null()]),
  security: WifiSecurity,
  hidden: Type.Boolean()
}, { additionalProperties: false })
export type FolderWifi = Static<typeof FolderWifi>

/**
 * Der Text im WLAN-QR-Code, den Android und iOS mit der Kamera erkennen.
 *
 * Format nach dem ZXing-Vorschlag `WIFI:T:..;S:..;P:..;H:..;;`. In Name und
 * Kennwort muessen `\ ; , : "` mit einem Rueckstrich maskiert werden; ein
 * Kennwort mit Semikolon ergaebe sonst einen Code, der ein anderes Kennwort
 * anbietet -- und der Gast sitzt vor einem Netz, das ihn abweist.
 */
export function wifiQrText(w: FolderWifi): string {
  const m = (s: string): string => s.replace(/([\\;,:"])/g, '\\$1')
  const teile = [`T:${w.security}`, `S:${m(w.ssid)}`]
  if (w.security !== 'nopass' && w.password !== null) teile.push(`P:${m(w.password)}`)
  if (w.hidden) teile.push('H:true')
  return `WIFI:${teile.join(';')};;`
}

/** Was die Seite des Gastes zeigt (`GET /v1/mappe`). */
/** Eine Seite in einer Sprache der Gaeste (0144). */
export const FolderPageText = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 300 }),
  body: Type.String({ maxLength: 10000 })
})
export type FolderPageText = Static<typeof FolderPageText>

/**
 * Was ein freigeschaltetes Telefon ueber den eigenen Aufenthalt sieht.
 * `cleaningWaiver` ist `null`, wenn das Haus den Verzicht nicht anbietet
 * oder kein Bleibetag mehr kommt (0148) -- dieselbe Form wie unter dem
 * Meldeschein, damit beide Tueren dasselbe zeigen.
 */
// ------------------------------------------------------------ Wuensche (0149)

/** Feste Gruende fuer "Nicht moeglich": der Gast liest sie in seiner Sprache. */
export const GUEST_REQUEST_DECLINE_REASONS = ['unavailable', 'notThatDay', 'askReception'] as const
export type GuestRequestDeclineReason = (typeof GUEST_REQUEST_DECLINE_REASONS)[number]
export const GuestRequestStatus = Type.Union([
  Type.Literal('open'), Type.Literal('done'), Type.Literal('declined')])
const DeclineReason = Type.Union(GUEST_REQUEST_DECLINE_REASONS.map(r => Type.Literal(r)))
/** Name je Sprache; `de` ist immer da und gilt, wo eine Sprache fehlt. */
const NameJeSprache = Type.Record(Type.String(), Type.String())
/**
 * Wann ein Eintrag angeboten wird (0154): den ganzen Aufenthalt, zur
 * Abreise (Abend davor und Abreisetag), oder als spaete Abreise -- wie zur
 * Abreise, aber nur, wenn am Abreisetag niemand ins Zimmer anreist.
 */
export const GuestRequestOffer = Type.Union([
  Type.Literal('stay'), Type.Literal('departure'), Type.Literal('late_checkout')])
export type GuestRequestOffer = Static<typeof GuestRequestOffer>

/** Ein Eintrag des Katalogs, wie der Gast ihn sieht. */
export const FolderRequestItem = Type.Object({
  itemRef: Type.String(),
  name: NameJeSprache,
  maxQty: Type.Integer(),
  /** Brutto je Stueck in Cent; `null` heisst kostenlos. */
  unitPriceCent: Type.Union([Type.Integer(), Type.Null()]),
  /**
   * Gilt fuer den Abreisetag und nur fuer ihn (0154): die Seite fragt nach
   * keinem Tag.
   */
  forDeparture: Type.Boolean()
})
export type FolderRequestItem = Static<typeof FolderRequestItem>

/** Ein eigener Wunsch mit Stand. */
export const FolderRequest = Type.Object({
  requestRef: Type.String(),
  /** Leer bei einer Nachricht (0153). */
  name: Type.Union([NameJeSprache, Type.Null()]),
  /** Der Text einer Nachricht; leer bei einem Eintrag, und nach der Loeschung. */
  message: Type.Union([Type.String(), Type.Null()]),
  /** Die Anfrage nach einer weiteren Nacht (0155); `wantedFor` ist die Nacht. */
  isExtension: Type.Boolean(),
  qty: Type.Integer(),
  unitPriceCent: Type.Union([Type.Integer(), Type.Null()]),
  wantedFor: Type.Union([Type.String(), Type.Null()]),
  status: GuestRequestStatus,
  declineReason: Type.Union([DeclineReason, Type.Null()]),
  createdAt: Type.String()
})
export type FolderRequest = Static<typeof FolderRequest>

export const FolderRequests = Type.Object({
  items: Type.Array(FolderRequestItem),
  mine: Type.Array(FolderRequest),
  /**
   * Die Tage, die der Gast als Wunschtag waehlen kann: ab heute
   * (Geschaeftstag) oder der Anreise bis zur Abreise. Die Seite rechnet
   * sie nicht selbst, weil sie den Geschaeftstag nicht kennt.
   */
  days: Type.Array(Type.String()),
  /** Ob das Haus die freie Nachricht an die Rezeption anbietet (0153). */
  messages: Type.Boolean(),
  /**
   * Noch eine Nacht (0155): die Nacht und ihr Preis, wenn das Haus sie
   * anbietet und sie frei ist; sonst `null`. Nur in der Mappe.
   */
  extension: Type.Union([Type.Object({ night: Type.String(), priceCent: Type.Integer() }),
    Type.Null()])
})
export type FolderRequests = Static<typeof FolderRequests>

/** Eine Nachricht an die Rezeption absenden (0153). */
export const FolderMessageCreate = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 500 })
}, { additionalProperties: false })
export type FolderMessageCreate = Static<typeof FolderMessageCreate>

/** Einen Wunsch absenden. */
export const FolderRequestCreate = Type.Object({
  itemRef: Type.String({ minLength: 1, maxLength: 20 }),
  qty: Type.Integer({ minimum: 1, maximum: 20 }),
  wantedFor: Type.Optional(Type.Union([Type.String(), Type.Null()]))
}, { additionalProperties: false })
export type FolderRequestCreate = Static<typeof FolderRequestCreate>

/**
 * Ein Wunsch, wie die Rezeption ihn sieht: im Eingang unter "Heute" und
 * im Seitenfenster der Reservierung.
 */
export const GuestRequestRow = Type.Object({
  requestRef: Type.String(),
  reservationRef: Type.String(),
  roomCode: Type.Union([Type.String(), Type.Null()]),
  lastName: Type.Union([Type.String(), Type.Null()]),
  firstName: Type.Union([Type.String(), Type.Null()]),
  /** Leer bei einer Nachricht (0153). */
  itemName: Type.Union([NameJeSprache, Type.Null()]),
  message: Type.Union([Type.String(), Type.Null()]),
  isMessage: Type.Boolean(),
  /** Noch eine Nacht (0155); `wantedFor` ist die Nacht. */
  isExtension: Type.Boolean(),
  qty: Type.Integer(),
  unitPriceCent: Type.Union([Type.Integer(), Type.Null()]),
  wantedFor: Type.Union([Type.String(), Type.Null()]),
  handler: Type.Union([Type.Literal('reception'), Type.Literal('housekeeping')]),
  source: Type.Union([Type.Literal('folder'), Type.Literal('mail'), Type.Literal('terminal')]),
  status: GuestRequestStatus,
  declineReason: Type.Union([DeclineReason, Type.Null()]),
  createdAt: Type.String()
})
export type GuestRequestRow = Static<typeof GuestRequestRow>

export const GuestRequestDecline = Type.Object({
  reason: DeclineReason
}, { additionalProperties: false })
export type GuestRequestDecline = Static<typeof GuestRequestDecline>

/** Ein Eintrag des Katalogs in den Einstellungen. */
export const GuestRequestItemAdmin = Type.Object({
  itemRef: Type.String(),
  name: NameJeSprache,
  handler: Type.Union([Type.Literal('reception'), Type.Literal('housekeeping')]),
  maxQty: Type.Integer(),
  /** `null`: kostenlos. Sonst der Artikel dahinter. */
  price: Type.Union([Type.Object({
    grossCent: Type.Integer(),
    taxRuleId: Type.Integer(),
    revenueAccount: Type.String()
  }), Type.Null()]),
  onFolder: Type.Boolean(),
  onTerminal: Type.Boolean(),
  offer: GuestRequestOffer,
  active: Type.Boolean(),
  position: Type.Integer()
})
export type GuestRequestItemAdmin = Static<typeof GuestRequestItemAdmin>

export const GuestRequestItemInput = Type.Object({
  name: NameJeSprache,
  handler: Type.Union([Type.Literal('reception'), Type.Literal('housekeeping')]),
  maxQty: Type.Integer({ minimum: 1, maximum: 20 }),
  price: Type.Union([Type.Object({
    grossCent: Type.Integer({ minimum: 1, maximum: 10_000_00 }),
    taxRuleId: Type.Integer(),
    revenueAccount: Type.String({ pattern: '^[0-9]{4,8}$' })
  }, { additionalProperties: false }), Type.Null()]),
  onFolder: Type.Boolean(),
  onTerminal: Type.Boolean(),
  /** Fehlt: den ganzen Aufenthalt. */
  offer: Type.Optional(GuestRequestOffer),
  active: Type.Boolean(),
  position: Type.Integer({ minimum: 0, maximum: 1000 })
}, { additionalProperties: false })
export type GuestRequestItemInput = Static<typeof GuestRequestItemInput>

export const GuestRequestCatalog = Type.Object({
  items: Type.Array(GuestRequestItemAdmin),
  /** Die Umsatzsteuersaetze des Hauses, zur Auswahl am Preis. */
  taxRules: Type.Array(Type.Object({
    id: Type.Integer(), name: Type.String(), rateBp: Type.Integer() }))
})
export type GuestRequestCatalog = Static<typeof GuestRequestCatalog>

export const GuestFolderStay = Type.Object({
  departure: Type.String(),
  cleaningWaiver: Type.Union([CleaningWaiverView, Type.Null()]),
  /** `null`, wenn das Haus keinen Eintrag fuer die Mappe hat (0149). */
  requests: Type.Union([FolderRequests, Type.Null()]),
  /** Ab dem Abend vor der Abreise (0154); die Seite nennt dann die Uhrzeit. */
  departureSoon: Type.Boolean(),
  /** Die Seite zur Abreise, ab dem Abend davor; sonst `null`. */
  departurePage: Type.Union([Type.String(), Type.Null()]),
  /** Am Abreisetag der Bewertungslink des Hauses; sonst `null`. */
  review: Type.Union([Type.Object({ label: Type.String(), url: Type.String() }), Type.Null()])
})
export type GuestFolderStay = Static<typeof GuestFolderStay>

export const GuestFolderView = Type.Object({
  propertyName: Type.String(),
  /** Name des Zimmers, sonst seine Nummer. */
  roomName: Type.String(),
  checkinTime: Type.String(),
  checkoutTime: Type.String(),
  wifi: Type.Union([FolderWifi, Type.Null()]),
  /**
   * Der eigene Aufenthalt, sobald dieses Telefon freigeschaltet ist (0147);
   * sonst `null`. Kein Name, keine Adresse, kein Betrag: wer das Telefon
   * weitergibt, gibt nur den Abreisetag mit.
   */
  stay: Type.Union([GuestFolderStay, Type.Null()]),
  pages: Type.Array(Type.Object({
    contentRef: Type.String(),
    title: Type.String(),
    body: Type.String(),
    imageRef: Type.Union([Type.String(), Type.Null()]),
    /**
     * Nur Uebersetzungen, die zur deutschen Fassung passen; fehlt eine
     * Sprache, zeigt die Seite des Gastes die deutsche.
     */
    translations: Type.Record(Type.String(), FolderPageText)
  }))
})
export type GuestFolderView = Static<typeof GuestFolderView>

/**
 * Stand einer Uebersetzung: `machine` und `manual` passen zur deutschen
 * Fassung, `pending` wartet auf DeepL (auch nach einer Aenderung der Seite),
 * `failed` hat alle Versuche hinter sich und bleibt deutsch, bis jemand die
 * Seite aendert oder von Hand uebersetzt.
 */
export const FolderTranslationState = Type.Union([
  Type.Literal('machine'), Type.Literal('manual'),
  Type.Literal('pending'), Type.Literal('failed')])
export type FolderTranslationState = Static<typeof FolderTranslationState>

export const FolderPageTranslation = Type.Object({
  lang: Type.String(),
  state: FolderTranslationState,
  /** Die passende Uebersetzung; `null`, solange es keine gibt. */
  title: Type.Union([Type.String(), Type.Null()]),
  body: Type.Union([Type.String(), Type.Null()])
})
export type FolderPageTranslation = Static<typeof FolderPageTranslation>

/** Die Einstellung des Hauses. */
export const GuestFolderSettings = Type.Object({
  enabled: Type.Boolean(),
  /** Freie Nachricht an die Rezeption (0153), aus als Vorgabe. */
  messagesEnabled: Type.Boolean(),
  /** Noch eine Nacht anbieten (0155), aus als Vorgabe. */
  extendEnabled: Type.Boolean(),
  /** Die Seite zur Abreise (0154), eine der Seiten in der Mappe. */
  departurePage: Type.Union([Type.String(), Type.Null()]),
  /** Der Bewertungslink am Abreisetag (0154), eine der freigegebenen Adressen. */
  reviewUrl: Type.Union([Type.String(), Type.Null()]),
  /** Die freigegebenen Adressen des Hauses, zur Auswahl. */
  urls: Type.Array(Type.Object({
    urlRef: Type.String(), label: Type.String(), url: Type.String() })),
  wifi: Type.Union([FolderWifi, Type.Null()]),
  /** Alle Seiten des Hauses; `folderPosition` leer heisst: nicht in der Mappe. */
  pages: Type.Array(Type.Object({
    contentRef: Type.String(),
    title: Type.String(),
    body: Type.String(),
    folderPosition: Type.Union([Type.Integer(), Type.Null()]),
    /** Je Sprache der Gaeste; leer fuer eine Seite, die nicht in der Mappe steht. */
    translations: Type.Array(FolderPageTranslation)
  }))
})
export type GuestFolderSettings = Static<typeof GuestFolderSettings>

export const GuestFolderSettingsSet = Type.Object({
  enabled: Type.Boolean(),
  /** Fehlt: bleibt, wie es ist. */
  messagesEnabled: Type.Optional(Type.Boolean()),
  extendEnabled: Type.Optional(Type.Boolean()),
  /** Fehlt: bleibt; `null`: keine. */
  departurePage: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  reviewUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  wifi: Type.Union([FolderWifi, Type.Null()])
}, { additionalProperties: false })
export type GuestFolderSettingsSet = Static<typeof GuestFolderSettingsSet>

/** Was die Zimmerkarten zum Drucken brauchen, in einem Aufruf fuer alle Zimmer. */
export const GuestFolderCards = Type.Object({
  propertyName: Type.String(),
  enabled: Type.Boolean(),
  wifi: Type.Union([FolderWifi, Type.Null()]),
  rooms: Type.Array(Type.Object({
    resourceId: Type.Integer(),
    code: Type.String(),
    name: Type.Union([Type.String(), Type.Null()]),
    link: Type.String()
  }))
})
export type GuestFolderCards = Static<typeof GuestFolderCards>

/** Eine Uebersetzung von Hand setzen (0144). */
export const FolderPageTextSet = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 300 }),
  body: Type.String({ maxLength: 10000 })
}, { additionalProperties: false })
export type FolderPageTextSet = Static<typeof FolderPageTextSet>

/** Freischalten: Nachname oder PLZ, in einem Feld (0147). */
export const FolderUnlock = Type.Object({
  value: Type.String({ minLength: 1, maxLength: 100 })
}, { additionalProperties: false })
export type FolderUnlock = Static<typeof FolderUnlock>

/** Die Freischaltungen einer Reservierung, fuer das Seitenfenster der Rezeption. */
export const GuestFolderStayStatus = Type.Object({
  activeSessions: Type.Integer()
})
export type GuestFolderStayStatus = Static<typeof GuestFolderStayStatus>
