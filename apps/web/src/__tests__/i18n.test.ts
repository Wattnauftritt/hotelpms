import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { LOCALES, textKeys, textFor } from '../lib/i18n/index.js'

/**
 * Der Katalog der Oberflaeche.
 *
 * Dass ein Schluessel in beiden Sprachen **existiert**, faengt schon der
 * Typecheck ab: `TextKey` leitet sich aus dem deutschen Block ab, und ein
 * fehlender englischer Eintrag bricht den Build. Was er nicht faengt, steht
 * hier: ein leerer Satz, ein Platzhalter, den nur eine Sprache kennt, und
 * ein Text, der im Code steht statt im Katalog.
 */

const I18N = join(import.meta.dirname, '..', 'lib', 'i18n')

describe('Katalog der Oberflaeche', () => {
  it('hat in jeder Sprache einen Satz zu jedem Schluessel', () => {
    for (const key of textKeys()) {
      for (const locale of LOCALES) {
        expect(textFor(key, locale).trim().length, `${key} / ${locale}`)
          .toBeGreaterThan(0)
      }
    }
  })

  /**
   * Ein Platzhalter, der nur in einer Sprache steht, ist der teure Fall: der
   * deutsche Satz nennt das Haus, der englische verschweigt es, und auf dem
   * Bildschirm steht ein Satz, der niemanden meint.
   */
  it('haelt die Platzhalter in beiden Sprachen gleich', () => {
    const platzhalter = (s: string) =>
      [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]!).sort()
    for (const key of textKeys()) {
      expect(platzhalter(textFor(key, 'en')), key)
        .toEqual(platzhalter(textFor(key, 'de')))
    }
  })

  /**
   * Jeder Bereich liegt in seiner eigenen Datei und ist im Index eingetragen.
   * Eine Datei, die niemand importiert, faellt sonst erst auf, wenn ein
   * Bildschirm seine Schluessel unuebersetzt zeigt.
   */
  it('traegt jeden Bereich in beide Sprachbloecke ein', () => {
    const index = readFileSync(join(I18N, 'index.ts'), 'utf8')
    const bereiche = readdirSync(I18N)
      .filter(n => n.endsWith('.ts') && n !== 'index.ts')
      .map(n => n.replace(/\.ts$/, ''))
    expect(bereiche.length).toBeGreaterThan(5)
    for (const bereich of bereiche) {
      expect(index, `${bereich} ist nicht importiert`)
        .toContain(`from './${bereich}.js'`)
      expect(index, `${bereich} fehlt im deutschen Block`)
        .toContain(`...${bereich}.de`)
      expect(index, `${bereich} fehlt im englischen Block`)
        .toContain(`...${bereich}.en`)
    }
  })
})
