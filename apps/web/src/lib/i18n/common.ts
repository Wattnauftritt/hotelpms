import type { LocalizedText } from '@hotelpms/contracts'

/** Rahmen, Navigation und was ueberall vorkommt. */
export const common = {
  'app.title': {
    de: 'hotelpms',
    en: 'hotelpms',
    tr: 'hotelpms' },
  'nav.tape': {
    de: 'Zimmerplan',
    en: 'Room chart',
    tr: 'Oda planı' },
  'nav.today': {
    de: 'Tagesgeschäft',
    en: 'Front desk',
    tr: 'Günlük işler' },
  'nav.housekeeping': {
    de: 'Housekeeping',
    en: 'Housekeeping',
    tr: 'Kat hizmetleri' },
  'nav.setup': {
    de: 'Einrichtung',
    en: 'Setup',
    tr: 'Kurulum' },
  'nav.guests': {
    de: 'Gäste',
    en: 'Guests',
    tr: 'Misafirler' },
  'nav.blocks': {
    de: 'Gruppen',
    en: 'Groups',
    tr: 'Gruplar' },
  'common.from': {
    de: 'Von',
    en: 'From',
    tr: 'Başlangıç' },
  'common.to': {
    de: 'Bis',
    en: 'To',
    tr: 'Bitiş' },
  'common.date': {
    de: 'Datum',
    en: 'Date',
    tr: 'Tarih' },
  'common.room': {
    de: 'Zimmer',
    en: 'Room',
    tr: 'Oda' },
  'common.rooms': {
    de: 'Zimmer',
    en: 'Rooms',
    tr: 'Oda' },
  'common.category': {
    de: 'Zimmergruppe',
    en: 'Room type',
    tr: 'Oda tipi' },
  'common.guest': {
    de: 'Gast',
    en: 'Guest',
    tr: 'Misafir' },
  'common.status': {
    de: 'Status',
    en: 'Status',
    tr: 'Durum' },
  'common.save': {
    de: 'Speichern',
    en: 'Save',
    tr: 'Kaydet' },
  'common.cancel': {
    de: 'Abbrechen',
    en: 'Cancel',
    tr: 'Vazgeç' },
  'common.preview': {
    de: 'Vorschau',
    en: 'Preview',
    tr: 'Önizleme' },
  'common.apply': {
    de: 'Übernehmen',
    en: 'Apply',
    tr: 'Uygula' },
  'common.loading': {
    de: 'Lädt…',
    en: 'Loading…',
    tr: 'Yükleniyor…' },
  'common.none': {
    de: 'Nichts vorhanden',
    en: 'Nothing here',
    tr: 'Kayıt yok' },
  'common.today': {
    de: 'Heute',
    en: 'Today',
    tr: 'Bugün' },
  'common.back': {
    de: 'Zurück',
    en: 'Back',
    tr: 'Geri' },
  'common.forward': {
    de: 'Weiter',
    en: 'Forward',
    tr: 'İleri' },
  'common.retry': {
    de: 'Erneut versuchen',
    en: 'Try again',
    tr: 'Tekrar dene' },
  'common.offline': {
    de: 'Offline. Angezeigt wird der zuletzt geladene Stand.',
    en: 'Offline. Showing the last loaded state.',
    tr: 'Çevrimdışı. Son yüklenen durum gösteriliyor.' },
  'status.Optional': {
    de: 'Option',
    en: 'Option',
    tr: 'Opsiyon' },
  'status.Confirmed': {
    de: 'Bestätigt',
    en: 'Confirmed',
    tr: 'Onaylandı' },
  'status.InHouse': {
    de: 'Im Haus',
    en: 'In house',
    tr: 'Tesiste' },
  'status.CheckedOut': {
    de: 'Abgereist',
    en: 'Checked out',
    tr: 'Çıkış yaptı' },
  'status.Canceled': {
    de: 'Storniert',
    en: 'Cancelled',
    tr: 'İptal edildi' },
  'status.NoShow': {
    de: 'No-Show',
    en: 'No show',
    tr: 'No-Show' },
  'error.title': {
    de: 'Das hat nicht geklappt',
    en: 'That did not work',
    tr: 'Bu işlem yürümedi' },
  'error.offlineWrite': {
    de: 'Ohne Verbindung lässt sich nichts speichern.',
    en: 'Nothing can be saved without a connection.',
    tr: 'Bağlantı olmadan hiçbir şey kaydedilemez.' },
  'login.email': {
    de: 'E-Mail',
    en: 'Email',
    tr: 'E-posta' },
  'login.password': {
    de: 'Kennwort',
    en: 'Password',
    tr: 'Parola' },
  'login.submit': {
    de: 'Anmelden',
    en: 'Sign in',
    tr: 'Oturum aç' },
  'auth.logout': {
    de: 'Abmelden',
    en: 'Sign out',
    tr: 'Oturumu kapat' },
  'app.noProperty': {
    de: 'Diesem Benutzer ist noch kein Haus zugeordnet.',
    en: 'This user is not assigned to any property yet.',
    tr: 'Bu kullanıcıya henüz bir tesis atanmamış.' },
  'app.noScreen': {
    de: 'Dieses Konto hat in {haus} keine Rechte, die einen Bildschirm '
      + 'öffnen.',
    en: 'This account has no rights in {haus} that open a screen.',
    tr: 'Bu hesabın {haus} tesisinde ekran açacak bir yetkisi yok.' },
} as const satisfies Record<string, LocalizedText>
