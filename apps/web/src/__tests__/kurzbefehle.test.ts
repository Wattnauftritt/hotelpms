import { beforeAll, describe, expect, it } from 'vitest'
import { kurzbefehleFuer, titelTexte } from '../lib/kurzbefehle.js'

// Die Titel kommen als Paket je Sprache; im Betrieb holt
// `kurzbefehleAktualisieren` es vor dem Setzen.
beforeAll(async () => { await titelTexte.laden('de') })

const ids = (...haeuser: string[][]): string[] =>
  kurzbefehleFuer(haeuser.map(permissions => ({ permissions })), 'de').map(k => k.id)

describe('Schnellaktionen am App-Symbol', () => {
  it('gibt der Rezeption ihre vier, in Svens Reihenfolge', () => {
    const k = kurzbefehleFuer([{ permissions: ['reservation:read', 'cashbook:read', 'guest:write'] }], 'de')
    expect(k.map(x => x.titel)).toEqual(
      ['Anreisen heute', 'Kalender', 'Kassenbuch', 'Visitenkarte scannen'])
    expect(k.map(x => x.pfad)).toEqual(['/?screen=today', '/?screen=tape', '/?screen=cashbook',
      '/?screen=guests&kurzbefehl=visitenkarte'])
  })

  it('laesst weg, wofuer das Recht fehlt, und fuellt mit der naechsten Rolle auf', () => {
    expect(ids(['reservation:read', 'housekeeping:plan', 'housekeeping:inspect']))
      .toEqual(['anreisen', 'kalender', 'kontrolleRezeption', 'reinigungsplan'])
  })

  it('schickt Hausdame und Kueche mit Personal-App in die Personal-App', () => {
    expect(ids(['staff:app', 'housekeeping:plan', 'housekeeping:inspect']))
      .toEqual(['kontrolle', 'reinigungsplan', 'zimmer', 'zusatzarbeit'])
    expect(ids(['staff:app', 'kitchen:breakfast'])).toEqual(['zimmer', 'zusatzarbeit', 'fruehstueck'])
    expect(ids(['kitchen:breakfast'])).toEqual(['fruehstueckRezeption'])
  })

  it('verlangt alle Rechte einer Aktion im selben Haus', () => {
    // Kontrolle im Hotel, Personal-App nur im Gaestehaus: die Kontrolle
    // fuehrt in die Rezeption, denn die Personal-App zeigte sie dort nicht.
    expect(ids(['housekeeping:plan', 'housekeeping:inspect'], ['staff:app']))
      .toEqual(['kontrolleRezeption', 'reinigungsplan', 'zimmer', 'zusatzarbeit'])
  })

  it('ist ohne Rechte leer und nennt nur Pfade dieser App', () => {
    expect(ids([])).toEqual([])
    const alle = kurzbefehleFuer([{ permissions: ['reservation:read', 'cashbook:read', 'guest:write',
      'housekeeping:plan', 'housekeeping:inspect', 'staff:app', 'kitchen:breakfast',
      'worktime:manage'] }], 'ar')
    expect(alle).toHaveLength(4)
    for (const k of alle) {
      expect(k.pfad).toMatch(/^\/(?!\/)/)
      expect(k.titel.length).toBeGreaterThan(0)
    }
  })
})
