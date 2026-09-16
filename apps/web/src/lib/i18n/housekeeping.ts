import type { LocalizedText } from '@hotelpms/contracts'

/** Housekeeping und Zimmerstatus. */
export const housekeeping = {
  'hk.generateTasks': {
    de: 'Aufgaben des Tages erzeugen',
    en: 'Create today’s tasks',
    tr: 'Günün görevlerini oluştur' },
  'hk.tasksCreated': {
    de: '{n} Aufgaben ergänzt',
    en: '{n} tasks added',
    tr: '{n} görev eklendi' },
  'hk.taskDeparture': {
    de: 'Abreisereinigung',
    en: 'Departure clean',
    tr: 'Çıkış temizliği' },
  'hk.taskStayover': {
    de: 'Bleibereinigung',
    en: 'Stayover clean',
    tr: 'Konaklama temizliği' },
  'hk.finishTask': {
    de: 'Erledigt',
    en: 'Done',
    tr: 'Tamamlandı' },
  'hk.dirty': {
    de: 'Schmutzig',
    en: 'Dirty',
    tr: 'Kirli' },
  'hk.clean': {
    de: 'Sauber',
    en: 'Clean',
    tr: 'Temiz' },
  'hk.inspected': {
    de: 'Kontrolliert',
    en: 'Inspected',
    tr: 'Kontrol edildi' },
  'hk.occupied': {
    de: 'Belegt',
    en: 'Occupied',
    tr: 'Dolu' },
  'hk.departureToday': {
    de: 'Abreise heute',
    en: 'Departing today',
    tr: 'Bugün çıkış' },
  'hk.arrivalToday': {
    de: 'Anreise heute',
    en: 'Arriving today',
    tr: 'Bugün giriş' },
  'hk.markClean': {
    de: 'Auf sauber setzen',
    en: 'Mark as clean',
    tr: 'Temiz olarak işaretle' },
  'hk.openTickets': {
    de: 'Offene Meldungen',
    en: 'Open tickets',
    tr: 'Açık bildirimler' },
} as const satisfies Record<string, LocalizedText>
