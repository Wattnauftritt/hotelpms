import { describe, it, expect } from 'vitest'
import { anzahlungsteile, summeTeile, anzahlungBereit,
         anzahlungsNutzlast } from '../lib/vorauszahlung.js'
import { kanalZeitraum } from '../lib/queries/rates.js'
import { SCREENS } from '../screens.tsx'

/**
 * Die Rechenteile der Vorauszahlung und der Kanalsicht (B8–B10).
 *
 * Geprüft wird, was ohne Bildschirm falsch sein kann: ein Cent in der
 * Aufteilung und ein Tag im Zeitraum. Beides sieht man der Oberfläche nicht
 * an — man sieht es an der Rechnung des Gastes und am Preis beim Portal.
 */

describe('Aufteilung einer Anzahlung auf Steuersätze', () => {
  it('rechnet in Cent und nie über Fließkomma', () => {
    // 0,07 + 0,01 wäre in Fließkomma 0,08000000000000002.
    expect(summeTeile([{ betrag: '0,07', satz: 700 }, { betrag: '0,01', satz: 1900 }]))
      .toBe(8)
    expect(summeTeile([{ betrag: '129,50', satz: 700 }])).toBe(12_950)
    // Punkt und Komma sind beide zulässig, die Gruppierung ebenso.
    expect(summeTeile([{ betrag: '1.234,50', satz: 700 }])).toBe(123_450)
  })

  it('lässt leere Zeilen weg, statt sie als Null mitzuschicken', () => {
    const teile = [{ betrag: '70,00', satz: 700 }, { betrag: '', satz: 1900 },
                   { betrag: '30,00', satz: 1900 }]
    expect(anzahlungsteile(teile)).toEqual([
      { grossCent: 7_000, taxRateBp: 700 },
      { grossCent: 3_000, taxRateBp: 1900 }])
  })

  it('gibt erst frei, wenn die Teile den Betrag auf den Cent ergeben', () => {
    const teile = [{ betrag: '70,00', satz: 700 }, { betrag: '29,99', satz: 1900 }]
    expect(anzahlungBereit('split', teile, 10_000)).toBe(false)
    expect(anzahlungBereit('split',
      [{ betrag: '70,00', satz: 700 }, { betrag: '30,00', satz: 1900 }], 10_000)).toBe(true)
    // Ohne gewählten Zahlungsvermerk gibt es nichts freizugeben.
    expect(anzahlungBereit('derive', teile, null)).toBe(false)
  })

  it('schickt bei der Ableitung keinen Steuersatz mit', () => {
    // Der Kern: ein mitgeschickter Satz -- und sei es der voreingestellte --
    // schaltet die Ableitung aus der Reservierung aus.
    expect(anzahlungsNutzlast('derive', 700, [])).toEqual({})
    expect(anzahlungsNutzlast('single', 1900, [])).toEqual({ taxRateBp: 1900 })
    expect(anzahlungsNutzlast('split', 700,
      [{ betrag: '10,00', satz: 700 }]))
      .toEqual({ lines: [{ grossCent: 1_000, taxRateBp: 700 }] })
  })
})

describe('Zeitraum der Kanalsicht', () => {
  it('macht aus dem einschließenden Ende des Rasters das ausschließende von ARI', () => {
    // Das Raster zeigt den 5. mit; ARI zählt Nächte und will den 6. als Ende.
    expect(kanalZeitraum('2026-10-01', '2026-10-05'))
      .toEqual({ from: '2026-10-01', to: '2026-10-06' })
  })

  it('trägt über Monats-, Jahres- und Schaltjahresgrenzen', () => {
    expect(kanalZeitraum('2026-01-01', '2026-01-31').to).toBe('2026-02-01')
    expect(kanalZeitraum('2026-12-01', '2026-12-31').to).toBe('2027-01-01')
    // 2028 ist ein Schaltjahr: auf den 28. folgt der 29., nicht der 1. März.
    expect(kanalZeitraum('2028-02-01', '2028-02-28').to).toBe('2028-02-29')
    // Die Zeitumstellung darf nichts verschieben: Kalenderdaten sind keine
    // Zeitpunkte. Am 29.03.2026 wird in Deutschland umgestellt.
    expect(kanalZeitraum('2026-03-28', '2026-03-29').to).toBe('2026-03-30')
  })
})

describe('Bildschirme', () => {
  it('erreicht die Kanalsicht über die Preise, nicht über einen eigenen Eintrag', () => {
    // Sie hängt am Preisbildschirm und an dessen Recht: die Frage stellt
    // sich dem, der Preise pflegt.
    const preise = SCREENS.find(s => s.key === 'rates')
    expect(preise?.permission).toBe('rate:read')
    expect(SCREENS.filter(s => s.key === 'channel-view')).toHaveLength(0)
  })
})
