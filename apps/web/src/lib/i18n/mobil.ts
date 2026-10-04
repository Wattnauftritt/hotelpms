import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Die Mobilansicht: Leiste unten, Heute, Zimmerplan, Zimmerstatus.
 *
 * Die Beschriftungen der Leiste sind kuerzer als die der Desktop-Leiste
 * ("Plan" statt "Zimmerplan"): fuenf Plaetze auf 390 Pixeln vertragen kein
 * Wort mit zehn Buchstaben.
 */
export const mobil = {
  'mobil.tab.today': {
    de: 'Heute',
    en: 'Today',
    tr: 'Bugün' },
  'mobil.tab.plan': {
    de: 'Plan',
    en: 'Chart',
    tr: 'Plan' },
  'mobil.tab.rooms': {
    de: 'Zimmer',
    en: 'Rooms',
    tr: 'Odalar' },
  'mobil.tab.search': {
    de: 'Suche',
    en: 'Search',
    tr: 'Ara' },
  'mobil.more.screens': {
    de: 'Weitere Bildschirme',
    en: 'More screens',
    tr: 'Diğer ekranlar' },
  'mobil.more.account': {
    de: 'Konto',
    en: 'Account',
    tr: 'Hesap' },
  'mobil.more.desktopHint': {
    de: 'Diese Bildschirme sind für den großen Bildschirm gebaut und lassen sich hier seitlich verschieben.',
    en: 'These screens are built for a large display and scroll sideways here.',
    tr: 'Bu ekranlar büyük ekran için tasarlandı ve burada yana kaydırılabilir.' },
  'mobil.plan.day': {
    de: 'Tag',
    en: 'Day',
    tr: 'Gün' },
  'mobil.plan.week': {
    de: 'Woche',
    en: 'Week',
    tr: 'Hafta' },
  'mobil.plan.all': {
    de: 'Alle',
    en: 'All',
    tr: 'Tümü' },
  'mobil.plan.onlyFree': {
    de: 'nur frei',
    en: 'free only',
    tr: 'sadece boş' },
  'mobil.plan.rooms': {
    de: '{n} Zi.',
    en: '{n} rms',
    tr: '{n} oda' },
  'mobil.plan.noFloor': {
    de: 'Ohne Etage',
    en: 'No floor',
    tr: 'Katsız' },
  'mobil.plan.floor': {
    de: 'Etage {n}',
    en: 'Floor {n}',
    tr: 'Kat {n}' },
  'mobil.plan.option': {
    de: 'Option',
    en: 'Option',
    tr: 'Opsiyon' },
  'mobil.plan.empty': {
    de: 'Kein Zimmer passt zum Filter.',
    en: 'No room matches the filter.',
    tr: 'Filtreye uyan oda yok.' },
  'mobil.count.free': {
    de: '{n} frei',
    en: '{n} free',
    tr: '{n} boş' },
  'mobil.count.arrivals': {
    de: '{n} Anreisen',
    en: '{n} arrivals',
    tr: '{n} giriş' },
  'mobil.count.departures': {
    de: '{n} Abreisen',
    en: '{n} departures',
    tr: '{n} çıkış' },
  'mobil.count.blocked': {
    de: '{n} gesperrt',
    en: '{n} blocked',
    tr: '{n} kapalı' },
  'mobil.lage.frei': {
    de: 'frei',
    en: 'free',
    tr: 'boş' },
  'mobil.lage.belegt': {
    de: 'belegt',
    en: 'occupied',
    tr: 'dolu' },
  'mobil.lage.anreise': {
    de: 'Anreise',
    en: 'Arrival',
    tr: 'Giriş' },
  'mobil.lage.abreise': {
    de: 'Abreise',
    en: 'Departure',
    tr: 'Çıkış' },
  'mobil.lage.wechsel': {
    de: 'Ab- und Anreise',
    en: 'Departure and arrival',
    tr: 'Çıkış ve giriş' },
  'mobil.lage.gesperrt': {
    de: 'gesperrt',
    en: 'blocked',
    tr: 'kapalı' },
  'mobil.night': {
    de: '1 Nacht',
    en: '1 night',
    tr: '1 gece' },
  'mobil.nights': {
    de: '{n} Nächte',
    en: '{n} nights',
    tr: '{n} gece' },
  'mobil.persons': {
    de: '{n} Pers.',
    en: '{n} pax',
    tr: '{n} kişi' },
  'mobil.today.noRoom': {
    de: 'kein Zimmer',
    en: 'no room',
    tr: 'oda yok' },
  'mobil.today.folio': {
    de: 'Konto',
    en: 'Folio',
    tr: 'Folyo' },
  'mobil.hk.all': {
    de: 'Alle',
    en: 'All',
    tr: 'Tümü' },
  'mobil.hk.priority': {
    de: 'Vorrang',
    en: 'Priority',
    tr: 'Öncelikli' },
  'mobil.hk.toClean': {
    de: 'Sauber',
    en: 'Clean',
    tr: 'Temiz' },
  'mobil.hk.toInspected': {
    de: 'Kontrolliert',
    en: 'Inspected',
    tr: 'Kontrol edildi' }
} as const satisfies Record<string, LocalizedText>
