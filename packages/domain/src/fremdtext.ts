/**
 * Text aus einem fremden System, bevor er bei uns liegt (Bedrohungsanalyse
 * 23.10.2026, T10).
 *
 * Eine Buchung aus dem Kanal kommt aus einem System, das wir nicht pruefen
 * koennen, und der Gastname darin stammt von irgendwem. Er landet auf der
 * Rechnung, im Meldeschein, in der Gastpost und im DATEV-Stapel. Das Audit
 * vom 19.10.2026 hat gezeigt, was ein einzelnes `\u0001` dort anrichtet:
 * das XML der E-Rechnung ist ungueltig. Richtungszeichen (U+202E und
 * Verwandte) drehen einen Namen in der Anzeige um, ohne dass man es sieht --
 * der Baustein jeder gefaelschten Absenderzeile.
 *
 * **Gekuerzt, nicht abgewiesen.** Eine abgewiesene Kanalbuchung bleibt beim
 * Anbieter liegen und fehlt im Plan; ein Name mit 300 Zeichen ist kein
 * Grund, ein Zimmer zweimal zu verkaufen.
 */

// Steuerzeichen ausser Zeilenumbruch und Tabulator, dazu die unsichtbaren
// Richtungs- und Formatzeichen, die eine Anzeige verfaelschen koennen.
const UNSICHTBAR = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb]', 'g')

/**
 * Bereinigt und kuerzt. `mehrzeilig` laesst Zeilenumbrueche stehen (fuer
 * Notizen); sonst wird jeder Weissraum zu einem Leerzeichen. Leer heisst
 * `undefined`, damit ein Feld aus lauter Steuerzeichen nicht als leerer
 * Name gespeichert wird.
 */
export function fremdText(
  wert: unknown, max: number, mehrzeilig = false
): string | undefined {
  if (typeof wert !== 'string') return undefined
  let s = wert.normalize('NFC').replace(UNSICHTBAR, '').replace(/\r\n?/g, '\n')
  s = mehrzeilig
    ? s.replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    : s.replace(/\s+/g, ' ')
  s = s.trim()
  if (s.length === 0) return undefined
  // Nach Codepunkten, nicht nach UTF-16-Einheiten: sonst zerschnitte die
  // Grenze ein Emoji in eine halbe Ersatzfolge, die kein XML mehr annimmt.
  const zeichen = Array.from(s)
  return zeichen.length <= max ? s : zeichen.slice(0, max).join('').trimEnd()
}

/** Eine Mailadresse oder nichts. Eine kaputte wird verworfen, nicht repariert. */
export function fremdEmail(wert: unknown): string | undefined {
  const s = fremdText(wert, 254)
  if (s === undefined) return undefined
  return /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(s) ? s : undefined
}

/** Eine Rufnummer: nur, was in einer Rufnummer vorkommt. */
export function fremdTelefon(wert: unknown): string | undefined {
  const s = fremdText(wert, 40)
  if (s === undefined) return undefined
  return /^\+?[0-9 ()./-]{3,40}$/.test(s) ? s : undefined
}
