/*
 * Von welchem Bildschirm jemand in die Hilfe kam. Der Knopf in der Kopfleiste
 * merkt es sich hier; das Formular schickt es mit, damit der Support nicht
 * erst fragen muss, wo es klemmt. Im Speicher und nicht in der Adresse: dort
 * stuende neben dem Schluessel bald auch ein Suchbegriff.
 */
let herkunftsBildschirm: string | null = null
export function merkeHerkunft(screen: string | null): void {
  herkunftsBildschirm = screen === 'support' ? herkunftsBildschirm : screen
}
export function herkunft(): string | null {
  return herkunftsBildschirm
}
