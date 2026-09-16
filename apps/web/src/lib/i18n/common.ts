import type { LocalizedText } from '@hotelpms/contracts'

/** Rahmen, Navigation und was ueberall vorkommt. */
export const common = {
  'app.title': {
    de: 'hotelpms',
    en: 'hotelpms' },
  'nav.tape': {
    de: 'Zimmerplan',
    en: 'Room chart' },
  'nav.today': {
    de: 'Tagesgeschäft',
    en: 'Front desk' },
  'nav.housekeeping': {
    de: 'Housekeeping',
    en: 'Housekeeping' },
  'nav.setup': {
    de: 'Einrichtung',
    en: 'Setup' },
  'nav.guests': {
    de: 'Gäste',
    en: 'Guests' },
  'nav.blocks': {
    de: 'Gruppen',
    en: 'Groups' },
  'common.from': {
    de: 'Von',
    en: 'From' },
  'common.to': {
    de: 'Bis',
    en: 'To' },
  'common.date': {
    de: 'Datum',
    en: 'Date' },
  'common.room': {
    de: 'Zimmer',
    en: 'Room' },
  'common.rooms': {
    de: 'Zimmer',
    en: 'Rooms' },
  'common.category': {
    de: 'Zimmergruppe',
    en: 'Room type' },
  'common.guest': {
    de: 'Gast',
    en: 'Guest' },
  'common.status': {
    de: 'Status',
    en: 'Status' },
  'common.save': {
    de: 'Speichern',
    en: 'Save' },
  'common.cancel': {
    de: 'Abbrechen',
    en: 'Cancel' },
  'common.preview': {
    de: 'Vorschau',
    en: 'Preview' },
  'common.apply': {
    de: 'Übernehmen',
    en: 'Apply' },
  'common.loading': {
    de: 'Lädt…',
    en: 'Loading…' },
  'common.none': {
    de: 'Nichts vorhanden',
    en: 'Nothing here' },
  'common.today': {
    de: 'Heute',
    en: 'Today' },
  'common.back': {
    de: 'Zurück',
    en: 'Back' },
  'common.forward': {
    de: 'Weiter',
    en: 'Forward' },
  'common.retry': {
    de: 'Erneut versuchen',
    en: 'Try again' },
  'common.offline': {
    de: 'Offline. Angezeigt wird der zuletzt geladene Stand.',
    en: 'Offline. Showing the last loaded state.' },
  'status.Optional': {
    de: 'Option',
    en: 'Option' },
  'status.Confirmed': {
    de: 'Bestätigt',
    en: 'Confirmed' },
  'status.InHouse': {
    de: 'Im Haus',
    en: 'In house' },
  'status.CheckedOut': {
    de: 'Abgereist',
    en: 'Checked out' },
  'status.Canceled': {
    de: 'Storniert',
    en: 'Cancelled' },
  'status.NoShow': {
    de: 'No-Show',
    en: 'No show' },
  'error.title': {
    de: 'Das hat nicht geklappt',
    en: 'That did not work' },
  'error.offlineWrite': {
    de: 'Ohne Verbindung lässt sich nichts speichern.',
    en: 'Nothing can be saved without a connection.' },
  'login.email': {
    de: 'E-Mail',
    en: 'Email' },
  'login.password': {
    de: 'Kennwort',
    en: 'Password' },
  'login.submit': {
    de: 'Anmelden',
    en: 'Sign in' },
  'auth.logout': {
    de: 'Abmelden',
    en: 'Sign out' },
  'app.noProperty': {
    de: 'Diesem Benutzer ist noch kein Haus zugeordnet.',
    en: 'This user is not assigned to any property yet.' },
  'app.noScreen': {
    de: 'Dieses Konto hat in {haus} keine Rechte, die einen Bildschirm '
      + 'öffnen.',
    en: 'This account has no rights in {haus} that open a screen.' },
} as const satisfies Record<string, LocalizedText>
