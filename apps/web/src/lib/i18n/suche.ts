import type { LocalizedText } from '@hotelpms/contracts'

/** Schnellsuche im Belegungsplan und Detailsuche hinter Strg+K. */
export const suche = {
  'suche.button': {
    de: 'Suchen',
    en: 'Search',
    tr: 'Ara' },
  'suche.shortcut': {
    de: 'Strg+K',
    en: 'Ctrl+K',
    tr: 'Ctrl+K' },
  'suche.title': {
    de: 'Suche',
    en: 'Search',
    tr: 'Arama' },
  'suche.placeholder': {
    de: 'Name, Begleitperson, Reservierungs- oder Buchungsnummer, E-Mail',
    en: 'Name, companion, reservation or booking number, email',
    tr: 'Ad, refakatçi, rezervasyon veya kayıt numarası, e-posta' },
  'suche.planPlaceholder': {
    de: 'Im Plan suchen …',
    en: 'Search the chart …',
    tr: 'Planda ara …' },
  'suche.minChars': {
    de: 'Ab zwei Zeichen',
    en: 'From two characters',
    tr: 'En az iki karakter' },
  'suche.noResults': {
    de: 'Nichts gefunden',
    en: 'Nothing found',
    tr: 'Sonuç bulunamadı' },
  'suche.more': {
    de: 'Weitere Treffer – genauer suchen',
    en: 'More matches – narrow the search',
    tr: 'Daha fazla sonuç – aramayı daraltın' },
  'suche.filter.all': {
    de: 'Alle',
    en: 'All',
    tr: 'Tümü' },
  'suche.filter.reservation': {
    de: 'Reservierung',
    en: 'Reservation',
    tr: 'Rezervasyon' },
  'suche.filter.customer': {
    de: 'Kunde',
    en: 'Customer',
    tr: 'Müşteri' },
  'suche.group.reservation': {
    de: 'Reservierung',
    en: 'Reservation',
    tr: 'Rezervasyon' },
  'suche.group.customer': {
    de: 'Kunde',
    en: 'Customer',
    tr: 'Müşteri' },
  'suche.group.command': {
    de: 'Befehl',
    en: 'Command',
    tr: 'Komut' },
  'suche.command.newReservation': {
    de: 'Neue Reservierung',
    en: 'New reservation',
    tr: 'Yeni rezervasyon' },
  'suche.command.newGuest': {
    de: 'Neuer Gast',
    en: 'New guest',
    tr: 'Yeni misafir' },
  'suche.command.newCompany': {
    de: 'Neue Firma',
    en: 'New company',
    tr: 'Yeni firma' },
  'suche.footer.navigate': {
    de: 'Navigieren',
    en: 'Navigate',
    tr: 'Gezin' },
  'suche.footer.select': {
    de: 'Auswählen',
    en: 'Select',
    tr: 'Seç' },
  'suche.footer.close': {
    de: 'Schließen',
    en: 'Close',
    tr: 'Kapat' },
  'suche.footer.filter': {
    de: 'Filter',
    en: 'Filter',
    tr: 'Filtre' },
  'suche.noRoom': {
    de: 'ohne Zimmer',
    en: 'no room',
    tr: 'odasız' },
  'suche.with': {
    de: 'mit {namen}',
    en: 'with {namen}',
    tr: '{namen} ile' },
  'suche.reservations': {
    de: 'Reservierungen: {n}',
    en: 'Reservations: {n}',
    tr: 'Rezervasyonlar: {n}' },
  'suche.company': {
    de: 'Firma',
    en: 'Company',
    tr: 'Firma' },
  'suche.inHouse': {
    de: 'Im Haus',
    en: 'In house',
    tr: 'Otelde' },
  'suche.matchedCompanion': {
    de: 'Begleitperson',
    en: 'Companion',
    tr: 'Refakatçi' },
  'suche.newReservationHint': {
    de: 'Für eine neue Reservierung Zimmergruppe und Anreisetag im Raster anklicken – die Buchungsmaske öffnet sich.',
    en: 'For a new reservation, click room type and arrival day in the grid – the booking form opens.',
    tr: 'Yeni rezervasyon için tabloda oda tipini ve varış gününü tıklayın – rezervasyon formu açılır.' },
  'suche.mark.inquired': {
    de: 'Anfrage',
    en: 'Inquiry',
    tr: 'Talep' },
  'suche.mark.optional': {
    de: 'Option',
    en: 'Option',
    tr: 'Opsiyon' },
  'suche.mark.confirmed': {
    de: 'Bestätigt',
    en: 'Confirmed',
    tr: 'Onaylandı' },
  'suche.mark.inHouse': {
    de: 'Eingecheckt',
    en: 'Checked in',
    tr: 'Giriş yaptı' },
  'suche.mark.checkedOut': {
    de: 'Abgereist',
    en: 'Checked out',
    tr: 'Çıkış yaptı' },
  'suche.mark.past': {
    de: 'Vergangenheit',
    en: 'Past',
    tr: 'Geçmiş' },
  'suche.mark.canceled': {
    de: 'Storniert',
    en: 'Cancelled',
    tr: 'İptal edildi' },
  'suche.mark.noShow': {
    de: 'No-Show',
    en: 'No show',
    tr: 'No-Show' }
} as const satisfies Record<string, LocalizedText>
