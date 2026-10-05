import { describe, it, expect } from 'vitest'
import { nameAufteilen, gastNameAnzeige } from '../lib/gastName.js'

/**
 * Ein Name im Gastfeld der Buchungsmaske wird beim Speichern zum Gast,
 * wenn niemand ausgewählt wurde. Geprüft wird, wie der eingetippte Text
 * in Nach- und Vorname zerfällt -- daran hängt, unter welchem Namen der
 * Gast im Plan und auf dem Meldeschein steht.
 */
describe('Gastname aus der Eingabe', () => {
  it('nimmt ein einzelnes Wort als Nachnamen', () => {
    expect(nameAufteilen('Meier')).toEqual({ lastName: 'Meier' })
  })

  it('nimmt ohne Komma das letzte Wort als Nachnamen', () => {
    expect(nameAufteilen('Max Meier')).toEqual({ lastName: 'Meier', firstName: 'Max' })
    expect(nameAufteilen('Anna Lena Schulz'))
      .toEqual({ lastName: 'Schulz', firstName: 'Anna Lena' })
  })

  it('liest mit Komma den Nachnamen vorn', () => {
    expect(nameAufteilen('Meier, Max')).toEqual({ lastName: 'Meier', firstName: 'Max' })
    expect(nameAufteilen('Meier,')).toEqual({ lastName: 'Meier' })
  })

  it('hält Namenszusätze beim Nachnamen', () => {
    expect(nameAufteilen('Hans von der Meier'))
      .toEqual({ lastName: 'von der Meier', firstName: 'Hans' })
    // Das erste Wort bleibt Vorname, auch klein geschrieben.
    expect(nameAufteilen('max meier')).toEqual({ lastName: 'meier', firstName: 'max' })
  })

  it('räumt Leerraum auf und lässt Leeres leer', () => {
    expect(nameAufteilen('  Max   Meier ')).toEqual({ lastName: 'Meier', firstName: 'Max' })
    expect(nameAufteilen('   ')).toBeNull()
    expect(nameAufteilen(' , ')).toBeNull()
  })

  it('zeigt den Namen so, wie die Maske Gäste zeigt', () => {
    expect(gastNameAnzeige({ lastName: 'Meier', firstName: 'Max' })).toBe('Meier, Max')
    expect(gastNameAnzeige({ lastName: 'Meier' })).toBe('Meier')
  })
})
