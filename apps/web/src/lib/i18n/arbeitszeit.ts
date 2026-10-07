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
  'worktime.by': {
    de: 'von {name}',
    en: 'by {name}',
    tr: '{name} tarafından' }
} satisfies Record<string, LocalizedText>
