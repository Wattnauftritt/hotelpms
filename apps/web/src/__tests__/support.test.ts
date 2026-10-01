import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { einstellungsBereiche } from '../routes/Settings.tsx'

/**
 * Wer den Support-Zugriff zu sehen bekommt.
 *
 * Die Freigabe gilt fuer den ganzen Account, nicht fuer ein Haus -- wer nur
 * ein Haus verwaltet, entscheidet sie nicht. Das ist keine
 * Sicherheitsmassnahme (die liegt in der Route und nirgends sonst), sondern
 * eine Frage der Brauchbarkeit und der Zustaendigkeit: ein Reiter, der beim
 * Klicken 403 liefert, ist schlimmer als keiner.
 */
describe('Reiter der Einstellungen', () => {
  const nur = (...erlaubt: string[]) =>
    einstellungsBereiche(p => erlaubt.includes(p)).map(b => b.key)

  it('zeigt den Support-Zugriff nur mit settings:account', () => {
    expect(nur('settings:account')).toContain('support')
  })

  it('zeigt ihn der Hausverwaltung nicht', () => {
    // settings:property verwaltet ein Haus. Die Einwilligung fuer den
    // gesamten Account gehoert nicht dazu.
    expect(nur('settings:property')).not.toContain('support')
    expect(nur('integration:manage')).not.toContain('support')
  })

  it('zeigt gar nichts ohne jedes Recht', () => {
    expect(nur()).toEqual([])
  })
})

/**
 * Die Bauzeit neben jedem Stand.
 *
 * Vier Hashes ohne Zeit sagten nicht, welcher der von gestern Mittag war;
 * wer zurueck wollte, musste raten. Der Agent meldet die Aenderungszeit von
 * .fertig (Migration 0042), und der Knopf zeigt sie -- als Bauzeit
 * benannt, nicht als nackte Uhrzeit, denn "ausgerollt am" waere die
 * naheliegende falsche Lesart.
 */
describe('Zurueckrollen mit Bauzeit', () => {
  const quelle = readFileSync(
    new URL('../routes/SupportKonsole.tsx', import.meta.url), 'utf8')

  it('zeigt neben jedem Ziel und neben dem laufenden Stand die Bauzeit', () => {
    expect(quelle).toMatch(/zurueck\.mutate\(z\.commit\)/)
    expect(quelle).toMatch(/t\('deploy\.builtAt', \{ when: zeit\(z\.builtAt\) \}\)/)
    expect(quelle).toMatch(/t\('deploy\.builtAt', \{ when: zeit\(d\.currentBuiltAt\) \}\)/)
  })

  it('laesst die Zeit weg, statt eine falsche zu zeigen', () => {
    // Ein Stand, den der Agent von vor 0042 eingetragen hat, hat keine.
    expect(quelle).toMatch(/z\.builtAt !== null &&/)
    expect(quelle).toMatch(/currentBuiltAt != null &&/)
  })
})

/**
 * Welcher Stand laeuft -- ohne einen Reiter zu oeffnen.
 *
 * Ein Hash und eine Bauzeit beantworten "welches Verzeichnis laeuft", nicht
 * die Frage, die gestellt wird: *welcher Stand ist das, und von wann?*
 * Zwoelf Zeichen sagen niemandem etwas, und zwischen Commit und Ausrollen
 * koennen Tage liegen (Migration 0057).
 */
describe('Der laufende Stand im Adminpanel', () => {
  const konsole = readFileSync(
    new URL('../routes/SupportKonsole.tsx', import.meta.url), 'utf8')
  const panel = readFileSync(
    new URL('../routes/Adminpanel.tsx', import.meta.url), 'utf8')

  it('zeigt Betreff und Commit-Zeit neben dem Hash', () => {
    expect(konsole).toMatch(/d\.currentSubject != null &&/)
    expect(konsole).toMatch(
      /t\('deploy\.committedAt', \{ when: zeit\(d\.currentCommittedAt\) \}\)/)
  })

  it('laesst beides weg, wo es niemand gemeldet hat', () => {
    // Alles, was vor 0057 gebaut wurde, hat keine Herkunft. Dann bleiben
    // Hash und Bauzeit -- eine geratene Zeit waere schlimmer als keine.
    expect(konsole).toMatch(/d\.currentCommittedAt != null &&/)
  })

  it('steht oben im Panel und nicht erst im Reiter Betrieb', () => {
    // Gefragt wird das, wenn etwas unerwartet aussieht. Drei Klicks dahin
    // sind drei zu viel.
    const zeile = panel.indexOf('<LaufenderStand rahmen />')
    const reiterleiste = panel.indexOf('{reiters.map(')
    expect(zeile).toBeGreaterThan(-1)
    expect(zeile).toBeLessThan(reiterleiste)
  })

  it('nur fuer wen die Route offen ist', () => {
    // Ohne `platform:operations` antwortet die Route mit 403, und das waere
    // eine Fehlermeldung ueber dem ganzen Panel.
    const abschnitt = panel.slice(panel.indexOf('<LaufenderStand rahmen />') - 200,
                                  panel.indexOf('<LaufenderStand rahmen />'))
    expect(abschnitt).toContain("platformPermissions.includes('platform:operations')")
  })
})
