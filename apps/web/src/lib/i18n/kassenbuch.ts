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
  'cash.settings.datevFrom': {
    de: 'DATEV-Export aus StayGrid ab',
    en: 'DATEV export from StayGrid as of',
    tr: 'StayGrid üzerinden DATEV dışa aktarımı başlangıcı' },
  'cash.settings.uploadEmail': {
    de: 'DATEV-Uploadmail für Belege',
    en: 'DATEV Upload-Mail for receipts',
    tr: 'Belgeler için DATEV Upload-Mail' },
  'cash.settings.uploadEmailHint': {
    de: 'Die Adresse der Barkasse aus DATEV Upload-Mail (…@uploadmail.datev.de). Beim Markieren eines Exports geht jeder Beleg als eigene Mail dorthin.',
    en: 'The cash register address from DATEV Upload-Mail (…@uploadmail.datev.de). When an export is marked, each receipt is sent there as its own e-mail.',
    tr: 'DATEV Upload-Mail\'deki kasa adresi (…@uploadmail.datev.de). Bir dışa aktarım işaretlendiğinde her belge oraya ayrı bir e-posta olarak gönderilir.' },
  'cash.settings.datevFromHint': {
    de: 'Bis zu diesem Tag exportiert das bisherige System. Nur eines darf an DATEV exportieren, sonst steht jede Buchung zweimal in der Buchhaltung.',
    en: 'Until this day the previous system exports. Only one may export to DATEV, otherwise every entry appears twice in accounting.',
    tr: 'Bu güne kadar önceki sistem dışa aktarır. DATEV\'e yalnızca biri aktarabilir, aksi halde her kayıt muhasebede iki kez görünür.' },
  'cash.print': {
    de: 'Drucken',
    en: 'Print',
    tr: 'Yazdır' },
  'cash.datev.title': {
    de: 'DATEV-Export',
    en: 'DATEV export',
    tr: 'DATEV dışa aktarımı' },
  'cash.datev.mode': {
    de: 'Umfang',
    en: 'Scope',
    tr: 'Kapsam' },
  'cash.datev.unsent': {
    de: 'Noch nicht übergeben',
    en: 'Not yet handed over',
    tr: 'Henüz aktarılmamış' },
  'cash.datev.range': {
    de: 'Zeitraum (erneut)',
    en: 'Period (again)',
    tr: 'Dönem (yeniden)' },
  'cash.datev.from': {
    de: 'Von',
    en: 'From',
    tr: 'Başlangıç' },
  'cash.datev.to': {
    de: 'Bis',
    en: 'To',
    tr: 'Bitiş' },
  'cash.datev.download': {
    de: 'Herunterladen',
    en: 'Download',
    tr: 'İndir' },
  'cash.datev.done': {
    de: '{n} Buchungen in der Datei. Erst wenn sie beim Steuerberater angekommen ist, als übergeben markieren.',
    en: '{n} entries in the file. Mark them as handed over only once the file has reached the tax advisor.',
    tr: 'Dosyada {n} kayıt var. Ancak dosya mali müşavire ulaştığında aktarıldı olarak işaretleyin.' },
  'cash.datev.mark': {
    de: 'Als an DATEV übergeben markieren',
    en: 'Mark as handed over to DATEV',
    tr: 'DATEV\'e aktarıldı olarak işaretle' },
  'cash.datev.marked': {
    de: '{n} Buchungen als übergeben markiert.',
    en: '{n} entries marked as handed over.',
    tr: '{n} kayıt aktarıldı olarak işaretlendi.' },
  'cash.datev.receiptsQueued': {
    de: '{n} Belege gehen an die DATEV-Uploadmail.',
    en: '{n} receipts are being sent to DATEV Upload-Mail.',
    tr: '{n} belge DATEV Upload-Mail adresine gönderiliyor.' },
  'cash.datev.receiptsWaiting': {
    de: '{n} Belege warten noch auf den Versand an DATEV.',
    en: '{n} receipts are still waiting to be sent to DATEV.',
    tr: '{n} belge hâlâ DATEV\'e gönderilmeyi bekliyor.' },
  'cash.datev.receiptsNoAddress': {
    de: '{n} Belege warten: in der Einstellung fehlt die DATEV-Uploadmail-Adresse.',
    en: '{n} receipts are waiting: the DATEV Upload-Mail address is missing in the settings.',
    tr: '{n} belge bekliyor: ayarlarda DATEV Upload-Mail adresi eksik.' },
  'cash.datev.receiptsMailNotReady': {
    de: '{n} Belege warten: der E-Mail-Versand des Hauses ist nicht eingerichtet.',
    en: '{n} receipts are waiting: e-mail sending is not set up for this property.',
    tr: '{n} belge bekliyor: bu tesis için e-posta gönderimi kurulmamış.' },
  'cash.datev.sendReceipts': {
    de: 'Belege jetzt senden',
    en: 'Send receipts now',
    tr: 'Belgeleri şimdi gönder' },
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
  'cash.receipt.none': {
    de: 'Kein Beleg.',
    en: 'No receipt.',
    tr: 'Fiş yok.' },
  'cash.entry.title': {
    de: 'Buchung {n}',
    en: 'Entry {n}',
    tr: 'Kayıt {n}' },
  'cash.receipt.add': {
    de: '+ Beleg',
    en: '+ Receipt',
    tr: '+ Fiş' },
  'cash.erase': {
    de: 'Löschen',
    en: 'Delete',
    tr: 'Sil' },
  'cash.erase.title': {
    de: 'Buchung {n} löschen',
    en: 'Delete entry {n}',
    tr: '{n} numaralı kaydı sil' },
  'cash.erase.hint': {
    de: 'Die Buchung verschwindet ganz, bei einer Gastbuchung mit allen Zeilen, Stornos und Belegen. Das geht nur, solange nichts davon an DATEV ging, und das Protokoll hält fest, wer gelöscht hat. Für einen echten Fehler ist Stornieren der richtige Weg.',
    en: 'The entry disappears completely; for a guest entry with all of its lines, reversals and receipts. This is only possible while none of it went to DATEV, and the log records who deleted it. For a real mistake, voiding is the right way.',
    tr: 'Kayıt tamamen kaldırılır; misafir kaydında tüm satırları, iptalleri ve belgeleriyle birlikte. Bu yalnızca hiçbiri DATEV\'e gitmediyse mümkündür ve kimin sildiği kayıt altına alınır. Gerçek bir hata için doğru yol iptal etmektir.' },
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
  'cash.group.lines': {
    de: '+{n} Zeilen',
    en: '+{n} lines',
    tr: '+{n} satır' },
  'cash.group.open': {
    de: 'Gruppe aufklappen',
    en: 'Expand group',
    tr: 'Grubu aç' },
  'cash.group.close': {
    de: 'Gruppe zuklappen',
    en: 'Collapse group',
    tr: 'Grubu kapat' },
  'cash.group.openAll': {
    de: 'Alle aufklappen',
    en: 'Expand all',
    tr: 'Tümünü aç' },
  'cash.group.closeAll': {
    de: 'Alle zuklappen',
    en: 'Collapse all',
    tr: 'Tümünü kapat' },
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
