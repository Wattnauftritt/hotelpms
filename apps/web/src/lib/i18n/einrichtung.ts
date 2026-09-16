import type { LocalizedText } from '@hotelpms/contracts'

/** Einrichtung: Zimmergruppen und Zimmer. */
export const einrichtung = {
  'setup.title': {
    de: 'Einrichtung des Hauses',
    en: 'Property setup',
    tr: 'Tesis kurulumu' },
  'setup.bookable': {
    de: 'Buchbar',
    en: 'Bookable',
    tr: 'Rezervasyona açık' },
  'setup.notBookable': {
    de: 'Noch nicht buchbar',
    en: 'Not bookable yet',
    tr: 'Henüz rezervasyona kapalı' },
  'setup.complete': {
    de: 'Vollständig eingerichtet',
    en: 'Setup complete',
    tr: 'Kurulum tamamlandı' },
  'setup.nextStep': {
    de: 'Nächster Schritt',
    en: 'Next step',
    tr: 'Sonraki adım' },
  'setup.categories': {
    de: 'Zimmergruppen',
    en: 'Room types',
    tr: 'Oda tipleri' },
  'setup.newCategory': {
    de: 'Neue Zimmergruppe',
    en: 'New room type',
    tr: 'Yeni oda tipi' },
  'setup.code': {
    de: 'Kürzel',
    en: 'Code',
    tr: 'Kod' },
  'setup.name': {
    de: 'Bezeichnung',
    en: 'Name',
    tr: 'Tanım' },
  'setup.maxOccupancy': {
    de: 'Personen je Einheit',
    en: 'People per unit',
    tr: 'Birim başına kişi' },
  'setup.activeRooms': {
    de: 'Aktive Zimmer',
    en: 'Active rooms',
    tr: 'Aktif odalar' },
  'setup.series': {
    de: 'Zimmerserie anlegen',
    en: 'Create room series',
    tr: 'Oda serisi oluştur' },
  'setup.prefix': {
    de: 'Vorsatz',
    en: 'Prefix',
    tr: 'Ön ek' },
  'setup.suffix': {
    de: 'Nachsatz',
    en: 'Suffix',
    tr: 'Son ek' },
  'setup.numberFrom': {
    de: 'Nummer von',
    en: 'Number from',
    tr: 'Numara başlangıcı' },
  'setup.numberTo': {
    de: 'Nummer bis',
    en: 'Number to',
    tr: 'Numara bitişi' },
  'setup.pad': {
    de: 'Stellen mit führender Null',
    en: 'Digits, zero padded',
    tr: 'Başına sıfır eklenerek basamak sayısı' },
  'setup.floor': {
    de: 'Etage',
    en: 'Floor',
    tr: 'Kat' },
  'setup.skip': {
    de: 'Nummern auslassen',
    en: 'Skip numbers',
    tr: 'Atlanacak numaralar' },
  'setup.skipHint': {
    de: 'Mit Komma getrennt, etwa 13, 404',
    en: 'Comma separated, e.g. 13, 404',
    tr: 'Virgülle ayrılmış, örneğin 13, 404' },
  'setup.seriesPreview': {
    de: 'Diese Nummern entstehen',
    en: 'These numbers will be created',
    tr: 'Oluşacak numaralar' },
  'setup.seriesExists': {
    de: 'Schon vergeben',
    en: 'Already taken',
    tr: 'Zaten kullanımda' },
  'setup.seriesResult': {
    de: 'Zimmer angelegt',
    en: 'Rooms created',
    tr: 'Oda oluşturuldu' },
  'setup.seriesEmpty': {
    de: 'Alle Nummern der Serie gibt es bereits.',
    en: 'Every number in this series already exists.',
    tr: 'Serideki bütün numaralar zaten var.' },
} as const satisfies Record<string, LocalizedText>
