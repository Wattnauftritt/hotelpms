import { describe, it, expect } from 'vitest'
import { kanalFarbe, KANAL_NEUTRAL } from '../lib/kanalFarbe.js'

describe('Farbe des Buchungskanals', () => {
  it('erkennt jede Booking-Nummer aus RoomCloud und den Altnamen', () => {
    for (const k of ['Booking 02', 'Booking 07', 'Booking.com', 'booking']) {
      expect(kanalFarbe(k), k).toContain('blue')
    }
  })

  it('faerbt beide Schreibweisen der Mail gleich', () => {
    expect(kanalFarbe('Email')).toContain('red')
    expect(kanalFarbe('E-Mail')).toContain('red')
  })

  it('kennt Expedia und HRS', () => {
    expect(kanalFarbe('Expedia')).toContain('yellow')
    expect(kanalFarbe(' HRS ')).toContain('neutral-300')
  })

  it('laesst Unbekanntes und bloss Aehnliches neutral', () => {
    for (const k of ['Agoda', 'BookingEngine', 'GH neu', 'Emailing', 'HRSX']) {
      expect(kanalFarbe(k), k).toBe(KANAL_NEUTRAL)
    }
  })
})
