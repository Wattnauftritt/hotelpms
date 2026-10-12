import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Einstellungen der digitalen Gaestemappe und die Zimmerkarten (Migration
 * 0143). Was der Gast liest, steht nicht hier, sondern im Katalog der Mappe
 * (`gast/mappeTexte.ts`) in den Sprachen der Gaeste.
 */
export const gaestemappe = {
  'folder.title': {
    de: 'Gästemappe',
    en: 'Guest folder',
    tr: 'Misafir dosyası' },
  'folder.hint': {
    de: 'Gäste scannen den Code auf der Zimmerkarte und sehen auf ihrem Telefon WLAN, Anreise- und Abreisezeiten und die Seiten, die du hier auswählst. Ohne Anmeldung und ohne App.',
    en: 'Guests scan the code on the room card and see Wi-Fi, check-in and check-out times and the pages you select here on their phone. No login, no app.',
    tr: 'Misafirler oda kartındaki kodu tarar ve telefonlarında Wi-Fi bilgilerini, giriş ve çıkış saatlerini ve burada seçtiğin sayfaları görür. Giriş ve uygulama gerekmez.' },
  'folder.enabled': {
    de: 'Gästemappe anbieten',
    en: 'Offer the guest folder',
    tr: 'Misafir dosyasını sun' },
  'folder.wifi': {
    de: 'WLAN des Hauses',
    en: 'Hotel Wi-Fi',
    tr: 'Otel Wi-Fi' },
  'folder.wifi.show': {
    de: 'WLAN in der Mappe und auf der Zimmerkarte zeigen',
    en: 'Show Wi-Fi in the folder and on the room card',
    tr: 'Wi-Fi bilgilerini dosyada ve oda kartında göster' },
  'folder.wifi.ssid': {
    de: 'Netzname (SSID)',
    en: 'Network name (SSID)',
    tr: 'Ağ adı (SSID)' },
  'folder.wifi.password': {
    de: 'Passwort',
    en: 'Password',
    tr: 'Şifre' },
  'folder.wifi.security': {
    de: 'Verschlüsselung',
    en: 'Security',
    tr: 'Güvenlik' },
  'folder.wifi.sec.WPA': {
    de: 'WPA, WPA2 oder WPA3',
    en: 'WPA, WPA2 or WPA3',
    tr: 'WPA, WPA2 veya WPA3' },
  'folder.wifi.sec.WEP': {
    de: 'WEP (veraltet)',
    en: 'WEP (outdated)',
    tr: 'WEP (eski)' },
  'folder.wifi.sec.nopass': {
    de: 'Offen, ohne Passwort',
    en: 'Open, no password',
    tr: 'Açık, şifresiz' },
  'folder.wifi.hidden': {
    de: 'Das Netz ist verborgen',
    en: 'The network is hidden',
    tr: 'Ağ gizli' },
  'folder.pages': {
    de: 'Seiten in der Mappe',
    en: 'Pages in the folder',
    tr: 'Dosyadaki sayfalar' },
  'folder.pagesHint': {
    de: 'Die Seiten sind dieselben wie am Gästeterminal und werden im Reiter „Gästeterminals“ angelegt und bearbeitet. Hier wählst du nur aus, welche in der Mappe stehen und in welcher Reihenfolge.',
    en: 'The pages are the same as on the guest terminal and are created and edited in the “Guest terminals” tab. Here you only choose which appear in the folder and in which order.',
    tr: 'Sayfalar misafir terminalindekilerle aynıdır ve “Misafir terminalleri” sekmesinde oluşturulur. Burada yalnızca hangilerinin dosyada hangi sırayla görüneceğini seçersin.' },
  'folder.pagesNone': {
    de: 'Noch keine Seiten angelegt. Lege zuerst unter „Gästeterminals“ Seiten an, etwa Frühstück, Hausordnung oder Parken.',
    en: 'No pages yet. First create pages under “Guest terminals”, such as breakfast, house rules or parking.',
    tr: 'Henüz sayfa yok. Önce “Misafir terminalleri” altında kahvaltı, ev kuralları veya otopark gibi sayfalar oluştur.' },
  'folder.up': {
    de: 'Nach oben',
    en: 'Move up',
    tr: 'Yukarı taşı' },
  'folder.down': {
    de: 'Nach unten',
    en: 'Move down',
    tr: 'Aşağı taşı' },
  'folder.saved': {
    de: 'Gespeichert',
    en: 'Saved',
    tr: 'Kaydedildi' },
  'folder.tr.title': {
    de: 'Übersetzungen',
    en: 'Translations',
    tr: 'Çeviriler' },
  'folder.tr.hint': {
    de: 'Die Seiten werden automatisch mit DeepL ins Englische, Niederländische und Polnische übersetzt. Deutsch bleibt die Vorlage: Änderst du eine Seite, wird sie neu übersetzt, und bis dahin sehen Gäste sie auf Deutsch. Eine Übersetzung, die nicht passt, kannst du von Hand überschreiben.',
    en: 'Pages are translated automatically into English, Dutch and Polish with DeepL. German stays the original: when you change a page it is translated again, and until then guests see it in German. You can overwrite a translation that does not fit by hand.',
    tr: 'Sayfalar DeepL ile otomatik olarak İngilizce, Felemenkçe ve Lehçeye çevrilir. Almanca asıl metin olarak kalır: bir sayfayı değiştirdiğinde yeniden çevrilir ve o zamana kadar misafirler Almanca görür. Uymayan bir çeviriyi elle değiştirebilirsin.' },
  'folder.tr.open': {
    de: 'Übersetzungen',
    en: 'Translations',
    tr: 'Çeviriler' },
  'folder.tr.lang.en': {
    de: 'Englisch',
    en: 'English',
    tr: 'İngilizce' },
  'folder.tr.lang.nl': {
    de: 'Niederländisch',
    en: 'Dutch',
    tr: 'Felemenkçe' },
  'folder.tr.lang.pl': {
    de: 'Polnisch',
    en: 'Polish',
    tr: 'Lehçe' },
  'folder.tr.state.machine': {
    de: 'automatisch übersetzt',
    en: 'translated automatically',
    tr: 'otomatik çevrildi' },
  'folder.tr.state.manual': {
    de: 'von Hand übersetzt',
    en: 'translated by hand',
    tr: 'elle çevrildi' },
  'folder.tr.state.pending': {
    de: 'wird übersetzt, Gäste sehen solange Deutsch',
    en: 'being translated, guests see German until then',
    tr: 'çevriliyor, o zamana kadar misafirler Almanca görür' },
  'folder.tr.state.failed': {
    de: 'Übersetzung gescheitert, Gäste sehen Deutsch',
    en: 'translation failed, guests see German',
    tr: 'çeviri başarısız oldu, misafirler Almanca görür' },
  'folder.tr.original': {
    de: 'Deutsche Vorlage',
    en: 'German original',
    tr: 'Almanca asıl metin' },
  'folder.tr.field.title': {
    de: 'Titel',
    en: 'Title',
    tr: 'Başlık' },
  'folder.tr.field.body': {
    de: 'Text',
    en: 'Text',
    tr: 'Metin' },
  'folder.tr.saveManual': {
    de: 'Von Hand speichern',
    en: 'Save by hand',
    tr: 'Elle kaydet' },
  'folder.tr.reset': {
    de: 'Neu von DeepL übersetzen lassen',
    en: 'Have DeepL translate again',
    tr: 'DeepL ile yeniden çevir' },
  'folder.cards': {
    de: 'Zimmerkarten',
    en: 'Room cards',
    tr: 'Oda kartları' },
  'folder.cardsHint': {
    de: 'Eine Karte je Zimmer im Format A6, zum Aufstellen: links der QR-Code fürs WLAN, rechts der zur Gästemappe, darunter Netzname und Passwort zum Abschreiben.',
    en: 'One A6 card per room, to stand on a table: Wi-Fi QR code on the left, guest folder on the right, network name and password written out below.',
    tr: 'Her oda için A6 boyutunda bir kart: solda Wi-Fi QR kodu, sağda misafir dosyası, altında ağ adı ve şifre.' },
  'folder.cardsOpen': {
    de: 'Zimmerkarten ansehen und drucken',
    en: 'View and print room cards',
    tr: 'Oda kartlarını görüntüle ve yazdır' },
  'folder.cardsPrint': {
    de: 'Drucken',
    en: 'Print',
    tr: 'Yazdır' },
  'folder.cardsClose': {
    de: 'Schließen',
    en: 'Close',
    tr: 'Kapat' },
  'folder.cardsOff': {
    de: 'Die Gästemappe ist ausgeschaltet. Wer die Karte scannt, sieht nur einen Hinweis, bis du sie einschaltest.',
    en: 'The guest folder is switched off. Anyone scanning the card only sees a notice until you switch it on.',
    tr: 'Misafir dosyası kapalı. Kartı tarayan kişi, sen açana kadar yalnızca bir uyarı görür.' },
  'folder.cardsPrintHint': {
    de: 'Jede Karte kommt auf ein eigenes Blatt A6. Im Druckdialog bei „Ränder“ „Keine“ wählen.',
    en: 'Each card prints on its own A6 sheet. In the print dialog set “Margins” to “None”.',
    tr: 'Her kart ayrı bir A6 sayfaya yazdırılır. Yazdırma penceresinde “Kenar boşlukları” için “Yok” seç.' },
  'folder.cardsRenew': {
    de: 'Neuer Code',
    en: 'New code',
    tr: 'Yeni kod' },
  'folder.cardsRenewConfirm': {
    de: 'Die bisherige Karte von Zimmer {room} funktioniert danach nicht mehr. Nur nötig, wenn ein Foto der Karte weitergegeben wurde. Neuen Code erzeugen?',
    en: 'The current card of room {room} will stop working. Only needed if a photo of the card was passed on. Create a new code?',
    tr: '{room} numaralı odanın mevcut kartı artık çalışmayacak. Yalnızca kartın fotoğrafı paylaşıldıysa gerekir. Yeni kod oluşturulsun mu?' },
  'folder.cardsRoom': {
    de: 'Zimmer {room}',
    en: 'Room {room}',
    tr: 'Oda {room}' }
} satisfies Record<string, LocalizedText>
