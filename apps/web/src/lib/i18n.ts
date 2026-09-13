import { createContext, useContext } from 'react'

/**
 * Deutsch und Englisch von Anfang an (AP 12).
 *
 * Nachträglich zu übersetzen heißt, jede Zeichenkette einzeln aus dem Code
 * zu ziehen, und dabei wird die Hälfte vergessen. Hier gibt es deshalb von
 * Beginn an keinen Text im Code, nur Schlüssel.
 *
 * Die Sprache des Hauses steht an der Property, die des Gastes am Profil.
 * Beides ist nicht dasselbe: ein deutsches Haus schreibt einem
 * niederländischen Gast auf Englisch und führt die Oberfläche auf Deutsch.
 */
export const LOCALES = ['de', 'en'] as const
export type Locale = (typeof LOCALES)[number]

const texts = {
  de: {
    'app.title': 'hotelpms',
    'nav.tape': 'Zimmerplan',
    'nav.today': 'Tagesgeschäft',
    'nav.housekeeping': 'Housekeeping',
    'nav.setup': 'Einrichtung',
    'nav.guests': 'Gäste',

    'common.from': 'Von',
    'common.to': 'Bis',
    'common.date': 'Datum',
    'common.room': 'Zimmer',
    'common.rooms': 'Zimmer',
    'common.category': 'Zimmergruppe',
    'common.guest': 'Gast',
    'common.status': 'Status',
    'common.save': 'Speichern',
    'common.cancel': 'Abbrechen',
    'common.preview': 'Vorschau',
    'common.apply': 'Übernehmen',
    'common.loading': 'Lädt…',
    'common.none': 'Nichts vorhanden',
    'common.today': 'Heute',
    'common.back': 'Zurück',
    'common.forward': 'Weiter',
    'common.retry': 'Erneut versuchen',
    'common.offline': 'Offline. Angezeigt wird der zuletzt geladene Stand.',

    'status.Optional': 'Option',
    'status.Confirmed': 'Bestätigt',
    'status.InHouse': 'Im Haus',
    'status.CheckedOut': 'Abgereist',
    'status.Canceled': 'Storniert',
    'status.NoShow': 'No-Show',

    'today.arrivals': 'Anreisen',
    'today.departures': 'Abreisen',
    'today.inhouse': 'Im Haus',
    'today.checkin': 'Check-in',
    'today.checkout': 'Check-out',
    'today.registered': 'Meldeschein liegt vor',
    'today.balance': 'Offener Saldo',
    'today.needsRoom': 'Kein Zimmer zugewiesen',

    'hk.dirty': 'Schmutzig',
    'hk.clean': 'Sauber',
    'hk.inspected': 'Kontrolliert',
    'hk.occupied': 'Belegt',
    'hk.departureToday': 'Abreise heute',
    'hk.arrivalToday': 'Anreise heute',
    'hk.markClean': 'Auf sauber setzen',
    'hk.openTickets': 'Offene Meldungen',

    'setup.title': 'Einrichtung des Hauses',
    'setup.bookable': 'Buchbar',
    'setup.notBookable': 'Noch nicht buchbar',
    'setup.complete': 'Vollständig eingerichtet',
    'setup.nextStep': 'Nächster Schritt',
    'setup.categories': 'Zimmergruppen',
    'setup.newCategory': 'Neue Zimmergruppe',
    'setup.code': 'Kürzel',
    'setup.name': 'Bezeichnung',
    'setup.maxOccupancy': 'Personen je Einheit',
    'setup.activeRooms': 'Aktive Zimmer',
    'setup.series': 'Zimmerserie anlegen',
    'setup.prefix': 'Vorsatz',
    'setup.suffix': 'Nachsatz',
    'setup.numberFrom': 'Nummer von',
    'setup.numberTo': 'Nummer bis',
    'setup.pad': 'Stellen mit führender Null',
    'setup.floor': 'Etage',
    'setup.skip': 'Nummern auslassen',
    'setup.skipHint': 'Mit Komma getrennt, etwa 13, 404',
    'setup.seriesPreview': 'Diese Nummern entstehen',
    'setup.seriesExists': 'Schon vergeben',
    'setup.seriesResult': 'Zimmer angelegt',
    'setup.seriesEmpty': 'Alle Nummern der Serie gibt es bereits.',

    'error.title': 'Das hat nicht geklappt',
    'error.offlineWrite': 'Ohne Verbindung lässt sich nichts speichern.'
  },
  en: {
    'app.title': 'hotelpms',
    'nav.tape': 'Room chart',
    'nav.today': 'Front desk',
    'nav.housekeeping': 'Housekeeping',
    'nav.setup': 'Setup',
    'nav.guests': 'Guests',

    'common.from': 'From',
    'common.to': 'To',
    'common.date': 'Date',
    'common.room': 'Room',
    'common.rooms': 'Rooms',
    'common.category': 'Room type',
    'common.guest': 'Guest',
    'common.status': 'Status',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.preview': 'Preview',
    'common.apply': 'Apply',
    'common.loading': 'Loading…',
    'common.none': 'Nothing here',
    'common.today': 'Today',
    'common.back': 'Back',
    'common.forward': 'Forward',
    'common.retry': 'Try again',
    'common.offline': 'Offline. Showing the last loaded state.',

    'status.Optional': 'Option',
    'status.Confirmed': 'Confirmed',
    'status.InHouse': 'In house',
    'status.CheckedOut': 'Checked out',
    'status.Canceled': 'Cancelled',
    'status.NoShow': 'No show',

    'today.arrivals': 'Arrivals',
    'today.departures': 'Departures',
    'today.inhouse': 'In house',
    'today.checkin': 'Check in',
    'today.checkout': 'Check out',
    'today.registered': 'Registration form on file',
    'today.balance': 'Open balance',
    'today.needsRoom': 'No room assigned',

    'hk.dirty': 'Dirty',
    'hk.clean': 'Clean',
    'hk.inspected': 'Inspected',
    'hk.occupied': 'Occupied',
    'hk.departureToday': 'Departing today',
    'hk.arrivalToday': 'Arriving today',
    'hk.markClean': 'Mark as clean',
    'hk.openTickets': 'Open tickets',

    'setup.title': 'Property setup',
    'setup.bookable': 'Bookable',
    'setup.notBookable': 'Not bookable yet',
    'setup.complete': 'Setup complete',
    'setup.nextStep': 'Next step',
    'setup.categories': 'Room types',
    'setup.newCategory': 'New room type',
    'setup.code': 'Code',
    'setup.name': 'Name',
    'setup.maxOccupancy': 'People per unit',
    'setup.activeRooms': 'Active rooms',
    'setup.series': 'Create room series',
    'setup.prefix': 'Prefix',
    'setup.suffix': 'Suffix',
    'setup.numberFrom': 'Number from',
    'setup.numberTo': 'Number to',
    'setup.pad': 'Digits, zero padded',
    'setup.floor': 'Floor',
    'setup.skip': 'Skip numbers',
    'setup.skipHint': 'Comma separated, e.g. 13, 404',
    'setup.seriesPreview': 'These numbers will be created',
    'setup.seriesExists': 'Already taken',
    'setup.seriesResult': 'Rooms created',
    'setup.seriesEmpty': 'Every number in this series already exists.',

    'error.title': 'That did not work',
    'error.offlineWrite': 'Nothing can be saved without a connection.'
  }
} as const

export type TextKey = keyof (typeof texts)['de']

export const I18nContext = createContext<Locale>('de')

export function useT(): (key: TextKey) => string {
  const locale = useContext(I18nContext)
  return (key) => texts[locale][key] ?? key
}

export function useLocale(): Locale {
  return useContext(I18nContext)
}

/** Cent als Betrag in der Sprache des Betrachters. */
export function formatMoney(cent: number, locale: Locale, currency = 'EUR'): string {
  return new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-GB',
    { style: 'currency', currency }).format(cent / 100)
}

/** Aufenthaltsdaten sind Kalenderdaten, keine Zeitpunkte. Nie als Date parsen. */
export function formatDate(iso: string, locale: Locale): string {
  const [y, m, d] = iso.split('-')
  return locale === 'de' ? `${d}.${m}.${y}` : `${y}-${m}-${d}`
}

export function weekdayShort(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB',
    { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`))
}
