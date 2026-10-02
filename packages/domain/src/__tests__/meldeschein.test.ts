import { describe, it, expect } from 'vitest'
import { requiresRegistrationSignature } from '../meldeschein.js'

/**
 * Unterschriftspflicht nach § 29 Abs. 2 BMG: Staatsangehörigkeit vor
 * Anschrift (Dokument 30, Abschnitt 2.2).
 */
describe('Unterschrift auf dem Meldeschein', () => {
  it('verlangt sie von der Türkin mit Wohnsitz in Köln', () => {
    expect(requiresRegistrationSignature({ nationality: 'TR', country: 'DE' })).toBe(true)
  })

  it('verlangt sie nicht vom Deutschen mit Wohnsitz in Wien', () => {
    expect(requiresRegistrationSignature({ nationality: 'DE', country: 'AT' })).toBe(false)
  })

  it('verlangt sie vom Niederländer in Amsterdam', () => {
    expect(requiresRegistrationSignature({ nationality: 'NL', country: 'NL' })).toBe(true)
  })

  it('verlangt sie nicht von der Deutschen in Husum', () => {
    expect(requiresRegistrationSignature({ nationality: 'DE', country: 'DE' })).toBe(false)
  })

  it('nimmt ohne Staatsangehörigkeit ersatzweise die Anschrift', () => {
    expect(requiresRegistrationSignature({ nationality: null, country: 'NL' })).toBe(true)
    expect(requiresRegistrationSignature({ nationality: '', country: 'DE' })).toBe(false)
  })

  it('verlangt sie ohne jede Angabe nicht', () => {
    expect(requiresRegistrationSignature({ nationality: null, country: null })).toBe(false)
    expect(requiresRegistrationSignature({})).toBe(false)
  })

  it('liest Kleinschreibung wie Grossschreibung', () => {
    expect(requiresRegistrationSignature({ nationality: 'de', country: 'at' })).toBe(false)
  })
})
