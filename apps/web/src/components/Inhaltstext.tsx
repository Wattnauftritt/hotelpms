import type { ReactNode } from 'react'

/**
 * Der Text einer Terminalseite, in einem bewusst kleinen Format.
 *
 * **Kein HTML, kein Markdown-Paket.** Eine Seite erscheint auf einem
 * Gastbildschirm; was dort steht, schreibt jemand in den Einstellungen.
 * Freies HTML waere ein Weg fuer Skript und fuer Formulare, die nach
 * Zugangsdaten fragen. Darum genau drei Dinge, und alle werden hier zu
 * React-Elementen -- nie zu einem `innerHTML`:
 *
 * - Leerzeile trennt Absaetze, ein Zeilenumbruch bleibt einer.
 * - Zeilen, die mit `- ` beginnen, sind eine Aufzaehlung.
 * - `**so**` ist fett.
 *
 * Keine Verweise: eine Seite am Terminal fuehrt nirgendwohin, wohin die
 * Freigabeliste der Adressen nicht fuehrt.
 */
export function Inhaltstext({ text, gross = false }: { text: string; gross?: boolean }
): JSX.Element {
  const bloecke = text.replace(/\r\n/g, '\n').split(/\n\s*\n/)
    .map(b => b.trim()).filter(b => b !== '')
  return (
    <div className={`space-y-3 ${gross ? 'text-xl leading-relaxed' : 'text-sm'}`}>
      {bloecke.map((b, i) => {
        const zeilen = b.split('\n')
        if (zeilen.every(z => z.trimStart().startsWith('- '))) {
          return (
            <ul key={i} className="list-disc pl-6 space-y-1">
              {zeilen.map((z, j) => <li key={j}>{fett(z.trimStart().slice(2))}</li>)}
            </ul>
          )
        }
        return (
          <p key={i} className="whitespace-pre-line">{fett(b)}</p>
        )
      })}
    </div>
  )
}

/** `**fett**` als <strong>; alles andere bleibt Text. */
export function fett(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/g).map((teil, i) =>
    teil.startsWith('**') && teil.endsWith('**') && teil.length > 4
      ? <strong key={i}>{teil.slice(2, -2)}</strong>
      : teil)
}
