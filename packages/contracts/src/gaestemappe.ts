import { Type, type Static } from '@sinclair/typebox'

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
 * Die Sprachen der Mappe (Sven, 11.10.2026): dieselben wie die der
 * Gastpost, weil es dieselben Gaeste sind. Eine eigene Liste neben
 * `EMAIL_LANGUAGES`, weil die Mappe ihren eigenen Katalog hat, in dem jede
 * Sprache vollstaendig sein muss -- die Gastpost kann eine Sprache dazu
 * nehmen, ohne dass die Mappe halb uebersetzt erscheint.
 */
export const FOLDER_LOCALES = ['de', 'en', 'nl', 'pl'] as const
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

export const GuestFolderView = Type.Object({
  propertyName: Type.String(),
  /** Name des Zimmers, sonst seine Nummer. */
  roomName: Type.String(),
  checkinTime: Type.String(),
  checkoutTime: Type.String(),
  wifi: Type.Union([FolderWifi, Type.Null()]),
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
