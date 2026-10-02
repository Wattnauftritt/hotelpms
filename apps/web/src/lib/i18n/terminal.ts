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
  'terminal.settings.kiosk': {
    de: 'Kiosk-Adresse',
    en: 'Kiosk address',
    tr: 'Kiosk adresi' },
  'terminal.settings.kioskTitle': {
    de: 'Kiosk-Adresse für „{name}“',
    en: 'Kiosk address for "{name}"',
    tr: '„{name}“ için kiosk adresi' },
  'terminal.settings.kioskHint': {
    de: 'Für einen Kiosk, der beim Neustart alles vergisst, etwa Edge im Kioskmodus '
      + 'von Windows: diese Adresse dort als Startseite eintragen. Das Terminal meldet '
      + 'sich damit bei jedem Start selbst an. Sie steht nur jetzt hier; wer sie '
      + 'verliert, erzeugt eine neue, und die alte gilt dann nicht mehr. Wer die '
      + 'Adresse hat, kann sich als dieses Terminal ausgeben — nicht weitergeben.',
    en: 'For a kiosk that forgets everything on restart, such as Edge in Windows kiosk '
      + 'mode: enter this address there as the start page. The terminal then signs '
      + 'itself in on every start. It is shown only now; if it is lost, create a new '
      + 'one and the old one stops working. Anyone with the address can act as this '
      + 'terminal — do not pass it on.',
    tr: 'Yeniden başlatıldığında her şeyi unutan bir kiosk için, örneğin Windows kiosk '
      + 'modundaki Edge: bu adresi orada başlangıç sayfası olarak girin. Terminal her '
      + 'açılışta kendini bununla oturum açar. Yalnızca şimdi gösterilir; kaybolursa '
      + 'yenisini oluşturun, eskisi o zaman geçersiz olur. Adrese sahip olan herkes bu '
      + 'terminal gibi davranabilir — başkasına vermeyin.' },
  'terminal.settings.copy': {
    de: 'Kopieren',
    en: 'Copy',
    tr: 'Kopyala' },
  'terminal.settings.copied': {
    de: 'Kopiert',
    en: 'Copied',
    tr: 'Kopyalandı' },
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
  'terminal.send.terms_sign': {
    de: 'Hausbedingung „{titel}“ am Terminal',
    en: 'House terms "{titel}" at the terminal',
    tr: '„{titel}“ tesis koşulları terminalde' },
  'terminal.showContent': {
    de: 'Am Terminal zeigen',
    en: 'Show at the terminal',
    tr: 'Terminalde göster' },
  'terminal.kind.registration_fill': {
    de: 'Meldeformular',
    en: 'Registration form',
    tr: 'Kayıt formu' },
  'terminal.kind.registration_sign': {
    de: 'Unterschrift Meldeschein',
    en: 'Meldeschein signature',
    tr: 'Meldeschein imzası' },
  'terminal.kind.terms_sign': {
    de: 'Hausbedingung',
    en: 'House terms',
    tr: 'Tesis koşulları' },
  'terminal.kind.content': {
    de: 'Seite',
    en: 'Page',
    tr: 'Sayfa' },
  'terminal.kind.url': {
    de: 'Externe Seite',
    en: 'External page',
    tr: 'Harici sayfa' },
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
  'kiosk.done': {
    de: 'Fertig',
    en: 'Done',
    tr: 'Tamam' },
  'kiosk.terms.accept': {
    de: 'Zustimmen',
    en: 'Agree',
    tr: 'Kabul et' },
  'kiosk.terms.sign': {
    de: 'Unterschreiben und zustimmen',
    en: 'Sign and agree',
    tr: 'İmzala ve kabul et' },
  'kiosk.url.hint': {
    de: 'Bleibt die Seite leer, erlaubt sie keine Anzeige hier. Bitte fragen Sie an der Rezeption.',
    en: 'If the page stays empty, it cannot be shown here. Please ask at the front desk.',
    tr: 'Sayfa boş kalırsa burada gösterilemiyor demektir. Lütfen resepsiyona sorun.' },

  // ------------------------------------------- Bedienfeld der Rezeption
  'nav.terminal': {
    de: 'Terminal',
    en: 'Terminal',
    tr: 'Terminal' },
  'pult.title': {
    de: 'Gästeterminals',
    en: 'Guest terminals',
    tr: 'Misafir terminalleri' },
  'pult.hint': {
    de: 'Seiten und freigegebene Adressen lassen sich hier ohne Reservierung zeigen. '
      + 'Meldeschein und Hausbedingungen schickt die Reservierung.',
    en: 'Pages and approved addresses can be shown here without a reservation. '
      + 'Registration and house terms are sent from the reservation.',
    tr: 'Sayfalar ve onaylı adresler burada rezervasyonsuz gösterilebilir. '
      + 'Meldeschein ve tesis koşulları rezervasyondan gönderilir.' },
  'pult.none': {
    de: 'Noch kein Terminal gekoppelt. Gekoppelt wird in den Einstellungen.',
    en: 'No terminal paired yet. Pairing happens in the settings.',
    tr: 'Henüz eşleştirilmiş terminal yok. Eşleştirme ayarlarda yapılır.' },
  'pult.noContent': {
    de: 'Noch keine Seiten oder Adressen angelegt (Einstellungen → Gästeterminals).',
    en: 'No pages or addresses yet (Settings → Guest terminals).',
    tr: 'Henüz sayfa veya adres yok (Ayarlar → Misafir terminalleri).' },
  'pult.idle': {
    de: 'Ruhezustand',
    en: 'Idle',
    tr: 'Beklemede' },

  // ------------------------------------------- Inhalte (Einstellungen)
  'inhalte.title': {
    de: 'Seiten',
    en: 'Pages',
    tr: 'Sayfalar' },
  'inhalte.hint': {
    de: 'Was das Terminal zeigen kann: Hausordnung, WLAN, Frühstückszeiten, Angebote. '
      + 'Text ohne HTML — Leerzeile für einen neuen Absatz, „- “ am Zeilenanfang für eine '
      + 'Aufzählung, **so** für fett.',
    en: 'What the terminal can show: house rules, Wi-Fi, breakfast times, offers. '
      + 'Text without HTML — blank line for a new paragraph, "- " at the start of a line '
      + 'for a list, **like this** for bold.',
    tr: 'Terminalin gösterebilecekleri: ev kuralları, Wi-Fi, kahvaltı saatleri, teklifler. '
      + 'HTML olmadan metin — yeni paragraf için boş satır, liste için satır başında „- “, '
      + 'kalın için **böyle**.' },
  'inhalte.titel': {
    de: 'Titel',
    en: 'Title',
    tr: 'Başlık' },
  'inhalte.text': {
    de: 'Text',
    en: 'Text',
    tr: 'Metin' },
  'inhalte.neu': {
    de: 'Seite anlegen',
    en: 'Create page',
    tr: 'Sayfa oluştur' },
  'inhalte.speichern': {
    de: 'Speichern',
    en: 'Save',
    tr: 'Kaydet' },
  'inhalte.bearbeiten': {
    de: 'Bearbeiten',
    en: 'Edit',
    tr: 'Düzenle' },
  'inhalte.archivieren': {
    de: 'Archivieren',
    en: 'Archive',
    tr: 'Arşivle' },
  'inhalte.archivierenConfirm': {
    de: 'Seite „{titel}“ archivieren? Sie verschwindet aus der Diashow und lässt sich nicht mehr schicken.',
    en: 'Archive page "{titel}"? It leaves the slideshow and can no longer be sent.',
    tr: '„{titel}“ sayfası arşivlensin mi? Slayt gösterisinden çıkar ve artık gönderilemez.' },
  'inhalte.bild': {
    de: 'Bild wählen',
    en: 'Choose image',
    tr: 'Görsel seç' },
  'inhalte.bildEntfernen': {
    de: 'Bild entfernen',
    en: 'Remove image',
    tr: 'Görseli kaldır' },
  'inhalte.bildHint': {
    de: 'PNG, JPEG oder WebP, höchstens 1 MB. SVG wird nicht angenommen.',
    en: 'PNG, JPEG or WebP, at most 1 MB. SVG is not accepted.',
    tr: 'PNG, JPEG veya WebP, en fazla 1 MB. SVG kabul edilmez.' },
  'inhalte.keine': {
    de: 'Noch keine Seite angelegt.',
    en: 'No page yet.',
    tr: 'Henüz sayfa yok.' },
  'diashow.title': {
    de: 'Diashow im Ruhezustand',
    en: 'Idle slideshow',
    tr: 'Bekleme slayt gösterisi' },
  'diashow.hint': {
    de: 'Ohne Seiten zeigt das Terminal nur die Begrüßung. Ein Auftrag der Rezeption unterbricht die Diashow.',
    en: 'Without pages the terminal only shows the greeting. A job from the front desk interrupts the slideshow.',
    tr: 'Sayfa olmadan terminal yalnızca karşılama gösterir. Resepsiyondan gelen bir görev slayt gösterisini keser.' },
  'diashow.sekunden': {
    de: 'Sekunden',
    en: 'seconds',
    tr: 'saniye' },
  'diashow.aufnehmen': {
    de: 'In die Diashow',
    en: 'Add to slideshow',
    tr: 'Slayta ekle' },
  'diashow.entfernen': {
    de: 'Aus der Diashow',
    en: 'Remove from slideshow',
    tr: 'Slayttan çıkar' },
  'diashow.hoch': {
    de: 'Nach oben',
    en: 'Move up',
    tr: 'Yukarı taşı' },
  'diashow.speichern': {
    de: 'Diashow speichern',
    en: 'Save slideshow',
    tr: 'Slaytı kaydet' },
  'adressen.title': {
    de: 'Freigegebene externe Seiten',
    en: 'Approved external pages',
    tr: 'Onaylı harici sayfalar' },
  'adressen.hint': {
    de: 'Nur diese Adressen kann die Rezeption auf das Terminal schicken — keine beliebige. '
      + 'Nur https. Viele Seiten verbieten die Anzeige in einem fremden Rahmen; ob eine Seite '
      + 'erscheint, zeigt die Vorschau.',
    en: 'Only these addresses can be sent to the terminal — no arbitrary ones. Only https. '
      + 'Many sites forbid being shown inside another page; the preview shows whether a page appears.',
    tr: 'Resepsiyon terminale yalnızca bu adresleri gönderebilir — rastgele adres değil. '
      + 'Yalnızca https. Birçok site başka bir sayfa içinde gösterilmeyi yasaklar; önizleme bunu gösterir.' },
  'adressen.label': {
    de: 'Bezeichnung',
    en: 'Label',
    tr: 'Ad' },
  'adressen.url': {
    de: 'Adresse (https://…)',
    en: 'Address (https://…)',
    tr: 'Adres (https://…)' },
  'adressen.freigeben': {
    de: 'Freigeben',
    en: 'Approve',
    tr: 'Onayla' },
  'adressen.entfernen': {
    de: 'Freigabe zurückziehen',
    en: 'Withdraw approval',
    tr: 'Onayı geri çek' },
  'adressen.vorschau': {
    de: 'Vorschau',
    en: 'Preview',
    tr: 'Önizleme' },
  'adressen.keine': {
    de: 'Keine Adresse freigegeben.',
    en: 'No address approved.',
    tr: 'Onaylı adres yok.' },
  'kiosk.language': {
    de: 'Sprache',
    en: 'Language',
    tr: 'Dil' }
} as const satisfies Record<string, LocalizedText>
