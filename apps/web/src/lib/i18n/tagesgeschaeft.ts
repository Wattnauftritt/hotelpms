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
  'today.registered': {
    de: 'Meldeschein liegt vor',
    en: 'Registration form on file',
    tr: 'Meldeschein mevcut' },
  'today.balance': {
    de: 'Offener Saldo',
    en: 'Open balance',
    tr: 'Açık bakiye' },
  'today.needsRoom': {
    de: 'Kein Zimmer zugewiesen',
    en: 'No room assigned',
    tr: 'Oda atanmamış' },
} as const satisfies Record<string, LocalizedText>
