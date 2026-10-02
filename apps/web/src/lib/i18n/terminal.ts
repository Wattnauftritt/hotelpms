import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Gaesteterminal (Dokument 31): Einstellungen, der Knopf an der Reservierung
 * und die Seite am Touchscreen selbst.
 *
 * Die Seite am Touchscreen (`kiosk.*`) liest ein **Gast**, nicht das
 * Personal. Sie spricht ihn deshalb mit „Sie" an und erklaert nichts, was
 * nur die Rezeption angeht. Deutsche Rechtsbegriffe bleiben auch hier
 * stehen: `Meldeschein` ist ein Name, und der Gast soll das Wort auf dem
 * Bildschirm dem Papier zuordnen koennen, das ihm die Rezeption zeigt.
 */
export const terminal = {
  // ------------------------------------------------------- Einstellungen
  'terminal.settings.title': {
    de: 'Gästeterminals',
    en: 'Guest terminals',
    tr: 'Misafir terminalleri' },
  'terminal.settings.hint': {
    de: 'Ein Gästeterminal ist ein Touchscreen an der Rezeption, an dem Gäste den '
      + 'Meldeschein unterschreiben. Es meldet sich nicht mit einem Benutzer an: '
      + 'es wird einmal mit einem Code gekoppelt und kann danach nur öffnen, was '
      + 'die Rezeption ihm schickt.',
    en: 'A guest terminal is a touchscreen at the front desk where guests sign the '
      + 'Meldeschein. It does not sign in as a user: it is paired once with a code '
      + 'and can then only open what the front desk sends it.',
    tr: 'Misafir terminali, resepsiyondaki bir dokunmatik ekrandır; misafirler '
      + 'Meldeschein\'ı burada imzalar. Bir kullanıcı olarak oturum açmaz: bir kez '
      + 'kodla eşleştirilir ve ardından yalnızca resepsiyonun gönderdiğini açabilir.' },
  'terminal.settings.name': {
    de: 'Name des Terminals',
    en: 'Terminal name',
    tr: 'Terminal adı' },
  'terminal.settings.namePlaceholder': {
    de: 'z. B. Touchscreen Rezeption',
    en: 'e.g. Front desk touchscreen',
    tr: 'örn. Resepsiyon dokunmatik ekranı' },
  'terminal.settings.pair': {
    de: 'Terminal koppeln',
    en: 'Pair terminal',
    tr: 'Terminali eşleştir' },
  'terminal.settings.codeTitle': {
    de: 'Kopplungscode für „{name}“',
    en: 'Pairing code for "{name}"',
    tr: '„{name}“ için eşleştirme kodu' },
  'terminal.settings.codeHint': {
    de: 'Am Touchscreen {adresse} öffnen und diesen Code eingeben. Er gilt bis '
      + '{zeit} Uhr und nur einmal. Eine Anmeldung des Personals in diesem Browser '
      + 'wird dabei beendet.',
    en: 'Open {adresse} on the touchscreen and enter this code. It is valid until '
      + '{zeit} and only once. A staff session in that browser is ended in the process.',
    tr: 'Dokunmatik ekranda {adresse} adresini açın ve bu kodu girin. Kod {zeit} '
      + 'saatine kadar ve yalnızca bir kez geçerlidir. Bu tarayıcıdaki personel '
      + 'oturumu bu sırada sonlandırılır.' },
  'terminal.settings.state.paired': {
    de: 'gekoppelt',
    en: 'paired',
    tr: 'eşleştirildi' },
  'terminal.settings.state.pairing': {
    de: 'wartet auf Kopplung bis {zeit} Uhr',
    en: 'waiting for pairing until {zeit}',
    tr: '{zeit} saatine kadar eşleştirme bekleniyor' },
  'terminal.settings.state.pairing_expired': {
    de: 'Code abgelaufen',
    en: 'code expired',
    tr: 'kodun süresi doldu' },
  'terminal.settings.online': {
    de: 'erreichbar',
    en: 'online',
    tr: 'çevrimiçi' },
  'terminal.settings.offline': {
    de: 'nicht erreichbar',
    en: 'offline',
    tr: 'çevrimdışı' },
  'terminal.settings.repair': {
    de: 'Neu koppeln',
    en: 'Pair again',
    tr: 'Yeniden eşleştir' },
  'terminal.settings.revoke': {
    de: 'Widerrufen',
    en: 'Revoke',
    tr: 'İptal et' },
  'terminal.settings.revokeConfirm': {
    de: 'Terminal „{name}“ widerrufen? Es kann danach nichts mehr öffnen.',
    en: 'Revoke terminal "{name}"? It will no longer be able to open anything.',
    tr: '„{name}“ terminali iptal edilsin mi? Ardından hiçbir şey açamaz.' },
  'terminal.settings.none': {
    de: 'Noch kein Terminal angelegt.',
    en: 'No terminal set up yet.',
    tr: 'Henüz terminal oluşturulmadı.' },

  // ------------------------------------------------- An der Reservierung
  'terminal.title': {
    de: 'Gästeterminal',
    en: 'Guest terminal',
    tr: 'Misafir terminali' },
  'terminal.send.registration_sign': {
    de: 'Meldeschein am Terminal unterschreiben',
    en: 'Sign Meldeschein at the terminal',
    tr: 'Meldeschein\'ı terminalde imzalat' },
  'terminal.send.registration_fill': {
    de: 'Meldeformular am Terminal ausfüllen',
    en: 'Fill in registration form at the terminal',
    tr: 'Kayıt formunu terminalde doldurt' },
  'terminal.chooseDevice': {
    de: 'An welches Terminal?',
    en: 'To which terminal?',
    tr: 'Hangi terminale?' },
  'terminal.send': {
    de: 'Senden',
    en: 'Send',
    tr: 'Gönder' },
  'terminal.deviceOffline': {
    de: 'nicht erreichbar',
    en: 'offline',
    tr: 'çevrimdışı' },
  'terminal.deviceBusy': {
    de: 'belegt',
    en: 'busy',
    tr: 'meşgul' },
  'terminal.state.pending': {
    de: 'Wartet auf „{terminal}“ …',
    en: 'Waiting for "{terminal}" …',
    tr: '„{terminal}“ bekleniyor …' },
  'terminal.state.opened': {
    de: 'Am Terminal „{terminal}“ geöffnet',
    en: 'Open at terminal "{terminal}"',
    tr: '„{terminal}“ terminalinde açık' },
  'terminal.state.done': {
    de: 'Erledigt am Terminal „{terminal}“',
    en: 'Done at terminal "{terminal}"',
    tr: '„{terminal}“ terminalinde tamamlandı' },
  'terminal.state.canceled': {
    de: 'Abgebrochen',
    en: 'Canceled',
    tr: 'İptal edildi' },
  'terminal.state.expired': {
    de: 'Abgelaufen — das Terminal hat den Auftrag nicht geöffnet. Ist es eingeschaltet?',
    en: 'Expired — the terminal did not open the job. Is it switched on?',
    tr: 'Süresi doldu — terminal görevi açmadı. Açık mı?' },
  'terminal.canceledBy.reception': {
    de: 'von der Rezeption',
    en: 'by the front desk',
    tr: 'resepsiyon tarafından' },
  'terminal.canceledBy.terminal': {
    de: 'vom Gast am Terminal',
    en: 'by the guest at the terminal',
    tr: 'terminaldeki misafir tarafından' },
  'terminal.canceledBy.timeout': {
    de: 'am Terminal ohne Eingabe abgelaufen',
    en: 'timed out at the terminal without input',
    tr: 'terminalde giriş yapılmadan süresi doldu' },
  'terminal.canceledBy.revoked': {
    de: 'Terminal widerrufen',
    en: 'terminal revoked',
    tr: 'terminal iptal edildi' },
  'terminal.cancel': {
    de: 'Abbrechen',
    en: 'Cancel',
    tr: 'İptal' },

  // ------------------------------------------------ Check-in am Tresen
  'terminal.checkin.signLater': {
    de: 'Anlegen, unterschreiben am Terminal',
    en: 'Create, sign at the terminal',
    tr: 'Oluştur, terminalde imzala' },
  'terminal.checkin.signLaterHint': {
    de: 'Legt den Meldeschein ohne Unterschrift an. Der Gast unterschreibt danach am '
      + 'Gästeterminal oder hier.',
    en: 'Creates the Meldeschein without a signature. The guest then signs at the '
      + 'guest terminal or here.',
    tr: 'Meldeschein\'ı imzasız oluşturur. Misafir ardından misafir terminalinde '
      + 'veya burada imzalar.' },
  'terminal.checkin.signaturePending': {
    de: 'Die Unterschrift des Gastes fehlt noch. Eingecheckt wird erst danach.',
    en: 'The guest\'s signature is still missing. Check-in follows afterwards.',
    tr: 'Misafirin imzası hâlâ eksik. Giriş işlemi ancak ondan sonra yapılır.' },
  'terminal.checkin.signed': {
    de: 'Vom Gast unterschrieben.',
    en: 'Signed by the guest.',
    tr: 'Misafir tarafından imzalandı.' },
  'terminal.checkin.signHere': {
    de: 'Hier unterschreiben lassen',
    en: 'Have it signed here',
    tr: 'Burada imzalat' },
  'terminal.checkin.signSubmit': {
    de: 'Unterschrift speichern',
    en: 'Save signature',
    tr: 'İmzayı kaydet' },

  // ------------------------------------------------- Am Touchscreen (Gast)
  'kiosk.welcome': {
    de: 'Willkommen',
    en: 'Welcome',
    tr: 'Hoş geldiniz' },
  'kiosk.idleHint': {
    de: 'Die Rezeption öffnet hier gleich Ihr Formular.',
    en: 'The front desk will open your form here in a moment.',
    tr: 'Resepsiyon formunuzu birazdan burada açacak.' },
  'kiosk.training': {
    de: 'Übungshaus',
    en: 'Training property',
    tr: 'Eğitim tesisi' },
  'kiosk.offline': {
    de: 'Keine Verbindung. Es wird weiter versucht …',
    en: 'No connection. Retrying …',
    tr: 'Bağlantı yok. Yeniden deneniyor …' },
  'kiosk.pairTitle': {
    de: 'Terminal koppeln',
    en: 'Pair terminal',
    tr: 'Terminali eşleştir' },
  'kiosk.pairHint': {
    de: 'Den Code aus Einstellungen → Gästeterminals eingeben.',
    en: 'Enter the code from Settings → Guest terminals.',
    tr: 'Ayarlar → Misafir terminalleri bölümündeki kodu girin.' },
  'kiosk.pairCode': {
    de: 'Kopplungscode',
    en: 'Pairing code',
    tr: 'Eşleştirme kodu' },
  'kiosk.pair': {
    de: 'Koppeln',
    en: 'Pair',
    tr: 'Eşleştir' },
  'kiosk.sign.title': {
    de: 'Meldeschein',
    en: 'Meldeschein (registration form)',
    tr: 'Meldeschein (kayıt formu)' },
  'kiosk.sign.intro': {
    de: 'Bitte prüfen Sie Ihre Angaben und unterschreiben Sie unten.',
    en: 'Please check your details and sign below.',
    tr: 'Lütfen bilgilerinizi kontrol edin ve aşağıyı imzalayın.' },
  'kiosk.field.name': {
    de: 'Name',
    en: 'Name',
    tr: 'Ad soyad' },
  'kiosk.field.birthDate': {
    de: 'Geburtsdatum',
    en: 'Date of birth',
    tr: 'Doğum tarihi' },
  'kiosk.field.nationality': {
    de: 'Staatsangehörigkeit',
    en: 'Nationality',
    tr: 'Uyruk' },
  'kiosk.field.address': {
    de: 'Anschrift',
    en: 'Address',
    tr: 'Adres' },
  'kiosk.field.stay': {
    de: 'Aufenthalt',
    en: 'Stay',
    tr: 'Konaklama' },
  'kiosk.field.occupants': {
    de: 'Personen',
    en: 'Persons',
    tr: 'Kişi sayısı' },
  'kiosk.field.companions': {
    de: 'Mitreisende',
    en: 'Travelling with',
    tr: 'Birlikte seyahat edenler' },
  'kiosk.sign.legal': {
    de: 'Mit Ihrer Unterschrift bestätigen Sie die Richtigkeit dieser Angaben '
      + '(Meldeschein nach § 30 BMG).',
    en: 'By signing you confirm that these details are correct '
      + '(Meldeschein under § 30 BMG).',
    tr: 'İmzanızla bu bilgilerin doğru olduğunu onaylarsınız '
      + '(§ 30 BMG uyarınca Meldeschein).' },
  'kiosk.sign.wrong': {
    de: 'Stimmt etwas nicht? Bitte sprechen Sie die Rezeption an.',
    en: 'Something not right? Please speak to the front desk.',
    tr: 'Bir yanlışlık mı var? Lütfen resepsiyona başvurun.' },
  'kiosk.sign.here': {
    de: 'Hier mit dem Finger unterschreiben',
    en: 'Sign here with your finger',
    tr: 'Buraya parmağınızla imzalayın' },
  'kiosk.sign.clear': {
    de: 'Neu zeichnen',
    en: 'Draw again',
    tr: 'Yeniden çiz' },
  'kiosk.sign.submit': {
    de: 'Unterschreiben',
    en: 'Sign',
    tr: 'İmzala' },
  'kiosk.abort': {
    de: 'Abbrechen',
    en: 'Cancel',
    tr: 'İptal' },
  'kiosk.thanks': {
    de: 'Vielen Dank!',
    en: 'Thank you!',
    tr: 'Teşekkür ederiz!' },
  'kiosk.thanksHint': {
    de: 'Die Rezeption kümmert sich um alles Weitere.',
    en: 'The front desk will take care of the rest.',
    tr: 'Gerisini resepsiyon halledecek.' },
  'kiosk.language': {
    de: 'Sprache',
    en: 'Language',
    tr: 'Dil' }
} as const satisfies Record<string, LocalizedText>
