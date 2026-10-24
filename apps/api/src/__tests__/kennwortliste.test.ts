import { describe, it, expect } from 'vitest'
import { kennwortBekannt, kennwortZuNah } from '../platform/kennwortliste.js'

/**
 * Die Liste geleakter Kennwoerter (Bedrohungsanalyse 23.10.2026, A2). Kein
 * Datenbanktest: der Filter liegt im Code, und hier zaehlt, dass er dasselbe
 * rechnet wie das Skript, das ihn gebaut hat. Liefe das auseinander, kaeme
 * jedes Kennwort durch, und kein anderer Test merkte es.
 */
describe('Liste geleakter Kennwoerter', () => {
  it('kennt die Klassiker ab zwoelf Zeichen, gross oder klein', () => {
    for (const k of ['qwertyuiopasdfghjkl', 'iloveyou1234', 'PASSWORD1234', 'Password1234',
                     'onomatopoeia', 'socialstudies']) {
      expect(kennwortBekannt(k), k).toBe(true)
    }
  })

  it('laesst ein zufaelliges Kennwort durch', () => {
    // Gegen die Fehlerrate von einem Tausendstel: von hundert zufaelligen
    // darf hoechstens eins haengen bleiben.
    let bekannt = 0
    for (let i = 0; i < 100; i++) {
      if (kennwortBekannt(`krabbe-${Math.random().toString(36).slice(2)}-watt`)) bekannt++
    }
    expect(bekannt).toBeLessThanOrEqual(1)
    expect(kennwortBekannt('ein-ganz-neues-kennwort-2026')).toBe(false)
  })

  it('weist den Produktnamen und den eigenen Anmeldenamen ab', () => {
    expect(kennwortZuNah('MeinStayGrid2026', null)).toBe(true)
    expect(kennwortZuNah('rezeption-ist-toll', 'rezeption@seeblick.de')).toBe(true)
    expect(kennwortZuNah('watt-und-krabben', 'rezeption@seeblick.de')).toBe(false)
    // Kurze Namen nicht: "max" steckt in zu vielen Woertern.
    expect(kennwortZuNah('maximal-langes-kennwort', 'max@seeblick.de')).toBe(false)
  })
})
