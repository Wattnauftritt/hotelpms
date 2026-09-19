import type { LocalizedText } from '@hotelpms/contracts'

/** Rahmen, Navigation und was ueberall vorkommt. */
export const common = {
  'app.title': {
    de: 'StayGrid',
    en: 'StayGrid',
    tr: 'StayGrid' },
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
  'workstation.switch': {
    de: 'Person wechseln',
    en: 'Switch person',
    tr: 'Kişi değiştir' },
  'workstation.title': {
    de: 'Arbeitsplatz',
    en: 'Workstation',
    tr: 'Çalışma yeri' },
  'workstation.acting': {
    de: 'Es handelt gerade nicht die angemeldete Person.',
    en: 'Someone other than the signed-in person is acting.',
    tr: 'Şu anda işlemi yapan, oturum açmış kişi değil.' },
  'workstation.switchHint': {
    de: 'Am geteilten Rezeptionsrechner übernimmt eine andere Person, ohne dass '
      + 'sich jemand neu anmeldet. Die Sitzung bleibt; im Protokoll steht, wer '
      + 'wirklich gebucht hat.',
    en: 'At a shared front-desk machine another person takes over without anyone '
      + 'signing in again. The session stays; the audit log records who actually '
      + 'booked.',
    tr: 'Ortak kullanılan resepsiyon bilgisayarında, kimse yeniden oturum açmadan başka bir kişi devralır. Oturum aynı kalır; kayıtta gerçekte kimin işlem yaptığı yazar.' },
  'workstation.pin': {
    de: 'Arbeitsplatz-PIN',
    en: 'Workstation PIN',
    tr: 'Çalışma yeri PIN\'i' },
  'workstation.switchSubmit': {
    de: 'Übernehmen',
    en: 'Take over',
    tr: 'Devral' },
  'workstation.ownPin': {
    de: 'Eigener Arbeitsplatz-PIN',
    en: 'Your own workstation PIN',
    tr: 'Kendi çalışma yeri PIN\'iniz' },
  'workstation.ownPinHint': {
    de: 'Vier bis zwölf Ziffern. Nur damit kann jemand an einem anderen '
      + 'Arbeitsplatz in Ihrem Namen weiterarbeiten — und nur damit kommen Sie '
      + 'nach einem Wechsel in Ihre eigene Sitzung zurück.',
    en: 'Four to twelve digits. Only with it can someone carry on in your name at '
      + 'another workstation — and only with it do you get back into your own '
      + 'session after a switch.',
    tr: 'Dört ile on iki basamak arası. Yalnızca onunla biri başka bir çalışma yerinde sizin adınıza çalışmayı sürdürebilir — ve yalnızca onunla bir devirden sonra kendi oturumunuza geri dönersiniz.' },
  'workstation.pinSet': {
    de: 'Hinterlegt',
    en: 'On file',
    tr: 'Kayıtlı' },
  'workstation.pinNotSet': {
    de: 'Nicht hinterlegt',
    en: 'Not on file',
    tr: 'Kayıtlı değil' },
  'workstation.pinSave': {
    de: 'PIN setzen',
    en: 'Set PIN',
    tr: 'PIN belirle' },
  'workstation.pinRemove': {
    de: 'PIN entfernen',
    en: 'Remove PIN',
    tr: 'PIN\'i kaldır' },
  'workstation.pinSaved': {
    de: 'Gespeichert',
    en: 'Saved',
    tr: 'Kaydedildi' },
  'workstation.needOwnPin': {
    de: 'Hinterlegen Sie zuerst einen eigenen PIN. Ohne ihn kämen Sie nach einem '
      + 'Wechsel nicht zurück.',
    en: 'Set a PIN of your own first. Without it you could not get back after a '
      + 'switch.',
    tr: 'Önce kendinize bir PIN belirleyin. O olmadan bir devirden sonra geri dönemezsiniz.' },
  /*
   * Der Satz fuer den gesperrten Account. Er nennt keinen Grund -- das ist
   * eine Frage zwischen dem Kunden und uns, nicht etwas, das ein
   * Anmeldebildschirm ausplaudert -- sagt aber klar, wohin man sich wendet.
   */
  'app.accountSuspended': {
    de: 'Dieser Zugang ist zurzeit gesperrt. Bitte wenden Sie sich an uns.',
    en: 'This account is currently suspended. Please get in touch with us.',
    tr: 'Bu hesap şu anda askıya alınmıştır. Lütfen bizimle iletişime geçin.' },
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
