import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LOCALES, MESSAGE_TEXTE } from '@hotelpms/contracts'
import { meldungsTexte, oberflaechenTexte, textFor } from '../lib/i18n/index.js'
import { textKeys, texts } from '../lib/i18n/katalog.js'

/**
 * Die Sprachpakete (Dokument 19): je Katalog und Sprache eine Datei, damit
 * der Browser nur die Sprache holt, die gilt.
 *
 * Geprueft wird zweierlei. Dass ein Paket genau den Katalog der Quelle
 * traegt -- ein Bauschritt, der eine Sprache verwechselt oder Schluessel
 * verliert, zeigte sonst still den falschen Satz. Und dass zur Laufzeit
 * niemand mehr die Kataloge selbst importiert: eine einzige Zeile
 * `import { texts } from './katalog.js'` zoege wieder alle Sprachen in den
 * Browser, und kein Test sonst saehe das.
 */
describe('Sprachpakete', () => {
  it('tragen je Sprache genau den Katalog der Quelle', async () => {
    for (const l of LOCALES) {
      const paket = await oberflaechenTexte.laden(l)
      expect(Object.keys(paket).length, l).toBe(textKeys().length)
      for (const k of textKeys()) expect(paket[k], `${k} / ${l}`).toBe(texts[k][l])
      const meldungen = await meldungsTexte.laden(l)
      for (const [k, saetze] of Object.entries(MESSAGE_TEXTE)) {
        expect(meldungen[k], `${k} / ${l}`).toBe(saetze[l])
      }
    }
  })

  it('setzen Werte ein und fallen ohne Paket auf Deutsch zurueck', async () => {
    await oberflaechenTexte.laden('de')
    expect(textFor('app.noScreen', 'de', { haus: 'Seerobbe' })).toContain('Seerobbe')
  })

  it('werden zur Laufzeit nicht umgangen', () => {
    const quelle = join(import.meta.dirname, '..')
    const verstoesse: string[] = []
    const suchen = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const pfad = join(dir, name)
        if (statSync(pfad).isDirectory()) {
          if (name !== '__tests__') suchen(pfad)
          continue
        }
        // Der Bauschritt liest die Kataloge, die Kataloge sind die Quelle.
        if (!/\.tsx?$/.test(name) || name === 'sprachpaketBau.ts') continue
        const text = readFileSync(pfad, 'utf8')
        for (const m of text.matchAll(/^import (type )?[^;]*?from '([^']+)'/gms)) {
          if (m[1] !== undefined) continue
          // Ein Katalog oder ein Bereich daraus, als Wert importiert. Nur
          // `katalog.ts` selbst setzt die Bereiche zusammen.
          const ziel = m[2]!
          const katalog = /\/(katalog|mappeKatalog)(\.js|\.ts)?$/.test(ziel)
          const bereich = /i18n\/(?!index\b)[a-zA-Z]+(\.js|\.ts)?$/.test(ziel)
            || (pfad.includes(join('lib', 'i18n')) && /^\.\/(?!index\b)[a-zA-Z]+\.js$/.test(ziel))
          if ((katalog || bereich) && !pfad.endsWith(join('i18n', 'katalog.ts'))) {
            verstoesse.push(`${pfad.slice(quelle.length + 1)}: ${m[2]}`)
          }
        }
        if (/renderMessage|MESSAGE_TEXTE/.test(text) && !pfad.endsWith('meldungen.ts')) {
          verstoesse.push(`${pfad.slice(quelle.length + 1)}: Meldungskatalog`)
        }
      }
    }
    suchen(quelle)
    expect(verstoesse, 'Diese Dateien laden einen ganzen Katalog').toEqual([])
  })
})
