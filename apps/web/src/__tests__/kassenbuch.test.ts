import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { zielmass } from '../lib/kassenbeleg.js'
import { visibleScreens } from '../screens.tsx'
import { kassenbloecke } from '../lib/kassengruppen.js'
import type { Kassenzeile } from '../lib/queries/kassenbuch.js'

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

  it('fasst eine Gastbuchung zu einer Zeile mit Summe und letztem Bestand zusammen', () => {
    const z = (entryNo: number, amountCent: number, groupNo: number | null,
               balanceAfterCent: number | null): Kassenzeile => ({
      entryNo, businessDate: '2026-09-15', kind: 'lodging', amountCent, taxRateBp: 700, text: null,
      guestName: null, groupNo, reversesNo: null, voidedByNo: null, balanceAfterCent,
      receipts: entryNo === 1 ? [{ ref: 'a', mime: 'application/pdf' }] : [],
      externalNumber: null, datevExported: false, createdBy: null, createdAt: '' })
    const b = kassenbloecke([z(1, 100, null, 1100), z(2, 50, 1, 1150), z(3, -20, null, 1130),
                             // Erste Zeile nicht davor: bleibt fuer sich.
                             z(5, 7, 4, 1137),
                             // Ganz storniert: Summe aller Zeilen, kein Bestand.
                             z(6, 10, null, null), z(7, 5, 6, null)])
    expect(b.map(x => [x.kopf.entryNo, x.mitglieder.map(m => m.entryNo), x.summeCent, x.bestandCent]))
      .toEqual([[1, [2], 150, 1150], [3, [], -20, 1130], [5, [], 7, 1137], [6, [7], 15, null]])
    expect(b[0]!.belege).toHaveLength(1)
  })
})
