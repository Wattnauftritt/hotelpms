import type { LocalizedText } from '@hotelpms/contracts'

/** Datenübernahme aus Altsystemen, zuerst KWHotel. */
export const altsystem = {
  'nav.import': {
    de: 'Datenübernahme',
    en: 'Data import',
    tr: 'Veri aktarımı' },
  'import.title': {
    de: 'Übernahme aus einem Altsystem',
    en: 'Import from a legacy system',
    tr: 'Eski sistemden aktarım' },
  'import.system': {
    de: 'Altsystem',
    en: 'Legacy system',
    tr: 'Eski sistem' },
  'import.target': {
    de: 'In welches Haus?',
    en: 'Into which property?',
    tr: 'Hangi tesise?' },
  'import.target.choose': {
    de: '— Haus wählen —',
    en: '— choose a property —',
    tr: '— tesis seçin —' },
  'import.undo.title': {
    de: 'Übernahme zurücknehmen',
    en: 'Undo the import',
    tr: 'Aktarımı geri al' },
  'import.undo.hint': {
    de: 'Entfernt, was die KWHotel-Übernahme in diesem Haus angelegt hat: '
      + 'Reservierungen, Buchungen, Gäste, Zimmer und Zimmergruppen. Was danach '
      + 'hier entstanden ist, bleibt. Zuerst wird nur gezählt.',
    en: 'Removes what the KWHotel import created in this property: reservations, '
      + 'bookings, guests, rooms and room types. Anything created here since stays. '
      + 'It only counts first.',
    tr: 'KWHotel aktarımının bu tesiste oluşturduklarını kaldırır: rezervasyonlar, '
      + 'rezervasyon grupları, misafirler, odalar ve oda tipleri. Sonradan burada '
      + 'oluşturulanlar kalır. Önce yalnızca sayılır.' },
  'import.undo.check': {
    de: 'Zählen, was zurückginge',
    en: 'Count what would be undone',
    tr: 'Geri alınacakları say' },
  'import.undo.runs': {
    de: 'Übernahmen in {haus}: {n}',
    en: 'Imports into {haus}: {n}',
    tr: '{haus} içine aktarımlar: {n}' },
  'import.undo.run': {
    de: '{at}: {n} Reservierungen',
    en: '{at}: {n} reservations',
    tr: '{at}: {n} rezervasyon' },
  'import.undo.counts': {
    de: '{reservations} Reservierungen in {bookings} Buchungen, {guests} Gäste, '
      + '{rooms} Zimmer, {categories} Zimmergruppen',
    en: '{reservations} reservations in {bookings} bookings, {guests} guests, '
      + '{rooms} rooms, {categories} room types',
    tr: '{bookings} grupta {reservations} rezervasyon, {guests} misafir, '
      + '{rooms} oda, {categories} oda tipi' },
  'import.undo.kept': {
    de: 'Bleiben stehen, weil inzwischen etwas daran hängt: {guests} Gäste, '
      + '{rooms} Zimmer, {categories} Zimmergruppen',
    en: 'Kept because something now refers to them: {guests} guests, {rooms} rooms, '
      + '{categories} room types',
    tr: 'Artık bunlara bağlı bir şey olduğu için kalır: {guests} misafir, '
      + '{rooms} oda, {categories} oda tipi' },
  'import.undo.commit': {
    de: 'Aus {haus} entfernen',
    en: 'Remove from {haus}',
    tr: '{haus} içinden kaldır' },
  'import.undo.confirm': {
    de: '{n} übernommene Reservierungen aus {haus} entfernen? Das lässt sich nicht '
      + 'rückgängig machen; die Übernahme lässt sich aber wiederholen.',
    en: 'Remove {n} imported reservations from {haus}? This cannot be undone; the '
      + 'import itself can be repeated.',
    tr: '{haus} içinden {n} aktarılmış rezervasyon kaldırılsın mı? Bu geri alınamaz; '
      + 'aktarım ise tekrarlanabilir.' },
  'import.undo.done': {
    de: 'Zurückgenommen: {n} Reservierungen. Das Haus ist frei für eine neue Übernahme.',
    en: 'Undone: {n} reservations. The property is ready for a new import.',
    tr: 'Geri alındı: {n} rezervasyon. Tesis yeni bir aktarım için hazır.' },
  'import.target.hint': {
    de: 'Zuerst das Haus wählen, in das übernommen wird. Zimmer, Gruppen und '
      + 'Reservierungen landen genau dort.',
    en: 'First choose the property to import into. Rooms, room types and '
      + 'reservations end up exactly there.',
    tr: 'Önce aktarılacak tesisi seçin. Odalar, oda tipleri ve rezervasyonlar '
      + 'tam olarak oraya gider.' },
  'import.kwhotel.hint': {
    de: 'KWHotel sichert seine Datenbank als Datei mit der Endung .bak. Diese '
      + 'Datei hier wählen. Gelesen werden nur Zimmer, Gäste und Reservierungen; '
      + 'der Rest der Datei verlässt diesen Rechner nicht.',
    en: 'KWHotel saves its database as a file ending in .bak. Choose that file '
      + 'here. Only rooms, guests and reservations are read; the rest of the '
      + 'file does not leave this computer.',
    tr: 'KWHotel veritabanını .bak uzantılı bir dosya olarak kaydeder. Bu '
      + 'dosyayı burada seçin. Yalnızca odalar, misafirler ve rezervasyonlar '
      + 'okunur; dosyanın geri kalanı bu bilgisayardan çıkmaz.' },
  'import.file': {
    de: 'Datei wählen',
    en: 'Choose file',
    tr: 'Dosya seç' },
  'import.fileRead': {
    de: '{name}: {size} MB gelesen, {sent} MB werden geprüft.',
    en: '{name}: {size} MB read, {sent} MB will be checked.',
    tr: '{name}: {size} MB okundu, {sent} MB kontrol edilecek.' },
  'import.exclude': {
    de: 'Platzhalter (Gastnamen, durch Komma getrennt)',
    en: 'Placeholders (guest names, comma-separated)',
    tr: 'Yer tutucular (misafir adları, virgülle ayrılmış)' },
  'import.exclude.hint': {
    de: 'Zeilen mit diesen Gastnamen sind keine Buchungen, etwa Merker für '
      + 'ungereinigte Zimmer. Groß- und Kleinschreibung und Leerzeichen zählen nicht.',
    en: 'Rows with these guest names are not bookings, e.g. markers for rooms '
      + 'to be cleaned. Case and spaces do not matter.',
    tr: 'Bu misafir adlarına sahip satırlar rezervasyon değildir, örn. '
      + 'temizlenmemiş odalar için işaretler. Büyük/küçük harf ve boşluklar önemsizdir.' },
  'import.fromDate': {
    de: 'Nur Aufenthalte ab',
    en: 'Only stays from',
    tr: 'Yalnızca şu tarihten itibaren konaklamalar' },
  'import.statusActive': {
    de: 'Statuscodes: gültig',
    en: 'Status codes: valid',
    tr: 'Durum kodları: geçerli' },
  'import.statusCanceled': {
    de: 'Statuscodes: storniert',
    en: 'Status codes: canceled',
    tr: 'Durum kodları: iptal' },
  'import.check': {
    de: 'Prüfen',
    en: 'Check',
    tr: 'Kontrol et' },
  'import.checking': {
    de: 'Wird geprüft …',
    en: 'Checking …',
    tr: 'Kontrol ediliyor …' },
  'import.commit': {
    de: '{n} Reservierungen in „{haus}“ übernehmen',
    en: 'Import {n} reservations into "{haus}"',
    tr: '{n} rezervasyonu "{haus}" tesisine aktar' },
  'import.commit.confirm': {
    de: '{n} Reservierungen aus „{quelle}“ in das Haus „{haus}“ übernehmen?',
    en: 'Import {n} reservations from "{quelle}" into the property "{haus}"?',
    tr: '"{quelle}" kaynağından {n} rezervasyon "{haus}" tesisine aktarılsın mı?' },
  'import.next': {
    de: 'Weiter',
    en: 'Continue',
    tr: 'Devam' },
  'import.next.hint': {
    de: 'Geändert seit der letzten Prüfung. „Weiter“ prüft mit den neuen Angaben.',
    en: 'Changed since the last check. "Continue" checks with the new settings.',
    tr: 'Son kontrolden beri değişti. „Devam“ yeni ayarlarla kontrol eder.' },
  'import.commit.hint': {
    de: 'Erst nach einer fehlerfreien Prüfung mit genau diesen Einstellungen. '
      + 'Ein zweiter Lauf derselben Datei überspringt, was schon übernommen ist.',
    en: 'Only after an error-free check with exactly these settings. A second '
      + 'run of the same file skips what was already imported.',
    tr: 'Yalnızca tam olarak bu ayarlarla hatasız bir kontrolden sonra. Aynı '
      + 'dosyanın ikinci çalıştırılması zaten aktarılanları atlar.' },
  'import.done': {
    de: '{n} Reservierungen übernommen.',
    en: '{n} reservations imported.',
    tr: '{n} rezervasyon aktarıldı.' },
  'import.dryRun': {
    de: 'Prüfung, nichts geschrieben',
    en: 'Check, nothing written',
    tr: 'Kontrol, hiçbir şey yazılmadı' },
  'import.summary': {
    de: '{hotel}: {rows} Zeilen vom {from} bis {to}, Stichtag {date}.',
    en: '{hotel}: {rows} rows from {from} to {to}, cutover date {date}.',
    tr: '{hotel}: {from} - {to} arası {rows} satır, geçiş tarihi {date}.' },
  'import.count.confirmed': {
    de: 'Künftig',
    en: 'Upcoming',
    tr: 'Gelecek' },
  'import.count.inHouse': {
    de: 'Im Haus',
    en: 'In house',
    tr: 'Otelde' },
  'import.count.checkedOut': {
    de: 'Abgereist',
    en: 'Checked out',
    tr: 'Ayrıldı' },
  'import.count.canceled': {
    de: 'Storniert',
    en: 'Canceled',
    tr: 'İptal' },
  'import.count.placeholder': {
    de: 'Platzhalter',
    en: 'Placeholders',
    tr: 'Yer tutucular' },
  'import.count.alreadyImported': {
    de: 'Schon übernommen',
    en: 'Already imported',
    tr: 'Zaten aktarıldı' },
  'import.count.beforeFrom': {
    de: 'Vor dem Zeitraum',
    en: 'Before the period',
    tr: 'Dönemden önce' },
  'import.count.roomSkipped': {
    de: 'Zimmer ausgelassen',
    en: 'Room left out',
    tr: 'Oda dışarıda bırakıldı' },
  'import.count.bookings': {
    de: 'Buchungen, davon {groups} Gruppen',
    en: 'Bookings, {groups} of them groups',
    tr: 'Rezervasyon, {groups} tanesi grup' },
  'import.count.guests': {
    de: 'Gastprofile',
    en: 'Guest profiles',
    tr: 'Misafir profilleri' },
  'import.multiGuest': {
    de: '{n} Zeilen haben mehrere Gäste; übernommen wird der Gast an der Reservierung.',
    en: '{n} rows have several guests; the guest on the reservation is imported.',
    tr: '{n} satırda birden fazla misafir var; rezervasyondaki misafir aktarılır.' },
  'import.rooms': {
    de: 'Zimmer',
    en: 'Rooms',
    tr: 'Odalar' },
  'import.rooms.hint': {
    de: 'Zugeordnet über die Zimmernummer. Jede Zuordnung lässt sich ändern; '
      + '„nicht übernehmen“ lässt die Reservierungen dieses Zimmers weg, „neu '
      + 'anlegen“ legt das Zimmer mit der Übernahme an.',
    en: 'Matched by room number. Every match can be changed; "do not import" '
      + 'leaves out the reservations of that room, "create new" creates the '
      + 'room along with the import.',
    tr: 'Oda numarasıyla eşleştirildi. Her eşleştirme değiştirilebilir; '
      + '„aktarma“ o odanın rezervasyonlarını dışarıda bırakır, „yeni oluştur“ '
      + 'odayı aktarımla birlikte oluşturur.' },
  'import.rooms.kw': {
    de: 'KWHotel',
    en: 'KWHotel',
    tr: 'KWHotel' },
  'import.rooms.reservations': {
    de: 'Reservierungen',
    en: 'Reservations',
    tr: 'Rezervasyonlar' },
  'import.rooms.target': {
    de: 'Zimmer in StayGrid',
    en: 'Room in StayGrid',
    tr: 'StayGrid\'deki oda' },
  'import.rooms.none': {
    de: '— keines —',
    en: '— none —',
    tr: '— yok —' },
  'import.rooms.skip': {
    de: 'nicht übernehmen',
    en: 'do not import',
    tr: 'aktarma' },
  'import.rooms.create': {
    de: 'neu anlegen',
    en: 'create new',
    tr: 'yeni oluştur' },
  'import.rooms.missing': {
    de: '{n} Zimmer aus KWHotel gibt es hier nicht.',
    en: '{n} rooms from KWHotel do not exist here.',
    tr: 'KWHotel\'deki {n} oda burada yok.' },
  'import.rooms.createAll': {
    de: 'alle fehlenden neu anlegen',
    en: 'create all missing',
    tr: 'eksiklerin hepsini oluştur' },
  'import.rooms.newCode': {
    de: 'Zimmernummer',
    en: 'Room number',
    tr: 'Oda numarası' },
  'import.rooms.newName': {
    de: 'Zimmername',
    en: 'Room name',
    tr: 'Oda adı' },
  'import.rooms.category': {
    de: 'Zimmergruppe',
    en: 'Room type',
    tr: 'Oda tipi' },
  'import.rooms.newCategory': {
    de: 'neue Gruppe',
    en: 'new room type',
    tr: 'yeni oda tipi' },
  'import.rooms.categoryCode': {
    de: 'Kürzel',
    en: 'Code',
    tr: 'Kısaltma' },
  'import.rooms.categoryName': {
    de: 'Name',
    en: 'Name',
    tr: 'Ad' },
  'import.rooms.maxOccupancy': {
    de: 'Personen höchstens',
    en: 'Max. guests',
    tr: 'En fazla kişi' },
  'import.statusCodes': {
    de: 'Statuscodes im Abzug',
    en: 'Status codes in the dump',
    tr: 'Dökümdeki durum kodları' },
  'import.status.active': {
    de: 'gültig',
    en: 'valid',
    tr: 'geçerli' },
  'import.status.canceled': {
    de: 'storniert',
    en: 'canceled',
    tr: 'iptal' },
  'import.status.unknown': {
    de: 'nicht eingeordnet',
    en: 'not classified',
    tr: 'sınıflandırılmadı' },
  'import.names': {
    de: 'Häufigste Gastnamen',
    en: 'Most frequent guest names',
    tr: 'En sık misafir adları' },
  'import.names.hint': {
    de: 'Ein Platzhalter fällt hier auf, bevor er als hundert Buchungen im Plan steht.',
    en: 'A placeholder stands out here before it shows up as a hundred bookings on the plan.',
    tr: 'Bir yer tutucu, planda yüz rezervasyon olarak görünmeden önce burada fark edilir.' },
  'import.names.exclude': {
    de: 'als Platzhalter',
    en: 'as placeholder',
    tr: 'yer tutucu olarak' },
  'import.names.excluded': {
    de: 'ausgeschlossen',
    en: 'excluded',
    tr: 'hariç tutuldu' },
  'import.findings': {
    de: 'Befunde',
    en: 'Findings',
    tr: 'Bulgular' },
  'import.noFindings': {
    de: 'Keine Befunde.',
    en: 'No findings.',
    tr: 'Bulgu yok.' }
} as const satisfies Record<string, LocalizedText>
