import type { LocalizedText } from '@hotelpms/contracts'

/** Tagesgeschaeft: Anreisen, Abreisen, Hausliste. */
export const tagesgeschaeft = {
  'today.arrivals': {
    de: 'Anreisen',
    en: 'Arrivals',
    tr: 'Girişler' },
  'today.departures': {
    de: 'Abreisen',
    en: 'Departures',
    tr: 'Çıkışlar' },
  'today.inhouse': {
    de: 'Im Haus',
    en: 'In house',
    tr: 'Tesiste' },
  'today.checkin': {
    de: 'Check-in',
    en: 'Check in',
    tr: 'Check-in' },
  'today.checkout': {
    de: 'Check-out',
    en: 'Check out',
    tr: 'Check-out' },
  // Kein Check-out: der Gast ist nicht abgereist, er war nie da.
  'today.undoCheckin': {
    de: 'Check-in zurücknehmen',
    en: 'Undo check-in',
    tr: 'Check-in’i geri al' },
  // Der Nachtlauf checkt jede Anreise mit Zimmer ein (0088). Wer trotzdem
  // nicht kam, wird hier No-Show; gebuchte Naechte gehen per Gegenbuchung
  // zurueck, sonstige Posten am Folio bleiben stehen.
  'today.noShow': {
    de: 'Nicht angereist',
    en: 'Did not arrive',
    tr: 'Gelmedi' },
  'today.noShowConfirm': {
    de: 'Gast als nicht angereist markieren? Die Reservierung wird No-Show, das Zimmer '
      + 'frei, und gebuchte Übernachtungen und Kurtaxe werden gegengebucht.',
    en: 'Mark the guest as not arrived? The reservation becomes a no-show, the room is '
      + 'released, and posted nights and city tax are reversed.',
    tr: 'Misafir gelmedi olarak işaretlensin mi? Rezervasyon gelmeyen misafir olur, oda '
      + 'serbest kalır, işlenmiş geceler ve konaklama vergisi ters kayıtla düzeltilir.' },
  'today.undoCheckinConfirm': {
    de: 'Check-in zurücknehmen? Die Reservierung steht danach wieder als erwartete Anreise.',
    en: 'Undo the check-in? The reservation then shows as an expected arrival again.',
    tr: 'Check-in geri alınsın mı? Rezervasyon daha sonra yeniden beklenen giriş olarak görünür.' },
  // Steht nur an Anreisen **ohne** Meldeschein. Hier stand "liegt vor",
  // also das Gegenteil dessen, was das Warnzeichen meint.
  'today.registrationMissing': {
    de: 'Meldeschein fehlt',
    en: 'Registration form missing',
    tr: 'Meldeschein eksik' },
  'today.balance': {
    de: 'Offener Saldo',
    en: 'Open balance',
    tr: 'Açık bakiye' },
  'today.needsRoom': {
    de: 'Kein Zimmer zugewiesen',
    en: 'No room assigned',
    tr: 'Oda atanmamış' },
} as const satisfies Record<string, LocalizedText>
