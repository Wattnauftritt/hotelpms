import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Einstellung „Zimmer sortieren" (Migration 0104). Die Gewichte heissen so,
 * wie die Rezeption sie meint, nicht wie der Schluessel im Code.
 */
export const zimmerSortieren = {
  'roomSort.title': {
    de: 'Zimmer sortieren',
    en: 'Room sorting',
    tr: 'Oda sıralama' },
  'roomSort.hint': {
    de: 'StayGrid verteilt die Aufenthalte einer Zimmergruppe so auf die Zimmer, dass die besten Zimmer an die Gäste gehen, für die sie sich lohnen, Wünsche aus der Notiz erfüllt werden und Gruppen beieinander liegen. Angereiste Gäste und Aufenthalte mit „Zimmer fest" bleiben, wo sie sind.',
    en: 'StayGrid distributes the stays of a room category across its rooms so that the best rooms go to the guests they pay off for, wishes from the note are met and groups stay together. Checked-in guests and stays marked “room fixed” stay where they are.',
    tr: 'StayGrid bir oda tipindeki konaklamaları odalara dağıtır: en iyi odalar en çok değer katan misafirlere gider, nottaki istekler karşılanır ve gruplar bir arada kalır. Giriş yapmış misafirler ve “oda sabit” işaretli konaklamalar yerinde kalır.' },
  'roomSort.mode': {
    de: 'Sortieren',
    en: 'Sorting',
    tr: 'Sıralama' },
  'roomSort.mode.off': {
    de: 'Nie',
    en: 'Never',
    tr: 'Hiçbir zaman' },
  'roomSort.mode.manual': {
    de: 'Auf Knopfdruck im Kalender',
    en: 'On request in the calendar',
    tr: 'Takvimde düğmeyle' },
  'roomSort.mode.auto': {
    de: 'Automatisch nach jeder Änderung',
    en: 'Automatically after every change',
    tr: 'Her değişiklikten sonra otomatik' },
  'roomSort.keepToday': {
    de: 'Anreisen von heute nicht umsetzen',
    en: 'Do not move today’s arrivals',
    tr: 'Bugünkü girişleri taşıma' },
  'roomSort.keepTodayHint': {
    de: 'Die Reinigung hat das Zimmer für heute vorbereitet, und der Gast steht vielleicht schon an der Rezeption.',
    en: 'Housekeeping has prepared the room for today, and the guest may already be at the desk.',
    tr: 'Kat hizmetleri odayı bugün için hazırladı ve misafir resepsiyonda olabilir.' },
  'roomSort.weights': {
    de: 'Gewichte',
    en: 'Weights',
    tr: 'Ağırlıklar' },
  'roomSort.weightsHint': {
    de: 'Ein leeres Feld nimmt die Vorgabe, die grau darin steht. Die Vorgaben stammen aus der Sortierung, die bisher im Adminpanel lief.',
    en: 'An empty field uses the default shown in grey. The defaults come from the sorting that ran in the Adminpanel so far.',
    tr: 'Boş alan gri gösterilen varsayılanı kullanır. Varsayılanlar şimdiye kadar Adminpanel’de çalışan sıralamadan gelir.' },
  'roomSort.w.pricePercent': {
    de: 'Anteil des Preises an der Wichtigkeit eines Gastes (%), der Rest zählt die Nächte',
    en: 'Share of the price in a guest’s weight (%), the rest counts nights',
    tr: 'Misafir ağırlığında fiyatın payı (%), kalanı geceler' },
  'roomSort.w.topRoomQuality': {
    de: 'Spitzenzimmer ab Qualität',
    en: 'Top room from quality',
    tr: 'Şu kaliteden itibaren en iyi oda' },
  'roomSort.w.cheapGuestMarginCent': {
    de: 'Zu günstig fürs Spitzenzimmer: so viele Cent unter dem Durchschnitt der Gruppe',
    en: 'Too cheap for a top room: this many cents below the category average',
    tr: 'En iyi oda için fazla ucuz: grup ortalamasının bu kadar sent altı' },
  'roomSort.w.topRoomPenalty': {
    de: 'Strafe je Nacht: günstiger Gast im Spitzenzimmer',
    en: 'Penalty per night: cheap guest in a top room',
    tr: 'Gece başı ceza: en iyi odada ucuz misafir' },
  'roomSort.w.wishPenalty': {
    de: 'Strafe je Nacht: Wunsch aus der Notiz nicht erfüllt',
    en: 'Penalty per night: wish from the note not met',
    tr: 'Gece başı ceza: nottaki istek karşılanmadı' },
  'roomSort.w.smallRoomAttribute': {
    de: 'Merkmal der kleinen Zimmer',
    en: 'Attribute of small rooms',
    tr: 'Küçük odaların özelliği' },
  'roomSort.w.smallRoomFromNights': {
    de: 'Kleines Zimmer wird teurer ab Nächten',
    en: 'Small room gets costlier from nights',
    tr: 'Küçük oda şu geceden itibaren pahalılaşır' },
  'roomSort.w.smallRoomPenalty': {
    de: 'Strafe je Nacht und Nacht darüber: langer Aufenthalt im kleinen Zimmer',
    en: 'Penalty per night and night beyond: long stay in a small room',
    tr: 'Gece ve aşan gece başı ceza: küçük odada uzun konaklama' },
  'roomSort.w.groupBuildingPenalty': {
    de: 'Gruppe: Strafe je Paar in verschiedenen Gebäuden',
    en: 'Group: penalty per pair in different buildings',
    tr: 'Grup: farklı binalardaki her çift için ceza' },
  'roomSort.w.groupQualityPenalty': {
    de: 'Gruppe: Strafe je Paar und Punkt Qualitätsunterschied',
    en: 'Group: penalty per pair and point of quality difference',
    tr: 'Grup: her çift ve kalite farkı puanı için ceza' },
  'roomSort.w.groupFloorPenalty': {
    de: 'Gruppe: Strafe je Paar und Etage Abstand',
    en: 'Group: penalty per pair and floor apart',
    tr: 'Grup: her çift ve kat farkı için ceza' },
  'roomSort.w.groupNumberPenaltyMax': {
    de: 'Gruppe: höchste Strafe für den Abstand der Zimmernummern',
    en: 'Group: maximum penalty for distance between room numbers',
    tr: 'Grup: oda numaraları arasındaki mesafe için en yüksek ceza' },
  'roomSort.w.movePenalty': {
    de: 'Strafe je Umsetzen',
    en: 'Penalty per move',
    tr: 'Taşıma başı ceza' },
  'roomSort.wishes': {
    de: 'Wünsche aus der Notiz, eine Zeile je Stichwort: stichwort = Merkmal',
    en: 'Wishes from the note, one line per keyword: keyword = attribute',
    tr: 'Nottaki istekler, anahtar kelime başına bir satır: kelime = özellik' },
  'roomSort.wishesHint': {
    de: '„kein", „ohne" oder „nicht" davor heben den Wunsch auf. Leer lassen nimmt die Vorgabe.',
    en: '“kein”, “ohne” or “nicht” in front cancels the wish. Leave empty for the default.',
    tr: 'Önüne “kein”, “ohne” veya “nicht” gelirse istek geçersiz olur. Varsayılan için boş bırakın.' },
  'roomSort.wishesInvalid': {
    de: 'Jede Zeile braucht ein Stichwort, ein Gleichheitszeichen und ein Merkmal.',
    en: 'Every line needs a keyword, an equals sign and an attribute.',
    tr: 'Her satırda bir kelime, eşittir işareti ve bir özellik olmalı.' },
  'roomSort.saved': {
    de: 'Gespeichert',
    en: 'Saved',
    tr: 'Kaydedildi' },
} as const satisfies Record<string, LocalizedText>
