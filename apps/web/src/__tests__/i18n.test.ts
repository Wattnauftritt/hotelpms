import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { EMAIL_LANGUAGES } from '@hotelpms/contracts'
import { LOCALES, textKeys, textFor, formatMoney, geldFormatierer,
         weekdayShort } from '../lib/i18n/index.js'

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

describe('Sprachen der Gastpost in der Maske', () => {
  /**
   * Die Gastmaske bietet die Sprachen an, in denen wir schreiben -- und die
   * Liste dafuer ist `EMAIL_LANGUAGES`, nicht eine zweite im Bildschirm.
   * Kommt eine Sprache dazu und fehlt hier ihr Name, stuende im Auswahlfeld
   * der Schluessel: "guests.language.nl".
   */
  it('benennt jede Sprache, in der Gastpost hinausgeht', () => {
    const vorhanden = new Set<string>(textKeys())
    for (const lang of EMAIL_LANGUAGES) {
      expect(vorhanden.has(`guests.language.${lang}`),
        `guests.language.${lang} fehlt im Katalog`).toBe(true)
    }
  })
})

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
      const erwartet = platzhalter(textFor(key, 'de'))
      for (const locale of LOCALES) {
        expect(platzhalter(textFor(key, locale)), `${key} / ${locale}`)
          .toEqual(erwartet)
      }
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

/**
 * Die Formatierer.
 *
 * `new Intl.NumberFormat(...)` baut jedes Mal die Regeln einer Sprache auf.
 * Auf einer Liste faellt das nicht auf, im Preisraster schon: 400 Tage mal
 * zehn Ratenplaene sind sechzehnhundert Zellen, und bei jeder Mausbewegung
 * entstand fuer jede ein eigenes Objekt -- gemessen 328 ms je Zug mit der
 * Maus. Geprueft wird deshalb nicht die Geschwindigkeit (das waere ein
 * wackliger Test), sondern die Ursache: dass derselbe Formatierer
 * wiederkommt.
 */
describe('Formatierer', () => {
  it('gibt fuer dieselbe Sprache und Waehrung denselben Formatierer zurueck', () => {
    expect(geldFormatierer('de')).toBe(geldFormatierer('de'))
    expect(geldFormatierer('de', 'CHF')).toBe(geldFormatierer('de', 'CHF'))
  })

  it('unterscheidet Sprache und Waehrung', () => {
    // Waere der Schluessel nur die Sprache, bekaeme die zweite Waehrung den
    // Formatierer der ersten -- und der Betrag stuende in Euro da.
    expect(geldFormatierer('de')).not.toBe(geldFormatierer('en'))
    expect(geldFormatierer('de')).not.toBe(geldFormatierer('de', 'CHF'))
    expect(formatMoney(12_950, 'de')).toContain('€')
    expect(formatMoney(12_950, 'de', 'CHF')).not.toContain('€')
  })

  it('rechnet Cent in Betrag um, nicht ueber Fliesskomma', () => {
    expect(formatMoney(12_950, 'de')).toMatch(/129[,.]50/)
    expect(formatMoney(-1, 'de')).toMatch(/0[,.]01/)
    expect(formatMoney(0, 'en')).toMatch(/0[.,]00/)
  })

  it('haelt das Wochentagskuerzel ueber Aufrufe hinweg gleich', () => {
    // Derselbe Tag, zweimal gefragt: dieselbe Antwort, aus demselben
    // gemerkten Formatierer.
    expect(weekdayShort('2026-01-05', 'de')).toBe(weekdayShort('2026-01-05', 'de'))
    expect(weekdayShort('2026-01-05', 'de')).toMatch(/^Mo/)
    expect(weekdayShort('2026-01-11', 'en')).toMatch(/^Sun/)
  })
})
