import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { navPasst } from '../components/Shell.tsx'

/**
 * Die Kopfleiste behaelt ihre rechte Seite.
 *
 * Mit dreizehn Bildschirmen war die Leiste rund 2 100 Pixel breit, und
 * Sprachwahl und Abmelden lagen bei 1 920 rechts ausserhalb des Bildschirms.
 * An einem geteilten Rechner ist Abmelden kein Komfort (CLAUDE.md, "Das
 * eigene Konto"). Geprueft wird die Rechnung, was vorne passt, und dass die
 * rechte Seite nicht von ihr abhaengt.
 */

const shell = readFileSync(
  new URL('../components/Shell.tsx', import.meta.url), 'utf8')

describe('Was vorne in die Leiste passt', () => {
  // Vier Eintraege zu 100, Abstand 4, "Mehr" 60.
  const breiten = [100, 100, 100, 100]
  const mehrBreiten = [110, 110, 110, 150]

  it('zeigt alles, wenn alles passt -- ohne Mehr-Knopf', () => {
    expect(navPasst(breiten, mehrBreiten, 60, 0, 412)).toBe(4)
  })

  it('laesst Platz fuer den Mehr-Knopf, sobald etwas ins Menue geht', () => {
    // 411 reicht fuer drei Eintraege und "Mehr" (3 * 104 + 60 = 372).
    expect(navPasst(breiten, mehrBreiten, 60, 0, 411)).toBe(3)
    expect(navPasst(breiten, mehrBreiten, 60, 0, 371)).toBe(2)
  })

  it('rechnet mit dem Namen des aktiven Bildschirms, wenn er im Menue liegt', () => {
    // Der Knopf traegt dann "Rechnungen ▾" statt "Mehr ▾" und ist breiter;
    // mit der schmalen Breite gerechnet ragte er ueber den Rand.
    expect(navPasst(breiten, mehrBreiten, 60, 3, 400)).toBe(2)
    expect(navPasst(breiten, mehrBreiten, 60, 0, 400)).toBe(3)
  })

  it('gibt bei sehr wenig Platz alles ins Menue', () => {
    expect(navPasst(breiten, mehrBreiten, 60, 0, 50)).toBe(0)
  })
})

describe('Die rechte Seite haengt nicht an der Rechnung', () => {
  it('darf nicht schrumpfen, die Leiste schon', () => {
    // Stimmte die Messung einmal nicht, laege die Leiste unter dem
    // Abmelden-Knopf, statt ihn aus dem Bildschirm zu schieben.
    expect(shell).toContain('className="relative min-w-0 grow"')
    expect(shell).toContain('className="relative z-10 flex shrink-0 items-center gap-4 bg-white"')
  })

  it('laesst keinen Bildschirm weg, sondern legt ihn ins Menue', () => {
    expect(shell).toContain('const vorne = screens.slice(0, sichtbar)')
    expect(shell).toContain('const hinten = screens.slice(sichtbar)')
  })

  it('schliesst das Menue ueber die gemeinsame Escape-Lage', () => {
    expect(shell).toContain('useEscape(() => setOffen(false), offen)')
  })
})
