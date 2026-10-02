import type { LocalizedText } from '@hotelpms/contracts'

/**
 * Hausnotizen am Gastprofil.
 *
 * Ein eigenes Buendel und nicht in `gaeste.ts`: am Gastbildschirm arbeiten
 * mehrere zugleich, und eine gemeinsame Textdatei ist die Stelle, an der sie
 * sich zuverlaessig in die Quere kommen (Dokument 19, §10).
 */
export const hausnotiz = {
  'note.add': {
    de: 'Notiz anlegen',
    en: 'Add note',
    tr: 'Not ekle' },
  'note.save': {
    de: 'Notiz speichern',
    en: 'Save note',
    tr: 'Notu kaydet' },
  'note.placeholder': {
    de: 'z. B. „ebenerdiges Zimmer“, „Zustellbett“',
    en: 'e.g. "ground-floor room", "extra bed"',
    tr: 'örn. „zemin kat oda“, „ilave yatak“' },
  'note.none': {
    de: 'Noch keine Hausnotiz.',
    en: 'No property note yet.',
    tr: 'Henüz tesis notu yok.' },
  'note.by': {
    de: 'von {name}',
    en: 'by {name}',
    tr: '{name} tarafından' },
  'note.remaining': {
    de: 'noch {n} Zeichen',
    en: '{n} characters left',
    tr: '{n} karakter kaldı' },
  'note.saved': {
    de: 'Notiz gespeichert.',
    en: 'Note saved.',
    tr: 'Not kaydedildi.' }
} as const satisfies Record<string, LocalizedText>
