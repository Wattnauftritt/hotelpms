import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { istTerminalAdresse } from '../routes/Terminal.tsx'

/**
 * Das Gaesteterminal und die Hausnotiz, an der Quelle geprueft.
 *
 * Eine DOM-Umgebung ist hier nicht eingerichtet (Dokument 16, Meldeschein);
 * geprueft wird deshalb, was die Quelle zusagt: dass die Seite am
 * Touchscreen keine Gastdaten ueber einen Auftrag hinaus haelt und nicht
 * fragt, solange sie nicht gekoppelt ist -- und dass Escape am
 * Rezeptionsrechner schliesst, was offen ist. Nachgefahren ist der ganze
 * Weg im Browser (Dokument 31).
 */

const quelle = (pfad: string): string =>
  readFileSync(new URL(pfad, import.meta.url), 'utf8')
/** Ohne Kommentare: ein Wort in einer Begruendung ist kein Aufruf. */
const code = (pfad: string): string =>
  quelle(pfad).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const terminal = code('../routes/Terminal.tsx')

describe('Terminalseite aus der Adresse', () => {
  it('erkennt genau /terminal', () => {
    expect(istTerminalAdresse('/terminal')).toBe(true)
    expect(istTerminalAdresse('/terminal/')).toBe(true)
    // Kein Praefixvergleich: sonst ersetzte die Terminalseite die
    // Anwendung unter jedem Pfad, der zufaellig so anfaengt.
    expect(istTerminalAdresse('/terminals')).toBe(false)
    expect(istTerminalAdresse('/')).toBe(false)
  })

  it('steht in main.tsx vor der Frage, wer angemeldet ist', () => {
    const main = code('../main.tsx')
    expect(main.indexOf('if (terminal) return <TerminalSeite />'))
      .toBeGreaterThan(-1)
    expect(main.indexOf('if (terminal) return <TerminalSeite />'))
      .toBeLessThan(main.indexOf("queryKey: ['me']"))
  })
})

describe('Ruhezustand raeumt die Daten ab', () => {
  it('legt keine Gastdaten im Browser ab', () => {
    expect(terminal).not.toMatch(/localStorage|sessionStorage|indexedDB/)
    // Kein Zwischenspeicher, der eine Antwort ueber die Ansicht hinaus haelt.
    expect(terminal).not.toContain('@tanstack/react-query')
  })

  it('ersetzt die Adresse und baut neu auf, statt einen Eintrag anzulegen', () => {
    expect(terminal).not.toContain('pushState')
    const abraeumen = terminal.slice(terminal.indexOf('export function abraeumen'))
      .split('\n}')[0]!
    expect(abraeumen).toContain('history.replaceState(')
    expect(abraeumen).toContain('location.replace(')
  })

  it('raeumt nach Abschluss, Abbruch, Stille und Abbruch der Rezeption ab', () => {
    // Danke-Bildschirm -> abraeumen
    expect(terminal).toMatch(/setTimeout\(abraeumen, DANKE_MS\)/)
    // Stille -> Auftrag abbrechen, dann abraeumen
    expect(terminal).toMatch(/reason: 'timeout'[\s\S]{0,120}\.finally\(abraeumen\)/)
    // Gast bricht ab
    expect(terminal).toMatch(/reason: 'guest'[\s\S]{0,120}\.finally\(abraeumen\)/)
    // Die Rezeption hat abgebrochen oder der Auftrag ist abgelaufen
    expect(terminal).toMatch(/f\.job === null \|\| f\.job\.jobRef !== p\.jobRef\) \{ abraeumen\(\)/)
  })

  it('baut eine Seite aus dem Vor-Zurueck-Speicher neu auf', () => {
    expect(terminal).toMatch(/'pageshow'/)
    expect(terminal).toMatch(/e\.persisted\) abraeumen\(\)/)
  })
})

describe('Ein ungekoppeltes Terminal fragt nicht', () => {
  it('fragt nur in Start, Ruhe und Auftrag', () => {
    expect(terminal).toMatch(
      /const fragt = phase\.art === 'start' \|\| phase\.art === 'ruhe' \|\| phase\.art === 'auftrag'/)
    expect(terminal).toMatch(/if \(!fragt\) return/)
  })

  it('hoert bei 401 auf, ohne eine weitere Runde zu planen', () => {
    const zweig = terminal.slice(terminal.indexOf('e.status === 401'))
    const bisReturn = zweig.slice(0, zweig.indexOf('return'))
    expect(bisReturn).toContain("setPhase({ art: 'koppeln' })")
    expect(bisReturn).not.toContain('setTimeout')
  })

  it('fragt ohne Netz seltener', () => {
    expect(terminal).toMatch(/FRAGE_OHNE_NETZ_MS = 10_000/)
  })
})

describe('Escape am Rezeptionsrechner', () => {
  it('schliesst die Auswahl des Terminals', () => {
    expect(code('../components/AmTerminal.tsx'))
      .toMatch(/useEscape\(\(\) => setWaehlt\(null\), waehlt !== null\)/)
  })

  it('schliesst den angezeigten Kopplungscode', () => {
    expect(code('../components/Gaesteterminals.tsx'))
      .toMatch(/useEscape\(\(\) => setCode\(null\), code !== null\)/)
  })

  it('klappt das Feld der Hausnotiz wieder ein', () => {
    expect(code('../routes/Guests.tsx')).toMatch(/useEscape\(schliessen, offen\)/)
  })
})

describe('Eine Unterschrift, ein Format', () => {
  it('hat der Check-in kein eigenes Unterschriftsfeld mehr', () => {
    const checkin = code('../routes/CheckIn.tsx')
    expect(checkin).not.toContain('function Unterschriftsfeld')
    expect(checkin).toContain("from '../components/Unterschriftsfeld.tsx'")
    expect(terminal).toContain("from '../components/Unterschriftsfeld.tsx'")
  })

  it('rechnet die Koordinaten auf die Leinwand um', () => {
    // Sonst lag der Strich neben dem Finger, sobald die Leinwand per CSS
    // breiter gezogen war als ihre Aufloesung.
    expect(code('../components/Unterschriftsfeld.tsx'))
      .toMatch(/c\.width \/ rect\.width/)
  })
})

describe('Inlaendische Gaeste', () => {
  /**
   * Die Oberflaeche entscheidet nicht selbst, wer unterschreibt: sie zeigt
   * nur, was die Schnittstelle anbietet. Eine zweite Fassung der Regel hier
   * liefe beim naechsten Stichtag auseinander.
   */
  it('bietet nur an, was die Schnittstelle anbietet', () => {
    const am = code('../components/AmTerminal.tsx')
    expect(am).toMatch(/offers\.map\(kind =>/)
    expect(am).not.toMatch(/isForeign|country/)
  })
})
