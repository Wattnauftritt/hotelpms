import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { zielmass } from '../lib/kassenbeleg.js'
import { visibleScreens } from '../screens.tsx'

describe('Kassenbuch in der Oberflaeche', () => {
  it('verkleinert Fotos an der langen Kante und laesst kleine, wie sie sind', () => {
    expect(zielmass(4032, 3024)).toEqual({ breite: 1600, hoehe: 1200 })
    expect(zielmass(3024, 4032)).toEqual({ breite: 1200, hoehe: 1600 })
    expect(zielmass(800, 600)).toEqual({ breite: 800, hoehe: 600 })
  })

  it('erscheint nur mit cashbook:read', () => {
    expect(visibleScreens(['cashbook:read']).map(s => s.key)).toContain('cashbook')
    expect(visibleScreens(['reservation:read']).map(s => s.key)).not.toContain('cashbook')
  })

  it('rechnet die Vorschau der Gastbuchung mit der Funktion des Servers', () => {
    // Eine eigene Fassung laege beim ersten krummen Fruehstueckspreis einen
    // Cent neben dem, was nachher im Buch steht.
    const quelle = readFileSync(new URL('../routes/Kassenbuch.tsx', import.meta.url), 'utf8')
    expect(quelle).toContain("from '@hotelpms/domain/cashbook'")
  })
})
