import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Arbeitszeit der Kraefte (Migration 0111, Baustein 6 des
 * Personalsystems): Monatsuebersicht, Korrektur mit Grund, Abschluss und
 * Ausgabe fuer die Zeitarbeitsfirma.
 */
export const arbeitszeit = {
  'nav.worktime': {
    de: 'Arbeitszeit',
    en: 'Working time',
    tr: 'Çalışma süresi' },
  'worktime.hint': {
    de: 'Minuten der gereinigten Zimmer, Zusatzarbeiten und Küchendienste, dazu deine Korrekturen. Die Kräfte sehen ihren eigenen Monat genauso, Korrekturen mit Grund.',
    en: 'Minutes of cleaned rooms, extra work and kitchen shifts, plus your corrections. Staff see their own month the same way, corrections with the reason.',
    tr: 'Temizlenen odaların dakikaları, ek işler ve mutfak vardiyaları ile düzeltmeleriniz. Personel kendi ayını aynı şekilde, düzeltmeleri gerekçesiyle görür.' },
  'worktime.month': {
    de: 'Monat',
    en: 'Month',
    tr: 'Ay' },
  'worktime.name': {
    de: 'Kraft',
    en: 'Staff member',
    tr: 'Personel' },
  'worktime.rooms': {
    de: 'Zimmer',
    en: 'Rooms',
    tr: 'Odalar' },
  'worktime.extra': {
    de: 'Zusatzarbeit',
    en: 'Extra work',
    tr: 'Ek iş' },
  'worktime.kitchen': {
    de: 'Küche',
    en: 'Kitchen',
    tr: 'Mutfak' },
  'worktime.correction': {
    de: 'Korrektur',
    en: 'Correction',
    tr: 'Düzeltme' },
  'worktime.total': {
    de: 'Summe',
    en: 'Total',
    tr: 'Toplam' },
  'worktime.empty': {
    de: 'In diesem Monat hat niemand Arbeitszeit.',
    en: 'Nobody has working time this month.',
    tr: 'Bu ay kimsenin çalışma süresi yok.' },
  'worktime.closedBy': {
    de: 'Abgeschlossen am {date} von {name}',
    en: 'Closed on {date} by {name}',
    tr: '{date} tarihinde {name} tarafından kapatıldı' },
  'worktime.close': {
    de: 'Monat abschließen',
    en: 'Close month',
    tr: 'Ayı kapat' },
  'worktime.closeHint': {
    de: 'Danach ändert sich in diesem Monat nichts mehr: keine Einträge, keine Korrekturen, kein Reinigungsplan.',
    en: 'After that, nothing changes in this month: no entries, no corrections, no cleaning plan.',
    tr: 'Bundan sonra bu ayda hiçbir şey değişmez: kayıt, düzeltme ve temizlik planı yok.' },
  'worktime.reopen': {
    de: 'Wieder öffnen',
    en: 'Reopen',
    tr: 'Yeniden aç' },
  'worktime.reopenReason': {
    de: 'Warum wieder öffnen?',
    en: 'Why reopen?',
    tr: 'Neden yeniden açılıyor?' },
  'worktime.export': {
    de: 'CSV für die Zeitarbeitsfirma',
    en: 'CSV for the staffing agency',
    tr: 'Personel ajansı için CSV' },
  'worktime.exportHint': {
    de: 'Erst nach dem Abschluss: eine Abrechnung, die sich danach noch ändern kann, ist keine.',
    en: 'Only after closing: a statement that can still change is not a statement.',
    tr: 'Yalnızca kapatıldıktan sonra: sonradan değişebilecek bir döküm, döküm değildir.' },
  'worktime.day': {
    de: 'Tag',
    en: 'Day',
    tr: 'Gün' },
  'worktime.roomsCount': {
    de: '{n} Zimmer',
    en: '{n} rooms',
    tr: '{n} oda' },
  'worktime.withdrawn': {
    de: 'zurückgezogen',
    en: 'withdrawn',
    tr: 'geri çekildi' },
  'worktime.correct': {
    de: 'Korrigieren',
    en: 'Correct',
    tr: 'Düzelt' },
  'worktime.minutesSigned': {
    de: 'Minuten (+ oder −)',
    en: 'Minutes (+ or −)',
    tr: 'Dakika (+ veya −)' },
  'worktime.reason': {
    de: 'Grund',
    en: 'Reason',
    tr: 'Neden' },
  'worktime.save': {
    de: 'Korrektur speichern',
    en: 'Save correction',
    tr: 'Düzeltmeyi kaydet' },
  'worktime.translationDe': {
    de: 'Deutsch',
    en: 'German',
    tr: 'Almanca' },
  'worktime.translationManual': {
    de: 'von Hand',
    en: 'edited',
    tr: 'elle' },
  'worktime.editTranslation': {
    de: 'Übersetzung berichtigen',
    en: 'Correct translation',
    tr: 'Çeviriyi düzelt' },
  'worktime.autoTranslation': {
    de: 'automatisch',
    en: 'automatic',
    tr: 'otomatik' },
  'worktime.cancel': {
    de: 'Abbrechen',
    en: 'Cancel',
    tr: 'Vazgeç' },
  'worktime.legacy.title': {
    de: 'Altdaten aus der alten Personal-App',
    en: 'Data from the old staff app',
    tr: 'Eski personel uygulamasından veriler' },
  'worktime.legacy.hint': {
    de: 'Export des Cleaning-Backends hochladen (Dokument 34). Jeder Tag im Ausschnitt wird ersetzt, soweit er aus der alten App kam; was in StayGrid geplant oder eingetragen ist, bleibt. Ein abgeschlossener Monat wird nicht angefasst.',
    en: 'Upload the export from the cleaning backend (document 34). Every day in the range is replaced where it came from the old app; anything planned or entered in StayGrid stays. A closed month is not touched.',
    tr: 'Temizlik arka ucunun dışa aktarımını yükleyin (belge 34). Aralıktaki her gün, eski uygulamadan geldiyse değiştirilir; StayGrid’de planlanan veya girilen her şey kalır. Kapatılmış bir aya dokunulmaz.' },
  'worktime.legacy.notJson': {
    de: 'Die Datei ist kein lesbares JSON.',
    en: 'The file is not readable JSON.',
    tr: 'Dosya okunabilir bir JSON değil.' },
  'worktime.legacy.check': {
    de: 'Prüfen',
    en: 'Check',
    tr: 'Kontrol et' },
  'worktime.legacy.commit': {
    de: 'Übernehmen',
    en: 'Import',
    tr: 'Aktar' },
  'worktime.legacy.recheck': {
    de: 'Zuordnung geändert: bitte erneut prüfen.',
    en: 'Mapping changed: please check again.',
    tr: 'Eşleştirme değişti: lütfen tekrar kontrol edin.' },
  'worktime.legacy.done': {
    de: 'Übernommen.',
    en: 'Imported.',
    tr: 'Aktarıldı.' },
  'worktime.legacy.days': {
    de: 'Ersetzt werden die Tage {from} bis {to} ({n} Tage).',
    en: 'Days {from} to {to} are replaced ({n} days).',
    tr: '{from} ile {to} arasındaki günler değiştirilir ({n} gün).' },
  'worktime.legacy.closedDays': {
    de: '{n} Tage liegen in abgeschlossenen Monaten und bleiben.',
    en: '{n} days are in closed months and stay as they are.',
    tr: '{n} gün kapatılmış aylarda ve olduğu gibi kalıyor.' },
  'worktime.legacy.schedules': {
    de: 'Putzplan',
    en: 'Cleaning plan',
    tr: 'Temizlik planı' },
  'worktime.legacy.entries': {
    de: 'Zusatzarbeiten',
    en: 'Extra work',
    tr: 'Ek işler' },
  'worktime.legacy.counts': {
    de: '{imported} von {total}',
    en: '{imported} of {total}',
    tr: '{total} içinden {imported}' },
  'worktime.legacy.skipStaygrid': {
    de: '{n} Zeilen übersprungen: in StayGrid steht für das Zimmer an dem Tag schon ein Plan.',
    en: '{n} rows skipped: StayGrid already has a plan for the room on that day.',
    tr: '{n} satır atlandı: StayGrid’de o gün oda için zaten bir plan var.' },
  'worktime.legacy.skipUnmapped': {
    de: '{n} Zeilen übersprungen: Person nicht zugeordnet.',
    en: '{n} rows skipped: person not mapped.',
    tr: '{n} satır atlandı: kişi eşleştirilmedi.' },
  'worktime.legacy.skipRoom': {
    de: '{n} Zeilen übersprungen: Zimmer unbekannt ({rooms}).',
    en: '{n} rows skipped: unknown room ({rooms}).',
    tr: '{n} satır atlandı: bilinmeyen oda ({rooms}).' },
  'worktime.legacy.skipClosed': {
    de: '{n} Zeilen übersprungen: Monat abgeschlossen.',
    en: '{n} rows skipped: month closed.',
    tr: '{n} satır atlandı: ay kapatıldı.' },
  'worktime.legacy.oldUser': {
    de: 'Benutzer der alten App',
    en: 'User in the old app',
    tr: 'Eski uygulamadaki kullanıcı' },
  'worktime.legacy.rows': {
    de: 'Zeilen',
    en: 'Rows',
    tr: 'Satır' },
  'worktime.legacy.person': {
    de: 'Person in StayGrid',
    en: 'Person in StayGrid',
    tr: 'StayGrid’deki kişi' },
  'worktime.legacy.skip': {
    de: '– nicht übernehmen –',
    en: '– do not import –',
    tr: '– aktarma –' },
  'worktime.legacy.suggested': {
    de: 'Vorschlag',
    en: 'Suggestion',
    tr: 'Öneri' },
  'worktime.legacy.inactive': {
    de: 'inaktiv',
    en: 'inactive',
    tr: 'pasif' },
  'worktime.by': {
    de: 'von {name}',
    en: 'by {name}',
    tr: '{name} tarafından' },
  // Mehrere Haeuser (0116)
  'worktime.elsewhere': {
    de: '{house} {time}',
    en: '{house} {time}',
    tr: '{house} {time}' },
  'worktime.allHouses': {
    de: 'alle Häuser {time}',
    en: 'all properties {time}',
    tr: 'tüm tesisler {time}' }
} satisfies Record<string, LocalizedText>
