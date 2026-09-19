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
    expect(quelle).toMatch(/t\('deploy\.builtAt', \{ when: zeit\(q\.data\.currentBuiltAt\) \}\)/)
  })

  it('laesst die Zeit weg, statt eine falsche zu zeigen', () => {
    // Ein Stand, den der Agent von vor 0042 eingetragen hat, hat keine.
    expect(quelle).toMatch(/z\.builtAt !== null &&/)
    expect(quelle).toMatch(/currentBuiltAt != null &&/)
  })
})
