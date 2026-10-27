import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { EBENEN, datumAusIso, datumLesen, datumTippen, einfuegen, grossSchreiben, heuteIso,
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

describe('Geburtsdatum, wie Menschen es schreiben', () => {
  const heute = '2026-10-05'
  const lesen = (t: string): string => datumLesen(t, heute)

  it('nimmt deutsche Schreibweisen mit jedem Trenner', () => {
    for (const t of ['03.11.1985', '3.11.1985', '03-11-1985', '03/11/1985', '03 11 1985',
                     '3.11.85', '03111985', '031185', ' 03.11.1985 ']) {
      expect(lesen(t), t).toBe('1985-11-03')
    }
  })

  it('nimmt ISO mit dem Jahr vorn', () => {
    expect(lesen('1985-11-03')).toBe('1985-11-03')
  })

  it('legt zwei Ziffern Jahr in die Vergangenheit', () => {
    expect(lesen('01.01.12')).toBe('2012-01-01')
    expect(lesen('01.01.26')).toBe('2026-01-01')
    expect(lesen('01.01.27')).toBe('1927-01-01')
  })

  it('weist Unmoegliches und Zukuenftiges ab', () => {
    expect(lesen('31.02.1985')).toBe('')
    expect(lesen('29.02.2000')).toBe('2000-02-29')
    expect(lesen('01.01.1899')).toBe('')
    expect(lesen('06.10.2026')).toBe('')
    expect(lesen('03.11.198')).toBe('')
    expect(lesen('')).toBe('')
  })

  it('zeigt ISO ohne Umweg ueber die Ortszeit', () => {
    expect(datumAusIso('1985-11-03')).toBe('03.11.1985')
    expect(datumAusIso('')).toBe('')
    expect(heuteIso(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05')
  })
})

describe('Anreisetag im Portalformular', () => {
  const heute = '2026-10-27'
  const lesen = (t: string): string => datumLesen(t, heute, 'anreise')

  /** Der Gast von CHECK24 (Anreise 28.10.2026) kam nicht durch: das Feld las morgen als ''. */
  it('nimmt einen Tag nach heute', () => {
    for (const t of ['28.10.2026', '28.10.26', '28102026', '2026-10-28']) {
      expect(lesen(t), t).toBe('2026-10-28')
    }
    expect(lesen('03.01.27')).toBe('2027-01-03')
  })

  it('weist weiter Unmoegliches ab', () => {
    expect(lesen('31.02.2027')).toBe('')
    expect(lesen('28.10.')).toBe('')
  })

  it('haengt am Portalformular als Anreise, nicht als Geburtsdatum', () => {
    expect(code('../routes/MeldescheinPortal.tsx')).toMatch(/<Datumsfeld[^>]*art="anreise"/)
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

describe('Datum beim Tippen', () => {
  /** Auf dem Ziffernblock des iPhones gibt es keinen Punkt. */
  it('setzt die Punkte selbst, Ziffer fuer Ziffer', () => {
    const schritte: string[] = []
    let text = ''
    for (const z of '03111985') {
      text = datumTippen(text + z)
      schritte.push(text)
    }
    expect(schritte).toEqual(['0', '03', '03.1', '03.11', '03.11.1', '03.11.19',
                              '03.11.198', '03.11.1985'])
    expect(datumLesen(text, '2026-10-11')).toBe('1985-11-03')
  })

  it('laesst Zurueck nicht am Punkt haengen', () => {
    expect(datumTippen('03.11.')).toBe('03.11')
    expect(datumTippen('03.')).toBe('03')
  })

  it('laesst eine eigene Schreibweise stehen', () => {
    expect(datumTippen('3.11.85')).toBe('3.11.85')
    expect(datumTippen('1985-11-03')).toBe('1985-11-03')
    expect(datumTippen('03 11 1985')).toBe('03 11 1985')
    expect(datumTippen('031119851')).toBe('031119851')
  })
})
