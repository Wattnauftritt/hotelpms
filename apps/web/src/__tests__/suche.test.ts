import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { marke, istDetailsucheTaste, befehlZurTaste, BEFEHLE, IM_PLAN }
  from '../lib/suche.js'

/**
 * Die Suche: Schnellsuche im Plan und Detailsuche hinter Strg+K.
 *
 * Getestet wird, was still schiefgeht -- eine Taste, die einem Textfeld ein
 * Zeichen stiehlt; eine Marke, die einer nie angereisten Buchung
 * "bestaetigt" bescheinigt; ein Treffer, der je Zeile nachlaedt. Die
 * Darstellung selbst ist im Browser nachgefahren, nicht hier.
 */

const SRC = join(import.meta.dirname, '..')
const lies = (pfad: string): string => readFileSync(join(SRC, pfad), 'utf8')

/** Ein Tastendruck, wie ihn der Browser liefert -- ohne DOM. */
function taste(teil: Partial<KeyboardEvent>): KeyboardEvent {
  return { key: '', code: '', ctrlKey: false, metaKey: false, altKey: false,
           shiftKey: false, target: null, ...teil } as KeyboardEvent
}

beforeAll(() => {
  /*
   * `istTextEingabe` fragt `instanceof` gegen die Elementklassen des
   * Browsers. Die Tests laufen ohne DOM; die Klassen stehen hier als leere
   * Stellvertreter, damit die Frage beantwortbar ist.
   */
  const g = globalThis as Record<string, unknown>
  class El { isContentEditable = false }
  class Eingabe extends El { type = 'text' }
  g.HTMLElement ??= El
  g.HTMLTextAreaElement ??= class extends El {}
  g.HTMLInputElement ??= Eingabe
})

describe('Statusmarke einer Trefferzeile', () => {
  it('nennt eine nie angereiste Buchung Vergangenheit, nicht bestaetigt', () => {
    expect(marke({ status: 'Confirmed', past: true })).toBe('past')
    expect(marke({ status: 'Optional', past: true })).toBe('past')
    expect(marke({ status: 'Confirmed', past: false })).toBe('confirmed')
    expect(marke({ status: 'Optional', past: false })).toBe('optional')
  })

  it('laesst die Endzustaende stehen, auch in der Vergangenheit', () => {
    expect(marke({ status: 'CheckedOut', past: true })).toBe('checkedOut')
    expect(marke({ status: 'Canceled', past: true })).toBe('canceled')
    expect(marke({ status: 'NoShow', past: true })).toBe('noShow')
    expect(marke({ status: 'InHouse', past: false })).toBe('inHouse')
  })

  it('springt im Plan nur zu dem, was der Plan zeigt', () => {
    // Dieselbe Liste wie die Abfrage des Plans in routes/availability.ts.
    const plan = lies('../../api/src/routes/availability.ts')
    expect(plan).toContain(`r.status IN ('Optional','Confirmed','InHouse','CheckedOut')`)
    expect([...IM_PLAN].sort()).toEqual(['CheckedOut', 'Confirmed', 'InHouse', 'Optional'])
  })
})

describe('Strg+K', () => {
  it('oeffnet unter Windows und Linux mit Strg, auch aus einem Textfeld', () => {
    const feld = new (globalThis as unknown as { HTMLInputElement: new () => EventTarget })
      .HTMLInputElement()
    expect(istDetailsucheTaste(taste({ key: 'k', ctrlKey: true }), false)).toBe(true)
    expect(istDetailsucheTaste(taste({ key: 'K', ctrlKey: true, target: feld }), false))
      .toBe(true)
  })

  it('laesst Strg+K auf dem Mac dem Textfeld und nimmt dort Cmd+K', () => {
    const feld = new (globalThis as unknown as { HTMLInputElement: new () => EventTarget })
      .HTMLInputElement()
    // Strg+K ist in jedem Textfeld unter macOS "loeschen bis Zeilenende".
    expect(istDetailsucheTaste(taste({ key: 'k', ctrlKey: true, target: feld }), true))
      .toBe(false)
    expect(istDetailsucheTaste(taste({ key: 'k', metaKey: true, target: feld }), true))
      .toBe(true)
    expect(istDetailsucheTaste(taste({ key: 'k', ctrlKey: true }), true)).toBe(true)
  })

  it('ist mit Umschalt oder Alt eine andere Taste', () => {
    // Strg+Umschalt+K ist in Firefox die Konsole.
    expect(istDetailsucheTaste(taste({ key: 'K', ctrlKey: true, shiftKey: true }), false))
      .toBe(false)
    expect(istDetailsucheTaste(taste({ key: 'k', ctrlKey: true, altKey: true }), false))
      .toBe(false)
    expect(istDetailsucheTaste(taste({ key: 'k' }), false)).toBe(false)
  })
})

describe('Befehle mit Alt', () => {
  it('liest die Taste und nicht das Zeichen', () => {
    // Auf dem Mac liefert Alt+N als `key` eine tote Taste, Alt+C ein "ç".
    expect(befehlZurTaste(taste({ key: 'Dead', code: 'KeyN', altKey: true })))
      .toBe('neueReservierung')
    expect(befehlZurTaste(taste({ key: '©', code: 'KeyG', altKey: true }))).toBe('neuerGast')
    expect(befehlZurTaste(taste({ key: 'ç', code: 'KeyC', altKey: true }))).toBe('neueFirma')
  })

  it('verwechselt AltGr nicht mit Alt', () => {
    // AltGr kommt als Strg+Alt. AltGr+Q ist das @ in jeder Mailadresse.
    expect(befehlZurTaste(taste({ code: 'KeyN', altKey: true, ctrlKey: true }))).toBeNull()
    expect(befehlZurTaste(taste({ code: 'KeyN' }))).toBeNull()
  })

  it('verlangt fuer jeden Befehl das Recht, das die Maske dahinter braucht', () => {
    expect(BEFEHLE.map(b => [b.befehl, b.recht])).toEqual([
      ['neueReservierung', 'reservation:write'],
      ['neuerGast', 'guest:write'],
      ['neueFirma', 'guest:write']
    ])
  })
})

describe('Detailsuche in der Shell', () => {
  const shell = lies('components/Shell.tsx')
  const detail = lies('components/Detailsuche.tsx')

  it('sitzt in der Shell und nicht in einem Bildschirm', () => {
    expect(shell).toMatch(/<Detailsuche propertyId=\{props\.haus\.id\} \/>/)
  })

  it('oeffnet nicht ueber einer offenen Maske und nimmt dem Browser die Taste', () => {
    const handler = detail.slice(detail.indexOf('if (istDetailsucheTaste(e))'))
    expect(handler.indexOf(`document.querySelector('[role="dialog"]') !== null) return`))
      .toBeGreaterThan(-1)
    expect(handler.indexOf('e.preventDefault()')).toBeGreaterThan(-1)
    expect(handler.indexOf('setOffen(true)')).toBeGreaterThan(
      handler.indexOf(`document.querySelector('[role="dialog"]')`))
  })

  it('laesst die Alt-Befehle im Textfeld in Ruhe', () => {
    const befehl = detail.slice(detail.indexOf('const befehl = befehlZurTaste(e)'))
    expect(befehl.slice(0, 400)).toContain('if (istTextEingabe(e.target)) return')
  })

  it('schliesst mit Escape und hat drei Filter, die Tab wechselt', () => {
    expect(detail).toContain('useEscape(onClose)')
    expect(detail).toMatch(/scope: 'all'[\s\S]*scope: 'reservation'[\s\S]*scope: 'customer'/)
    expect(detail).toMatch(/e\.key === 'Tab'[\s\S]{0,200}setScope/)
    for (const k of ['suche.footer.navigate', 'suche.footer.select', 'suche.footer.close']) {
      expect(detail).toContain(k)
    }
  })

  it('zeigt den Kundenfilter nur mit Gastrecht', () => {
    expect(detail).toContain(`f.scope !== 'customer' || darfKunden`)
  })

  it('oeffnet keine eigene Maske, sondern springt ueber den Rahmen', () => {
    const main = lies('main.tsx')
    expect(main).toContain('<SprungContext.Provider value={{ springen, auftrag }}>')
    expect(main).toMatch(/suchReservierung !== null && \(\s*<ReservationPanel/)
    // Bei jedem Sprung neu eingehaengt, sonst behielte die Gaesteliste das
    // alte Profil.
    expect(main).toMatch(/<Fragment key=\{haus\.id\}>\s*<Fragment key=\{sprung\}>/)
    expect(detail).not.toMatch(/<(BookingDialog|GastFormular|FirmaFormular)\b/)
  })
})

describe('Schnellsuche im Plan', () => {
  const plan = lies('components/PlanSuche.tsx')
  const tape = lies('routes/Tape.tsx')
  const chart = lies('components/TapeChart.tsx')

  it('steht in der Leiste des Plans', () => {
    expect(tape).toMatch(/<PlanSuche propertyId=\{propertyId\} von=\{von\} bis=\{bis\}/)
  })

  it('findet jeden Balken ueber seine Nummer, in der Zeile und im Band', () => {
    expect(chart.match(/data-reservation-ref=\{r\.public_ref\}/g)).toHaveLength(2)
    expect(plan).toContain('[data-reservation-ref="${CSS.escape(ziel.ref)}"]')
  })

  it('blaettert zur Anreise, rollt hin, fokussiert und hebt hervor', () => {
    expect(plan).toContain('if (r.arrival < von || r.arrival >= bis) onVon(addDays(r.arrival, -2))')
    expect(plan).toContain('el.scrollIntoView(')
    expect(plan).toContain('el.focus(')
    expect(plan).toContain('el.classList.add(...HERVORHEBUNG)')
  })

  it('oeffnet mit Enter auf dem Balken, und was keinen Balken hat, gleich', () => {
    expect(plan).toMatch(/if \(e\.key !== 'Enter'\) return[\s\S]{0,120}oeffnenRef\.current\(ziel\.ref\)/)
    expect(plan).toMatch(/if \(!IM_PLAN\.has\(r\.status\)\) \{\s*onOeffnen\(r\.reservationRef\)/)
  })

  it('leert mit Escape und haelt dabei nur, solange es etwas zu leeren gibt', () => {
    expect(plan).toMatch(/useEscape\(\(\) => \{\s*setBegriff\(''\)/)
    expect(plan).toContain(`}, begriff !== '' || offen)`)
  })

  it('bedient sich mit Pfeilen und Enter', () => {
    expect(plan).toContain(`e.key === 'ArrowDown' || e.key === 'ArrowUp'`)
    expect(plan).toContain('role="combobox"')
    expect(plan).toContain('aria-activedescendant')
  })
})

describe('Ein Aufruf je Tastendruck', () => {
  it('laedt in keiner Trefferzeile nach', () => {
    /*
     * Die Zeile zeigt, was die Antwort traegt. Ein `useReservation` oder
     * `useGuest` darin waere eine Anfrage je Treffer und Buchstabe.
     */
    const zeile = lies('components/Suchtreffer.tsx')
    expect(zeile).not.toMatch(/\buse(Reservation|Guest|Company|Query)\b/)
    for (const datei of ['components/PlanSuche.tsx', 'components/Detailsuche.tsx']) {
      const quelle = lies(datei)
      expect(quelle.match(/\buseSuche\(/g), datei).toHaveLength(1)
      expect(quelle, datei).toContain('useEntprellt(')
    }
  })
})
