import { describe, it, expect } from 'vitest'
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
