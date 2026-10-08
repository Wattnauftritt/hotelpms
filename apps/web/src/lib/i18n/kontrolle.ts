import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Kontrolle durch die Hausdame (Migration 0109, Baustein 4 des
 * Personalsystems). Dieselbe Seite wie in der Personal-App, fuer die
 * Hausdame am Rechner.
 */
export const kontrolle = {
  'nav.inspection': {
    de: 'Kontrolle',
    en: 'Inspection',
    tr: 'Kontrol' },
  'inspection.summary': {
    de: '{passed} kontrolliert · {open} zu kontrollieren · {todo} noch nicht gereinigt',
    en: '{passed} inspected · {open} to inspect · {todo} not cleaned yet',
    tr: '{passed} kontrol edildi · {open} kontrol edilecek · {todo} henüz temizlenmedi' },
  'inspection.hint': {
    de: 'Kontrolliert macht das Zimmer bezugsfertig; die Rezeption sieht es sofort im Zimmerplan. Nacharbeiten schickt es mit deinem Satz zurück an die Kraft.',
    en: 'Inspected makes the room ready for the next guest; reception sees it in the room plan right away. Rework sends it back to the cleaner with your note.',
    tr: 'Kontrol edildi odayı bir sonraki misafir için hazır yapar; resepsiyon bunu oda planında hemen görür. Yeniden yap, notunuzla birlikte odayı temizlik personeline geri gönderir.' },
  'inspection.legend': {
    de: 'Weiß offen · … Gast noch da · ✓ gereinigt, prüfen · ✓✓ kontrolliert · ↺ nacharbeiten · ⊘ Gast will keine (rot: heute gesperrt) · ↘ Anreise · ⚠ Problem gemeldet',
    en: 'White open · … guest still in · ✓ cleaned, inspect · ✓✓ inspected · ↺ rework · ⊘ guest declined (red: locked today) · ↘ arrival · ⚠ problem reported',
    tr: 'Beyaz açık · … misafir hâlâ odada · ✓ temizlendi, kontrol et · ✓✓ kontrol edildi · ↺ yeniden yap · ⊘ misafir istemedi (kırmızı: bugün kilitli) · ↘ varış · ⚠ sorun bildirildi' },
  'inspection.empty': {
    de: 'Für heute ist noch kein Zimmer geplant.',
    en: 'No rooms are planned for today yet.',
    tr: 'Bugün için henüz planlanmış oda yok.' },
  'inspection.filterOpen': {
    de: 'Nur zu kontrollieren',
    en: 'Only to inspect',
    tr: 'Yalnızca kontrol edilecekler' },
  'inspection.room': {
    de: 'Zimmer',
    en: 'Room',
    tr: 'Oda' },
  'inspection.staff': {
    de: 'Kraft',
    en: 'Cleaner',
    tr: 'Temizlik görevlisi' },
  'inspection.state': {
    de: 'Stand',
    en: 'State',
    tr: 'Durum' },
  'inspection.unassigned': {
    de: 'nicht zugeteilt',
    en: 'not assigned',
    tr: 'atanmadı' },
  'inspection.notCleaned': {
    de: 'noch nicht gereinigt',
    en: 'not cleaned yet',
    tr: 'henüz temizlenmedi' },
  'inspection.waitingCheckout': {
    de: 'Gast noch nicht ausgecheckt',
    en: 'guest not checked out yet',
    tr: 'misafir henüz çıkış yapmadı' },
  'inspection.cleaned': {
    de: 'gereinigt',
    en: 'cleaned',
    tr: 'temizlendi' },
  'inspection.declined': {
    de: 'Gast will keine Reinigung',
    en: 'guest declined cleaning',
    tr: 'misafir temizlik istemedi' },
  'inspection.wasClean': {
    de: 'war schon sauber',
    en: 'was already clean',
    tr: 'zaten temizdi' },
  'inspection.passed': {
    de: 'Kontrolliert',
    en: 'Inspected',
    tr: 'Kontrol edildi' },
  'inspection.rework': {
    de: 'Nacharbeiten',
    en: 'Rework',
    tr: 'Yeniden yap' },
  'inspection.reworkPlaceholder': {
    de: 'Was fehlt?',
    en: 'What is missing?',
    tr: 'Eksik olan ne?' },
  'inspection.undo': {
    de: 'Zurücknehmen',
    en: 'Undo',
    tr: 'Geri al' },
  'inspection.cancel': {
    de: 'Abbrechen',
    en: 'Cancel',
    tr: 'Vazgeç' },
  'inspection.problems': {
    de: '{n} offene Meldung(en)',
    en: '{n} open report(s)',
    tr: '{n} açık bildirim' }
} satisfies Record<string, LocalizedText>
