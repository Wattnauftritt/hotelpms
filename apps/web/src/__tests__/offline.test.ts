import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cacheRead, cacheWrite, offlineKopieLoeschen } from '../lib/offline.js'

/**
 * Die Offline-Kopie haelt Gastnamen im Browser (Befund M8).
 *
 * Geprueft wird, was am geteilten Rezeptionsrechner zaehlt: nach dem
 * Abmelden liegt keine Liste mehr da, und waehrend des Betriebs wachsen
 * nicht Wochen an Anreiselisten auf. Die Tests laufen in Node; der
 * Browserspeicher ist hier eine Map mit derselben Schnittstelle.
 */
function speicher(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => { m.clear() }
  }
}

const schluessel = (): string[] => {
  const alle: string[] = []
  for (let i = 0; i < localStorage.length; i++) alle.push(localStorage.key(i) ?? '')
  return alle.sort()
}

beforeEach(() => { vi.stubGlobal('localStorage', speicher()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('Offline-Kopie beim Abmelden', () => {
  it('entfernt alle Offline-Schluessel und laesst fremde stehen', () => {
    cacheWrite('daily.1.2026-10-11', { gast: 'Meyer' }, '2026-10-11')
    cacheWrite('hk.1.2026-10-12', { gast: 'Schulz' }, '2026-10-11')
    cacheWrite('daily.2.2026-10-11', { gast: 'Weber' }, '2026-10-11')
    localStorage.setItem('staygrid.locale', 'en')
    localStorage.setItem('staygrid.plan.tage', '21')

    offlineKopieLoeschen()

    expect(schluessel()).toEqual(['staygrid.locale', 'staygrid.plan.tage'])
    expect(cacheRead('daily.1.2026-10-11')).toBeNull()
  })

  it('scheitert nicht an gesperrtem Speicher', () => {
    vi.stubGlobal('localStorage', {
      get length(): number { throw new Error('SecurityError') }
    })
    expect(() => { offlineKopieLoeschen() }).not.toThrow()
    expect(() => { cacheWrite('daily.1.2026-10-11', {}, '2026-10-11') }).not.toThrow()
  })
})

describe('Offline-Kopie beim Schreiben', () => {
  it('verwirft Tage vor gestern und behaelt gestern, heute und die Zukunft', () => {
    const vorher = '2026-10-01'
    for (const tag of ['2026-09-28', '2026-10-01', '2026-10-02', '2026-10-05']) {
      cacheWrite(`daily.1.${tag}`, { tag }, vorher)
      cacheWrite(`hk.1.${tag}`, { tag }, vorher)
    }
    localStorage.setItem('staygrid.locale', 'de')

    // Neun Tage spaeter wird wieder geschrieben: was vor gestern liegt, faellt.
    cacheWrite('daily.1.2026-10-10', { tag: '2026-10-10' }, '2026-10-10')

    expect(schluessel()).toEqual([
      'staygrid.locale',
      'staygrid.offline.daily.1.2026-10-10'
    ])

    cacheWrite('daily.1.2026-10-09', { tag: 'gestern' }, '2026-10-10')
    cacheWrite('hk.1.2026-10-20', { tag: 'voraus' }, '2026-10-10')
    expect(cacheRead<{ tag: string }>('daily.1.2026-10-09')?.data.tag).toBe('gestern')
    expect(cacheRead<{ tag: string }>('hk.1.2026-10-20')?.data.tag).toBe('voraus')
    expect(cacheRead('daily.1.2026-10-10')).not.toBeNull()
  })

  it('legt ein altes Datum, das jemand nachschlaegt, gar nicht erst ab', () => {
    cacheWrite('daily.1.2026-10-08', { gast: 'Meyer' }, '2026-10-10')
    expect(cacheRead('daily.1.2026-10-08')).toBeNull()
    expect(schluessel()).toEqual([])
  })

  it('rechnet ueber den Monatswechsel als Kalenderdatum', () => {
    cacheWrite('daily.1.2026-10-31', {}, '2026-10-31')
    cacheWrite('daily.1.2026-10-30', {}, '2026-10-31')
    cacheWrite('daily.1.2026-11-01', {}, '2026-11-01')
    // Gestern vom 1.11. ist der 31.10.; der 30.10. liegt davor.
    expect(schluessel()).toEqual([
      'staygrid.offline.daily.1.2026-10-31',
      'staygrid.offline.daily.1.2026-11-01'
    ])
  })
})
