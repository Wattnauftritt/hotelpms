import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Bildschirm „Kassenbuch" (Migration 0095). `DATEV` und `SKR` bleiben in
 * jeder Sprache stehen; der Steuerberater kennt sie unter diesem Namen.
 */
export const kassenbuch = {
  'nav.cashbook': {
    de: 'Kassenbuch',
    en: 'Cash book',
    tr: 'Kasa defteri' },
  'cash.title': {
    de: 'Kassenbuch',
    en: 'Cash book',
    tr: 'Kasa defteri' },
  'cash.disabled': {
    de: 'Das Kassenbuch ist für dieses Haus nicht eingeschaltet.',
    en: 'The cash book is not switched on for this property.',
    tr: 'Kasa defteri bu tesis için açık değil.' },
  'cash.disabled.canEnable': {
    de: 'Das Kassenbuch ist für dieses Haus nicht eingeschaltet. Unter „Einstellungen" lässt es sich einschalten, mit Anfangsbestand und Konten.',
    en: 'The cash book is not switched on for this property. It can be switched on under "Settings", with opening balance and accounts.',
    tr: 'Kasa defteri bu tesis için açık değil. "Ayarlar" bölümünden açılış bakiyesi ve hesaplarla açılabilir.' },
  'cash.settings': {
    de: 'Einstellungen',
    en: 'Settings',
    tr: 'Ayarlar' },
  'cash.settings.enabled': {
    de: 'Kassenbuch für dieses Haus führen',
    en: 'Keep a cash book for this property',
    tr: 'Bu tesis için kasa defteri tut' },
  'cash.settings.openingBalance': {
    de: 'Anfangsbestand (EUR)',
    en: 'Opening balance (EUR)',
    tr: 'Açılış bakiyesi (EUR)' },
  'cash.settings.openingDate': {
    de: 'Anfangsbestand am',
    en: 'Opening balance on',
    tr: 'Açılış bakiyesi tarihi' },
  'cash.settings.breakfastPrice': {
    de: 'Frühstück je Person (EUR)',
    en: 'Breakfast per person (EUR)',
    tr: 'Kişi başı kahvaltı (EUR)' },
  'cash.settings.foodShare': {
    de: 'Anteil Speisen (7 %) in Prozent',
    en: 'Food share (7 %) in percent',
    tr: 'Yiyecek payı (%7), yüzde olarak' },
  'cash.settings.chart': {
    de: 'Kontenrahmen',
    en: 'Chart of accounts',
    tr: 'Hesap planı' },
  'cash.new': {
    de: 'Neue Buchung',
    en: 'New entry',
    tr: 'Yeni kayıt' },
  'cash.field.kind': {
    de: 'Art',
    en: 'Type',
    tr: 'Tür' },
  'cash.field.date': {
    de: 'Datum',
    en: 'Date',
    tr: 'Tarih' },
  'cash.field.total': {
    de: 'Gesamtpreis inkl. Frühstück',
    en: 'Total incl. breakfast',
    tr: 'Kahvaltı dahil toplam' },
  'cash.field.amount': {
    de: 'Betrag',
    en: 'Amount',
    tr: 'Tutar' },
  'cash.field.breakfasts': {
    de: 'Frühstücke',
    en: 'Breakfasts',
    tr: 'Kahvaltı sayısı' },
  'cash.field.cityTax': {
    de: 'Kurtaxe',
    en: 'City tax',
    tr: 'Konaklama vergisi' },
  'cash.field.taxRate': {
    de: 'Steuersatz',
    en: 'Tax rate',
    tr: 'Vergi oranı' },
  'cash.field.guest': {
    de: 'Gast',
    en: 'Guest',
    tr: 'Misafir' },
  'cash.field.text': {
    de: 'Buchungstext',
    en: 'Description',
    tr: 'Açıklama' },
  'cash.otherHint': {
    de: 'Ein Minuszeichen bucht einen Abgang aus der Kasse.',
    en: 'A minus sign books money leaving the till.',
    tr: 'Eksi işareti kasadan çıkışı kaydeder.' },
  'cash.save': {
    de: 'Buchen',
    en: 'Book',
    tr: 'Kaydet' },
  'cash.kind.guest': {
    de: 'Übernachtung (Gast)',
    en: 'Stay (guest)',
    tr: 'Konaklama (misafir)' },
  'cash.kind.lodging': {
    de: 'Übernachtung',
    en: 'Accommodation',
    tr: 'Konaklama' },
  'cash.kind.breakfastFood': {
    de: 'Frühstück Speisen',
    en: 'Breakfast food',
    tr: 'Kahvaltı yiyecek' },
  'cash.kind.breakfastDrinks': {
    de: 'Frühstück Getränke',
    en: 'Breakfast drinks',
    tr: 'Kahvaltı içecek' },
  'cash.kind.cityTax': {
    de: 'Kurtaxe',
    en: 'City tax',
    tr: 'Konaklama vergisi' },
  'cash.kind.cashIn': {
    de: 'Bareinlage',
    en: 'Cash deposit into till',
    tr: 'Kasaya nakit giriş' },
  'cash.kind.bankDeposit': {
    de: 'Bankeinzahlung',
    en: 'Bank deposit',
    tr: 'Bankaya yatırma' },
  'cash.kind.expense': {
    de: 'Ausgabe',
    en: 'Expense',
    tr: 'Gider' },
  'cash.kind.other': {
    de: 'Sonstiges',
    en: 'Other',
    tr: 'Diğer' },
  'cash.kind.legacyGuest': {
    de: 'Gast (Altdaten)',
    en: 'Guest (legacy)',
    tr: 'Misafir (eski kayıt)' },
  'cash.receipt.photo': {
    de: 'Foto aufnehmen',
    en: 'Take photo',
    tr: 'Fotoğraf çek' },
  'cash.receipt.file': {
    de: 'Datei wählen',
    en: 'Choose file',
    tr: 'Dosya seç' },
  'cash.receipt.remove': {
    de: 'Beleg entfernen',
    en: 'Remove receipt',
    tr: 'Fişi kaldır' },
  'cash.receipt.tooLarge': {
    de: 'Ein PDF darf höchstens 10 MB groß sein.',
    en: 'A PDF may be at most 10 MB.',
    tr: 'Bir PDF en fazla 10 MB olabilir.' },
  'cash.receipt.type': {
    de: 'Belege nur als PDF, JPEG oder PNG.',
    en: 'Receipts only as PDF, JPEG or PNG.',
    tr: 'Fişler yalnızca PDF, JPEG veya PNG olarak.' },
  'cash.receipt.n': {
    de: 'Beleg {n}',
    en: 'Receipt {n}',
    tr: 'Fiş {n}' },
  'cash.receipt.add': {
    de: '+ Beleg',
    en: '+ Receipt',
    tr: '+ Fiş' },
  'cash.void': {
    de: 'Stornieren',
    en: 'Void',
    tr: 'İptal et' },
  'cash.void.title': {
    de: 'Buchung {n} stornieren',
    en: 'Void entry {n}',
    tr: '{n} numaralı kaydı iptal et' },
  'cash.void.hint': {
    de: 'Die Buchung bleibt stehen, eine Gegenbuchung hebt sie auf. Bei einer Gastbuchung gilt das für alle ihre Zeilen.',
    en: 'The entry stays; a reversal cancels it. For a guest entry this applies to all of its lines.',
    tr: 'Kayıt silinmez; bir ters kayıt onu iptal eder. Misafir kaydında bu tüm satırları için geçerlidir.' },
  'cash.void.reason': {
    de: 'Grund',
    en: 'Reason',
    tr: 'Neden' },
  'cash.reverses': {
    de: 'Storno zu {n}',
    en: 'Reversal of {n}',
    tr: '{n} iptali' },
  'cash.voidedBy': {
    de: 'storniert durch {n}',
    en: 'voided by {n}',
    tr: '{n} ile iptal edildi' },
  'cash.balance.today': {
    de: 'Kassenbestand heute',
    en: 'Cash on hand today',
    tr: 'Bugünkü kasa bakiyesi' },
  'cash.balance.start': {
    de: 'Bestand Monatsanfang',
    en: 'Balance at start of month',
    tr: 'Ay başı bakiyesi' },
  'cash.balance.end': {
    de: 'Bestand Monatsende',
    en: 'Balance at end of month',
    tr: 'Ay sonu bakiyesi' },
  'cash.income': {
    de: 'Einnahmen',
    en: 'Income',
    tr: 'Gelir' },
  'cash.outgoing': {
    de: 'Ausgaben',
    en: 'Outgoings',
    tr: 'Çıkışlar' },
  'cash.opening': {
    de: 'Anfangsbestand {betrag} am {datum}. Buchungen davor zählen für den Bestand nicht.',
    en: 'Opening balance {betrag} on {datum}. Entries before that do not count towards the balance.',
    tr: '{datum} tarihli açılış bakiyesi {betrag}. Öncesindeki kayıtlar bakiyeye dahil değildir.' },
  'cash.none': {
    de: 'In diesem Monat ist nichts gebucht.',
    en: 'Nothing booked in this month.',
    tr: 'Bu ay kayıt yok.' },
  'cash.col.no': {
    de: 'Nr.',
    en: 'No.',
    tr: 'No.' },
  'cash.col.tax': {
    de: 'USt.',
    en: 'VAT',
    tr: 'KDV' },
  'cash.col.balance': {
    de: 'Bestand',
    en: 'Balance',
    tr: 'Bakiye' },
  'cash.col.receipts': {
    de: 'Belege',
    en: 'Receipts',
    tr: 'Fişler' },
  'cash.outputTax': {
    de: 'Umsatzsteuer',
    en: 'Output VAT',
    tr: 'Satış KDV' },
  'cash.inputTax': {
    de: 'Vorsteuer',
    en: 'Input VAT',
    tr: 'İndirilecek KDV' },
  'cash.taxGroup': {
    de: '{satz} %: brutto {brutto}, netto {netto}, USt. {steuer}',
    en: '{satz} %: gross {brutto}, net {netto}, VAT {steuer}',
    tr: '%{satz}: brüt {brutto}, net {netto}, KDV {steuer}' }
} satisfies Record<string, LocalizedText>
