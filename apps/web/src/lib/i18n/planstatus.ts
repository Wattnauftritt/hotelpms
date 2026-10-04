import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Reinigungs- und Zahlungsstand im Belegungsplan.
 *
 * Eine eigene Datei und nicht `plan.ts`: am Plan arbeiten mehrere zugleich,
 * und zwei Bearbeiter am Ende derselben Datei sind ein Konflikt bei jedem
 * Zusammenfuehren. Die Woerter fuer die Zustaende selbst stehen in
 * `housekeeping.ts` (`hk.dirty` ...) -- der Plan nennt denselben Zustand
 * mit demselben Wort wie der Housekeeping-Bildschirm.
 */
export const planstatus = {
  'ps.hk.title': {
    de: 'Reinigung: {status}',
    en: 'Housekeeping: {status}',
    tr: 'Temizlik: {status}' },
  'ps.hk.markClean': {
    de: 'Als sauber markieren',
    en: 'Mark as clean',
    tr: 'Temiz olarak işaretle' },
  'ps.hk.markCleanN': {
    de: '{n} Zimmer als sauber markieren',
    en: 'Mark {n} rooms as clean',
    tr: '{n} odayı temiz olarak işaretle' },
  'ps.hk.markDirty': {
    de: 'Als schmutzig markieren',
    en: 'Mark as dirty',
    tr: 'Kirli olarak işaretle' },
  'ps.hk.markDirtyN': {
    de: '{n} Zimmer als schmutzig markieren',
    en: 'Mark {n} rooms as dirty',
    tr: '{n} odayı kirli olarak işaretle' },
  'ps.hk.markInspected': {
    de: 'Als kontrolliert markieren',
    en: 'Mark as inspected',
    tr: 'Kontrol edildi olarak işaretle' },
  'ps.hk.markInspectedN': {
    de: '{n} Zimmer als kontrolliert markieren',
    en: 'Mark {n} rooms as inspected',
    tr: '{n} odayı kontrol edildi olarak işaretle' },
  'ps.legend.hk': {
    de: 'Reinigung',
    en: 'Housekeeping',
    tr: 'Temizlik' },
  'ps.legend.pay': {
    de: 'Zahlung',
    en: 'Payment',
    tr: 'Ödeme' },
  'ps.pay.none': {
    de: 'Noch nichts aufs Konto gebucht, nichts gezahlt',
    en: 'Nothing charged to the account or paid yet',
    tr: 'Henüz hesaba kayıt veya ödeme yok' },
  'ps.pay.requested': {
    de: 'Zahlung angefordert',
    en: 'Payment requested',
    tr: 'Ödeme talep edildi' },
  'ps.pay.open': {
    de: 'Offen',
    en: 'Unpaid',
    tr: 'Ödenmedi' },
  'ps.pay.partial': {
    de: 'Teilweise bezahlt',
    en: 'Partly paid',
    tr: 'Kısmen ödendi' },
  'ps.pay.deposit': {
    de: 'Anzahlung eingegangen',
    en: 'Deposit received',
    tr: 'Ön ödeme alındı' },
  'ps.pay.paid': {
    de: 'Bezahlt',
    en: 'Paid',
    tr: 'Ödendi' },
  'ps.pay.title': {
    de: 'Zahlung: {state}',
    en: 'Payment: {state}',
    tr: 'Ödeme: {state}' },
  'ps.pay.figures': {
    de: 'gezahlt {paid} von {expected} erwartet · Saldo {balance}',
    en: 'paid {paid} of {expected} expected · balance {balance}',
    tr: 'beklenen {expected} tutarın {paid} kadarı ödendi · bakiye {balance}' },
  'ps.pay.unpostedOne': {
    de: 'Eine Nacht noch nicht aufs Konto gebucht',
    en: 'One night not yet posted',
    tr: 'Bir gece henüz kaydedilmedi' },
  'ps.pay.unposted': {
    de: '{n} Nächte noch nicht aufs Konto gebucht',
    en: '{n} nights not yet posted',
    tr: '{n} gece henüz kaydedilmedi' },
  'ps.pay.depositPart': {
    de: 'davon über Anzahlungsrechnung {amount}',
    en: 'of which by deposit invoice {amount}',
    tr: 'bunun {amount} kadarı ön ödeme faturasıyla' },
  'ps.pay.linkOpen': {
    de: 'Zahlungslink offen über {amount}',
    en: 'Payment link open for {amount}',
    tr: '{amount} tutarında ödeme bağlantısı açık' },
  'ps.pay.routed': {
    de: 'Logis geht auf ein anderes Konto',
    en: 'Accommodation is routed to another account',
    tr: 'Konaklama başka bir hesaba yönlendiriliyor' },
  'ps.pay.group': {
    de: 'Gruppe ({n} Zimmer): {state} · gezahlt {paid} von {expected}',
    en: 'Group ({n} rooms): {state} · paid {paid} of {expected}',
    tr: 'Grup ({n} oda): {state} · {expected} tutarın {paid} kadarı ödendi' },
  /*
   * Preis und Notizen im Titel des Balkens. "Gesamtpreis" ist die Summe
   * der Naechte, ohne Extras: was der Gast insgesamt schuldet, sagt der
   * Zahlungsstand darunter, und der braucht das Folio-Recht.
   */
  'ps.persons': {
    de: '{n} P.',
    en: '{n} p.',
    tr: '{n} k.' },
  'ps.personsTitle': {
    de: '{n} Personen',
    en: '{n} guests',
    tr: '{n} kişi' },
  'ps.personsSplit': {
    de: '{n} Personen ({a} Erw., {k} Ki.)',
    en: '{n} guests ({a} adults, {k} children)',
    tr: '{n} kişi ({a} yetişkin, {k} çocuk)' },
  'ps.price.night': {
    de: 'Preis pro Nacht: {price}',
    en: 'Price per night: {price}',
    tr: 'Gecelik fiyat: {price}' },
  'ps.price.nightRange': {
    de: 'Preis pro Nacht: {min} bis {max}',
    en: 'Price per night: {min} to {max}',
    tr: 'Gecelik fiyat: {min} ile {max} arası' },
  'ps.price.stayOne': {
    de: 'Gesamtpreis (1 Nacht): {total}',
    en: 'Total price (1 night): {total}',
    tr: 'Toplam fiyat (1 gece): {total}' },
  'ps.price.stay': {
    de: 'Gesamtpreis ({n} Nächte): {total}',
    en: 'Total price ({n} nights): {total}',
    tr: 'Toplam fiyat ({n} gece): {total}' },
  'ps.notes.reservation': {
    de: 'Notiz zur Reservierung:',
    en: 'Reservation note:',
    tr: 'Rezervasyon notu:' },
  'ps.notes.guest': {
    de: 'Notizen zum Gast:',
    en: 'Guest notes:',
    tr: 'Misafir notları:' },
} as const satisfies Record<string, LocalizedText>
