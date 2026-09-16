import type { LocalizedText } from '@hotelpms/contracts'

/** Gruppen und Kontingente. */
export const gruppen = {
  'block.title': {
    de: 'Gruppen und Kontingente',
    en: 'Groups and blocks' },
  'block.new': {
    de: 'Kontingent anlegen',
    en: 'Create a block' },
  'block.name': {
    de: 'Bezeichnung',
    en: 'Name' },
  'block.quantity': {
    de: 'Zimmer',
    en: 'Rooms' },
  'block.pickedUp': {
    de: 'Abgerufen',
    en: 'Picked up' },
  'block.remaining': {
    de: 'Noch frei',
    en: 'Still held' },
  'block.releaseDate': {
    de: 'Freigabe ab',
    en: 'Release from' },
  'block.releaseHint': {
    de: 'Ab diesem Tag gibt der Nachtlauf den nicht abgerufenen Rest frei.',
    en: 'From this day the night audit releases whatever was not picked up.' },
  'block.release': {
    de: 'Rest freigeben',
    en: 'Release the remainder' },
  'block.releaseConfirm': {
    de: 'Nicht abgerufene Zimmer wieder in den freien Verkauf geben?',
    en: 'Return the rooms that were not picked up to open sale?' },
  'block.pickups': {
    de: 'Abrufe',
    en: 'Pickups' },
  'block.noPickups': {
    de: 'Noch kein Abruf',
    en: 'Nothing picked up yet' },
  'block.company': {
    de: 'Firma',
    en: 'Company' },
  'block.status.active': {
    de: 'Offen',
    en: 'Open' },
  'block.status.released': {
    de: 'Freigegeben',
    en: 'Released' },
  'block.status.closed': {
    de: 'Geschlossen',
    en: 'Closed' },
  'block.rangeHint': {
    de: 'Ein Abruf läuft über den ganzen Zeitraum des Kontingents.',
    en: 'A pickup runs for the whole period of the block.' },
  'block.showReleased': {
    de: 'Freigegebene zeigen',
    en: 'Show released' },
} as const satisfies Record<string, LocalizedText>
