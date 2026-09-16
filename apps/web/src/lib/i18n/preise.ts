import type { LocalizedText } from '@hotelpms/contracts'

/** Preisraster, Massenänderung, Restriktionen (Spur B). */
export const preise = {
  'nav.rates': {
    de: 'Preise',
    en: 'Rates',
    tr: 'Fiyatlar' },
  'rate.title': {
    de: 'Preise und Restriktionen',
    en: 'Rates and restrictions',
    tr: 'Fiyatlar ve kısıtlar' },
  'rate.plan': {
    de: 'Ratenplan',
    en: 'Rate plan',
    tr: 'Fiyat planı' },
  'rate.days': {
    de: 'Zeitraum',
    en: 'Period',
    tr: 'Dönem' },
  'rate.days.30': {
    de: '30 Tage',
    en: '30 days',
    tr: '30 gün' },
  'rate.days.90': {
    de: '90 Tage',
    en: '90 days',
    tr: '90 gün' },
  'rate.days.180': {
    de: '180 Tage',
    en: '180 days',
    tr: '180 gün' },
  'rate.days.400': {
    de: '400 Tage',
    en: '400 days',
    tr: '400 gün' },
  'rate.occupancy': {
    de: 'Belegung',
    en: 'Occupancy',
    tr: 'Doluluk' },
  'rate.occupancy.n': {
    de: 'Personen',
    en: 'guests',
    tr: 'kişi' },
  'rate.noPlans': {
    de: 'Für dieses Haus ist kein Ratenplan angelegt.',
    en: 'No rate plan exists for this property.',
    tr: 'Bu tesis için fiyat planı tanımlanmamış.' },
  'rate.noPrice': {
    de: 'kein Preis',
    en: 'no price',
    tr: 'fiyat yok' },
  'rate.derived': {
    de: 'abgeleitet',
    en: 'derived',
    tr: 'türetilmiş' },
  'rate.selection': {
    de: 'Auswahl',
    en: 'Selection',
    tr: 'Seçim' },
  'rate.selection.none': {
    de: 'Kein Bereich gewählt. Im Raster über die Tage ziehen '
      + 'oder den Zeitraum unten eintragen.',
    en: 'No range selected. Drag across the days in the grid '
      + 'or enter the period below.',
    tr: 'Hiçbir alan seçilmedi. Izgarada günlerin üzerinde sürükleyin veya dönemi aşağıya girin.' },
  'rate.selection.days': {
    de: 'Tage',
    en: 'days',
    tr: 'gün' },
  'rate.weekdays': {
    de: 'Nur an',
    en: 'Only on',
    tr: 'Yalnızca' },
  'rate.weekdays.all': {
    de: 'allen Tagen',
    en: 'all days',
    tr: 'bütün günler' },
  'rate.setPrice': {
    de: 'Preis setzen',
    en: 'Set price',
    tr: 'Fiyat belirle' },
  'rate.price.perOccupancy': {
    de: 'Preis je Belegung',
    en: 'Price per occupancy',
    tr: 'Doluluğa göre fiyat' },
  'rate.price.person': {
    de: 'Person',
    en: 'guest',
    tr: 'kişi' },
  'rate.price.persons': {
    de: 'Personen',
    en: 'guests',
    tr: 'kişi' },
  'rate.preview': {
    de: 'Vorschau',
    en: 'Preview',
    tr: 'Önizleme' },
  'rate.preview.again': {
    de: 'Vorschau erneuern',
    en: 'Refresh preview',
    tr: 'Önizlemeyi yenile' },
  'rate.preview.affected': {
    de: 'betroffene Tage',
    en: 'days affected',
    tr: 'etkilenen gün' },
  'rate.preview.changed': {
    de: 'davon mit abweichendem Preis',
    en: 'of those with a different price',
    tr: 'bunlardan fiyatı değişen' },
  'rate.preview.unchanged': {
    de: 'unverändert',
    en: 'unchanged',
    tr: 'değişmedi' },
  'rate.preview.required': {
    de: 'Erst ansehen, dann übernehmen.',
    en: 'Look first, then apply.',
    tr: 'Önce bakın, sonra uygulayın.' },
  'rate.preview.stale': {
    de: 'Die Eingabe hat sich geändert. Vorschau erneuern.',
    en: 'The input changed. Refresh the preview.',
    tr: 'Girdi değişti. Önizlemeyi yenileyin.' },
  'rate.apply': {
    de: 'Übernehmen',
    en: 'Apply',
    tr: 'Uygula' },
  'rate.applied': {
    de: 'Tage geschrieben',
    en: 'days written',
    tr: 'gün yazıldı' },
  'rate.hint.bulk': {
    de: 'Preise einer bestätigten Buchung bleiben, wie sie waren. '
      + 'Eine Änderung hier wirkt nur auf neue Buchungen.',
    en: 'A confirmed booking keeps the price it was made at. '
      + 'A change here only affects new bookings.',
    tr: 'Onaylanmış bir rezervasyonun fiyatları olduğu gibi kalır. Buradaki bir değişiklik yalnızca yeni rezervasyonları etkiler.' },
  'rate.restrictions': {
    de: 'Restriktionen',
    en: 'Restrictions',
    tr: 'Kısıtlar' },
  'rate.minLos': {
    de: 'Mindestaufenthalt',
    en: 'Minimum stay',
    tr: 'Asgari konaklama' },
  'rate.maxLos': {
    de: 'Höchstaufenthalt',
    en: 'Maximum stay',
    tr: 'Azami konaklama' },
  'rate.closed': {
    de: 'Geschlossen',
    en: 'Closed',
    tr: 'Kapalı' },
  'rate.cta': {
    de: 'Keine Anreise',
    en: 'No arrival',
    tr: 'Girişe kapalı' },
  'rate.ctd': {
    de: 'Keine Abreise',
    en: 'No departure',
    tr: 'Çıkışa kapalı' },
  'rate.unchangedField': {
    de: 'unverändert',
    en: 'unchanged',
    tr: 'değişmedi' },
  'rate.clear': {
    de: 'löschen',
    en: 'clear',
    tr: 'sil' },
  'rate.legend': {
    de: 'G geschlossen · A keine Anreise · B keine Abreise · n Mindestaufenthalt',
    en: 'G closed · A no arrival · B no departure · n minimum stay',
    tr: 'G kapalı · A girişe kapalı · B çıkışa kapalı · n asgari konaklama' },
  'rate.plans': {
    de: 'Ratenpläne',
    en: 'Rate plans',
    tr: 'Fiyat planları' },
  'rate.plan.new': {
    de: 'Ratenplan anlegen',
    en: 'Create a rate plan',
    tr: 'Fiyat planı oluştur' },
  'rate.plan.code': {
    de: 'Kürzel',
    en: 'Code',
    tr: 'Kod' },
  'rate.plan.name': {
    de: 'Name',
    en: 'Name',
    tr: 'Ad' },
  'rate.plan.base': {
    de: 'Abgeleitet von',
    en: 'Derived from',
    tr: 'Şundan türetilmiş' },
  'rate.plan.base.none': {
    de: 'eigenständig',
    en: 'standalone',
    tr: 'bağımsız' },
  'rate.plan.deriveKind': {
    de: 'Ableitung',
    en: 'Derivation',
    tr: 'Türetme' },
  'rate.plan.derive.amount': {
    de: 'Betrag in Cent',
    en: 'Amount in cents',
    tr: 'Kuruş cinsinden tutar' },
  'rate.plan.derive.percent': {
    de: 'Prozent',
    en: 'Percent',
    tr: 'Yüzde' },
  'rate.plan.deriveValue': {
    de: 'Wert',
    en: 'Value',
    tr: 'Değer' },
  'rate.plan.deriveHint': {
    de: 'Negativ heißt günstiger: −15 Prozent oder −1000 Cent.',
    en: 'Negative means cheaper: −15 percent or −1000 cents.',
    tr: 'Negatif değer daha ucuz demektir: −15 yüzde veya −1000 kuruş.' },
  'rate.plan.emptyHint': {
    de: 'Eine abgeleitete Rate steht leer da, bis einmal neu '
      + 'gerechnet wurde — ihre Preise liegen als Zahlen vor, '
      + 'nicht als Formel.',
    en: 'A derived rate stays empty until it has been rebuilt once — '
      + 'its prices are stored as numbers, not as a formula.',
    tr: 'Türetilmiş bir fiyat, bir kez yeniden hesaplanana kadar boş görünür — fiyatları formül olarak değil, sayı olarak durur.' },
  'rate.rebuild': {
    de: 'Abgeleitete Raten neu rechnen',
    en: 'Rebuild derived rates',
    tr: 'Türetilmiş fiyatları yeniden hesapla' },
  'rate.rebuild.done': {
    de: 'Tage neu gerechnet, über',
    en: 'days rebuilt, across',
    tr: 'gün yeniden hesaplandı, şu kadar üzerinde:' },
  'rate.rebuild.plan': {
    de: 'abgeleitete Rate',
    en: 'derived rate',
    tr: 'türetilmiş fiyat' },
  'rate.rebuild.plans': {
    de: 'abgeleitete Raten',
    en: 'derived rates',
    tr: 'türetilmiş fiyat' },

  // Was der Channel Manager sieht (B10)
  'cv.title': {
    de: 'Was der Channel Manager sieht',
    en: 'What the channel manager sees',
    tr: 'Channel Manager ne görüyor' },
  'cv.open': {
    de: 'Auslieferung zu diesem Zeitraum ansehen',
    en: 'Show what goes out for this period',
    tr: 'Bu döneme ait gönderimi görüntüle' },
  'cv.intro': {
    de: 'Dieselbe Antwort, die der Channel Manager über die Schnittstelle '
      + 'bekommt — nur lesbar dargestellt. Das Raster darüber zeigt den '
      + 'Pflegestand; hier steht, was das Haus verlässt.',
    en: 'The same answer the channel manager gets over the interface — just '
      + 'readable. The grid above shows what is maintained; this shows what '
      + 'leaves the property.',
    tr: 'Channel Manager\'ın arayüzden aldığı yanıtın aynısı — yalnızca okunur biçimde gösteriliyor. Üstteki ızgara işlenmiş durumu gösterir; burada ise tesisten çıkan şey yazar.' },
  'cv.generatedAt': {
    de: 'Stand',
    en: 'As of',
    tr: 'Durum' },
  'cv.availability': {
    de: 'Verfügbarkeit',
    en: 'Availability',
    tr: 'Müsaitlik' },
  'cv.rates': {
    de: 'Preise und Restriktionen',
    en: 'Rates and restrictions',
    tr: 'Fiyatlar ve kısıtlar' },
  'cv.noPrice': {
    de: 'ohne Preis',
    en: 'without a price',
    tr: 'fiyatsız' },
  'cv.noPriceHint': {
    de: 'Ein Tag ohne Preis geht als „kein Preis“ hinaus und wird drüben '
      + 'nicht verkauft. Das ist der häufigste Grund dafür, dass bei einem '
      + 'Portal nichts oder etwas anderes steht.',
    en: 'A day without a price goes out as “no price” and is not sold over '
      + 'there. That is the most common reason a portal shows nothing or '
      + 'something else.',
    tr: 'Fiyatı olmayan bir gün „fiyat yok“ olarak gider ve karşı tarafta satılmaz. Bir portalda hiçbir şeyin ya da başka bir şeyin görünmesinin en sık nedeni budur.' },
  'cv.closedDays': {
    de: 'gesperrt',
    en: 'closed',
    tr: 'kapalı' },
  'cv.inactiveHint': {
    de: 'Ein stillgelegter Ratenplan steht hier gar nicht: er geht '
      + 'nicht hinaus, auch wenn im Raster noch Preise an ihm hängen.',
    en: 'An inactive rate plan does not appear here at all: it does not '
      + 'go out, even if the grid still carries prices for it.',
    tr: 'Devre dışı bırakılmış bir fiyat planı burada hiç görünmez: ızgarada ona bağlı fiyatlar dursa bile dışarı gitmez.' },
  'cv.days': {
    de: 'Tage',
    en: 'days',
    tr: 'gün' },
  'cv.raw': {
    de: 'Rohdaten dieses Tages',
    en: 'Raw answer for this day',
    tr: 'Bu güne ait ham veri' },
  'cv.raw.hint': {
    de: 'Ein Klick auf ein Datum zeigt die Antwort zu diesem Tag so, wie sie '
      + 'über die Leitung geht.',
    en: 'Clicking a date shows the answer for that day exactly as it goes '
      + 'over the wire.',
    tr: 'Bir tarihe tıklamak, o güne ait yanıtı hattan gittiği hâliyle gösterir.' },
  'cv.raw.close': {
    de: 'Schließen',
    en: 'Close',
    tr: 'Kapat' },
  'cv.empty': {
    de: 'Zu diesem Zeitraum geht nichts hinaus.',
    en: 'Nothing goes out for this period.',
    tr: 'Bu döneme ait dışarı hiçbir şey gitmiyor.' },
} as const satisfies Record<string, LocalizedText>
