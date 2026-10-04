import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Online-Check-in (Dokument 30): die Gastseite und was die Rezeption davon
 * sieht.
 *
 * Die Gastseite spricht mit einem Gast, nicht mit Personal: kurze Saetze,
 * keine Fachwoerter ausser denen, die auf dem Papier stehen. "Meldeschein"
 * und "§ 29 BMG" bleiben in jeder Sprache stehen -- wer den Bildschirm dem
 * Papier zuordnen soll, das ihm die Rezeption vielleicht doch noch reicht,
 * braucht dasselbe Wort auf beiden (CLAUDE.md, "Neue Meldung").
 */
export const onlineCheckin = {
  // ------------------------------------------------------------- Gastseite
  'gastCheckin.title': {
    de: 'Online-Check-in',
    en: 'Online check-in',
    tr: 'Online check-in' },
  'gastCheckin.welcome': {
    de: 'Willkommen, {name}.',
    en: 'Welcome, {name}.',
    tr: 'Hoş geldiniz, {name}.' },
  'gastCheckin.stay': {
    de: 'Ihr Aufenthalt im {haus}: {von} bis {bis}.',
    en: 'Your stay at {haus}: {von} to {bis}.',
    tr: '{haus} konaklamanız: {von} – {bis}.' },
  'gastCheckin.intro': {
    de: 'Füllen Sie hier den Meldeschein aus, den das Gesetz für jeden '
      + 'Hotelaufenthalt vorsieht. Das spart Ihnen bei der Ankunft Zeit.',
    en: 'Fill in the registration form (Meldeschein) that German law requires '
      + 'for every hotel stay. This saves you time on arrival.',
    tr: 'Alman yasalarının her otel konaklaması için öngördüğü kayıt formunu '
      + '(Meldeschein) burada doldurun. Bu, varışta size zaman kazandırır.' },
  'gastCheckin.language': {
    de: 'Sprache',
    en: 'Language',
    tr: 'Dil' },
  'gastCheckin.loading': {
    de: 'Einen Moment …',
    en: 'One moment …',
    tr: 'Bir dakika …' },

  'gastCheckin.nationality.title': {
    de: 'Ihre Staatsangehörigkeit',
    en: 'Your nationality',
    tr: 'Uyruğunuz' },
  'gastCheckin.nationality.hint': {
    de: 'Haben Sie mehrere und ist eine davon die deutsche, wählen Sie Deutschland.',
    en: 'If you have several and one of them is German, choose Germany.',
    tr: 'Birden fazla uyruğunuz varsa ve biri Alman ise Almanya’yı seçin.' },
  'gastCheckin.choose': {
    de: 'Bitte wählen',
    en: 'Please choose',
    tr: 'Lütfen seçin' },

  'gastCheckin.person.title': {
    de: 'Ihre Angaben',
    en: 'Your details',
    tr: 'Bilgileriniz' },
  'gastCheckin.lastName': {
    de: 'Familienname',
    en: 'Family name',
    tr: 'Soyadı' },
  'gastCheckin.firstName': {
    de: 'Vorname(n)',
    en: 'First name(s)',
    tr: 'Ad(lar)' },
  'gastCheckin.birthDate': {
    de: 'Geburtsdatum',
    en: 'Date of birth',
    tr: 'Doğum tarihi' },
  'gastCheckin.street': {
    de: 'Straße und Hausnummer',
    en: 'Street and number',
    tr: 'Sokak ve numara' },
  'gastCheckin.postalCode': {
    de: 'Postleitzahl',
    en: 'Postcode',
    tr: 'Posta kodu' },
  'gastCheckin.city': {
    de: 'Ort',
    en: 'City',
    tr: 'Şehir' },
  'gastCheckin.country': {
    de: 'Land',
    en: 'Country',
    tr: 'Ülke' },
  'gastCheckin.document.title': {
    de: 'Reisedokument',
    en: 'Travel document',
    tr: 'Seyahat belgesi' },
  // § 29 Abs. 3 und § 30 Abs. 2 BMG: die Nummer ja, eine Kopie nie -- und
  // vorgezeigt wird das Dokument trotzdem vor Ort.
  'gastCheckin.document.hint': {
    de: 'Für Gäste ohne deutsche Staatsangehörigkeit verlangt § 30 BMG die '
      + 'Nummer des Reisepasses oder Ausweises. Eine Kopie nehmen wir nicht; '
      + 'bitte zeigen Sie das Dokument bei der Ankunft vor.',
    en: 'For guests without German citizenship, § 30 BMG requires the number '
      + 'of the passport or identity card. We do not take a copy; please show '
      + 'the document on arrival.',
    tr: 'Alman vatandaşı olmayan misafirler için § 30 BMG pasaport veya kimlik '
      + 'kartı numarasını şart koşar. Kopya almıyoruz; lütfen belgeyi varışta '
      + 'gösterin.' },
  'gastCheckin.document.type': {
    de: 'Art',
    en: 'Type',
    tr: 'Tür' },
  'gastCheckin.document.passport': {
    de: 'Reisepass',
    en: 'Passport',
    tr: 'Pasaport' },
  'gastCheckin.document.idCard': {
    de: 'Personalausweis',
    en: 'Identity card',
    tr: 'Kimlik kartı' },
  'gastCheckin.document.other': {
    de: 'Anderes Passersatzpapier',
    en: 'Other travel document',
    tr: 'Diğer seyahat belgesi' },
  'gastCheckin.document.number': {
    de: 'Nummer',
    en: 'Number',
    tr: 'Numara' },

  'gastCheckin.companions.title': {
    de: 'Mitreisende',
    en: 'Travelling with you',
    tr: 'Birlikte seyahat edenler' },
  'gastCheckin.companions.hint': {
    de: 'Wer mit Ihnen im Zimmer übernachtet. Höchstens {max} Personen.',
    en: 'Who stays in the room with you. At most {max} people.',
    tr: 'Odada sizinle kalan kişiler. En fazla {max} kişi.' },
  'gastCheckin.companions.add': {
    de: 'Person hinzufügen',
    en: 'Add a person',
    tr: 'Kişi ekle' },
  'gastCheckin.companions.remove': {
    de: 'Entfernen',
    en: 'Remove',
    tr: 'Kaldır' },
  'gastCheckin.companions.person': {
    de: 'Person {n}',
    en: 'Person {n}',
    tr: '{n}. kişi' },

  'gastCheckin.signature.title': {
    de: 'Unterschrift',
    en: 'Signature',
    tr: 'İmza' },
  'gastCheckin.signature.hint': {
    de: 'Für Gäste ohne deutsche Staatsangehörigkeit verlangt § 29 BMG die '
      + 'Unterschrift am Tag der Ankunft. Bitte hier mit dem Finger oder der Maus.',
    en: 'For guests without German citizenship, § 29 BMG requires a signature '
      + 'on the day of arrival. Please sign here with your finger or the mouse.',
    tr: 'Alman vatandaşı olmayan misafirler için § 29 BMG varış günü imza şart '
      + 'koşar. Lütfen buraya parmağınızla veya fareyle imzalayın.' },
  'gastCheckin.signature.later': {
    de: 'Weil eine Person ohne deutsche Staatsangehörigkeit dabei ist, '
      + 'unterschreiben Sie den Meldeschein am Tag der Ankunft vor Ort '
      + '(§ 29 BMG) und zeigen dort Reisepass oder Ausweis vor.',
    en: 'Because someone without German citizenship is travelling, you sign the '
      + 'registration form on site on the day of arrival (§ 29 BMG) and show '
      + 'your passport or identity card there.',
    tr: 'Alman vatandaşı olmayan biri bulunduğundan, kayıt formunu varış günü '
      + 'tesiste imzalayacak (§ 29 BMG) ve orada pasaport veya kimlik kartınızı '
      + 'göstereceksiniz.' },
  'gastCheckin.signature.clear': {
    de: 'Neu unterschreiben',
    en: 'Sign again',
    tr: 'Yeniden imzala' },

  'gastCheckin.confirm': {
    de: 'Meine Angaben sind richtig und vollständig.',
    en: 'My details are correct and complete.',
    tr: 'Bilgilerim doğru ve eksiksizdir.' },
  // Art. 13 DSGVO: wer, wozu, wie lange -- an der Stelle, an der erhoben
  // wird, nicht hinter einem Link, den es auf der Terminalseite nicht gibt.
  'gastCheckin.privacy': {
    de: '{haus} erhebt diese Angaben, weil das Bundesmeldegesetz (§§ 29, 30 BMG) '
      + 'es für jede Beherbergung vorschreibt. Der Meldeschein wird ein Jahr '
      + 'nach Ihrer Abreise vernichtet. Die Angaben gehen nur auf Verlangen an '
      + 'die zuständige Behörde.',
    en: '{haus} collects these details because the Federal Registration Act '
      + '(§§ 29, 30 BMG) requires it for every hotel stay. The registration form '
      + 'is destroyed one year after your departure. The details go to the '
      + 'competent authority only on request.',
    tr: '{haus} bu bilgileri, Federal Kayıt Kanunu (§§ 29, 30 BMG) her konaklama '
      + 'için öngördüğü için toplar. Kayıt formu ayrılışınızdan bir yıl sonra '
      + 'imha edilir. Bilgiler yalnızca talep üzerine yetkili makama iletilir.' },
  'gastCheckin.submit': {
    de: 'Meldeschein absenden',
    en: 'Submit registration form',
    tr: 'Kayıt formunu gönder' },
  'gastCheckin.submitSignature': {
    de: 'Unterschrift absenden',
    en: 'Submit signature',
    tr: 'İmzayı gönder' },
  'gastCheckin.fixFields': {
    de: 'Bitte prüfen Sie die markierten Angaben.',
    en: 'Please check the marked details.',
    tr: 'Lütfen işaretli bilgileri kontrol edin.' },

  'gastCheckin.done.title': {
    de: 'Vielen Dank!',
    en: 'Thank you!',
    tr: 'Teşekkür ederiz!' },
  'gastCheckin.done.text': {
    de: 'Ihr Meldeschein liegt vor. Wir freuen uns auf Sie.',
    en: 'Your registration form has been received. We look forward to seeing you.',
    tr: 'Kayıt formunuz alındı. Sizi görmeyi dört gözle bekliyoruz.' },
  'gastCheckin.done.signatureLater': {
    de: 'Ihre Angaben liegen vor. Die Unterschrift leisten Sie am Tag der '
      + 'Ankunft vor Ort; bitte halten Sie Reisepass oder Ausweis bereit.',
    en: 'Your details have been received. You sign on site on the day of '
      + 'arrival; please have your passport or identity card ready.',
    tr: 'Bilgileriniz alındı. İmzayı varış günü tesiste atacaksınız; lütfen '
      + 'pasaportunuzu veya kimlik kartınızı hazır bulundurun.' },
  'gastCheckin.done.close': {
    de: 'Fertig',
    en: 'Done',
    tr: 'Tamam' },
  'gastCheckin.noLink': {
    de: 'Dieser Link ist unvollständig. Bitte öffnen Sie ihn noch einmal aus '
      + 'Ihrer E-Mail oder wenden Sie sich an die Rezeption.',
    en: 'This link is incomplete. Please open it again from your email or '
      + 'contact the front desk.',
    tr: 'Bu bağlantı eksik. Lütfen e-postanızdan yeniden açın veya resepsiyona '
      + 'başvurun.' },

  // -------------------------------------------------------------- Rezeption
  'onlineCheckin.title': {
    de: 'Online-Check-in',
    en: 'Online check-in',
    tr: 'Online check-in' },
  'onlineCheckin.invitedAt': {
    de: 'Link verschickt am {zeit}',
    en: 'Link sent on {zeit}',
    tr: 'Bağlantı {zeit} tarihinde gönderildi' },
  'onlineCheckin.invitationPending': {
    de: 'Link wartet auf Versand (eingereiht {zeit})',
    en: 'Link waiting to be sent (queued {zeit})',
    tr: 'Bağlantı gönderimi bekliyor ({zeit} sıraya alındı)' },
  'onlineCheckin.invitationFailed': {
    de: 'Versand des Links gescheitert ({zeit})',
    en: 'Sending the link failed ({zeit})',
    tr: 'Bağlantı gönderilemedi ({zeit})' },
  'onlineCheckin.notInvited': {
    de: 'Noch kein Link verschickt.',
    en: 'No link sent yet.',
    tr: 'Henüz bağlantı gönderilmedi.' },
  'onlineCheckin.completedOnline': {
    de: 'Online ausgefüllt am {zeit}',
    en: 'Filled in online on {zeit}',
    tr: '{zeit} tarihinde online dolduruldu' },
  'onlineCheckin.completedTerminal': {
    de: 'Am Terminal ausgefüllt am {zeit}',
    en: 'Filled in at the terminal on {zeit}',
    tr: '{zeit} tarihinde terminalde dolduruldu' },
  // Aus einem Umsystem uebernommen (0087); {system} ist dessen Name.
  'onlineCheckin.completedImported': {
    de: 'Ausgefüllt am {zeit}, übernommen aus {system}',
    en: 'Filled in on {zeit}, taken over from {system}',
    tr: '{zeit} tarihinde dolduruldu, {system} sisteminden aktarıldı' },
  'onlineCheckin.signaturePending': {
    de: 'Unterschrift steht aus: am Anreisetag am Terminal oder hier beim '
      + 'Check-in (§ 29 BMG). Reisedokument vorzeigen lassen.',
    en: 'Signature outstanding: on the day of arrival at the terminal or here '
      + 'at check-in (§ 29 BMG). Ask to see the travel document.',
    tr: 'İmza bekleniyor: varış günü terminalde veya burada check-in sırasında '
      + '(§ 29 BMG). Seyahat belgesini görmeyi isteyin.' },
  'onlineCheckin.activeLinks': {
    de: 'Gültige Links: {n}',
    en: 'Valid links: {n}',
    tr: 'Geçerli bağlantılar: {n}' },
  'onlineCheckin.send': {
    de: 'Link erneut senden',
    en: 'Send link again',
    tr: 'Bağlantıyı yeniden gönder' },
  'onlineCheckin.sent': {
    de: 'Eingereiht.',
    en: 'Queued.',
    tr: 'Sıraya alındı.' },
  'onlineCheckin.copy': {
    de: 'Link kopieren',
    en: 'Copy link',
    tr: 'Bağlantıyı kopyala' },
  'onlineCheckin.copied': {
    de: 'In die Zwischenablage kopiert. Gültig bis {datum}.',
    en: 'Copied to the clipboard. Valid until {datum}.',
    tr: 'Panoya kopyalandı. {datum} tarihine kadar geçerli.' },
  'onlineCheckin.copyManual': {
    de: 'Link markieren und kopieren. Gültig bis {datum}.',
    en: 'Select and copy the link. Valid until {datum}.',
    tr: 'Bağlantıyı seçip kopyalayın. {datum} tarihine kadar geçerli.' },
  'onlineCheckin.copyWarning': {
    de: 'Nur an den Gast selbst weitergeben: wer den Link hat, kann seinen '
      + 'Meldeschein ausfüllen.',
    en: 'Give it only to the guest: whoever has the link can fill in their '
      + 'registration form.',
    tr: 'Yalnızca misafirin kendisine verin: bağlantıya sahip olan kişi kayıt '
      + 'formunu doldurabilir.' },
  'onlineCheckin.revoke': {
    de: 'Links zurückziehen',
    en: 'Withdraw links',
    tr: 'Bağlantıları geri çek' },
  'onlineCheckin.revoked': {
    de: 'Zurückgezogen: {n}',
    en: 'Withdrawn: {n}',
    tr: 'Geri çekildi: {n}' },

  'onlineCheckin.settings.title': {
    de: 'Online-Check-in',
    en: 'Online check-in',
    tr: 'Online check-in' },
  'onlineCheckin.settings.enabled': {
    de: 'Link vor Anreise automatisch per E-Mail schicken',
    en: 'Send the link by email automatically before arrival',
    tr: 'Bağlantıyı varıştan önce otomatik olarak e-postayla gönder' },
  'onlineCheckin.settings.days': {
    de: 'Tage vor Anreise',
    en: 'Days before arrival',
    tr: 'Varıştan önceki gün sayısı' },
  'onlineCheckin.settings.hint': {
    de: 'Nur für bestätigte Buchungen mit E-Mail-Adresse und ohne Meldeschein, '
      + 'genau einmal je Buchung. Voraussetzung ist der eingeschaltete Gastversand '
      + 'mit freigeschalteter Absenderdomain; ein Übungshaus verschickt nichts. '
      + 'Ausländische Gäste unterschreiben am Anreisetag vor Ort (§ 29 BMG).',
    en: 'Only for confirmed bookings with an email address and no registration '
      + 'form yet, exactly once per booking. Guest mail must be switched on with '
      + 'an approved sender domain; a training property sends nothing. Foreign '
      + 'guests sign on site on the day of arrival (§ 29 BMG).',
    tr: 'Yalnızca e-posta adresi olan ve henüz kayıt formu bulunmayan onaylı '
      + 'rezervasyonlar için, rezervasyon başına tam bir kez. Misafir e-postasının '
      + 'onaylı gönderici alan adıyla açık olması gerekir; eğitim tesisi hiçbir '
      + 'şey göndermez. Yabancı misafirler varış günü tesiste imzalar (§ 29 BMG).' }
} as const satisfies Record<string, LocalizedText>
