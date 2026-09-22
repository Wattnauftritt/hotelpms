import type { LocalizedText } from '@hotelpms/contracts'

/** Gruppen und Kontingente. */
export const gruppen = {
  'block.title': {
    de: 'Gruppen und Kontingente',
    en: 'Groups and blocks',
    tr: 'Gruplar ve kontenjanlar' },
  'pickup.label': {
    de: 'Abruf aus Kontingent',
    en: 'Pick up from a block',
    tr: 'Kontenjandan çekim' },
  'pickup.freeSale': {
    de: '— freier Verkauf —',
    en: '— free sale —',
    tr: '— serbest satış —' },
  'pickup.remaining': {
    de: 'noch {n} frei',
    en: '{n} left',
    tr: '{n} kaldı' },
  'pickup.periodFixed': {
    de: 'Der Zeitraum steht fest: {from} – {to}. Ein Abruf verbraucht das '
      + 'Kontingent ganz; wer andere Tage braucht, bucht frei.',
    en: 'The period is fixed: {from} – {to}. A pickup consumes the whole block; '
      + 'for different dates, book from free sale.',
    tr: 'Tarih aralığı sabit: {from} – {to}. Çekim kontenjanı tümüyle tüketir; '
      + 'farklı tarihler için serbest satıştan rezerve edin.' },
  'pickup.roomDatesBlocked': {
    de: 'Beim Abruf aus einem Kontingent gilt dessen Zeitraum für alle Zimmer.',
    en: 'When picking up from a block, its period applies to every room.',
    tr: 'Kontenjandan çekimde kontenjanın tarih aralığı tüm odalar için geçerlidir.' },
  'block.new': {
    de: 'Kontingent anlegen',
    en: 'Create a block',
    tr: 'Kontenjan oluştur' },
  'block.name': {
    de: 'Bezeichnung',
    en: 'Name',
    tr: 'Tanım' },
  'block.quantity': {
    de: 'Zimmer',
    en: 'Rooms',
    tr: 'Oda' },
  'block.pickedUp': {
    de: 'Abgerufen',
    en: 'Picked up',
    tr: 'Çekilen' },
  'block.remaining': {
    de: 'Noch frei',
    en: 'Still held',
    tr: 'Kalan' },
  'block.releaseDate': {
    de: 'Freigabe ab',
    en: 'Release from',
    tr: 'Serbest bırakma tarihi' },
  'block.releaseHint': {
    de: 'Ab diesem Tag gibt der Nachtlauf den nicht abgerufenen Rest frei.',
    en: 'From this day the night audit releases whatever was not picked up.',
    tr: 'Bu tarihten itibaren gece işlemi, çekilmeyen kalanı serbest bırakır.' },
  'block.release': {
    de: 'Rest freigeben',
    en: 'Release the remainder',
    tr: 'Kalanı serbest bırak' },
  'block.releaseConfirm': {
    de: 'Nicht abgerufene Zimmer wieder in den freien Verkauf geben?',
    en: 'Return the rooms that were not picked up to open sale?',
    tr: 'Çekilmeyen odalar yeniden serbest satışa açılsın mı?' },
  'block.pickups': {
    de: 'Abrufe',
    en: 'Pickups',
    tr: 'Çekimler' },
  'block.noPickups': {
    de: 'Noch kein Abruf',
    en: 'Nothing picked up yet',
    tr: 'Henüz çekim yok' },
  'block.company': {
    de: 'Firma',
    en: 'Company',
    tr: 'Firma' },
  'block.status.active': {
    de: 'Offen',
    en: 'Open',
    tr: 'Açık' },
  'block.status.released': {
    de: 'Freigegeben',
    en: 'Released',
    tr: 'Serbest bırakıldı' },
  'block.status.closed': {
    de: 'Geschlossen',
    en: 'Closed',
    tr: 'Kapalı' },
  'block.rangeHint': {
    de: 'Ein Abruf läuft über den ganzen Zeitraum des Kontingents.',
    en: 'A pickup runs for the whole period of the block.',
    tr: 'Bir çekim, kontenjanın tüm dönemini kapsar.' },
  'block.showReleased': {
    de: 'Freigegebene zeigen',
    en: 'Show released',
    tr: 'Serbest bırakılanları göster' },
} as const satisfies Record<string, LocalizedText>
