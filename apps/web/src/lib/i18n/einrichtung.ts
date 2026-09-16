import type { LocalizedText } from '@hotelpms/contracts'

/** Einrichtung: Zimmergruppen und Zimmer. */
export const einrichtung = {
  'setup.title': {
    de: 'Einrichtung des Hauses',
    en: 'Property setup' },
  'setup.bookable': {
    de: 'Buchbar',
    en: 'Bookable' },
  'setup.notBookable': {
    de: 'Noch nicht buchbar',
    en: 'Not bookable yet' },
  'setup.complete': {
    de: 'Vollständig eingerichtet',
    en: 'Setup complete' },
  'setup.nextStep': {
    de: 'Nächster Schritt',
    en: 'Next step' },
  'setup.categories': {
    de: 'Zimmergruppen',
    en: 'Room types' },
  'setup.newCategory': {
    de: 'Neue Zimmergruppe',
    en: 'New room type' },
  'setup.code': {
    de: 'Kürzel',
    en: 'Code' },
  'setup.name': {
    de: 'Bezeichnung',
    en: 'Name' },
  'setup.maxOccupancy': {
    de: 'Personen je Einheit',
    en: 'People per unit' },
  'setup.activeRooms': {
    de: 'Aktive Zimmer',
    en: 'Active rooms' },
  'setup.series': {
    de: 'Zimmerserie anlegen',
    en: 'Create room series' },
  'setup.prefix': {
    de: 'Vorsatz',
    en: 'Prefix' },
  'setup.suffix': {
    de: 'Nachsatz',
    en: 'Suffix' },
  'setup.numberFrom': {
    de: 'Nummer von',
    en: 'Number from' },
  'setup.numberTo': {
    de: 'Nummer bis',
    en: 'Number to' },
  'setup.pad': {
    de: 'Stellen mit führender Null',
    en: 'Digits, zero padded' },
  'setup.floor': {
    de: 'Etage',
    en: 'Floor' },
  'setup.skip': {
    de: 'Nummern auslassen',
    en: 'Skip numbers' },
  'setup.skipHint': {
    de: 'Mit Komma getrennt, etwa 13, 404',
    en: 'Comma separated, e.g. 13, 404' },
  'setup.seriesPreview': {
    de: 'Diese Nummern entstehen',
    en: 'These numbers will be created' },
  'setup.seriesExists': {
    de: 'Schon vergeben',
    en: 'Already taken' },
  'setup.seriesResult': {
    de: 'Zimmer angelegt',
    en: 'Rooms created' },
  'setup.seriesEmpty': {
    de: 'Alle Nummern der Serie gibt es bereits.',
    en: 'Every number in this series already exists.' },
} as const satisfies Record<string, LocalizedText>
