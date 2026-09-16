import type { LocalizedText } from '@hotelpms/contracts'

/** Housekeeping und Zimmerstatus. */
export const housekeeping = {
  'hk.generateTasks': {
    de: 'Aufgaben des Tages erzeugen',
    en: 'Create today’s tasks' },
  'hk.tasksCreated': {
    de: '{n} Aufgaben ergänzt',
    en: '{n} tasks added' },
  'hk.taskDeparture': {
    de: 'Abreisereinigung',
    en: 'Departure clean' },
  'hk.taskStayover': {
    de: 'Bleibereinigung',
    en: 'Stayover clean' },
  'hk.finishTask': {
    de: 'Erledigt',
    en: 'Done' },
  'hk.dirty': {
    de: 'Schmutzig',
    en: 'Dirty' },
  'hk.clean': {
    de: 'Sauber',
    en: 'Clean' },
  'hk.inspected': {
    de: 'Kontrolliert',
    en: 'Inspected' },
  'hk.occupied': {
    de: 'Belegt',
    en: 'Occupied' },
  'hk.departureToday': {
    de: 'Abreise heute',
    en: 'Departing today' },
  'hk.arrivalToday': {
    de: 'Anreise heute',
    en: 'Arriving today' },
  'hk.markClean': {
    de: 'Auf sauber setzen',
    en: 'Mark as clean' },
  'hk.openTickets': {
    de: 'Offene Meldungen',
    en: 'Open tickets' },
} as const satisfies Record<string, LocalizedText>
