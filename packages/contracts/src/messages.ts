/**
 * Meldungen der Schnittstelle in allen angebotenen Sprachen.
 *
 * **Warum das hier liegt und nicht in der API.** Ein Fehler der Schnittstelle
 * wird an zwei Orten gelesen: von einer Maschine, die auf ihn reagiert, und
 * von einem Menschen an der Rezeption, der ihn verstehen soll. Die Maschine
 * braucht einen stabilen Schluessel, der Mensch einen Satz in seiner Sprache.
 * Der Schluessel gehoert damit zum Vertrag, genau wie ein Feldname -- und
 * deshalb steht er hier neben den Schemata und nicht in `apps/api`.
 *
 * **Die Sprachen stehen nebeneinander, nicht in getrennten Listen.**
 * Getrennte Bloecke laufen auseinander, sobald jemand einen Satz aendert und
 * die anderen vergisst; nebeneinander faellt die Luecke beim Hinsehen auf,
 * und ein Test faengt sie ohnehin ab. Ab der dritten Sprache ist das kein
 * Geschmack mehr, sondern die einzige Form, in der sich ein Satz noch
 * gegenlesen laesst.
 *
 * **Platzhalter** stehen in geschweiften Klammern: `{max}`. Eine Meldung mit
 * Platzhaltern ohne Werte bleibt lesbar -- der Platzhalter bleibt stehen,
 * statt dass die Meldung verschwindet.
 *
 * Die Sprache der Oberflaeche ist die des Personals; die der Gastpost steht
 * am Gastprofil und wird nicht hier entschieden (Dokument 19).
 */

/**
 * Die Sprachen, in denen Oberflaeche und Meldungen **vollstaendig**
 * vorliegen.
 *
 * Bewusst hier und nicht in `apps/web`: die Liste ist eine Zusage des
 * Produkts, kein Merkmal eines Bildschirms, und der Test ueber den Katalog
 * braucht sie genauso wie die Oberflaeche. Eine Sprache steht hier erst,
 * wenn jeder Schluessel sie hat -- halb uebersetzt anzubieten heisst, dem
 * Benutzer die Haelfte in einer Sprache zu zeigen, die er nicht gewaehlt
 * hat.
 */
export const LOCALES = ['de', 'en', 'tr'] as const
export type MessageLocale = (typeof LOCALES)[number]

/**
 * Die Sprachen, in denen **Gastpost** entsteht.
 *
 * Bewusst eine zweite Liste neben `LOCALES` und nicht dieselbe: die eine
 * folgt dem Personal am Bildschirm, die andere dem Gast an seinem Profil.
 * Ein deutsches Haus, dessen Rezeption die Oberflaeche auf Deutsch fuehrt,
 * schreibt einem niederlaendischen Gast trotzdem niederlaendisch -- und
 * eine Sprache in die Oberflaeche zu uebersetzen ist ein Vielfaches der
 * Arbeit, die ein Anschreiben kostet. Die Listen waeren zusammengelegt
 * entweder zu klein oder zu teuer.
 *
 * Bewusst hier und nicht in `packages/domain`, wo die Vorlagen stehen:
 * die Gastmaske bietet diese Sprachen zur Auswahl an und braucht dafuer
 * nur die Liste. Sie ueber die Domaene zu holen zog deren Barrel in das
 * Buendel der Oberflaeche -- mit `node:crypto` darin, das ein Browser
 * nicht hat.
 */
export const EMAIL_LANGUAGES = ['de', 'en', 'nl', 'pl'] as const
export type EmailLanguage = (typeof EMAIL_LANGUAGES)[number]

/**
 * Die Sprache eines Gastes auf eine Sprache abbilden, in der wir schreiben.
 *
 * Gegen die Liste und nicht gegen eine einzelne Sprache: mit
 * `code === 'en' ? 'en' : 'de'` bekaeme jede neue Sprache stillschweigend
 * deutsche Post, und aufgefallen waere es dem Gast, nicht uns.
 *
 * Nur die ersten beiden Zeichen: am Profil steht mal `en`, mal `en-GB`.
 * Einen Gast deutsch anzuschreiben, weil sein Profil die Region mitfuehrt,
 * waere eine seltsame Art, genau zu sein.
 */
export function emailLanguage(code: string | null | undefined): EmailLanguage {
  const kurz = (code ?? '').slice(0, 2).toLowerCase()
  return (EMAIL_LANGUAGES as readonly string[]).includes(kurz)
    ? (kurz as EmailLanguage)
    : 'de'
}

/**
 * Ein Eintrag: ein Satz je Sprache.
 *
 * Bewusst benannte Felder und keine Liste. Bei zwei Sprachen waere eine
 * Liste knapper; ab der dritten liest niemand mehr ab, welcher Satz zu
 * welcher Sprache gehoert, und eine vertauschte Reihenfolge faellt keinem
 * Typ auf. Ein fehlendes Feld dagegen bricht den Build.
 *
 * Ausgefuehrt, weil die Beschriftungen der Oberflaeche dieselbe Form haben.
 * Zweimal dieselbe Zeile zu schreiben hiesse, sie beim Hinzufuegen einer
 * Sprache an zwei Stellen zu aendern -- und eine davon zu vergessen.
 */
export type LocalizedText = { readonly [L in MessageLocale]: string }

const M = {
  // ------------------------------------------------------------ Fehlertitel

  'error.unauthorized': {
    de: 'Nicht angemeldet',
    en: 'Not signed in',
    tr: 'Oturum açılmamış' },
  'error.forbidden': {
    de: 'Keine Berechtigung',
    en: 'Not permitted',
    tr: 'Yetki yok' },
  'error.notFound': {
    de: '{what} nicht gefunden',
    en: '{what} not found',
    tr: '{what} bulunamadı' },
  'error.conflict': {
    de: 'Konflikt',
    en: 'Conflict',
    tr: 'Çakışma' },
  'error.validation': {
    de: 'Eingabe ungueltig',
    en: 'Invalid input',
    tr: 'Girdi geçersiz' },
  'error.unprocessable': {
    de: 'Nicht verarbeitbar',
    en: 'Cannot be processed',
    tr: 'İşlenemiyor' },
  'error.soldOut': {
    de: 'Kein Kontingent verfuegbar',
    en: 'No availability left',
    tr: 'Kontenjan kalmadı' },
  'error.soldOut.detail': {
    de: 'Fuer mindestens eine Nacht des Zeitraums ist die Kapazitaet erschoepft.',
    en: 'For at least one night of the period there is no capacity left.',
    tr: 'Dönemin en az bir gecesinde kapasite tükenmiş durumda.' },
  'error.notMaterialized': {
    de: 'Zeitraum nicht verfuegbar',
    en: 'Period not available',
    tr: 'Dönem kullanılamıyor' },
  'error.notMaterialized.detail': {
    de: 'Der Zeitraum liegt ausserhalb des vorbereiteten Horizonts. '
      + 'Der Betrieb wurde benachrichtigt.',
    en: 'The period lies beyond the prepared horizon. Operations have been notified.',
    tr: 'Dönem, hazırlanmış ufkun dışında kalıyor. İşletme bilgilendirildi.' },
  'error.rangeTooLarge': {
    de: 'Zeitraum zu gross',
    en: 'Period too large',
    tr: 'Dönem çok geniş' },
  'error.rangeTooLarge.detail': {
    de: 'Hoechstens {max} Tage je Anfrage.',
    en: 'At most {max} days per request.',
    tr: 'Sorgu başına en fazla {max} gün.' },
  'error.idempotencyMismatch': {
    de: 'Idempotenzschluessel wiederverwendet',
    en: 'Idempotency key reused',
    tr: 'Idempotency anahtarı yeniden kullanıldı' },
  'error.idempotencyMismatch.detail': {
    de: 'Derselbe Schluessel wurde bereits mit einem anderen Rumpf benutzt.',
    en: 'The same key has already been used with a different body.',
    tr: 'Aynı anahtar daha önce başka bir gövdeyle kullanılmış.' },
  'error.idempotencyInFlight': {
    de: 'Anfrage laeuft bereits',
    en: 'Request already in flight',
    tr: 'İstek zaten işleniyor' },
  'error.idempotencyInFlight.detail': {
    de: 'Eine Anfrage mit diesem Schluessel wird gerade verarbeitet. Bitte wiederholen.',
    en: 'A request with this key is being processed. Please try again.',
    tr: 'Bu anahtarla gelen bir istek şu anda işleniyor. Lütfen tekrar deneyin.' },
  'error.upstreamFailed': {
    de: 'Ein beteiligtes System hat nicht geantwortet',
    en: 'An upstream system did not respond',
    tr: 'Bağlı bir sistem yanıt vermedi' },
  'error.notConfigured': {
    de: 'Nicht eingerichtet',
    en: 'Not configured',
    tr: 'Kurulmamış' },
  'error.invalidSignature': {
    de: 'Signatur ungueltig',
    en: 'Invalid signature',
    tr: 'İmza geçersiz' },
  'error.documentPending': {
    de: 'Beleg noch nicht erzeugt',
    en: 'Document not generated yet',
    tr: 'Belge henüz oluşturulmadı' },
  'error.documentPending.detail': {
    de: 'Die Rechnung ist festgeschrieben, der Beleg wird gerade erzeugt. '
      + 'Bitte in Kuerze erneut abrufen.',
    en: 'The invoice is final; the document is being generated. Please retry shortly.',
    tr: 'Fatura kesinleşti, belge şu anda oluşturuluyor. Lütfen birazdan tekrar çağırın.' },
  'error.unknown': {
    de: 'Unbekannter Fehler',
    en: 'Unknown error',
    tr: 'Bilinmeyen hata' },
  'error.internal': {
    de: 'Interner Fehler',
    en: 'Internal error',
    tr: 'İç hata' },
  'error.rateLimited': {
    de: 'Zu viele Anfragen',
    en: 'Too many requests',
    tr: 'Çok fazla istek' },
  'error.rateLimited.detail': {
    de: 'Bitte in {seconds} Sekunden erneut versuchen.',
    en: 'Please try again in {seconds} seconds.',
    tr: 'Lütfen {seconds} saniye sonra tekrar deneyin.' },

  // -------------------------------------------------------------- Ressourcen
  //
  // Der Name, der in "X nicht gefunden" eingesetzt wird. Eine kleine, feste
  // Liste: was es nicht gibt, ist immer eines dieser Dinge.

  'res.resource': {
    de: 'Ressource',
    en: 'Resource',
    tr: 'Kaynak' },
  'res.property': {
    de: 'Property',
    en: 'Property',
    tr: 'Property' },
  'res.reservation': {
    de: 'Reservierung',
    en: 'Reservation',
    tr: 'Rezervasyon' },
  'res.booking': {
    de: 'Buchung',
    en: 'Booking',
    tr: 'Rezervasyon kaydı' },
  'res.folio': {
    de: 'Folio',
    en: 'Folio',
    tr: 'Folio' },
  'res.guest': {
    de: 'Gast',
    en: 'Guest',
    tr: 'Misafir' },
  'res.company': {
    de: 'Firma',
    en: 'Company',
    tr: 'Firma' },
  'res.category': {
    de: 'Zimmergruppe',
    en: 'Room type',
    tr: 'Oda tipi' },
  'res.room': {
    de: 'Zimmer',
    en: 'Room',
    tr: 'Oda' },
  'res.invoice': {
    de: 'Rechnung',
    en: 'Invoice',
    tr: 'Fatura' },
  'res.block': {
    de: 'Kontingent',
    en: 'Block',
    tr: 'Kontenjan' },
  'res.terms': {
    de: 'Hausbedingung',
    en: 'House terms',
    tr: 'Konaklama koşulları' },
  'res.subscription': {
    de: 'Abonnement',
    en: 'Subscription',
    tr: 'Abonelik' },
  'res.settlement': {
    de: 'Zahlungsvermerk',
    en: 'Settlement',
    tr: 'Ödeme kaydı' },
  'res.paymentMethod': {
    de: 'Zahlungsart',
    en: 'Payment method',
    tr: 'Ödeme türü' },
  'res.maintenanceTicket': {
    de: 'Wartungsmeldung',
    en: 'Maintenance ticket',
    tr: 'Bakım bildirimi' },
  'res.connection': {
    de: 'Verbindung',
    en: 'Connection',
    tr: 'Bağlantı' },
  'res.ratePlan': {
    de: 'Ratenplan',
    en: 'Rate plan',
    tr: 'Fiyat planı' },
  'res.registration': {
    de: 'Meldeschein',
    en: 'Registration form',
    tr: 'Meldeschein' },
  'res.oauthClient': {
    de: 'Maschinenzugang',
    en: 'Machine access',
    tr: 'Makine erişimi' },
  'res.user': {
    de: 'Benutzer',
    en: 'User',
    tr: 'Kullanıcı' },
  'res.task': {
    de: 'Aufgabe',
    en: 'Task',
    tr: 'Görev' },
  'res.message': {
    de: 'Nachricht',
    en: 'Message',
    tr: 'Mesaj' },
  'res.product': {
    de: 'Artikel',
    en: 'Product',
    tr: 'Ürün' },
  'res.posChargeByReference': {
    de: 'Kassenumsatz mit der Belegnummer {reference}',
    en: 'POS charge with document number {reference}',
    tr: '{reference} belge numaralı kasa hareketi' },

  // ------------------------------------------------------------- Feldfehler
  //
  // Die Meldung, die an einem einzelnen Feld haengt. Bewusst knapp: sie steht
  // neben dem Feld, nicht allein auf einer Seite.

  'field.required': {
    de: 'Pflichtfeld',
    en: 'Required',
    tr: 'Zorunlu alan' },
  'field.requiredWithManyAccounts': {
    de: 'Pflichtfeld bei mehreren Accounts',
    en: 'Required when there are several accounts',
    tr: 'Birden çok account varsa zorunlu alan' },
  'field.requiredForDerived': {
    de: 'Bei abgeleiteter Rate erforderlich',
    en: 'Required for a derived rate',
    tr: 'Türetilmiş fiyatta zorunlu' },
  'field.headerRequired': {
    de: 'Kopfzeile erforderlich',
    en: 'Header required',
    tr: 'Başlık satırı gerekli' },
  'field.bodyMissing': {
    de: 'Rumpf fehlt',
    en: 'Body missing',
    tr: 'Gövde eksik' },
  'field.invalid': {
    de: 'ungueltig',
    en: 'invalid',
    tr: 'geçersiz' },
  'field.isoDate': {
    de: 'Datum im Format YYYY-MM-DD erwartet',
    en: 'Date in the format YYYY-MM-DD expected',
    tr: 'YYYY-MM-DD biçiminde tarih bekleniyor' },
  'field.isoMonth': {
    de: 'Format YYYY-MM erwartet',
    en: 'Format YYYY-MM expected',
    tr: 'YYYY-MM biçimi bekleniyor' },
  'field.isoTimestamp': {
    de: 'Zeitstempel nach ISO 8601 erwartet',
    en: 'Timestamp in ISO 8601 expected',
    tr: 'ISO 8601 biçiminde zaman damgası bekleniyor' },
  'field.email': {
    de: 'Keine brauchbare Adresse',
    en: 'Not a usable address',
    tr: 'Kullanılabilir bir adres değil' },
  'field.httpsOnly': {
    de: 'Muss mit https:// beginnen. Ohne TLS nur an eine Adresse aus einem '
      + 'freigegebenen Netz, und dann als Adresse, nicht als Name',
    en: 'Must start with https://. Without TLS only to an address in an '
      + 'allowed network, and then as an address, not as a name',
    tr: 'https:// ile başlamalı. TLS olmadan yalnızca izin verilen bir ağdaki '
      + 'adrese, o zaman da ad olarak değil adres olarak' },
  'field.urlMalformed': {
    de: 'Kein lesbarer URL',
    en: 'Not a readable URL',
    tr: 'Okunabilir bir URL değil' },
  'field.urlCredentials': {
    de: 'Keine Zugangsdaten im URL. Die Echtheit belegt die Signatur',
    en: 'No credentials in the URL. The signature proves authenticity',
    tr: "URL'de kimlik bilgisi olmaz. Gerçekliği imza kanıtlar" },
  'field.blockedTarget': {
    de: 'Diese Adresse wird nicht angesprochen: sie liegt in einem privaten, '
      + 'lokalen oder reservierten Netz',
    en: 'This address is not contacted: it is in a private, local or '
      + 'reserved network',
    tr: 'Bu adrese bağlanılmaz: özel, yerel veya ayrılmış bir ağda bulunuyor' },
  'field.integer': {
    de: 'Ganze Zahl erwartet',
    en: 'Whole number expected',
    tr: 'Tam sayı bekleniyor' },
  'field.nonZeroInteger': {
    de: 'Ganze Zahl ungleich null erwartet',
    en: 'A non-zero whole number is expected',
    tr: 'Sıfırdan farklı bir tam sayı bekleniyor' },
  'field.positiveInteger': {
    de: 'Ganze Zahl groesser als null erwartet',
    en: 'Whole number greater than zero expected',
    tr: 'Sıfırdan büyük tam sayı bekleniyor' },
  'field.centAmount': {
    de: 'Ganze Cent-Betraege, nicht negativ',
    en: 'Whole amounts in cents, not negative',
    tr: 'Tam kuruş tutarları, negatif olmamalı' },
  'field.positiveCent': {
    de: 'Muss eine positive Centzahl sein',
    en: 'Must be a positive amount in cents',
    tr: 'Pozitif bir kuruş tutarı olmalı' },
  'field.minTwoChars': {
    de: 'Mindestens zwei Zeichen',
    en: 'At least two characters',
    tr: 'En az iki karakter' },
  'field.maxValue': {
    de: 'Hoechstens {max}',
    en: 'At most {max}',
    tr: 'En fazla {max}' },
  'field.maxLength': {
    de: 'Hoechstens {max} Zeichen',
    en: 'At most {max} characters',
    tr: 'En fazla {max} karakter' },
  'field.requiredForOption': {
    de: 'Eine unverbindliche Reservierung braucht eine Frist. Ohne sie '
      + 'verfaellt sie nie und haelt das Zimmer dauerhaft besetzt.',
    en: 'A provisional reservation needs an expiry. Without one it never '
      + 'lapses and holds the room indefinitely.',
    tr: 'Opsiyonlu bir rezervasyon için son tarih gerekir. Onsuz asla düşmez ve '
      + 'odayı süresiz tutar.' },
  'field.onlyForOption': {
    de: 'Eine Frist gibt es nur bei einer unverbindlichen Reservierung.',
    en: 'An expiry only applies to a provisional reservation.',
    tr: 'Son tarih yalnızca opsiyonlu rezervasyonda geçerlidir.' },
  'field.afterArrival': {
    de: 'Muss nach arrival liegen',
    en: 'Must be after arrival',
    tr: 'arrival tarihinden sonra olmalı' },
  'field.afterFrom': {
    de: 'Muss nach from liegen',
    en: 'Must be after from',
    tr: 'from tarihinden sonra olmalı' },
  'field.afterFromDate': {
    de: 'Muss nach fromDate liegen',
    en: 'Must be after fromDate',
    tr: 'fromDate tarihinden sonra olmalı' },
  'field.onOrAfterFrom': {
    de: 'Muss auf oder nach from liegen',
    en: 'Must be on or after from',
    tr: 'from tarihinde veya sonrasında olmalı' },
  'field.notBeforeFrom': {
    de: 'Darf nicht kleiner als from sein',
    en: 'Must not be smaller than from',
    tr: 'from değerinden küçük olamaz' },
  'field.notAboveMaxLos': {
    de: 'Darf nicht groesser als maxLos sein',
    en: 'Must not be greater than maxLos',
    tr: 'maxLos değerinden büyük olamaz' },
  'field.weekday': {
    de: 'Werte von 0 (Montag) bis 6 (Sonntag)',
    en: 'Values from 0 (Monday) to 6 (Sunday)',
    tr: '0 (Pazartesi) ile 6 (Pazar) arası değerler' },
  'field.weekdayRange': {
    de: 'Zwischen 0 und 6',
    en: 'Between 0 and 6',
    tr: '0 ile 6 arasında' },
  'field.atLeastOneRoom': {
    de: 'Mindestens ein Zimmer',
    en: 'At least one room',
    tr: 'En az bir oda' },
  'field.tooManyRooms': {
    de: 'Hoechstens {max} Zimmer je Buchung. Groessere Gruppen laufen ueber ein '
      + 'Kontingent.',
    en: 'At most {max} rooms per booking. Larger groups go through a block.',
    tr: 'Rezervasyon başına en fazla {max} oda. Daha büyük gruplar kontenjan üzerinden yürür.' },
  'field.stayTooLong': {
    de: 'Hoechstens {max} Naechte je Aufenthalt.',
    en: 'At most {max} nights per stay.',
    tr: 'Konaklama başına en fazla {max} gece.' },
  'field.pinDigits': {
    de: 'Zwischen {min} und {max} Ziffern, nur Ziffern',
    en: 'Between {min} and {max} digits, digits only',
    tr: '{min} ile {max} basamak arasında, yalnızca rakam' },
  'field.duplicateRoom': {
    de: 'Dasselbe Zimmer steht zweimal in der Auswahl',
    en: 'The same room appears twice in the selection',
    tr: 'Aynı oda seçimde iki kez var' },
  'field.eitherPriceOrTotal': {
    de: 'Entweder Preis je Nacht oder Gesamtpreis, nicht beides',
    en: 'Either a price per night or a total, not both',
    tr: 'Ya gecelik fiyat ya da toplam fiyat, ikisi birden değil' },
  'field.eitherCategoryOrRooms': {
    de: 'Entweder eine Zimmergruppe oder eine Zimmerliste',
    en: 'Either a room category or a list of rooms',
    tr: 'Ya bir oda tipi ya da bir oda listesi' },
  'field.atLeastOneScope': {
    de: 'Mindestens ein Zugriffsbereich',
    en: 'At least one scope',
    tr: 'En az bir erişim alanı' },
  'field.roleKeyList': {
    de: 'Liste der Rollenschluessel erwartet',
    en: 'A list of role keys is expected',
    tr: 'Rol anahtarlarının listesi bekleniyor' },
  'field.allowedValues': {
    de: 'Erlaubt: {values}',
    en: 'Allowed: {values}',
    tr: 'İzin verilen: {values}' },
  'field.unknownValues': {
    de: 'Unbekannt: {values}',
    en: 'Unknown: {values}',
    tr: 'Bilinmeyen: {values}' },
  'field.seriesEmpty': {
    de: 'Die Serie ist nach den Auslassungen leer',
    en: 'After the exclusions the series is empty',
    tr: 'Seri, çıkarmalardan sonra boş kalıyor' },
  'field.occupancyPrices': {
    de: 'Preis je Belegung erwartet, Index 0 = 1 Person',
    en: 'A price per occupancy is expected, index 0 = 1 person',
    tr: 'Doluluğa göre fiyat bekleniyor, indeks 0 = 1 kişi' },
  'field.unknownCategory': {
    de: 'Unbekannte Kategorie',
    en: 'Unknown room type',
    tr: 'Bilinmeyen oda tipi' },
  'field.unknownRatePlan': {
    de: 'Unbekannter Ratenplan',
    en: 'Unknown rate plan',
    tr: 'Bilinmeyen fiyat planı' },
  'field.unknownPaymentMethod': {
    de: 'Unbekannte Zahlart',
    en: 'Unknown payment method',
    tr: 'Bilinmeyen ödeme türü' },
  'field.unknownEventType': {
    de: 'Unbekannte Ereignisart: {values}',
    en: 'Unknown event type: {values}',
    tr: 'Bilinmeyen olay türü: {values}' },
  'field.unknownRole': {
    de: 'Unbekannte Rolle: {values}',
    en: 'Unknown role: {values}',
    tr: 'Bilinmeyen rol: {values}' },
  'field.mustMatchBlockCategory': {
    de: 'Muss der Zimmergruppe des Kontingents entsprechen',
    en: 'Must match the room type of the block',
    tr: 'Kontenjanın oda tipiyle aynı olmalı' },
  'field.blockNeedsRoom': {
    de: 'Eine Sperrung braucht ein Zimmer',
    en: 'A block needs a room',
    tr: 'Bir bloke için oda gerekir' },
  'field.onlyRoomcloud': {
    de: 'Nur roomcloud ist bisher angebunden',
    en: 'Only roomcloud is connected so far',
    tr: 'Şimdilik yalnızca roomcloud bağlı' },
  'field.onlyPreviousYear': {
    de: 'Erlaubt ist nur previous-year',
    en: 'Only previous-year is allowed',
    tr: 'Yalnızca previous-year kabul edilir' },
  'field.notAnIncomingPayment': {
    de: 'Der Zahlungsvermerk ist kein Zahlungseingang.',
    en: 'That settlement is not an incoming payment.',
    tr: 'Ödeme kaydı bir tahsilat değil.' },
  'field.originalDocumentNumber': {
    de: 'Belegnummer des Originals',
    en: 'Document number of the original',
    tr: 'Aslın belge numarası' },
  'field.reversalDocumentNumber': {
    de: 'Belegnummer des Stornos',
    en: 'Document number of the reversal',
    tr: 'İptalin belge numarası' },
  'field.noPlatformScopes': {
    de: 'Plattformrechte sind keine Zugriffsbereiche: {values}',
    en: 'Platform permissions are not scopes: {values}',
    tr: 'Platform yetkileri erişim alanı değildir: {values}' },
  // ------------------------------------------------- Zugriff und Anmeldung

  'access.accountOutOfScope': {
    de: 'Account liegt nicht im Zugriffsbereich.',
    en: 'That account is outside your scope.',
    tr: 'Account erişim alanının dışında.' },
  'access.propertyOutOfScope': {
    de: 'Property liegt nicht im Zugriffsbereich.',
    en: 'That property is outside your scope.',
    tr: 'Property erişim alanının dışında.' },
  'access.missingPermission': {
    de: 'Fehlende Berechtigung: {permission}',
    en: 'Missing permission: {permission}',
    tr: 'Eksik yetki: {permission}' },
  'auth.tooManyAttempts': {
    de: 'Zu viele Fehlversuche. Bitte später erneut versuchen.',
    en: 'Too many failed attempts. Please try again later.',
    tr: 'Çok fazla başarısız deneme. Lütfen daha sonra tekrar deneyin.' },
  // Bewusst dieselbe Antwort fuer "Adresse unbekannt" und "Kennwort falsch":
  // eine hilfreichere Meldung waere eine Auskunft darueber, welche Adressen
  // es gibt.
  'auth.badCredentials': {
    de: 'E-Mail oder Kennwort stimmt nicht.',
    en: 'Email or password is not correct.',
    tr: 'E-posta veya parola doğru değil.' },
  'auth.badPin': {
    de: 'E-Mail oder PIN stimmt nicht.',
    en: 'Email or PIN is not correct.',
    tr: 'E-posta veya PIN doğru değil.' },
  // Wer wechselt, muss auch zurueckwechseln koennen -- und das verlangt
  // denselben Nachweis. Ohne eigenen PIN waere der Angemeldete nach dem
  // ersten Wechsel aus seiner eigenen Sitzung ausgesperrt.
  'auth.ownerNeedsPin': {
    de: 'Die angemeldete Person braucht selbst einen Arbeitsplatz-PIN, bevor '
      + 'gewechselt werden kann. Sonst ist der Weg zurueck versperrt.',
    en: 'The signed-in person needs a workstation PIN of their own before '
      + 'switching. Otherwise there is no way back.',
    tr: 'Devretmeden önce oturum açmış kişinin kendisinin bir çalışma yeri PIN\'i olmalıdır. Aksi hâlde geri dönüş yolu kapalıdır.' },
  // Bewusst ohne Unterscheidung zwischen unbekannt, abgelaufen und schon
  // benutzt: jede davon waere eine Auskunft ueber ein Token, das der
  // Aufrufer nicht hat.
  'auth.tokenInvalid': {
    de: 'Der Link ist ungueltig oder abgelaufen. Fordern Sie einen neuen an.',
    en: 'The link is invalid or has expired. Please request a new one.',
    tr: 'Bağlantı geçersiz veya süresi dolmuş. Yeni bir tane isteyin.' },
  'auth.passwordUnchanged': {
    de: 'Das ist Ihr bisheriges Kennwort. Es hat sich nichts geaendert.',
    en: 'That is your current password. Nothing has changed.',
    tr: 'Bu, mevcut parolanız. Hiçbir şey değişmedi.' },
  'auth.emailUnchanged': {
    de: 'Das ist bereits Ihre Adresse.',
    en: 'That is already your address.',
    tr: 'Bu zaten sizin adresiniz.' },
  'auth.emailTaken': {
    de: 'Diese Adresse gehoert bereits zu einem anderen Zugang.',
    en: 'This address already belongs to another account.',
    tr: 'Bu adres zaten başka bir hesaba ait.' },
  'auth.passwordTooShort': {
    de: 'Das Kennwort muss mindestens {min} Zeichen haben.',
    en: 'The password must be at least {min} characters long.',
    tr: 'Parola en az {min} karakter olmalı.' },

  // ------------------------------------------------------------ Onboarding

  'onboarding.emailTaken': {
    de: 'Diese E-Mail-Adresse gehoert bereits zu einem Zugang.',
    en: 'This email address already belongs to an account.',
    tr: 'Bu e-posta adresi zaten bir erişime bağlı.' },
  // Nicht "Feld fehlt": der Grund gehoert dazu, sonst traegt jemand einen
  // Punkt ein und das Haus stellt Rechnungen aus, die nicht gelten.
  'onboarding.invoiceDataRequired': {
    de: 'Anschrift und Steuernummer sind Pflicht: ohne sie darf das Haus nach '
        + '§ 14 UStG keine Rechnung ausstellen.',
    en: 'Address and tax number are required: without them the property may not '
        + 'issue invoices under § 14 UStG.',
    tr: 'Adres ve vergi numarası zorunludur: bunlar olmadan tesis § 14 UStG uyarınca fatura kesemez.' },

  // ----------------------------------------------------------- Ausrollen

  // Der Teilindex laesst nur eine offene Anforderung zu. Das ist kein
  // Gedraenge, sondern der Schutz davor, dass sich zwei Laeufe im selben
  // Verzeichnis die Dateien wegziehen.
  'deploy.alreadyRunning': {
    de: 'Es laeuft bereits ein Ausrollvorgang. Warten Sie, bis er durch ist.',
    en: 'A deployment is already in progress. Please wait until it finishes.',
    tr: 'Halihazırda bir dağıtım sürüyor. Bitmesini bekleyin.' },

  'deploy.unknownRelease': {
    de: 'Dieser Stand ist nicht mehr auf der Maschine. Zurueckgerollt werden kann '
        + 'nur auf einen Stand, der noch dort liegt.',
    en: 'That release is no longer on the machine. You can only roll back to a '
        + 'release that is still there.',
    tr: 'Bu sürüm artık makinede yok. Yalnızca hâlâ orada duran bir sürüme geri dönülebilir.' },
  'deploy.alreadyCurrent': {
    de: 'Dieser Stand laeuft bereits.',
    en: 'That release is already running.',
    tr: 'Bu sürüm zaten çalışıyor.' },

  // ------------------------------------------------------------ Adminpanel

  /*
   * Ein vorhandener Benutzer wird nie nachtraeglich zu Plattformpersonal
   * erhoben -- dieselbe Regel wie im Skript `db:plattformbenutzer`. Ein
   * Tippfehler in der Adresse genuegte sonst, um einem Hotelier Vollzugriff
   * auf die Plattform zu geben.
   */
  'platform.staffExists': {
    de: 'Diese Adresse hat schon einen Zugang. Ein vorhandener Benutzer wird '
        + 'nicht nachtraeglich zu Plattformpersonal gemacht.',
    en: 'That address already has an account. An existing user is never '
        + 'turned into platform staff after the fact.',
    tr: 'Bu adresin zaten bir hesabı var. Mevcut bir kullanıcı sonradan '
        + 'platform personeline dönüştürülmez.' },
  'platform.staffNotFound': {
    de: 'Diesen Plattformbenutzer gibt es nicht.',
    en: 'That platform user does not exist.',
    tr: 'Böyle bir platform kullanıcısı yok.' },
  'platform.staffSelf': {
    de: 'Den eigenen Zugang koennen Sie hier nicht stilllegen.',
    en: 'You cannot disable your own account here.',
    tr: 'Kendi hesabınızı buradan devre dışı bırakamazsınız.' },
  'platform.staffLastAdmin': {
    de: 'Das ist der letzte aktive Plattform-Admin. Legen Sie zuerst einen '
        + 'weiteren an.',
    en: 'That is the last active platform admin. Create another one first.',
    tr: 'Bu, son etkin platform yöneticisidir. Önce bir tane daha oluşturun.' },
  'platform.userNotFound': {
    de: 'Diesen Benutzer gibt es bei diesem Kunden nicht.',
    en: 'That user does not exist at this customer.',
    tr: 'Bu müşteride böyle bir kullanıcı yok.' },
  'platform.userDisabled': {
    de: 'Dieser Zugang ist stillgelegt. Erst freigeben, dann einen Link schicken.',
    en: 'That account is disabled. Enable it first, then send a link.',
    tr: 'Bu hesap devre dışı. Önce etkinleştirin, sonra bağlantı gönderin.' },
  'platform.userExists': {
    de: 'Diese Adresse hat schon einen Zugang. Ein Benutzer, der in zwei '
        + 'Betrieben arbeitet, bekommt seine Rolle vom Kunden selbst.',
    en: 'That address already has an account. A user working at two '
        + 'businesses gets their role from the customer directly.',
    tr: 'Bu adresin zaten bir hesabı var. İki işletmede çalışan bir '
        + 'kullanıcı rolünü doğrudan müşteriden alır.' },
  'platform.propertyCodeTaken': {
    de: 'Dieses Kürzel gibt es bei diesem Kunden schon.',
    en: 'That code already exists at this customer.',
    tr: 'Bu kod bu müşteride zaten var.' },
  'platform.accountNotFound': {
    de: 'Diesen Kunden gibt es nicht.',
    en: 'That customer does not exist.',
    tr: 'Böyle bir müşteri yok.' },

  // -------------------------------------------------------- Support-Sitzung

  'support.unknownSession': {
    de: 'Diese Support-Sitzung gibt es nicht.',
    en: 'This support session does not exist.',
    tr: 'Böyle bir destek oturumu yok.' },
  'support.alreadyGranted': {
    de: 'Diese Sitzung ist bereits freigegeben.',
    en: 'This session has already been approved.',
    tr: 'Bu oturum zaten onaylanmış.' },
  'support.notPending': {
    de: 'Diese Sitzung laesst sich nicht mehr freigeben: sie ist abgelaufen oder '
        + 'widerrufen.',
    en: 'This session can no longer be approved: it has expired or been revoked.',
    tr: 'Bu oturum artık onaylanamaz: süresi dolmuş veya iptal edilmiş.' },
  'support.badLevel': {
    de: 'Unbekannte Stufe. Erlaubt sind lesen und schreiben.',
    en: 'Unknown level. Allowed are read and write.',
    tr: 'Bilinmeyen düzey. İzin verilenler: okuma ve yazma.' },
  'support.badHours': {
    de: 'Die Laufzeit muss zwischen 1 und {max} Stunden liegen.',
    en: 'The duration must be between 1 and {max} hours.',
    tr: 'Süre 1 ile {max} saat arasında olmalı.' },
  'support.reasonRequired': {
    de: 'Ohne Anlass keine Anfrage: der Kunde entscheidet danach.',
    en: 'No request without a reason: the customer decides based on it.',
    tr: 'Gerekçesiz talep olmaz: müşteri buna bakarak karar verir.' },
  // Es gibt niemanden, der die Anfrage sehen und freigeben koennte -- eine
  // Anfrage ins Leere zu stellen waere schlimmer als sie abzuweisen.
  'support.noApprover': {
    de: 'Dieser Account hat niemanden, der eine Support-Sitzung freigeben kann.',
    en: 'This account has nobody who could approve a support session.',
    tr: 'Bu account\'ta destek oturumunu onaylayabilecek kimse yok.' },

  // ----------------------------------------------------------- Uebungshaus

  'training.notPossible': {
    de: '{was} ist fuer ein Schulungshaus nicht moeglich. Uebungsdaten duerfen '
      + 'nicht in die Buchhaltung oder an eine Behoerde gelangen.',
    en: '{was} is not possible for a training property. Practice data must not '
      + 'reach the books or an authority.',
    tr: '{was} bir eğitim tesisi için mümkün değildir. Alıştırma verileri muhasebeye veya bir resmi kuruma ulaşmamalıdır.' },
  // Was ein Uebungshaus nicht darf. Wird in `training.notPossible` eingesetzt.
  'training.what.statistics': {
    de: 'Die Beherbergungsstatistik',
    en: 'The accommodation statistics',
    tr: 'Beherbergungsstatistik (konaklama istatistiği)' },
  'training.what.datev': {
    de: 'Der DATEV-Export',
    en: 'The DATEV export',
    tr: 'DATEV aktarımı' },
  'training.what.gobd': {
    de: 'Der GoBD-Export',
    en: 'The GoBD export',
    tr: 'GoBD aktarımı' },
  'training.what.guestLevy': {
    de: 'Das Gaesteverzeichnis',
    en: 'The guest levy register',
    tr: 'Konaklama katkısı kaydı' },
  'training.noEmail': {
    de: 'Ein Uebungshaus verschickt keine E-Mail. Der Versand bleibt ausgeschaltet.',
    en: 'A training property sends no email. Sending stays switched off.',
    tr: 'Eğitim tesisi e-posta göndermez. Gönderim kapalı kalır.' },

  // ------------------------------------------------- Folio, Rechnung, Geld

  'folio.closed': {
    de: 'Folio ist geschlossen.',
    en: 'The folio is closed.',
    tr: 'Folio kapalı.' },
  'folio.closedNoPosting': {
    de: 'Das Folio ist geschlossen und nimmt nichts mehr auf.',
    en: 'The folio is closed and takes no further postings.',
    tr: 'Folio kapalı ve artık kayıt almıyor.' },
  'folio.nothingOpen': {
    de: 'Keine offenen Positionen.',
    en: 'No open items.',
    tr: 'Açık kalem yok.' },
  'paymentMethod.duplicateCode': {
    de: 'Die Zahlungsart {code} gibt es in diesem Haus schon.',
    en: 'A payment method {code} already exists in this property.',
    tr: '{code} ödeme türü bu tesiste zaten var.' },
  'deposit.needsReservation': {
    de: 'Eine Anzahlungsrechnung braucht die Reservierung des Folios '
      + 'fuer den Leistungszeitraum.',
    en: 'A deposit invoice needs the folio reservation for the service period.',
    tr: 'Bir ön ödeme faturası, hizmet dönemi için folionun rezervasyonunu gerektirir.' },
  'deposit.alreadyInvoiced': {
    de: 'Zu diesem Zahlungsvermerk gibt es bereits eine Anzahlungsrechnung.',
    en: 'There is already a deposit invoice for this settlement.',
    tr: 'Bu ödeme kaydı için zaten bir ön ödeme faturası var.' },
  'deposit.noRatesForSplit': {
    de: 'Zu diesem Aufenthalt sind keine Preise hinterlegt, aus denen sich die '
      + 'Steuersaetze ableiten liessen. Bitte taxRateBp oder lines mitgeben.',
    en: 'This stay has no rates from which tax rates could be derived. Please '
      + 'send taxRateBp or lines.',
    tr: 'Bu konaklama için vergi oranlarının türetilebileceği bir fiyat kaydı yok. Lütfen taxRateBp veya lines gönderin.' },
  'deposit.settlementOnInvoice': {
    de: 'Dieser Zahlungsvermerk steht schon als Zahlung auf Rechnung {number}. '
      + 'Aus ihm laesst sich keine Anzahlungsrechnung mehr machen, sonst waere '
      + 'derselbe Betrag zweimal abgerechnet.',
    en: 'This settlement is already recorded as a payment on invoice {number}. '
      + 'It cannot also become a deposit invoice; the same amount would be '
      + 'billed twice.',
    tr: 'Bu ödeme kaydı {number} numaralı faturada ödeme olarak yer alıyor. Ondan artık ön ödeme faturası çıkarılamaz, yoksa aynı tutar iki kez faturalanmış olur.' },
  'deposit.exceedsServices': {
    de: 'Die angerechnete Anzahlung uebersteigt die abzurechnenden Leistungen um '
      + '{cent} Cent. Das ist eine Rueckzahlung und keine Rechnung; sie ist in '
      + 'diesem System noch nicht vorgesehen.',
    en: 'The applied deposit exceeds the services to be billed by {cent} cents. '
      + 'That is a refund and not an invoice; this system does not provide for '
      + 'it yet.',
    tr: 'Mahsup edilen ön ödeme, faturalanacak hizmetleri {cent} kuruş aşıyor. Bu bir iade olur, fatura değil; bu sistemde henüz öngörülmemiştir.' },
  'invoice.requirementsUnmet': {
    de: 'Die Rechnung erfüllt die Pflichtangaben nicht: {maengel}',
    en: 'The invoice does not meet the mandatory particulars: {maengel}',
    tr: 'Fatura zorunlu bilgileri karşılamıyor: {maengel}' },
  'deposit.requirementsUnmet': {
    de: 'Die Anzahlungsrechnung erfüllt die Pflichtangaben nicht: {maengel}',
    en: 'The deposit invoice does not meet the mandatory particulars: {maengel}',
    tr: 'Ön ödeme faturası zorunlu bilgileri karşılamıyor: {maengel}' },

  // ------------------------------------------------------------ Kontingent

  'block.alreadyStatus': {
    de: 'Kontingent ist bereits {status}.',
    en: 'The block is already {status}.',
    tr: 'Kontenjan zaten {status} durumunda.' },
  'block.notPickable': {
    de: 'Kontingent ist {status} und nicht mehr abrufbar.',
    en: 'The block is {status} and can no longer be picked up.',
    tr: 'Kontenjan {status} durumunda ve artık çekilemez.' },
  'block.fullyPickedUp': {
    de: 'Kontingent ist vollstaendig abgerufen.',
    en: 'The block is fully picked up.',
    tr: 'Kontenjan tamamen çekilmiş.' },
  'block.notEnoughLeft': {
    de: 'Das Kontingent hat nur noch {left} von {quantity} Zimmern frei.',
    en: 'The block has only {left} of {quantity} rooms left.',
    tr: 'Kontenjanda {quantity} odadan yalnızca {left} tanesi boş.' },
  'block.pickupWholePeriod': {
    de: 'Ein Abruf laeuft ueber den ganzen Zeitraum des Kontingents ({from} bis '
      + '{to}). Fuer abweichende Naechte eine eigene Reservierung anlegen.',
    en: 'A pickup runs for the whole period of the block ({from} to {to}). For '
      + 'different nights, create a separate reservation.',
    tr: 'Bir çekim, kontenjanın tüm dönemini kapsar ({from} - {to}). Farklı geceler için ayrı bir rezervasyon oluşturun.' },

  // --------------------------------------------------- Zimmer und Aufenthalt

  'room.inactive': {
    de: 'Zimmer ist stillgelegt.',
    en: 'The room is deactivated.',
    tr: 'Oda devre dışı.' },
  'room.outOfOrder': {
    de: 'Zimmer ist im Zeitraum ausser Betrieb.',
    en: 'The room is out of order during that period.',
    tr: 'Oda bu dönemde arızalı.' },
  'room.occupied': {
    de: 'Zimmer ist im Zeitraum bereits belegt.',
    en: 'The room is already occupied during that period.',
    tr: 'Oda bu dönemde zaten dolu.' },
  'inventory.unknownError': {
    de: 'Unbekannter Inventarfehler: {code}',
    en: 'Unknown inventory error: {code}',
    tr: 'Bilinmeyen envanter hatası: {code}' },
  'stay.pickupNotMovable': {
    de: 'Ein Abruf aus einem Kontingent laesst sich nicht verschieben. '
      + 'Abruf stornieren und frei neu buchen.',
    en: 'A pickup from a block cannot be moved. Cancel the pickup and book again.',
    tr: 'Kontenjandan yapılan bir çekim taşınamaz. Çekimi iptal edip serbestçe yeniden rezerve edin.' },
  'stay.statusHoldsNoInventory': {
    de: 'Eine Reservierung im Zustand {status} bindet kein Kontingent und '
      + 'laesst sich nicht aendern.',
    en: 'A reservation in state {status} holds no inventory and cannot be changed.',
    tr: '{status} durumundaki bir rezervasyon kontenjan bağlamaz ve değiştirilemez.' },
  'stay.inHouseArrivalFixed': {
    de: 'Die Anreise eines Gastes im Haus laesst sich nicht verlegen.',
    en: 'The arrival of a guest in house cannot be moved.',
    tr: 'Tesiste bulunan bir misafirin giriş tarihi değiştirilemez.' },
  'stay.groupNothingToMove': {
    de: 'In dieser Buchung liegt kein Aufenthalt, der sich verschieben laesst',
    en: 'This booking has no stay that can be moved',
    tr: 'Bu kayıtta taşınabilecek bir konaklama yok' },
  'stay.checkinNeedsRoom': {
    de: 'Check-in erfordert ein zugewiesenes Zimmer.',
    en: 'Check-in requires an assigned room.',
    tr: 'Check-in için atanmış bir oda gerekir.' },

  // ---------------------------------------------------------------- Gastpost

  'mail.alreadySent': {
    de: 'Diese Rechnung ist bereits verschickt oder eingereiht. '
      + 'Zum erneuten Versand resend=true angeben.',
    en: 'This invoice has already been sent or queued. To send it again, pass '
      + 'resend=true.',
    tr: 'Bu fatura zaten gönderilmiş veya kuyruğa alınmış. Yeniden göndermek için resend=true verin.' },
  'mail.guestAnonymized': {
    de: 'Der Gast ist anonymisiert. An eine geloeschte Adresse wird nicht versandt.',
    en: 'The guest is anonymized. Nothing is sent to a deleted address.',
    tr: 'Misafir anonimleştirilmiş. Silinmiş bir adrese gönderim yapılmaz.' },
  'mail.noInvoiceAddress': {
    de: 'Zu dieser Rechnung ist keine brauchbare Empfaengeradresse hinterlegt. '
      + 'Adresse am Gast- oder Firmenprofil ergaenzen oder mit to angeben.',
    en: 'This invoice has no usable recipient address. Add one to the guest or '
      + 'company profile, or pass it as to.',
    tr: 'Bu fatura için kullanılabilir bir alıcı adresi yok. Misafir veya firma profiline adres ekleyin ya da to ile belirtin.' },
  'mail.noReservationAddress': {
    de: 'Zu dieser Reservierung ist keine brauchbare Empfaengeradresse hinterlegt.',
    en: 'This reservation has no usable recipient address.',
    tr: 'Bu rezervasyon için kullanılabilir bir alıcı adresi yok.' },
  'mail.onlyUnsentCancellable': {
    de: 'Nur eine noch nicht abgeschickte Nachricht laesst sich zurueckziehen.',
    en: 'Only a message that has not gone out yet can be withdrawn.',
    tr: 'Yalnızca henüz gönderilmemiş bir mesaj geri çekilebilir.' },

  // -------------------------------------------- Absenderdomain der Gastpost

  'domain.alreadyRequested': {
    de: 'Fuer dieses Haus liegt bereits ein Antrag vor. Erst zuruecknehmen, '
      + 'dann neu stellen.',
    en: 'A request already exists for this property. Withdraw it first, then '
      + 'submit a new one.',
    tr: 'Bu tesis için zaten bir başvuru var. Önce geri çekin, sonra yeniden gönderin.' },
  'domain.freemail': {
    de: 'Eine Adresse bei GMX, Web.de oder T-Online laesst sich nicht als '
      + 'Absenderdomain anmelden. Waehlen Sie den Versand ueber {relay}.',
    en: 'An address at GMX, Web.de or T-Online cannot be registered as a '
      + 'sender domain. Choose sending via {relay} instead.',
    tr: 'GMX, Web.de veya T-Online adresi gönderen alan adı olarak kaydedilemez. '
      + '{relay} üzerinden gönderimi seçin.' },
  'domain.taken': {
    de: 'Diese Domain ist bereits fuer ein anderes Haus angemeldet.',
    en: 'This domain is already registered for another property.',
    tr: 'Bu alan adı başka bir tesis için zaten kayıtlı.' },
  'domain.localPartTaken': {
    de: 'Dieser Name ist unter {relay} schon vergeben. Waehlen Sie einen anderen.',
    en: 'This name is already taken under {relay}. Please choose another.',
    tr: '{relay} altında bu ad zaten alınmış. Lütfen başka bir ad seçin.' },
  'domain.notRequested': {
    de: 'Fuer dieses Haus ist keine Absenderdomain beantragt.',
    en: 'No sender domain has been requested for this property.',
    tr: 'Bu tesis için gönderen alan adı başvurusu yok.' },
  'domain.onlyWhilePending': {
    de: 'Nachsehen laesst sich erst, wenn der Antrag freigegeben ist und die '
      + 'DNS-Eintraege vorliegen.',
    en: 'Checking is only possible once the request is approved and the DNS '
      + 'records are available.',
    tr: 'Kontrol ancak başvuru onaylandıktan ve DNS kayıtları hazır olduktan sonra yapılabilir.' },
  'domain.notActive': {
    de: 'Der Versand laesst sich erst einschalten, wenn die Absenderdomain '
      + 'freigeschaltet ist. Sonst landet die Post beim Gast im Werbeordner, '
      + 'ohne dass es jemand merkt.',
    en: 'Sending can only be switched on once the sender domain is active. '
      + 'Otherwise mail lands in the guest\u2019s spam folder unnoticed.',
    tr: 'Gönderim ancak gönderen alan adı etkinleştirildikten sonra açılabilir. '
      + 'Aksi halde posta misafirin istenmeyen klasörüne düşer ve kimse fark etmez.' },
  'domain.senderMismatch': {
    de: 'Die Absenderadresse liegt nicht auf der freigeschalteten Domain {domain}.',
    en: 'The sender address is not on the activated domain {domain}.',
    tr: 'Gönderen adresi etkinleştirilmiş {domain} alan adında değil.' },
  'domain.notDecidable': {
    de: 'Dieser Antrag ist bereits entschieden.',
    en: 'This request has already been decided.',
    tr: 'Bu başvuru zaten karara bağlanmış.' },
  'domain.rejectNeedsNote': {
    de: 'Eine Ablehnung braucht einen Grund. Er geht an den Kunden hinaus.',
    en: 'A rejection needs a reason. It is sent to the customer.',
    tr: 'Ret için bir gerekçe gerekir. Gerekçe müşteriye iletilir.' },
  'domain.providerUnavailable': {
    de: 'Der Versandanbieter hat den Antrag abgewiesen oder war nicht '
      + 'erreichbar. Der Antrag bleibt offen und laesst sich erneut freigeben.',
    en: 'The email provider rejected the request or was unreachable. The '
      + 'request stays open and can be approved again.',
    tr: 'E-posta sağlayıcısı başvuruyu reddetti veya ulaşılamadı. Başvuru açık kalır '
      + 've yeniden onaylanabilir.' },
  'domain.providerNotConfigured': {
    de: 'Der Zugang zum Versandanbieter ist nicht eingerichtet. Ohne ihn '
      + 'laesst sich keine Absenderdomain anmelden.',
    en: 'Access to the email provider is not configured. Without it no sender '
      + 'domain can be registered.',
    tr: 'E-posta sağlayıcısı erişimi yapılandırılmamış. Bu olmadan gönderen alan adı kaydedilemez.' },
  'domain.relayNotConfigured': {
    de: 'Der Versand ueber eine Unterdomain der Plattform ist nicht '
      + 'eingerichtet.',
    en: 'Sending via a platform subdomain is not configured.',
    tr: 'Platform alt alan adı üzerinden gönderim yapılandırılmamış.' },

  // -------------------------------------------------------------------- Gast

  'guest.anonymizedNotRevived': {
    de: 'Ein anonymisiertes Profil wird nicht wiederbelebt.',
    en: 'An anonymized profile is not revived.',
    tr: 'Anonimleştirilmiş bir profil geri getirilmez.' },
  'guest.levyRetentionRunning': {
    de: 'Fuer diesen Gast laeuft noch die Aufbewahrung des '
      + 'Gaestebeitragsnachweises bis zum {until}. Bis dahin ist die '
      + 'Aufbewahrung eine rechtliche Verpflichtung (Art. 17 Abs. 3 lit. b '
      + 'DSGVO).',
    en: 'The retention of the guest levy record for this guest runs until '
      + '{until}. Until then keeping it is a legal obligation (Art. 17(3)(b) '
      + 'GDPR).',
    tr: 'Bu misafir için konaklama katkısı kaydının saklama süresi {until} '
      + 'tarihine kadar devam ediyor. O tarihe kadar saklama yasal bir '
      + 'yükümlülüktür (GDPR Md. 17(3)(b)).' },
  'guest.hasOpenReservations': {
    de: 'Es gibt noch offene oder laufende Reservierungen fuer diesen Gast.',
    en: 'There are still open or current reservations for this guest.',
    tr: 'Bu misafir için hâlâ açık veya süren rezervasyonlar var.' },

  // -------------------------------------------------------------- Meldeschein

  'reservation.guestFixedAfterCheckIn': {
    de: 'Der Gast laesst sich nach dem Check-in nicht mehr wechseln (Zustand '
      + '{status}). Der Meldeschein ist eine Erklaerung dieser Person ueber '
      + 'sich selbst.',
    en: 'The guest can no longer be changed after check-in (status {status}). '
      + 'The registration form is that person\u2019s own declaration.',
    tr: 'Misafir, check-in sonrasında değiştirilemez (durum: {status}). '
      + 'Meldeschein, o kişinin kendisi hakkında verdiği beyandır.' },
  'reservation.guestFixedAfterInvoice': {
    de: 'Zu dieser Reservierung ist bereits fakturiert. Der Rechnungsempfaenger '
      + 'steht auf einem Beleg und wird nicht nachtraeglich umgeschrieben.',
    en: 'This reservation has already been invoiced. The invoice recipient is on '
      + 'a document and is not rewritten afterwards.',
    tr: 'Bu rezervasyon için fatura zaten düzenlendi. Fatura alıcısı bir belgede '
      + 'yer alır ve sonradan değiştirilmez.' },
  // ------------------------------------------------------ Hausbedingungen
  'terms.signatureRequired': {
    de: 'Diese Bedingung verlangt eine Unterschrift.',
    en: 'These terms require a signature.',
    tr: 'Bu koşullar imza gerektirir.' },
  'terms.alreadyAgreed': {
    de: 'Dieser Aufenthalt hat der Bedingung bereits zugestimmt.',
    en: 'This stay has already agreed to these terms.',
    tr: 'Bu konaklama için koşullar zaten kabul edilmiş.' },

  'registration.noPrimaryGuest': {
    de: 'Die Reservierung hat keinen Hauptgast. Meldeschein nicht moeglich.',
    en: 'The reservation has no primary guest. No registration form is possible.',
    tr: 'Rezervasyonun ana misafiri yok. Meldeschein düzenlenemez.' },
  'registration.alreadyExists': {
    de: 'Fuer diese Reservierung liegt bereits ein Meldeschein vor.',
    en: 'A registration form already exists for this reservation.',
    tr: 'Bu rezervasyon için zaten bir Meldeschein var.' },
  // Seit dem 1.1.2025 unterschreiben nur noch auslaendische Gaeste.
  'registration.signatureRequired': {
    de: 'Fuer auslaendische Gaeste ist die Unterschrift nach § 30 BMG erforderlich.',
    en: 'For foreign guests the signature is required under § 30 BMG.',
    tr: 'Yabancı misafirler için § 30 BMG uyarınca imza zorunludur.' },
  'registration.signatureNotForeseen': {
    de: 'Fuer inlaendische Gaeste ist seit dem 1.1.2025 keine Unterschrift vorgesehen.',
    en: 'For domestic guests no signature has been foreseen since 1 January 2025.',
    tr: 'Yurt içinde ikamet eden misafirler için 1.1.2025 tarihinden beri imza öngörülmemiştir.' },
  'registration.alreadySigned': {
    de: 'Der Meldeschein ist bereits unterschrieben.',
    en: 'The registration form is already signed.',
    tr: 'Meldeschein zaten imzalanmış.' },

  // -------------------------------------------------------- Kasse und Kanal

  'pos.roomUnknown': {
    de: 'Zimmer {room} gibt es in diesem Haus nicht.',
    en: 'There is no room {room} in this property.',
    tr: '{room} numaralı oda bu tesiste yok.' },
  'pos.nobodyCheckedIn': {
    de: 'Auf Zimmer {room} ist niemand angereist. Fehlt der Check-in?',
    en: 'Nobody has checked in to room {room}. Is the check-in missing?',
    tr: '{room} numaralı odaya kimse giriş yapmamış. Check-in eksik mi?' },
  'pos.productUnknown': {
    de: 'Artikel {product} ist in diesem Haus nicht eingerichtet. Er braucht ein '
      + 'Erloeskonto und einen Steuersatz, bevor die Kasse darauf buchen kann.',
    en: 'Product {product} is not set up in this property. It needs a revenue '
      + 'account and a tax rate before the POS can post to it.',
    tr: '{product} ürünü bu tesiste tanımlı değil. Kasanın ona kayıt yapabilmesi için bir gelir hesabı ve bir vergi oranı gerekir.' },
  'pos.productNoTaxRate': {
    de: 'Fuer {product} ist kein Steuersatz hinterlegt. Entweder am Artikel '
      + 'einrichten oder als taxRateBp mitschicken.',
    en: 'No tax rate is stored for {product}. Either set it up on the product or '
      + 'pass it as taxRateBp.',
    tr: '{product} için vergi oranı tanımlı değil. Ya üründe tanımlayın ya da taxRateBp olarak gönderin.' },
  'pos.severalGuestsInRoom': {
    de: 'Auf Zimmer {room} sind mehrere Gaeste angereist. Bitte folioRef '
      + 'mitschicken: {folios}',
    en: 'Several guests have checked in to room {room}. Please pass folioRef: '
      + '{folios}',
    tr: '{room} numaralı odaya birden çok misafir giriş yapmış. Lütfen folioRef gönderin: {folios}' },
  'channel.referenceInFlight': {
    de: 'Externe Nummer ist bereits in Bearbeitung. Bitte spaeter erneut zustellen.',
    en: 'That external reference is being processed. Please deliver again later.',
    tr: 'Dış numara halihazırda işleniyor. Lütfen daha sonra tekrar iletin.' },

  // ---------------------------------------------- Raten, Einrichtung, Rollen

  'rate.derivationCycle': {
    de: 'Die Ableitungskette enthaelt einen Zyklus.',
    en: 'The derivation chain contains a cycle.',
    tr: 'Türetme zinciri bir döngü içeriyor.' },
  'setup.onlyNightUnit': {
    de: 'Andere Zeiteinheiten als die Nacht sind noch nicht freigeschaltet.',
    en: 'Time units other than the night are not enabled yet.',
    tr: 'Gece dışındaki zaman birimleri henüz açılmadı.' },
  'setup.duplicateCategoryCode': {
    de: 'Eine Zimmergruppe mit dem Kürzel {code} gibt es schon.',
    en: 'A room type with the code {code} already exists.',
    tr: '{code} kodlu bir oda tipi zaten var.' },
  'setup.duplicateRoomCode': {
    de: 'Die Nummer {code} ist im Haus schon vergeben.',
    en: 'The number {code} is already taken in this property.',
    tr: '{code} numarası tesiste zaten kullanılıyor.' },
  'setup.categoryHasFutureReservations': {
    de: 'Die Gruppe hat noch {count} künftige Reservierungen. '
      + 'Erst umbuchen, dann stilllegen.',
    en: 'The room type still has {count} future reservations. Move them first, '
      + 'then deactivate.',
    tr: 'Bu tipte hâlâ {count} gelecek rezervasyon var. Önce aktarın, sonra devre dışı bırakın.' },
  'setup.roomHasFutureReservations': {
    de: 'Auf dem Zimmer liegen noch künftige Reservierungen: {reservations}. '
      + 'Erst umbuchen, dann stilllegen.',
    en: 'The room still carries future reservations: {reservations}. Move them '
      + 'first, then deactivate.',
    tr: 'Odada hâlâ gelecek rezervasyonlar var: {reservations}. Önce aktarın, sonra devre dışı bırakın.' },
  'report.noOpenBusinessDay': {
    de: 'Fuer die Property ist kein Tag geoeffnet.',
    en: 'No business day is open for this property.',
    tr: 'Property için açık bir gün yok.' },
  /*
   * Selbstverwaltung des Kunden (0040). Die Saetze richten sich an eine
   * Hausleitung, nicht an uns -- sie sagen, was zu tun ist, nicht was
   * intern schiefging.
   */
  'user.emailTaken': {
    de: 'Diese Adresse hat schon einen Zugang. Gehört die Person zu Ihrem '
        + 'Betrieb, ändern Sie ihre Rollen statt sie neu anzulegen.',
    en: 'That address already has an account. If the person belongs to your '
        + 'business, change their roles instead of creating them again.',
    tr: 'Bu adresin zaten bir hesabı var. Kişi işletmenize aitse yeniden '
        + 'oluşturmak yerine rollerini değiştirin.' },
  'user.notYourself': {
    de: 'Den eigenen Zugang können Sie hier nicht sperren oder entfernen.',
    en: 'You cannot block or remove your own account here.',
    tr: 'Kendi hesabınızı buradan engelleyemez veya kaldıramazsınız.' },
  'user.accountRoleNeedsAccountRight': {
    de: 'Diese Person hat eine Rolle für den ganzen Betrieb. Das darf nur '
        + 'ändern, wer die Betriebseinstellungen verwaltet.',
    en: 'This person holds a role for the whole business. Only someone who '
        + 'manages the business settings may change that.',
    tr: 'Bu kişinin tüm işletme için bir rolü var. Bunu yalnızca işletme '
        + 'ayarlarını yöneten biri değiştirebilir.' },
  'user.lastAccountAdmin': {
    de: 'Das ist die letzte Person, die den Betrieb verwalten kann. Geben Sie '
        + 'das Recht zuerst jemand anderem.',
    en: 'That is the last person who can manage the business. Give that '
        + 'right to someone else first.',
    tr: 'Bu, işletmeyi yönetebilen son kişidir. Önce bu yetkiyi başka birine '
        + 'verin.' },
  'user.blocked': {
    de: 'Diese Person ist bei Ihnen gesperrt. Erst entsperren, dann einen '
        + 'Link schicken.',
    en: 'This person is blocked at your business. Unblock first, then send a '
        + 'link.',
    tr: 'Bu kişi işletmenizde engelli. Önce engeli kaldırın, sonra bağlantı '
        + 'gönderin.' },
  'user.wouldLockYourselfOut': {
    de: 'Damit naehmen Sie sich selbst das Recht, Rollen zu vergeben. '
      + 'Lassen Sie das jemand anderen tun.',
    en: 'That would take away your own right to assign roles. Let somebody else '
      + 'do it.',
    tr: 'Bununla rol verme yetkinizi kendinizden almış olursunuz. Bunu başkası yapsın.' },
  'payments.stripeKeyMissing': {
    de: 'STRIPE_SECRET_KEY ist nicht gesetzt.',
    en: 'STRIPE_SECRET_KEY is not set.',
    tr: 'STRIPE_SECRET_KEY tanımlı değil.' },
  'payments.stripeWebhookSecretMissing': {
    de: 'STRIPE_WEBHOOK_SECRET ist nicht gesetzt.',
    en: 'STRIPE_WEBHOOK_SECRET is not set.',
    tr: 'STRIPE_WEBHOOK_SECRET tanımlı değil.' },

  // ------------------------------------------------ Hinweise in Antworten
  //
  // Saetze, die neben einer Antwort stehen und eine Erwartung geraderuecken.
  // Sie gehen denselben Weg wie eine Fehlermeldung: die Antwort traegt den
  // deutschen Satz **und** den Schluessel.

  // ---------------------------------------------- Auskunft nach Art. 15
  //
  // Die Angaben nach Abs. 1 lit. a bis h. Sie gehoeren als fester Kopf an
  // jede Auskunft: Daten allein sind keine Auskunft im Sinne der Norm
  // (Befund 6, Dokument 26). Sie stehen hier und nicht im Code, weil ein
  // Gast sie in seiner Sprache lesen soll.

  'zwecke.beherbergung': {
    de: 'Abwicklung des Beherbergungsvertrags: Reservierung, Aufenthalt, '
      + 'Abrechnung sowie die gesetzlichen Melde- und Aufbewahrungspflichten.',
    en: 'Performance of the accommodation contract: reservation, stay, billing, '
      + 'and the statutory registration and retention duties.',
    tr: 'Konaklama sözleşmesinin yürütülmesi: rezervasyon, konaklama, '
      + 'faturalandırma ve yasal bildirim ile saklama yükümlülükleri.' },
  'kategorien.gast': {
    de: 'Stammdaten, Kontaktdaten, Aufenthaltsdaten, Rechnungsdaten, '
      + 'Meldedaten und was die Rezeption als Hausnotiz erfasst hat.',
    en: 'Master data, contact details, stay data, billing data, registration '
      + 'data, and whatever the front desk recorded as a property note.',
    tr: 'Ana veriler, iletişim bilgileri, konaklama verileri, fatura verileri, '
      + 'bildirim verileri ve resepsiyonun tesis notu olarak kaydettikleri.' },
  'empfaenger.gast': {
    de: 'Das Haus selbst, sein Zahlungsdienstleister, sein Versanddienst fuer '
      + 'Gastpost, und bei gesetzlicher Pflicht die Meldebehoerde und das '
      + 'Statistische Landesamt. Kartendaten werden nie gespeichert.',
    en: 'The property itself, its payment provider, its delivery service for '
      + 'guest mail, and where required by law the registration authority and '
      + 'the statistical office. Card details are never stored.',
    tr: 'Tesisin kendisi, ödeme sağlayıcısı, misafir yazışması için gönderim '
      + 'hizmeti ve yasal zorunluluk hâlinde nüfus idaresi ile istatistik '
      + 'kurumu. Kart bilgileri asla saklanmaz.' },
  'speicherdauer.gast': {
    de: 'Der Meldeschein wird nach der gesetzlichen Frist vernichtet, '
      + 'Rechnungen unterliegen der steuerlichen Aufbewahrungsfrist, das '
      + 'Profil wird auf Verlangen anonymisiert, sobald keine Frist entgegensteht.',
    en: 'The registration form is destroyed after the statutory period, invoices '
      + 'are subject to the tax retention period, and the profile is anonymised '
      + 'on request as soon as no retention period stands in the way.',
    tr: 'Meldeschein yasal sürenin ardından imha edilir, faturalar vergisel '
      + 'saklama süresine tabidir, profil ise talep hâlinde, önünde bir süre '
      + 'kalmadığı anda anonimleştirilir.' },
  'rechte.betroffene': {
    de: 'Auskunft, Berichtigung, Loeschung, Einschraenkung, Datenuebertragbarkeit, '
      + 'Widerspruch, und das Recht auf Beschwerde bei einer Aufsichtsbehoerde.',
    en: 'Access, rectification, erasure, restriction, data portability, objection, '
      + 'and the right to lodge a complaint with a supervisory authority.',
    tr: 'Bilgi edinme, düzeltme, silme, kısıtlama, veri taşınabilirliği, itiraz '
      + 've bir denetim makamına şikâyette bulunma hakkı.' },
  'herkunft.gast': {
    de: 'Vom Gast selbst, aus seiner Buchung, oder von dem Portal, ueber das '
      + 'er gebucht hat.',
    en: 'From the guest, from their booking, or from the portal they booked through.',
    tr: 'Misafirin kendisinden, rezervasyonundan veya rezervasyonu yaptığı '
      + 'portaldan.' },

  'hint.noteNoHealthData': {
    de: 'Eine Hausnotiz haelt eine Anforderung fest, nicht ihren Grund: '
      + '"barrierefreies Zimmer" gehoert hierher, die Diagnose dahinter nicht. '
      + 'Gesundheitsdaten stehen nach Art. 9 DSGVO unter einer deutlich '
      + 'hoeheren Schwelle als der Rest dieses Profils.',
    en: 'A property note records a requirement, not its reason: "step-free room" '
      + 'belongs here, the diagnosis behind it does not. Health data is held to a '
      + 'far higher standard under Art. 9 GDPR than the rest of this profile.',
    tr: 'Tesis notu bir gereksinimi kaydeder, nedenini değil: "engelsiz oda" '
      + 'buraya aittir, arkasındaki teşhis ait değildir. Sağlık verileri DSGVO '
      + 'Madde 9 uyarınca bu profilin geri kalanından çok daha yüksek bir '
      + 'eşiğe tabidir.' },
  'hint.settlementIsNotPayment': {
    de: 'Ein Zahlungsvermerk ordnet zu, er wickelt nicht ab. Die Zahlung selbst '
      + 'laeuft ueber Kasse, Portal oder Bank des Betriebs.',
    en: 'A settlement records where money was taken; it does not process it. The '
      + 'payment itself runs through the till, the portal or the bank.',
    tr: 'Ödeme kaydı yalnızca eşleştirir, tahsilatı kendisi yapmaz. Ödemenin kendisi kasa, portal veya işletmenin bankası üzerinden yürür.' },
  'hint.invoiceRetention': {
    de: 'Rechnungen unterliegen der steuerlichen Aufbewahrungsfrist und werden '
      + 'bei einer Loeschung nicht entfernt.',
    en: 'Invoices are subject to the statutory retention period and are not '
      + 'removed when a profile is deleted.',
    tr: 'Faturalar vergisel saklama süresine tabidir ve silme işleminde kaldırılmaz.' },
  'hint.statisticsSubmission': {
    de: 'Uebermittlung an das Statistische Landesamt ueber eSTATISTIK.core. '
      + 'Land XX bedeutet: kein Wohnsitzland erfasst.',
    en: 'Submission to the statistical office via eSTATISTIK.core. Country XX '
      + 'means no country of residence was recorded.',
    tr: 'eSTATISTIK.core üzerinden Statistisches Landesamt\'a iletim. XX ülkesi şu demektir: ikamet ülkesi kaydedilmemiş.' },
  'hint.webhookSecretOnce': {
    de: 'Der Schluessel wird nur hier einmal ausgegeben. Signatur: HMAC-SHA256 '
      + 'ueber "Zeitstempel.Rumpf".',
    en: 'The key is handed out here once and never again. Signature: HMAC-SHA256 '
      + 'over "timestamp.body".',
    tr: 'Anahtar yalnızca burada bir kez gösterilir. İmza: "zaman damgası.gövde" üzerinden HMAC-SHA256.' },
  'hint.oauthSecretOnce': {
    de: 'Das Geheimnis wird nur hier einmal ausgegeben. Token holen: POST '
      + '/oauth/token mit grant_type=client_credentials.',
    en: 'The secret is handed out here once and never again. Get a token: POST '
      + '/oauth/token with grant_type=client_credentials.',
    tr: 'Gizli anahtar yalnızca burada bir kez gösterilir. Token almak için: POST /oauth/token, grant_type=client_credentials.' },
  'hint.occupancyNotCapacity': {
    de: 'Die Belegungszahl wirkt auf Preise und Meldeschein, nicht auf die Kapazität.',
    en: 'Occupancy affects prices and the registration form, not capacity.',
    tr: 'Doluluk sayısı fiyatları ve Meldeschein\'i etkiler, kapasiteyi değil.' },
  'hint.legacyFormatsUnverified': {
    de: 'Keines dieser drei Formate ist eine veroeffentlichte Spezifikation '
      + '(Dokument 05, Abschnitt 6). Vor dem ersten echten Kunden gegen eine '
      + 'tatsaechliche Exportdatei pruefen.',
    en: 'None of these three formats is a published specification (document 05, '
      + 'section 6). Check against a real export file before the first real '
      + 'customer.',
    tr: 'Bu üç biçimin hiçbiri yayımlanmış bir şartname değildir (Belge 05, Bölüm 6). İlk gerçek müşteriden önce gerçek bir aktarım dosyasıyla doğrulayın.' },

  // ------------------------------------------------------- Einrichtungsstand

  'setup.step.categories': {
    de: 'Zimmergruppen angelegt',
    en: 'Room types created',
    tr: 'Oda tipleri oluşturuldu' },
  'setup.step.categories.hint': {
    de: 'Mindestens eine Gruppe, etwa Doppelzimmer oder Ferienwohnung.',
    en: 'At least one type, such as a double room or a holiday flat.',
    tr: 'En az bir tip, örneğin çift kişilik oda veya apart daire.' },
  'setup.step.rooms': {
    de: 'Zimmer angelegt',
    en: 'Rooms created',
    tr: 'Odalar oluşturuldu' },
  'setup.step.rooms.hint': {
    de: 'Am schnellsten als Serie: Nummernbereich und Etage angeben.',
    en: 'Fastest as a series: give a number range and a floor.',
    tr: 'En hızlısı seri olarak: numara aralığı ve kat verin.' },
  'setup.step.inventory': {
    de: 'Inventar materialisiert',
    en: 'Inventory materialized',
    tr: 'Envanter hazırlandı' },
  'setup.step.inventory.hint.missing': {
    de: 'Ohne materialisierten Zeitraum weist jede Buchung ab. Der Worker legt '
      + 'ihn an, oder einmal von Hand anstoßen.',
    en: 'Without a materialized period every booking is refused. The worker '
      + 'creates it, or trigger it once by hand.',
    tr: 'Hazırlanmış bir dönem olmadan her rezervasyon reddedilir. Worker bunu oluşturur veya bir kez elle başlatın.' },
  'setup.step.inventory.hint.until': {
    de: 'Belegbar bis {date}.',
    en: 'Bookable until {date}.',
    tr: '{date} tarihine kadar rezerve edilebilir.' },
  'setup.step.tax_rules': {
    de: 'Steuersätze hinterlegt',
    en: 'Tax rates stored',
    tr: 'Vergi oranları tanımlandı' },
  'setup.step.tax_rules.hint': {
    de: 'Ohne Regel bucht der Nachtlauf Logis mit 7 Prozent.',
    en: 'Without a rule the night audit posts accommodation at 7 percent.',
    tr: 'Kural olmadan gece işlemi konaklamayı yüzde 7 ile kaydeder.' },
  'setup.step.rate_plans': {
    de: 'Ratenpläne angelegt',
    en: 'Rate plans created',
    tr: 'Fiyat planları oluşturuldu' },
  'setup.step.rate_plans.hint': {
    de: 'Je Gruppe mindestens eine Basisrate.',
    en: 'At least one base rate per type.',
    tr: 'Her tip için en az bir temel fiyat.' },
  'setup.step.prices': {
    de: 'Preise gepflegt',
    en: 'Prices maintained',
    tr: 'Fiyatlar işlendi' },
  'setup.step.prices.hint': {
    de: 'Ohne Preise werden Reservierungen mit 0 Cent gebucht.',
    en: 'Without prices, reservations are booked at 0 cents.',
    tr: 'Fiyat olmadan rezervasyonlar 0 kuruş ile kaydedilir.' },
  'setup.step.payment_methods': {
    de: 'Zahlungsarten angelegt',
    en: 'Payment methods created',
    tr: 'Ödeme türleri oluşturuldu' },
  'setup.step.payment_methods.hint': {
    de: 'Nur zur Zuordnung. Die Zahlung selbst läuft außerhalb dieses Systems.',
    en: 'For assignment only. The payment itself runs outside this system.',
    tr: 'Yalnızca eşleştirme içindir. Ödemenin kendisi bu sistemin dışında yürür.' },
  'setup.step.business_day': {
    de: 'Geschäftstag geöffnet',
    en: 'Business day open',
    tr: 'İşletme günü açıldı' },
  'setup.step.business_day.hint.missing': {
    de: 'Ohne offenen Tag läuft kein Nachtlauf.',
    en: 'Without an open day no night audit runs.',
    tr: 'Açık gün olmadan gece işlemi çalışmaz.' },
  'setup.step.business_day.hint.since': {
    de: 'Offen seit {date}.',
    en: 'Open since {date}.',
    tr: '{date} tarihinden beri açık.' },

  'field.depositPartsMismatch': {
    de: 'Die Teile ergeben {sum} Cent, vereinnahmt sind {received} Cent.',
    en: 'The parts add up to {sum} cents, {received} cents were received.',
    tr: 'Parçalar {sum} kuruş ediyor, tahsil edilen {received} kuruş.' },

  'webhookError.timeout': {
    de: 'Der Empfaenger hat nicht rechtzeitig geantwortet',
    en: 'The receiver did not answer in time',
    tr: 'Alıcı zamanında yanıt vermedi' },
  'webhookError.dns': {
    de: 'Der Name des Empfaengers liess sich nicht aufloesen',
    en: 'The receiver name could not be resolved',
    tr: 'Alıcının adı çözümlenemedi' },
  'webhookError.refused': {
    de: 'Der Empfaenger hat die Verbindung abgelehnt',
    en: 'The receiver refused the connection',
    tr: 'Alıcı bağlantıyı reddetti' },
  'webhookError.unreachable': {
    de: 'Der Empfaenger war nicht erreichbar',
    en: 'The receiver was unreachable',
    tr: 'Alıcıya ulaşılamadı' },
  'webhookError.reset': {
    de: 'Der Empfaenger hat die Verbindung abgebrochen',
    en: 'The receiver dropped the connection',
    tr: 'Alıcı bağlantıyı kesti' },
  'webhookError.tls': {
    de: 'Die gesicherte Verbindung kam nicht zustande. Zertifikat pruefen',
    en: 'The secured connection failed. Check the certificate',
    tr: 'Güvenli bağlantı kurulamadı. Sertifikayı denetleyin' },
  'webhookError.blockedTarget': {
    de: 'Das Ziel wird nicht angesprochen. Es liegt in einem privaten, '
      + 'lokalen oder reservierten Netz oder ist kein brauchbares '
      + 'https-Ziel. Abonnement mit einem anderen Ziel neu anlegen',
    en: 'The target is not contacted. It is in a private, local or reserved '
      + 'network, or it is not a usable https target. Create the '
      + 'subscription anew with a different target',
    tr: 'Hedefe bağlanılmaz. Özel, yerel veya ayrılmış bir ağda bulunuyor ya '
      + 'da kullanılabilir bir https hedefi değil. Aboneliği başka bir '
      + 'hedefle yeniden oluşturun' },
  'webhookError.httpStatus': {
    de: 'Der Empfaenger hat die Zustellung abgelehnt',
    en: 'The receiver rejected the delivery',
    tr: 'Alıcı iletimi reddetti' },
  'webhookError.other': {
    de: 'Die Zustellung ist gescheitert',
    en: 'The delivery failed',
    tr: 'İletim başarısız oldu' }
} as const satisfies Record<string, LocalizedText>

export type MessageKey = keyof typeof M
export type MessageParams = Record<string, string | number>

/** Alle Schluessel. Ein Test prueft damit, dass die Quelle keine erfindet. */
export const MESSAGE_KEYS = Object.keys(M) as MessageKey[]

export function isMessageKey(v: string): v is MessageKey {
  return Object.prototype.hasOwnProperty.call(M, v)
}

/**
 * Eine Meldung in einer Sprache, mit eingesetzten Werten.
 *
 * Ein unbekannter Schluessel kommt unveraendert zurueck. Das ist Absicht:
 * waehrend der Umstellung stehen an manchen Stellen noch deutsche Saetze
 * statt Schluesseln, und eine leere Fehlermeldung waere schlimmer als eine
 * einsprachige.
 */
export function renderMessage(
  key: string, locale: MessageLocale, params?: MessageParams
): string {
  const eintrag = isMessageKey(key) ? M[key] : null
  const text = eintrag === null ? key : eintrag[locale]
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (ganz, name: string) =>
    // Ein Platzhalter ohne Wert bleibt stehen. Ihn durch nichts zu ersetzen
    // ergaebe einen Satz mit einem Loch, den niemand als Fehler erkennt.
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : ganz)
}
