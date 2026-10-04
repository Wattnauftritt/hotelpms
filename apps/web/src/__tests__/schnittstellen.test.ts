import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
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
    expect(schnittstellenBereiche(p => p === 'user:manage')).toEqual([])
    expect(schnittstellenBereiche(() => true).map(b => b.key))
      .toEqual(['webhooks', 'clients', 'channel'])
  })

  it('sagt nichts zu, solange nichts geladen ist', () => {
    expect(schnittstellenBereiche(() => false)).toEqual([])
  })
})

describe('Bildschirm in der Navigation', () => {
  it('erscheint nur fuer den, der Maschinen anbindet', () => {
    expect(visibleScreens(['integration:manage']).map(s => s.key)).toContain('integrations')
    expect(visibleScreens(['user:manage']).map(s => s.key)).not.toContain('integrations')
    expect(visibleScreens(['reservation:read']).map(s => s.key))
      .not.toContain('integrations')
  })

  /**
   * Der Befund (Sven, 04.10.2026): ein Kunde fand keine Benutzerverwaltung.
   * Es gab sie -- als vierten Reiter unter „Schnittstellen", wo niemand
   * Personal sucht. Sie steht jetzt im Menue „Einstellungen", und zwar fuer
   * jeden mit `user:manage`, auch ohne ein anderes Einstellungsrecht.
   */
  it('fuehrt Benutzer und Rollen im Menue Einstellungen', () => {
    const benutzer = visibleScreens(['user:manage']).find(s => s.key === 'users')
    expect(benutzer?.group).toBe('settings')
    expect(visibleScreens(['integration:manage', 'reservation:read']).map(s => s.key))
      .not.toContain('users')
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

/**
 * Der Kunde verwaltet sein Personal selbst (0040) -- was die Oberflaeche
 * dabei zeigt und was nicht. Die Grenze zieht die API; hier steht, dass die
 * Oberflaeche sie nachzeichnet, statt Knoepfe zu zeigen, die mit 403 oder
 * 409 antworten.
 */
describe('Selbstverwaltung des Personals', () => {
  const quelle = readFileSync(
    new URL('../routes/Benutzer.tsx', import.meta.url), 'utf8')

  it('zeigt am eigenen Eintrag weder Sperre noch Entfernen', () => {
    expect(quelle).toMatch(/\{!istSelbst && \(/)
  })

  it('fasst einen Inhaber nur an, wer den Betrieb verwaltet', () => {
    // Sonst sperrt die Direktion eines Hauses den, dem der Betrieb gehoert.
    expect(quelle).toMatch(/benutzer\.accountRoles\.length === 0 \|\| darfBetrieb/)
  })

  it('fragt vor Sperren und Entfernen mit dem Satz, der sagt, was passiert', () => {
    expect(quelle).toContain('user.blockConfirm')
    expect(quelle).toContain('user.removeConfirm')
  })

  it('laedt ein, statt ein Kennwort zu vergeben', () => {
    expect(quelle).toContain('useInviteUser')
    expect(quelle).not.toMatch(/password/i)
  })
})
