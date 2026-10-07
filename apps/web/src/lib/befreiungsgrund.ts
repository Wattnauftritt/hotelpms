/**
 * Das Kuerzel eines Kurtaxe-Befreiungsgrunds aus dem, was jemand eintippt.
 *
 * Die Datenbank nimmt nur `[a-z0-9_]` (Migration 0089), weil ein Umsystem
 * den Grund unter diesem Kuerzel schickt. Wer "Behinderung" schrieb, sah
 * bisher einen grauen Speichern-Knopf ohne Grund dafuer und legte keinen
 * einzigen Grund an -- das Meldeformular fragte dann niemanden nach einer
 * Befreiung, auch den Hauptgast nicht (Sven, 06.10.2026). Deshalb wird
 * angepasst statt abgewiesen: klein, Umlaute ausgeschrieben, Leerzeichen und
 * Bindestriche als Unterstrich, alles andere faellt weg.
 *
 * Ohne eigenes Kuerzel kommt es aus der Bezeichnung; ein Feld, das jeder
 * leer laesst, soll nicht das Speichern verhindern.
 */
export function kuerzelAus(text: string): string {
  return text.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40)
    .replace(/_$/, '')
}

/** Die AVS-Kategorie aus dem Feld: leer = keine, sonst 1 bis 99. */
export function avsKategorieAus(text: string): number | null | 'ungueltig' {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : 'ungueltig'
}
