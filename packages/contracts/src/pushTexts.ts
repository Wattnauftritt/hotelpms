import type { StaffLocale } from './messages.js'

/**
 * Texte der Push-Meldungen an das Personal (Baustein 8, Migration 0113).
 *
 * Hier und nicht im Katalog der Personal-App, weil der Worker sie baut: der
 * Service Worker auf dem Telefon zeigt nur an, was kommt, und hat keinen
 * Katalog. Gebaut wird in der Sprache der Kraft im Augenblick des Sendens --
 * wer seine Sprache umstellt, bekommt die naechste Meldung schon richtig.
 */
export const PUSH_TEXTS = {
  'plan.title': {
    de: 'Reinigungsplan geändert',
    en: 'Cleaning plan changed',
    ru: 'План уборки изменён',
    uk: 'План прибирання змінено' },
  'plan.body': {
    de: 'Deine Zimmer für {date} haben sich geändert.',
    en: 'Your rooms for {date} have changed.',
    ru: 'Ваши номера на {date} изменились.',
    uk: 'Ваші номери на {date} змінилися.' },
  'room_free.title': {
    de: 'Zimmer {room} ist frei',
    en: 'Room {room} is free',
    ru: 'Номер {room} свободен',
    uk: 'Номер {room} вільний' },
  'room_free.body': {
    de: 'Der Gast ist abgereist. Du kannst reinigen.',
    en: 'The guest has left. You can clean now.',
    ru: 'Гость выехал. Можно убирать.',
    uk: 'Гість виїхав. Можна прибирати.' },
  'rework.title': {
    de: 'Zimmer {room}: nacharbeiten',
    en: 'Room {room}: please redo',
    ru: 'Номер {room}: доработать',
    uk: 'Номер {room}: доопрацювати' },
  'rework.body': {
    de: 'Die Hausdame hat etwas gefunden. Details in der App.',
    en: 'The head housekeeper found something. Details in the app.',
    ru: 'Старшая горничная нашла недочёт. Подробности в приложении.',
    uk: 'Старша покоївка знайшла недолік. Подробиці в застосунку.' }
} satisfies Record<string, Record<StaffLocale, string>>

export type PushTextKey = keyof typeof PUSH_TEXTS

/** Platzhalter `{name}` ersetzen; ein fehlender Wert bleibt sichtbar stehen. */
export function renderPushText(
  key: PushTextKey, locale: StaffLocale, params: Record<string, string>
): string {
  return PUSH_TEXTS[key][locale].replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m)
}
