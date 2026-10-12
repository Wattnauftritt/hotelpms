import { createContext, useContext } from 'react'
import { FOLDER_LOCALES, type FolderLocale } from '@hotelpms/contracts'

/**
 * Die Saetze der Gaestemappe, in den Sprachen der Gaeste (Sven,
 * 11.10.2026: de, en, nl, pl wie die Gastpost).
 *
 * **Ein eigener Katalog**, aus demselben Grund wie in der Personal-App: der
 * grosse traegt die Sprachen der Rezeption (`LOCALES`), und Niederlaendisch
 * oder Polnisch fuer zweitausend Saetze der Rezeption zu uebersetzen, die
 * kein Gast sieht, waere Arbeit ohne Leser. In der Mappe ist jede ihrer vier
 * Sprachen vollstaendig -- `satisfies` macht eine vergessene zum Typfehler
 * an genau dem Schluessel.
 *
 * Die Seiten des Hauses selbst schreibt das Haus; sie erscheinen in seiner
 * Fassung, bis die automatische Uebersetzung dazukommt.
 */
type MappeText = { readonly [L in FolderLocale]: string }

const texte = {
  'title': {
    de: 'Gästemappe',
    en: 'Guest folder',
    nl: 'Gastenmap',
    pl: 'Informator dla gości' },
  'language': {
    de: 'Sprache',
    en: 'Language',
    nl: 'Taal',
    pl: 'Język' },
  'loading': {
    de: 'Wird geladen …',
    en: 'Loading …',
    nl: 'Bezig met laden …',
    pl: 'Ładowanie …' },
  'room': {
    de: 'Zimmer {room}',
    en: 'Room {room}',
    nl: 'Kamer {room}',
    pl: 'Pokój {room}' },
  'unknown': {
    de: 'Diese Karte kennen wir nicht. Bitte scannen Sie den Code auf der Karte in Ihrem Zimmer oder fragen Sie an der Rezeption.',
    en: 'We do not recognise this card. Please scan the code on the card in your room or ask at reception.',
    nl: 'We herkennen deze kaart niet. Scan de code op de kaart in uw kamer of vraag het bij de receptie.',
    pl: 'Nie rozpoznajemy tej karty. Proszę zeskanować kod z karty w pokoju lub zapytać w recepcji.' },
  'off': {
    de: 'Die Gästemappe ist gerade nicht verfügbar. Bei Fragen hilft Ihnen die Rezeption gern.',
    en: 'The guest folder is not available at the moment. Reception will be happy to help.',
    nl: 'De gastenmap is op dit moment niet beschikbaar. De receptie helpt u graag.',
    pl: 'Informator jest obecnie niedostępny. Recepcja chętnie pomoże.' },
  'offline': {
    de: 'Keine Verbindung. Prüfen Sie WLAN oder mobile Daten.',
    en: 'No connection. Please check Wi-Fi or mobile data.',
    nl: 'Geen verbinding. Controleer wifi of mobiele data.',
    pl: 'Brak połączenia. Sprawdź Wi-Fi lub dane komórkowe.' },
  'retry': {
    de: 'Erneut versuchen',
    en: 'Try again',
    nl: 'Opnieuw proberen',
    pl: 'Spróbuj ponownie' },
  'wifi.title': {
    de: 'WLAN',
    en: 'Wi-Fi',
    nl: 'Wifi',
    pl: 'Wi-Fi' },
  'wifi.network': {
    de: 'Netzwerk',
    en: 'Network',
    nl: 'Netwerk',
    pl: 'Sieć' },
  'wifi.password': {
    de: 'Passwort',
    en: 'Password',
    nl: 'Wachtwoord',
    pl: 'Hasło' },
  'wifi.noPassword': {
    de: 'Offenes Netz, kein Passwort nötig.',
    en: 'Open network, no password needed.',
    nl: 'Open netwerk, geen wachtwoord nodig.',
    pl: 'Sieć otwarta, hasło nie jest potrzebne.' },
  'wifi.hidden': {
    de: 'Das Netz ist verborgen: bitte den Namen von Hand eingeben.',
    en: 'The network is hidden: please enter its name manually.',
    nl: 'Het netwerk is verborgen: voer de naam handmatig in.',
    pl: 'Sieć jest ukryta: proszę wpisać jej nazwę ręcznie.' },
  'wifi.copy': {
    de: 'Passwort kopieren',
    en: 'Copy password',
    nl: 'Wachtwoord kopiëren',
    pl: 'Kopiuj hasło' },
  'wifi.copied': {
    de: 'Kopiert',
    en: 'Copied',
    nl: 'Gekopieerd',
    pl: 'Skopiowano' },
  'wifi.qr': {
    de: 'Für ein weiteres Gerät: diesen Code mit der Kamera scannen.',
    en: 'For another device: scan this code with the camera.',
    nl: 'Voor een ander apparaat: scan deze code met de camera.',
    pl: 'Dla kolejnego urządzenia: zeskanuj ten kod aparatem.' },
  'times.title': {
    de: 'Anreise und Abreise',
    en: 'Arrival and departure',
    nl: 'Aankomst en vertrek',
    pl: 'Przyjazd i wyjazd' },
  'times.checkin': {
    de: 'Zimmer bereit ab {time} Uhr',
    en: 'Room ready from {time}',
    nl: 'Kamer beschikbaar vanaf {time} uur',
    pl: 'Pokój gotowy od godz. {time}' },
  'times.checkout': {
    de: 'Abreise bis {time} Uhr',
    en: 'Check-out by {time}',
    nl: 'Vertrek uiterlijk om {time} uur',
    pl: 'Wymeldowanie do godz. {time}' }
} as const satisfies Record<string, MappeText>

export type MappeTextKey = keyof typeof texte
export { FOLDER_LOCALES }

export const MappeSprache = createContext<FolderLocale>('de')

/** Die Sprache, mit der die Mappe beginnt: die des Telefons, sonst Englisch. */
export function startSprache(browser: string): FolderLocale {
  const b = browser.slice(0, 2).toLowerCase()
  return (FOLDER_LOCALES as readonly string[]).includes(b) ? b as FolderLocale : 'en'
}

/** Ein Satz in einer Sprache, ohne React -- auch fuer die gedruckte Zimmerkarte. */
export function mappeText(
  k: MappeTextKey, l: FolderLocale, werte: Record<string, string> = {}
): string {
  let s: string = texte[k][l]
  for (const [n, v] of Object.entries(werte)) s = s.replaceAll(`{${n}}`, v)
  return s
}

export function useMappeT(): (k: MappeTextKey, werte?: Record<string, string>) => string {
  const l = useContext(MappeSprache)
  return (k, werte) => mappeText(k, l, werte)
}

/** Fuer den Test des Katalogs: jeder Schluessel, jede Sprache, nichts leer. */
export const MAPPE_TEXTE: Readonly<Record<string, MappeText>> = texte
