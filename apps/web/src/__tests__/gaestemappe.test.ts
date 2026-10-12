import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FOLDER_LOCALES, folderLink, folderRefAusFragment, wifiQrText } from '@hotelpms/contracts'
import { istMappeAdresse, istCheckinAdresse } from '../gast/adresse.js'
import { MAPPE_TEXTE, mappeText, startSprache } from '../gast/mappeTexte.js'

/**
 * Die digitale Gaestemappe in der Oberflaeche (Migration 0143).
 *
 * Quelltextbasiert wie die Tests der anderen Gastseiten: geprueft wird, was
 * still schiefginge -- die Referenz im Fragment statt im Pfad, nichts vom
 * Zimmer im Browserspeicher, und ein vollstaendiger Katalog in jeder
 * Sprache der Gaeste.
 */

const quelle = (datei: string): string =>
  readFileSync(join(import.meta.dirname, '..', datei), 'utf8')

describe('Adresse der Mappe', () => {
  it('traegt die Zimmer-Referenz im Fragment, nicht im Pfad', () => {
    const link = folderLink('https://app.staygrid.test/', 'ABCDEFGHJKMN')
    expect(link).toBe('https://app.staygrid.test/mappe#ABCDEFGHJKMN')
    const url = new URL(link)
    expect(istMappeAdresse(url.pathname)).toBe(true)
    expect(folderRefAusFragment(url.hash)).toBe('ABCDEFGHJKMN')
    expect(url.pathname).not.toContain('ABCDEFGHJKMN')
    expect(url.search).toBe('')
  })

  it('weist verformte Referenzen ab, ohne zu fragen', () => {
    expect(folderRefAusFragment('#')).toBeNull()
    expect(folderRefAusFragment('#ABCDEFGHJKM')).toBeNull()
    // 0, 1, I, L, O, U kommen im Alphabet von generate_public_ref nicht vor.
    expect(folderRefAusFragment('#ABCDEFGHJKMO')).toBeNull()
    expect(folderRefAusFragment('#abcdefghjkmn')).toBe('ABCDEFGHJKMN')
  })

  it('verwechselt die Mappe nicht mit anderen Gastseiten', () => {
    expect(istMappeAdresse('/mappe/')).toBe(true)
    expect(istMappeAdresse('/mappen')).toBe(false)
    expect(istCheckinAdresse('/mappe')).toBe(false)
  })

  it('laedt eine eigene Anwendung, nicht die Rezeption', () => {
    const boot = quelle('boot.ts')
    expect(boot).toMatch(/istMappeAdresse\(location\.pathname\)\)\s*\{\s*void import\('\.\/gast\/mappe\.tsx'\)/)
  })
})

describe('Seite des Gastes', () => {
  it('legt nichts im Browser ab und schickt die Referenz als Kopfzeile', () => {
    const seite = quelle('routes/GastMappe.tsx')
    expect(seite).not.toMatch(/(localStorage|sessionStorage|indexedDB)\s*[.[]/)
    expect(seite).not.toMatch(/useQuery/)
    expect(seite).toContain('FOLDER_ROOM_HEADER')
    // Seitentext ist Text, nie HTML.
    expect(seite).not.toContain('dangerouslySetInnerHTML')
  })

  it('zeigt die Uebersetzung der gewaehlten Sprache und sonst Deutsch, als deutsch ausgezeichnet', () => {
    const seite = quelle('routes/GastMappe.tsx')
    expect(seite).toMatch(/locale === 'de' \? undefined : seite\.translations\[locale\]/)
    expect(seite).toMatch(/lang=\{fassung === undefined \? 'de' : locale\}/)
    // Im Format des Terminals, damit **fett** nicht als Sternchen erscheint.
    expect(seite).toContain('<Inhaltstext')
  })
})

describe('Katalog der Mappe', () => {
  it('hat jeden Satz in jeder Sprache der Gaeste, keinen leer', () => {
    for (const [k, v] of Object.entries(MAPPE_TEXTE)) {
      for (const l of FOLDER_LOCALES) {
        expect(v[l]?.trim(), `${k} ${l}`).toBeTruthy()
      }
    }
  })

  it('setzt Platzhalter ein und beginnt in der Sprache des Telefons', () => {
    expect(mappeText('room', 'nl', { room: '12' })).toBe('Kamer 12')
    expect(startSprache('pl-PL')).toBe('pl')
    expect(startSprache('fr-FR')).toBe('en')
  })
})

describe('WLAN-QR-Code', () => {
  it('maskiert, was das Format sonst zerlegt', () => {
    expect(wifiQrText({ ssid: 'Gästehaus', password: 'a;b', security: 'WPA', hidden: false }))
      .toBe('WIFI:T:WPA;S:Gästehaus;P:a\\;b;;')
  })
})
