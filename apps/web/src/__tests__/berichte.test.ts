import { describe, it, expect } from 'vitest'
import { berichtsBereiche, veraenderung } from '../routes/Reports.tsx'
import { visibleScreens } from '../screens.js'

/**
 * Geprueft wird die Rechteauswertung und die Vorjahresrechnung. Beides
 * faellt bei einem Fehler nicht auf: ein zu grosszuegiger Reiter zeigt sich
 * erst als 403 beim Klicken, ein zu strenger nie, und eine falsche
 * Veraenderung sieht aus wie eine richtige.
 */

const alles = (p: string) => ['report:operational', 'report:revenue',
                              'report:export', 'settings:account'].includes(p)

describe('Bereiche der Berichte', () => {
  it('zeigt der Rezeption nur den Nachtlauf', () => {
    const b = berichtsBereiche(p => p === 'report:operational', false).map(x => x.key)
    expect(b).toEqual(['audit'])
  })

  it('zeigt dem Revenue Management die Kennzahlen, aber keine Ausgaben', () => {
    const b = berichtsBereiche(p => p === 'report:revenue', false).map(x => x.key)
    expect(b).toEqual(['kpi'])
  })

  /**
   * Ein Uebungshaus exportiert nicht nach draussen (C11, Dokument 13). Die
   * API weist das ohnehin ab; der Bildschirm bietet es gar nicht erst an,
   * damit niemand eine Uebungsmeldung an ein Landesamt versucht.
   */
  it('nimmt dem Uebungshaus Statistik und Ausgaben, nicht die Kennzahlen', () => {
    const echt = berichtsBereiche(alles, false).map(x => x.key)
    expect(echt).toEqual(['kpi', 'audit', 'statistics', 'exports'])
    const uebung = berichtsBereiche(alles, true).map(x => x.key)
    expect(uebung).toEqual(['kpi', 'audit'])
  })

  /**
   * Der Mandantenexport haengt an der Einstellungsberechtigung des Accounts,
   * nicht an `report:export`: wer das ganze Haus exportiert, beendet in der
   * Regel den Vertrag.
   */
  it('oeffnet die Ausgaben auch fuer den Mandantenexport allein', () => {
    const b = berichtsBereiche(p => p === 'settings:account', false).map(x => x.key)
    expect(b).toEqual(['exports'])
  })

  it('sagt nichts zu, solange nichts geladen ist', () => {
    expect(berichtsBereiche(() => false, false)).toEqual([])
  })
})

describe('Bildschirm in der Navigation', () => {
  /**
   * Der Bildschirm buendelt drei Rechte. Mit einem einzelnen waere entweder
   * die Rezeption oder das Revenue Management ausgesperrt; beide haben nur
   * eines davon.
   */
  it('erscheint bei jedem der drei Rechte', () => {
    for (const recht of ['report:operational', 'report:revenue', 'report:export']) {
      expect(visibleScreens([recht]).map(s => s.key)).toContain('reports')
    }
    expect(visibleScreens(['housekeeping:read']).map(s => s.key)).not.toContain('reports')
  })
})

describe('Vorjahresvergleich', () => {
  it('rechnet die Veraenderung in Prozent, auf eine Stelle', () => {
    expect(veraenderung(120, 100)).toBe(20)
    expect(veraenderung(80, 100)).toBe(-20)
    expect(veraenderung(100, 100)).toBe(0)
    expect(veraenderung(1, 3)).toBe(-66.7)
  })

  /**
   * Von null auf etwas ist keine Steigerung um unendlich Prozent. Ein Haus,
   * das im Vorjahr geschlossen war, meldete sonst eine Zahl, die entweder
   * "Infinity" heisst oder, schlimmer, "NaN %" -- und beides sieht auf einem
   * Bildschirm aus wie ein Programmfehler und nicht wie eine Aussage.
   */
  it('sagt nichts, wo nichts zu sagen ist', () => {
    expect(veraenderung(500, 0)).toBeNull()
    expect(veraenderung(0, 0)).toBeNull()
    expect(veraenderung(0, 100)).toBe(-100)
  })
})
