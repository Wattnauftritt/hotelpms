import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { EBENEN, datumAnzeige, datumAusIso, datumIso, einfuegen, grossSchreiben,
         loeschen, startEbene } from '../lib/bildschirmtastatur.js'

/**
 * Die Bildschirmtastatur des Gaesteterminals. Eine DOM-Umgebung ist hier
 * nicht eingerichtet (siehe terminal.test.ts); geprueft wird die Logik ohne
 * DOM und an der Quelle, dass die Seite sie traegt.
 */

const code = (pfad: string): string =>
  readFileSync(new URL(pfad, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('Tasten', () => {
  const alle = (e: keyof typeof EBENEN): string =>
    EBENEN[e].flat().filter(t => t.art === 'text').map(t => t.zeichen).join('')

  it('hat Umlaute, ß, @, + und die Ziffern', () => {
    for (const z of 'äöüß@+1234567890') expect(alle('buchstaben')).toContain(z)
  })

  it('schreibt Namen auslaendischer Gaeste', () => {
    // Wer den Meldeschein unterschreibt, ist per Gesetz auslaendisch.
    for (const z of 'øåéçñşğıİł') expect(alle('akzente')).toContain(z)
  })

  it('hat auf jeder Ebene Loeschen und Weiter', () => {
    for (const e of Object.keys(EBENEN) as Array<keyof typeof EBENEN>) {
      const arten = EBENEN[e].flat().map(t => t.art)
      expect(arten).toContain('loeschen')
      expect(arten).toContain('weiter')
    }
  })

  it('schreibt gross, ß bleibt ß', () => {
    expect(grossSchreiben('ä')).toBe('Ä')
    expect(grossSchreiben('ø')).toBe('Ø')
    expect(grossSchreiben('ß')).toBe('ß')
  })

  it('beginnt fuer Ziffernfelder mit dem Ziffernblock', () => {
    expect(startEbene('numeric')).toBe('ziffern')
    expect(startEbene('')).toBe('buchstaben')
  })
})

describe('Schreiben an der Schreibmarke', () => {
  it('fuegt ein und ersetzt eine Auswahl', () => {
    expect(einfuegen({ wert: 'Mler', anfang: 1, ende: 1 }, 'ü'))
      .toEqual({ wert: 'Müler', anfang: 2, ende: 2 })
    expect(einfuegen({ wert: 'Maier', anfang: 1, ende: 3 }, 'ey'))
      .toEqual({ wert: 'Meyer', anfang: 3, ende: 3 })
  })

  it('haelt maxLength ein', () => {
    const f = { wert: 'abc', anfang: 3, ende: 3 }
    expect(einfuegen(f, 'd', 3)).toBe(f)
    expect(einfuegen(f, 'd', -1).wert).toBe('abcd')
  })

  it('loescht ein Zeichen oder die Auswahl', () => {
    expect(loeschen({ wert: 'Müller', anfang: 2, ende: 2 }))
      .toEqual({ wert: 'Mller', anfang: 1, ende: 1 })
    expect(loeschen({ wert: 'Müller', anfang: 1, ende: 3 }))
      .toEqual({ wert: 'Mler', anfang: 1, ende: 1 })
    expect(loeschen({ wert: 'x', anfang: 0, ende: 0 }).wert).toBe('x')
  })
})

describe('Datum als Ziffern', () => {
  it('setzt die Punkte selbst und laesst sie zuruecknehmen', () => {
    expect(datumAnzeige('0')).toBe('0')
    expect(datumAnzeige('031')).toBe('03.1')
    expect(datumAnzeige('03.11.19')).toBe('03.11.19')
    expect(datumAnzeige('031119851')).toBe('03.11.1985')
    // Loeschen ueber den Punkt hinweg: "03." wird "03", nicht wieder "03.".
    expect(datumAnzeige('03.')).toBe('03')
  })

  it('liefert ISO nur fuer ein vollstaendiges, moegliches Datum', () => {
    expect(datumIso('03.11.1985')).toBe('1985-11-03')
    expect(datumIso('03.11.198')).toBe('')
    expect(datumIso('31.02.1985')).toBe('')
    expect(datumIso('29.02.2000')).toBe('2000-02-29')
    expect(datumIso('01.01.0985')).toBe('')
  })

  it('zeigt ISO ohne Umweg ueber die Ortszeit', () => {
    expect(datumAusIso('1985-11-03')).toBe('03.11.1985')
    expect(datumAusIso('')).toBe('')
  })
})

describe('An der Terminalseite', () => {
  it('haengt einmal an der Seite, nicht am einzelnen Feld', () => {
    expect(code('../routes/Terminal.tsx')).toContain('<Bildschirmtastatur />')
  })

  it('haelt die Systemtastatur zu und den Fokus im Feld', () => {
    const k = code('../components/Bildschirmtastatur.tsx')
    expect(k).toContain("el.inputMode = 'none'")
    expect(k).toContain('onMouseDown={e => e.preventDefault()}')
  })

  it('setzt den Ziffernblock als Raster, nicht als zentrierte Reihen', () => {
    // Als Reihen mit Flex stand jede Reihe fuer sich zentriert, die Spalten
    // versetzt -- so sah es am Touchscreen aus.
    const k = code('../components/Bildschirmtastatur.tsx')
    expect(k).toContain("ebene === 'ziffern'")
    expect(k).toContain('grid-cols-4')
  })

  it('haelt keinen Text ausserhalb des Feldes', () => {
    const k = code('../components/Bildschirmtastatur.tsx')
    expect(k).not.toMatch(/localStorage|sessionStorage/)
  })

  it('nimmt am Terminal Ziffern statt des Datumsfelds des Browsers', () => {
    const g = code('../routes/GastCheckin.tsx')
    expect(g).toContain('<Datumsfeld')
    expect(g).not.toMatch(/<input type="date"[^>]*birthDate/)
  })
})
