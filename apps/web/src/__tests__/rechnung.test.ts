import { describe, it, expect } from 'vitest'
import { zeitraum, istBelegInArbeit } from '../lib/queries/billing.js'
import { ApiError } from '../lib/api.js'
import { SCREENS, visibleScreens } from '../screens.js'

/**
 * Geprüft wird, was an der Rechnungsliste still falsch sein kann: ein
 * Zeitraum, der einen Tag daneben liegt, und die Unterscheidung zwischen
 * „der Beleg wird gerade erzeugt" und „hier ist etwas kaputt". Das eine ist
 * ein Zustand, das andere ein Fehler, und wer sie verwechselt, zeigt der
 * Rezeption eine rote Meldung für einen Vorgang, der planmäßig läuft.
 */

describe('Zeitraum der Liste', () => {
  it('zählt beide Enden mit', () => {
    // 30 Tage bis zum 30. Oktober beginnen am 1., nicht am 30. September.
    expect(zeitraum('2026-10-30', 30)).toEqual({ von: '2026-10-01', bis: '2026-10-30' })
    expect(zeitraum('2026-10-01', 1)).toEqual({ von: '2026-10-01', bis: '2026-10-01' })
  })

  it('läuft über Monats- und Jahresgrenzen und über die Zeitumstellung', () => {
    expect(zeitraum('2027-01-05', 10).von).toBe('2026-12-27')
    expect(zeitraum('2026-03-30', 7).von).toBe('2026-03-24')
    expect(zeitraum('2026-10-26', 7).von).toBe('2026-10-20')
  })

  it('bleibt in der Obergrenze des Endpunkts', () => {
    const { von, bis } = zeitraum('2027-02-04', 400)
    expect(von).toBe('2026-01-01')
    expect(bis).toBe('2027-02-04')
  })
})

describe('Beleg in Arbeit', () => {
  const problem = (type: string, status: number): ApiError =>
    new ApiError({ type, title: 'x', status }, status)

  /**
   * Der Beleg entsteht nach dem Festschreiben im Worker. Bis dahin
   * antwortet die API mit 409 und `document_pending` — das ist kein
   * Fehler, sondern „gleich".
   */
  it('erkennt den Zustand am Typ, nicht am Statuscode', () => {
    expect(istBelegInArbeit(problem('urn:staygrid:document_pending', 409))).toBe(true)
    // Ein anderer Konflikt ist keiner davon: eine schon verschickte
    // Rechnung antwortet ebenfalls mit 409.
    expect(istBelegInArbeit(problem('urn:staygrid:conflict', 409))).toBe(false)
    expect(istBelegInArbeit(problem('urn:staygrid:not_found', 404))).toBe(false)
    expect(istBelegInArbeit(new Error('Netz weg'))).toBe(false)
    expect(istBelegInArbeit(null)).toBe(false)
  })
})

describe('Der Bildschirm im Verzeichnis', () => {
  it('haengt am Leserecht fuers Gastkonto', () => {
    expect(SCREENS.find(s => s.key === 'invoices')?.permission).toBe('folio:read')
  })

  it('bleibt einem Konto ohne dieses Recht verborgen', () => {
    expect(visibleScreens(['housekeeping:read']).map(s => s.key)).not.toContain('invoices')
    expect(visibleScreens(['folio:read']).map(s => s.key)).toContain('invoices')
  })
})
