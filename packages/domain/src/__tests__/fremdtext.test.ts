import { describe, it, expect } from 'vitest'
import { fremdText, fremdEmail, fremdTelefon } from '../fremdtext.js'
import { kanalRumpfPruefen } from '../channelBooking.js'
import { kanalSignatur, kanalSignaturGueltig } from '../kanalSignatur.js'

/**
 * Text aus einem fremden System (Bedrohungsanalyse 23.10.2026, T10).
 * Festgehalten wird, was ein Gast nie merkt und eine E-Rechnung bricht.
 */
describe('fremdText', () => {
  it('entfernt Steuer- und Richtungszeichen und faltet Weissraum', () => {
    expect(fremdText('Mül\u0001ler‮  Anna\n', 100)).toBe('Müller Anna')
    expect(fremdText('​\u0007', 100)).toBeUndefined()
    expect(fremdText(42, 100)).toBeUndefined()
  })

  it('laesst in Notizen Absaetze stehen', () => {
    expect(fremdText('Zimmer\r\n\r\n\r\n\rruhig\tbitte', 100, true)).toBe('Zimmer\n\nruhig bitte')
  })

  it('kuerzt nach Zeichen, ohne ein Emoji zu zerschneiden', () => {
    expect(fremdText('a'.repeat(300), 100)).toHaveLength(100)
    expect(fremdText('ab😀', 3)).toBe('ab😀')
    expect(fremdText('abc😀', 3)).toBe('abc')
  })

  it('verwirft kaputte Adressen und Rufnummern', () => {
    expect(fremdEmail('anna@beispiel.de')).toBe('anna@beispiel.de')
    expect(fremdEmail('anna@beispiel.de<script>')).toBeUndefined()
    expect(fremdTelefon('+49 (4721) 123-45')).toBe('+49 (4721) 123-45')
    expect(fremdTelefon('Rückruf unter wa.me/123')).toBeUndefined()
  })
})

describe('Kanalbuchung', () => {
  const segment = { categoryCode: 'DZ', arrival: '2026-11-01', departure: '2026-11-03' }

  it('kommt bereinigt an, egal welcher Adapter sie bringt', () => {
    const b = kanalRumpfPruefen({ segments: [segment],
      guest: { lastName: ' Meyer\u0001 ', firstName: '‮anna', email: 'kaputt', phone: '0471 1' },
      notes: 'Spaet\u0000 an', channelCode: 'Booking.com' })
    expect(b.guest).toEqual({ lastName: 'Meyer', firstName: 'anna', phone: '0471 1' })
    expect(b.notes).toBe('Spaet an')
    expect(b.channelCode).toBe('Booking.com')
  })

  it('weist einen Namen aus lauter Steuerzeichen ab', () => {
    expect(() => kanalRumpfPruefen({ segments: [segment], guest: { lastName: '\u0001\u0002' } }))
      .toThrow()
  })
})

describe('Signatur einer Kanalnachricht', () => {
  const geheimnis = 'ein-langes-geheimnis-123'
  const rumpf = '{"revision":"r1"}'

  it('nimmt eine frische, richtige Signatur an', () => {
    const sig = kanalSignatur(geheimnis, 1_000_000, rumpf)
    expect(kanalSignaturGueltig({ geheimnis, rumpf, zeitstempel: '1000000', signatur: sig,
                                  jetztS: 1_000_100 })).toBe(true)
  })

  it('weist veraenderten Rumpf, altes Datum und fehlende Angaben ab', () => {
    const sig = kanalSignatur(geheimnis, 1_000_000, rumpf)
    const basis = { geheimnis, zeitstempel: '1000000', signatur: sig, jetztS: 1_000_000 }
    expect(kanalSignaturGueltig({ ...basis, rumpf: rumpf + ' ' })).toBe(false)
    expect(kanalSignaturGueltig({ ...basis, rumpf, jetztS: 1_000_301 })).toBe(false)
    expect(kanalSignaturGueltig({ ...basis, rumpf, signatur: undefined })).toBe(false)
    expect(kanalSignaturGueltig({ ...basis, rumpf, geheimnis: 'kurz' })).toBe(false)
  })
})
