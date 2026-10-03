import type { LocalizedText } from '@hotelpms/contracts'

/** Erste Schritte: der Assistent fuer ein leeres Haus. */
export const ersteSchritte = {
  'first.title': {
    de: 'Willkommen bei StayGrid',
    en: 'Welcome to StayGrid',
    tr: 'StayGrid’e hoş geldiniz' },
  'first.stepRooms': {
    de: '1. Zimmer',
    en: '1. Rooms',
    tr: '1. Odalar' },
  'first.stepPrices': {
    de: '2. Preise',
    en: '2. Prices',
    tr: '2. Fiyatlar' },
  'first.stepCheck': {
    de: '3. Prüfen',
    en: '3. Review',
    tr: '3. Kontrol' },
  'first.stepDone': {
    de: 'Fertig',
    en: 'Done',
    tr: 'Tamam' },
  'first.intro': {
    de: 'Ihr Haus ist noch leer. In drei Schritten legen wir Ihre Zimmerarten, '
      + 'die Zimmer und einen Grundpreis an, damit Sie gleich buchen können. '
      + 'Alles lässt sich danach in der Einrichtung und im Preisraster ändern.',
    en: 'Your property is still empty. In three steps we create your room types, '
      + 'the rooms and a base price so you can start taking bookings right away. '
      + 'Everything can be changed later in the setup and the rate grid.',
    tr: 'Tesisiniz henüz boş. Üç adımda oda tiplerinizi, odaları ve bir temel '
      + 'fiyatı oluşturuyoruz, böylece hemen rezervasyon alabilirsiniz. Her şey '
      + 'daha sonra kurulumda ve fiyat tablosunda değiştirilebilir.' },
  'first.importHint': {
    de: 'Sie wechseln von einem anderen Programm? Dann bringen Sie Zimmer, Gäste '
      + 'und Reservierungen mit, statt sie hier neu anzulegen.',
    en: 'Switching from another system? Bring your rooms, guests and reservations '
      + 'along instead of creating them again here.',
    tr: 'Başka bir programdan mı geçiyorsunuz? Odaları, misafirleri ve '
      + 'rezervasyonları burada yeniden oluşturmak yerine yanınızda getirin.' },
  'first.importButton': {
    de: 'Daten übernehmen',
    en: 'Import data',
    tr: 'Verileri aktar' },
  'first.roomsTitle': {
    de: 'Welche Zimmer hat Ihr Haus?',
    en: 'Which rooms does your property have?',
    tr: 'Tesisinizde hangi odalar var?' },
  'first.roomsHint': {
    de: 'Eine Zeile je Zimmerart. Die Nummern werden fortlaufend vergeben, '
      + 'etwa 101, 102, 103.',
    en: 'One row per room type. Numbers are assigned consecutively, '
      + 'for example 101, 102, 103.',
    tr: 'Her oda tipi için bir satır. Numaralar sırayla verilir, '
      + 'örneğin 101, 102, 103.' },
  'first.code': {
    de: 'Kürzel',
    en: 'Code',
    tr: 'Kod' },
  'first.name': {
    de: 'Bezeichnung',
    en: 'Name',
    tr: 'Ad' },
  'first.persons': {
    de: 'Personen',
    en: 'Guests',
    tr: 'Kişi' },
  'first.count': {
    de: 'Anzahl',
    en: 'Count',
    tr: 'Adet' },
  'first.from': {
    de: 'Nummern ab',
    en: 'Numbers from',
    tr: 'Numara başlangıcı' },
  'first.prefix': {
    de: 'Vorsatz',
    en: 'Prefix',
    tr: 'Ön ek' },
  'first.addRow': {
    de: 'Weitere Zimmerart',
    en: 'Add room type',
    tr: 'Oda tipi ekle' },
  'first.removeRow': {
    de: 'Zeile entfernen',
    en: 'Remove row',
    tr: 'Satırı kaldır' },
  'first.rowIncomplete': {
    de: 'Bitte jede Zeile vollständig ausfüllen.',
    en: 'Please complete every row.',
    tr: 'Lütfen her satırı eksiksiz doldurun.' },
  'first.pricesTitle': {
    de: 'Was kostet eine Nacht?',
    en: 'What does a night cost?',
    tr: 'Bir gece ne kadar?' },
  'first.pricesHint': {
    de: 'Ein Grundpreis je Zimmerart, für die nächsten zwölf Monate. Saisonpreise, '
      + 'Wochenenden und Raten mit Frühstück kommen danach im Preisraster dazu. '
      + 'Ein leeres Feld legt für diese Zimmerart keine Rate an.',
    en: 'One base price per room type for the next twelve months. Seasonal prices, '
      + 'weekends and rates with breakfast are added afterwards in the rate grid. '
      + 'An empty field creates no rate for that room type.',
    tr: 'Önümüzdeki on iki ay için her oda tipine bir temel fiyat. Sezon fiyatları, '
      + 'hafta sonları ve kahvaltılı fiyatlar daha sonra fiyat tablosunda eklenir. '
      + 'Boş bir alan o oda tipi için fiyat oluşturmaz.' },
  'first.pricePerNight': {
    de: 'Preis je Nacht (€)',
    en: 'Price per night (€)',
    tr: 'Gecelik fiyat (€)' },
  'first.rateName': {
    de: 'Name der Rate',
    en: 'Rate name',
    tr: 'Fiyat adı' },
  'first.rateNameDefault': {
    de: 'Standardpreis',
    en: 'Standard rate',
    tr: 'Standart fiyat' },
  'first.noPricePermission': {
    de: 'Preise darf in diesem Haus nur pflegen, wer das Recht dazu hat. Die Zimmer '
      + 'legen wir trotzdem an; die Preise trägt danach jemand mit diesem Recht ein.',
    en: 'Only users with the right to do so may maintain prices in this property. '
      + 'We create the rooms anyway; someone with that right adds the prices later.',
    tr: 'Bu tesiste fiyatları yalnızca yetkisi olan kişi düzenleyebilir. Odaları '
      + 'yine de oluşturuyoruz; fiyatları daha sonra yetkili biri girer.' },
  'first.checkTitle': {
    de: 'Das legen wir an',
    en: 'This is what we create',
    tr: 'Oluşturacaklarımız' },
  'first.checkRooms': {
    de: '{n} Zimmer',
    en: '{n} rooms',
    tr: '{n} oda' },
  'first.checkNoRate': {
    de: 'ohne Rate',
    en: 'no rate',
    tr: 'fiyatsız' },
  'first.checkPeriod': {
    de: 'Preise vom {from} bis {to}. Der Bestand für die nächsten 24 Monate wird gleich '
      + 'mit angelegt, Buchungen gehen also sofort.',
    en: 'Prices from {from} to {to}. Availability for the next 24 months is created '
      + 'at the same time, so bookings work immediately.',
    tr: 'Fiyatlar {from} ile {to} arasında. Önümüzdeki 24 ayın müsaitliği de aynı anda '
      + 'oluşturulur, yani rezervasyonlar hemen çalışır.' },
  'first.checkNoPrices': {
    de: 'Ohne Preise werden Reservierungen mit 0 € gebucht, bis jemand im Preisraster '
      + 'Preise einträgt.',
    en: 'Without prices, reservations are booked at €0 until someone enters prices in '
      + 'the rate grid.',
    tr: 'Fiyat olmadan, biri fiyat tablosuna fiyat girene kadar rezervasyonlar 0 € ile '
      + 'kaydedilir.' },
  'first.create': {
    de: 'Anlegen',
    en: 'Create',
    tr: 'Oluştur' },
  'first.next': {
    de: 'Weiter',
    en: 'Next',
    tr: 'İleri' },
  'first.back': {
    de: 'Zurück',
    en: 'Back',
    tr: 'Geri' },
  'first.later': {
    de: 'Später einrichten',
    en: 'Set up later',
    tr: 'Daha sonra kur' },
  'first.doneTitle': {
    de: 'Ihr Haus ist buchbar.',
    en: 'Your property is ready for bookings.',
    tr: 'Tesisiniz rezervasyona hazır.' },
  'first.doneSummary': {
    de: '{categories} Zimmerarten, {rooms} Zimmer und {rates} Raten sind angelegt.',
    en: '{categories} room types, {rooms} rooms and {rates} rates have been created.',
    tr: '{categories} oda tipi, {rooms} oda ve {rates} fiyat oluşturuldu.' },
  'first.priceListTitle': {
    de: 'Preislisten pflegen',
    en: 'Maintain price lists',
    tr: 'Fiyat listelerini düzenle' },
  'first.priceListHint': {
    de: 'Im Preisraster setzen Sie Saisonpreise und Wochenendaufschläge über '
      + 'beliebige Zeiträume, legen abgeleitete Raten an, etwa mit Frühstück oder '
      + 'nicht stornierbar, und können Preise nach Auslastung steuern lassen.',
    en: 'In the rate grid you set seasonal prices and weekend surcharges for any '
      + 'period, create derived rates such as with breakfast or non-refundable, and '
      + 'can let prices follow occupancy.',
    tr: 'Fiyat tablosunda istediğiniz dönemler için sezon fiyatları ve hafta sonu '
      + 'farkları belirler, kahvaltılı veya iptal edilemez gibi türetilmiş fiyatlar '
      + 'oluşturur ve fiyatları doluluğa göre yönlendirebilirsiniz.' },
  'first.toRates': {
    de: 'Zum Preisraster',
    en: 'Open rate grid',
    tr: 'Fiyat tablosuna git' },
  'first.toSetup': {
    de: 'Weitere Einrichtung',
    en: 'More setup',
    tr: 'Diğer kurulum' },
  'first.setupHint': {
    de: 'Zahlungsarten, Steuersätze und Hausbedingungen zeigt der Einrichtungsstand.',
    en: 'Payment methods, tax rates and house terms are listed in the setup status.',
    tr: 'Ödeme türleri, vergi oranları ve tesis koşulları kurulum durumunda '
      + 'gösterilir.' },
  'first.toPlan': {
    de: 'Zum Belegungsplan',
    en: 'Open room plan',
    tr: 'Doluluk planına git' },
  'first.open': {
    de: 'Assistent für die erste Einrichtung',
    en: 'First setup assistant',
    tr: 'İlk kurulum yardımcısı' },
  'first.tplSingle': {
    de: 'Einzelzimmer',
    en: 'Single room',
    tr: 'Tek kişilik oda' },
  'first.tplDouble': {
    de: 'Doppelzimmer',
    en: 'Double room',
    tr: 'Çift kişilik oda' }
} satisfies Record<string, LocalizedText>
