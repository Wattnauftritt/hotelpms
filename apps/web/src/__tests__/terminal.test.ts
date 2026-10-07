import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { hauptskript, istTerminalAdresse, kioskSchluesselAusAdresse } from '../routes/Terminal.tsx'
import { referrerFuer } from '../lib/rahmen.js'

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
const ruhebild = code('../components/Ruhebild.tsx')

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

describe('Kiosk-Adresse', () => {
  const k = 'A'.repeat(40) + '_-9'

  it('liest das Geheimnis nur aus dem Teil hinter dem #', () => {
    expect(kioskSchluesselAusAdresse(`#k=${k}`)).toBe(k)
    expect(kioskSchluesselAusAdresse('')).toBeNull()
    // Keine andere Form: was nicht wie ein Geheimnis aussieht, geht nicht raus.
    expect(kioskSchluesselAusAdresse('#k=kurz')).toBeNull()
  })

  it('loest eine Adresse ein, die in eine offene Terminalseite kommt', () => {
    // Nur der Teil hinter dem # aendert sich: kein Neuladen, nur hashchange.
    expect(terminal).toMatch(/addEventListener\('hashchange'/)
    expect(terminal).toMatch(/if \(key !== null\) setPhase\(\{ art: 'kiosk', key \}\)/)
  })

  it('nimmt das Geheimnis aus der Adresse, bevor es eingeloest wird', () => {
    const effekt = terminal.slice(terminal.indexOf('if (kioskKey === null) return'))
    expect(effekt.indexOf('history.replaceState(null, \'\', TERMINAL_PFAD)'))
      .toBeLessThan(effekt.indexOf("'/v1/terminal/resume'"))
    expect(effekt.indexOf("'/v1/terminal/resume'")).toBeGreaterThan(-1)
  })
})

describe('Referer eines Rahmens', () => {
  it('schickt keinen, ausser dem YouTube-Player die Herkunft', () => {
    // Ohne Referer verweigert der Player das Abspielen ("Fehler 153").
    expect(referrerFuer('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'))
      .toBe('strict-origin-when-cross-origin')
    expect(referrerFuer('https://restaurant.example/karte')).toBe('no-referrer')
    expect(terminal).toContain('referrerPolicy={referrerFuer(d.url)}')
  })
})

describe('Ruhezustand raeumt die Daten ab', () => {
  it('legt keine Gastdaten im Browser ab', () => {
    expect(terminal).not.toMatch(/localStorage|sessionStorage|indexedDB/)
    expect(ruhebild).not.toMatch(/localStorage|sessionStorage|indexedDB/)
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

  /**
   * 403 heisst: angemeldet, aber nicht als Terminal -- eine
   * Mitarbeitersitzung im Browser am Touchscreen. Das aendert keine weitere
   * Runde; die Seite fragte einmal endlos alle zwei Sekunden.
   */
  it('hoert bei 403 auf und zeigt die Kopplung mit dem Grund', () => {
    const zweig = terminal.slice(terminal.indexOf('e.status === 403'))
    const bisReturn = zweig.slice(0, zweig.indexOf('return'))
    expect(bisReturn).toContain("setPhase({ art: 'koppeln', fehler: e })")
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

  it('schliesst den angezeigten Kopplungscode und die Kiosk-Adresse', () => {
    expect(code('../components/Gaesteterminals.tsx'))
      .toMatch(/useEscape\(\(\) => \{ setCode\(null\); setAdresse\(null\) \},\s*code !== null \|\| adresse !== null\)/)
  })

  it('klappt das Feld der Hausnotiz wieder ein', () => {
    expect(code('../routes/Guests.tsx')).toMatch(/useEscape\(schliessen, offen\)/)
  })
})

describe('Eine Unterschrift, ein Format', () => {
  it('hat der Check-in kein Unterschriftsfeld: der Gast unterschreibt am Terminal', () => {
    // Sven, 05.10.2026: die Rezeption soll nicht fuer den Gast unterschreiben.
    const checkin = code('../routes/CheckIn.tsx')
    expect(checkin).not.toContain('function Unterschriftsfeld')
    expect(checkin).not.toContain('Unterschriftsfeld')
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
    expect(am).toMatch(/offers\.filter\(/)
    expect(am).not.toMatch(/isForeign|country|nationality/)
  })
})

describe('Ein allgemeiner Anzeige-Client, kein Scheunentor', () => {
  it('hat fuer jede Art der Schnittstelle eine Ansicht', () => {
    for (const art of ['registration_fill', 'registration_sign', 'terms_sign', 'content', 'url']) {
      expect(terminal, art).toMatch(new RegExp(`\\b${art}: [A-Z]\\w+`))
    }
  })

  it('setzt den Text einer Seite nie als HTML', () => {
    for (const datei of ['../components/Inhaltstext.tsx', '../routes/Terminal.tsx',
                         '../components/TerminalInhalte.tsx']) {
      expect(code(datei), datei).not.toMatch(/dangerouslySetInnerHTML|innerHTML/)
    }
  })

  it('laesst eine fremde Seite das Terminal nicht verlassen', () => {
    const funde = [...terminal.matchAll(/<iframe[^>]*sandbox="([^"]*)"/g)].map(m => m[1]!)
    expect(funde).toHaveLength(1)
    for (const f of funde) {
      expect(f).not.toMatch(/allow-top-navigation|allow-popups|allow-downloads|allow-modals/)
    }
    // Die Adresse kommt aus der Antwort auf den Auftrag, nie aus einer Eingabe.
    expect(terminal).toMatch(/src=\{d\.url\}/)
  })

  it('bettet das Meldeformular des Online-Check-ins ein, statt ein zweites zu bauen', () => {
    expect(terminal).toContain("from './GastCheckin.tsx'")
    expect(terminal).toMatch(/<GastCheckin token=\{token\} modus="terminal"/)
  })

  it('zeigt im Ruhebild nur Seiten und Bilder des Hauses', () => {
    // Das Ruhebild fragt selbst nichts: die Folien kommen aus der Diashow,
    // die Bilder nur ueber die Bildroute des Geraets. Kein Text aus einem
    // Auftrag, keine fremde Adresse, kein HTML.
    expect(ruhebild).not.toMatch(/api\.|fetch\(|dangerouslySetInnerHTML|innerHTML/)
    expect(ruhebild).toContain('`/v1/terminal/images/${ref}`')
    expect(ruhebild.match(/src=\{[^}]+\}/g)).toEqual(['src={bildAdresse(folie.imageRef)}'])
  })

  it('holt die Diashow, aber nie in der Frage nach dem Auftrag', () => {
    expect(terminal).toContain("'/v1/terminal/idle'")
    const runde = terminal.slice(terminal.indexOf('const runde = async'))
    expect(runde.slice(0, runde.indexOf('void runde()'))).not.toContain('/v1/terminal/idle')
  })

  it('zeigt das Bedienfeld nur mit dem Recht zum Einchecken', () => {
    expect(code('../screens.tsx')).toMatch(
      /key: 'terminal', group: 'settings', nav: 'nav\.terminal', permission: 'reservation:checkin'/)
  })
})

describe('Neuer Stand am ruhenden Terminal', () => {
  it('erkennt das Hauptskript am Hash des Baus', () => {
    expect(hauptskript('<script type="module" crossorigin src="/assets/index-y32G3BjI.js"></script>'))
      .toBe('/assets/index-y32G3BjI.js')
    // Entwicklungsmodus: kein gebautes Skript, keine Pruefung.
    expect(hauptskript('<script type="module" src="/src/main.tsx"></script>')).toBeNull()
  })

  it('laedt nur in Ruhe neu, nie mitten in einem Auftrag', () => {
    expect(terminal).toContain("const ruht = phase.art === 'ruhe'")
    expect(terminal).toMatch(/if \(!ruht\) return/)
  })
})
