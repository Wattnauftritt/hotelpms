import { describe, it, expect } from 'vitest'
import { isClockTime, isMonth, minutesBetween, monthRange } from '../worktime.js'

describe('Arbeitszeit', () => {
  it('rechnet Dienste ueber Mitternacht und weist gleiche Zeiten ab', () => {
    expect(minutesBetween('06:00', '10:30')).toBe(270)
    expect(minutesBetween('22:00', '06:00')).toBe(480)
    expect(minutesBetween('07:00', '07:00')).toBeNull()
  })

  it('kennt Monat, Uhrzeit und Monatsgrenzen mit Schaltjahr', () => {
    expect(isMonth('2026-10')).toBe(true)
    expect(isMonth('2026-13')).toBe(false)
    expect(isClockTime('23:59')).toBe(true)
    expect(isClockTime('24:00')).toBe(false)
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })
})
