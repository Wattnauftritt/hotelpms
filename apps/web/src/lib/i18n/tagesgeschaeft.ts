import type { LocalizedText } from '@hotelpms/contracts'

/** Tagesgeschaeft: Anreisen, Abreisen, Hausliste. */
export const tagesgeschaeft = {
  'today.arrivals': {
    de: 'Anreisen',
    en: 'Arrivals' },
  'today.departures': {
    de: 'Abreisen',
    en: 'Departures' },
  'today.inhouse': {
    de: 'Im Haus',
    en: 'In house' },
  'today.checkin': {
    de: 'Check-in',
    en: 'Check in' },
  'today.checkout': {
    de: 'Check-out',
    en: 'Check out' },
  'today.registered': {
    de: 'Meldeschein liegt vor',
    en: 'Registration form on file' },
  'today.balance': {
    de: 'Offener Saldo',
    en: 'Open balance' },
  'today.needsRoom': {
    de: 'Kein Zimmer zugewiesen',
    en: 'No room assigned' },
} as const satisfies Record<string, LocalizedText>
