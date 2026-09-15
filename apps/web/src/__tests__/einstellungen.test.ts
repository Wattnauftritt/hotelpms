import { describe, it, expect } from 'vitest'
import { einstellungsBereiche } from '../routes/Settings.tsx'
import { merkmaleLesen } from '../components/Stammdaten.tsx'
import { visibleScreens } from '../screens.js'

/**
 * Geprueft wird die Rechteauswertung und die Umrechnung von Formulardaten
 * in die Nutzlast -- die beiden Stellen, an denen ein Fehler nicht als
 * Fehler aussieht.
 */

describe('Bereiche der Einstellungen', () => {
  it('trennt Gastpost und Zahlungsarten nach ihren Rechten', () => {
    expect(einstellungsBereiche(p => p === 'integration:manage').map(b => b.key))
      .toEqual(['mail'])
    expect(einstellungsBereiche(p => p === 'settings:property').map(b => b.key))
      .toEqual(['pay'])
    // Support-Zugriff kam mit Aufgabe 13c dazu und haengt an
    // settings:account -- siehe support.test.ts.
    expect(einstellungsBereiche(() => true).map(b => b.key))
      .toEqual(['mail', 'pay', 'support'])
    expect(einstellungsBereiche(() => false)).toEqual([])
  })
})

describe('Bildschirme dieser Spur in der Navigation', () => {
  /**
   * Wer die Zimmer macht, findet die Schaeden. Die Wartungsliste haengt
   * deshalb an `housekeeping:read` und nicht erst an `maintenance:write`;
   * anlegen und erledigen bleiben ohne das Schreibrecht verborgen.
   */
  it('zeigt Wartung dem Housekeeping, Einstellungen aber nicht', () => {
    const hk = visibleScreens(['housekeeping:read', 'maintenance:write']).map(s => s.key)
    expect(hk).toContain('maintenance')
    expect(hk).not.toContain('settings')
  })

  it('zeigt Einstellungen bei jedem der beiden Rechte', () => {
    for (const recht of ['integration:manage', 'settings:property']) {
      expect(visibleScreens([recht]).map(s => s.key)).toContain('settings')
    }
  })
})

describe('Merkmale eines Zimmers', () => {
  /**
   * Die Merkmale sind im Modell eine Liste, im Formular eine Zeile. An
   * dieser Umrechnung haengt spaeter die Zimmerzuweisung ("Gast wuenscht
   * barrierefrei") -- ein Merkmal mit Leerzeichen oder in Grossschreibung
   * findet dort nichts, ohne dass es irgendwo eine Fehlermeldung gaebe.
   */
  it('macht aus einer Zeile eine saubere Liste', () => {
    expect(merkmaleLesen('balkon, barrierefrei')).toEqual(['balkon', 'barrierefrei'])
    expect(merkmaleLesen('  Balkon ,BARRIEREFREI  ')).toEqual(['balkon', 'barrierefrei'])
  })

  it('wirft Leeres weg und doppelt nichts', () => {
    expect(merkmaleLesen('')).toEqual([])
    expect(merkmaleLesen(' , , ')).toEqual([])
    expect(merkmaleLesen('balkon,,balkon, Balkon')).toEqual(['balkon'])
  })
})
