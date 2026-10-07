import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Fruehstueckszahl (Migration 0110, Baustein 5 des Personalsystems).
 * Dieselbe Seite wie in der Personal-App, fuer Hausdame und Rezeption am
 * Rechner.
 */
export const kueche = {
  'nav.breakfast': {
    de: 'Frühstück',
    en: 'Breakfast',
    tr: 'Kahvaltı' },
  'breakfast.today': {
    de: 'Heute',
    en: 'Today',
    tr: 'Bugün' },
  'breakfast.tomorrow': {
    de: 'Morgen',
    en: 'Tomorrow',
    tr: 'Yarın' },
  'breakfast.children': {
    de: 'davon Kinder: {n}',
    en: 'children: {n}',
    tr: 'çocuk: {n}' },
  'breakfast.week': {
    de: 'Nächste Tage',
    en: 'Next days',
    tr: 'Sonraki günler' },
  'breakfast.rule': {
    de: 'Gezählt werden die Gäste der Vornacht: kein Frühstück am Anreisetag, eines am Abreisetag.',
    en: 'Counted are the guests of the night before: no breakfast on the arrival day, one on the departure day.',
    tr: 'Önceki gecenin misafirleri sayılır: varış gününde kahvaltı yok, ayrılış gününde bir kahvaltı var.' },
  'breakfast.assumed': {
    de: 'Heute geschätzt: {n} Personen ohne genaue Angabe, gezählt mit der vollen Zimmerbelegung.',
    en: 'Estimated today: {n} guests without an exact count, counted at full room occupancy.',
    tr: 'Bugün tahmini: kesin sayısı bilinmeyen {n} kişi, tam oda kapasitesiyle sayıldı.' }
} satisfies Record<string, LocalizedText>
