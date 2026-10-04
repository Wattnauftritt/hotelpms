/**
 * Welchen Referer ein Rahmen fuer eine freigegebene Adresse schickt
 * (Dokument 31).
 *
 * Grundsaetzlich keinen: die Seite gibt sonst preis, von welchem Haus und
 * welchem Bildschirm aus sie aufgerufen wurde. Der YouTube-Player ist die
 * Ausnahme -- ohne Referer verweigert er das Abspielen mit "Fehler 153"
 * (Konfigurationsfehler des Players). Er bekommt deshalb die Herkunft,
 * nicht den Pfad: `strict-origin-when-cross-origin` schickt nach aussen nur
 * `https://app.staygrid.cloud/`.
 */
export function referrerFuer(url: string): 'no-referrer' | 'strict-origin-when-cross-origin' {
  return url.startsWith('https://www.youtube-nocookie.com/embed/')
    ? 'strict-origin-when-cross-origin'
    : 'no-referrer'
}
