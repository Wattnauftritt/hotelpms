import { describe, it, expect } from 'vitest'
import { schnittstellenBereiche } from '../routes/Integrations.tsx'
import { visibleScreens, resolveScreen } from '../screens.js'

/**
 * Geprueft wird die Rechteauswertung -- die Stelle, an der ein Fehler nicht
 * als Fehler aussieht: ein zu grosszuegiger Reiter zeigt sich erst als 403
 * beim Klicken, ein zu strenger nie.
 */

describe('Bereiche der Schnittstellen', () => {
  /**
   * Zwei verschiedene Rechte, zwei verschiedene Menschen: `integration:manage`
   * hat, wer Maschinen anbindet; `user:manage`, wer Personal verwaltet. Das
   * ist selten dieselbe Person, und keiner von beiden soll den Bereich des
   * anderen sehen.
   */
  it('trennt Maschinen von Menschen', () => {
    expect(schnittstellenBereiche(p => p === 'integration:manage').map(b => b.key))
      .toEqual(['webhooks', 'clients', 'channel'])
    expect(schnittstellenBereiche(p => p === 'user:manage').map(b => b.key))
      .toEqual(['users'])
    expect(schnittstellenBereiche(() => true).map(b => b.key))
      .toEqual(['webhooks', 'clients', 'channel', 'users'])
  })

  it('sagt nichts zu, solange nichts geladen ist', () => {
    expect(schnittstellenBereiche(() => false)).toEqual([])
  })
})

describe('Bildschirm in der Navigation', () => {
  it('erscheint bei jedem der beiden Rechte', () => {
    for (const recht of ['integration:manage', 'user:manage']) {
      expect(visibleScreens([recht]).map(s => s.key)).toContain('integrations')
    }
    expect(visibleScreens(['reservation:read']).map(s => s.key))
      .not.toContain('integrations')
  })

  /**
   * Ein Lesezeichen auf einen Bildschirm, den dieses Konto nicht darf,
   * fuehrt still zurueck statt in eine Fehlerseite -- hier geprueft an dem
   * Bildschirm, den am wenigsten Leute duerfen.
   */
  it('faellt still zurueck, wenn das Recht fehlt', () => {
    expect(resolveScreen('integrations', ['reservation:read'])?.key).toBe('tape')
  })
})
