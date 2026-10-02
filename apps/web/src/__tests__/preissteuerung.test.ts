import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SteerRule, SteerPreviewCell } from '@hotelpms/contracts'
import { bpAusEingabe, prozentText, eingabeAusBp, regelSatz, regelNutzlast,
         eingabeAusRegel, auswahlNutzlast, zellSchluessel, stufenpreis,
         LEERE_REGEL } from '../lib/preissteuerung.js'
import { textFor, type TextKey } from '../lib/i18n/index.js'

/**
 * Die Preissteuerung in der Oberflaeche (Dokument 32).
 *
 * Geprueft wird, wo ein Fehler Geld kostet: die Umrechnung eines
 * Prozentsatzes in Basispunkte, der Satz, den eine Regel bildet -- er ist
 * das Einzige, was die Rezeption von ihr liest --, und die Nutzlast, die zur
 * API geht. Dazu ueber die Quelle, dass die Oberflaeche nichts nachrechnet
 * und Escape schliesst.
 */

const t = (key: TextKey, params?: Record<string, string | number>): string => {
  const text = textFor(key, 'de')
  return params === undefined ? text
    : text.replace(/\{(\w+)\}/g, (ganz, n: string) =>
        Object.prototype.hasOwnProperty.call(params, n) ? String(params[n]) : ganz)
}

const regel = (r: Partial<SteerRule>): SteerRule => ({
  name: null, ratePlanId: null, categoryId: null, kind: 'occupancy',
  occupancyScope: 'category', occupancyMinBp: null, occupancyBelowBp: null,
  leadMinDays: null, leadBelowDays: null, weekdays: null, periodFrom: null,
  periodTo: null, effectKind: 'percent', effectValue: 1000, active: true, ...r
})

const quelle = (pfad: string): string =>
  readFileSync(fileURLToPath(new URL(pfad, import.meta.url)), 'utf8')

describe('Prozent und Basispunkte', () => {
  it('rechnet auf den Ziffern, nicht ueber Fliesskomma', () => {
    expect(bpAusEingabe('20')).toBe(2000)
    expect(bpAusEingabe('12,5')).toBe(1250)
    expect(bpAusEingabe('12.35')).toBe(1235)
    expect(bpAusEingabe('85 %')).toBe(8500)
    expect(bpAusEingabe('abc')).toBeNull()
  })

  it('zeigt Basispunkte als Prozent und als Eingabe', () => {
    expect(prozentText(1250, 'de')).toBe('12,5')
    expect(prozentText(-2000, 'en')).toBe('20')
    expect(eingabeAusBp(1250)).toBe('12,5')
    expect(eingabeAusBp(2000)).toBe('20')
    expect(eingabeAusBp(1235)).toBe('12,35')
    expect(eingabeAusBp(null)).toBe('')
  })
})

describe('Eine Regel als Satz', () => {
  it('liest sich wie gemeint', () => {
    expect(regelSatz(regel({ occupancyMinBp: 8500, effectValue: 2000 }), t, 'de'))
      .toBe('Wenn die Belegung der Kategorie mindestens 85 % beträgt: Preis +20 %')
  })

  it('nennt den Ausloeser zuerst und haengt weitere Bedingungen mit "und" an', () => {
    const satz = regelSatz(regel({
      kind: 'lead_time', leadBelowDays: 3, occupancyBelowBp: 4000, occupancyScope: 'house',
      effectValue: -1000 }), t, 'de')
    expect(satz).toBe('Wenn die Anreise in weniger als 3 Tagen ist und die Belegung '
      + 'des Hauses unter 40 % liegt: Preis −10 %')
  })

  it('schreibt einen Betrag als Geld und den Zeitraum als Kalenderdatum', () => {
    const satz = regelSatz(regel({
      kind: 'period', periodFrom: '2026-12-24', periodTo: '2026-12-26',
      effectKind: 'amount', effectValue: 1500 }), t, 'de')
    expect(satz).toContain('zwischen 24.12.2026 und 26.12.2026')
    expect(satz).toMatch(/Preis \+15,00\s€/)
  })

  it('setzt jeden Platzhalter ein, in jeder Sprache', () => {
    for (const locale of ['de', 'en', 'tr'] as const) {
      const tl = (k: TextKey, p?: Record<string, string | number>): string =>
        textFor(k, locale).replace(/\{(\w+)\}/g, (g, n: string) =>
          p !== undefined && n in p ? String(p[n]) : g)
      const satz = regelSatz(regel({ kind: 'weekday', weekdays: [4, 5], leadMinDays: 7,
                                     occupancyMinBp: 7000 }), tl, locale)
      expect(satz, locale).not.toMatch(/\{\w+\}/)
    }
  })
})

describe('Die Maske als Nutzlast', () => {
  it('bietet nichts an, solange der Ausloeser keine Bedingung hat', () => {
    expect(regelNutzlast({ ...LEERE_REGEL, wert: '10' })).toBeNull()
    expect(regelNutzlast({ ...LEERE_REGEL, occMin: '85' })).toBeNull()
    expect(regelNutzlast({ ...LEERE_REGEL, occMin: '85', wert: '0' })).toBeNull()
    expect(regelNutzlast({ ...LEERE_REGEL, kind: 'period', periodFrom: '2026-10-01',
                           wert: '10' })).toBeNull()
  })

  it('macht aus einem Abschlag einen negativen Wert und aus dem Ziel eine Kennung', () => {
    const n = regelNutzlast({ ...LEERE_REGEL, kind: 'lead_time', leadBelow: '3',
                              occBelow: '40', richtung: 'runter', wert: '10',
                              ziel: 'plan:7' })
    expect(n).toMatchObject({ kind: 'lead_time', leadBelowDays: 3, occupancyBelowBp: 4000,
                              effectKind: 'percent', effectValue: -1000, ratePlanId: 7,
                              categoryId: null })
  })

  it('nimmt einen Betrag in Cent', () => {
    const n = regelNutzlast({ ...LEERE_REGEL, kind: 'weekday', weekdays: [5, 4],
                              effectKind: 'amount', wert: '15,50' })
    expect(n).toMatchObject({ effectKind: 'amount', effectValue: 1550, weekdays: [4, 5] })
  })

  it('kommt aus der gespeicherten Regel unveraendert zurueck', () => {
    for (const r of [
      regel({ occupancyMinBp: 8500, occupancyBelowBp: 9500, effectValue: 1250,
              occupancyScope: 'house', name: 'Messe', categoryId: 3 }),
      regel({ kind: 'period', periodFrom: '2026-12-01', periodTo: '2026-12-31',
              effectKind: 'amount', effectValue: -990, ratePlanId: 9, active: false }),
      regel({ kind: 'weekday', weekdays: [0, 6], leadMinDays: 14, effectValue: -500 })
    ]) {
      expect(regelNutzlast(eingabeAusRegel(r))).toEqual(r)
    }
  })
})

describe('Auswahl in der Vorschau', () => {
  const zelle = (ratePlanId: number, date: string, changed: boolean): SteerPreviewCell => ({
    ratePlanId, date, leadDays: 0, occupancyBp: null, houseOccupancyBp: null,
    currentCent: [10000], baseCent: [10000], suggestedCent: [changed ? 12000 : 10000],
    ruleIds: [], changed })

  it('schickt nur gewaehlte, tatsaechlich geaenderte Tage', () => {
    const zellen = [zelle(1, '2026-10-01', true), zelle(1, '2026-10-02', false),
                    zelle(2, '2026-10-01', true)]
    const gewaehlt = new Set([zellSchluessel(1, '2026-10-01'), zellSchluessel(1, '2026-10-02')])
    expect(auswahlNutzlast(zellen, gewaehlt)).toEqual([{ ratePlanId: 1, date: '2026-10-01' }])
  })

  it('zeigt fuer eine fehlende Belegungsstufe die hoechste vorhandene', () => {
    expect(stufenpreis([9000, 12000], 1)).toBe(9000)
    expect(stufenpreis([9000, 12000], 4)).toBe(12000)
    expect(stufenpreis([], 2)).toBeNull()
  })
})

describe('Bildschirm', () => {
  const komponente = quelle('../components/Preissteuerung.tsx')

  it('rechnet keinen Preis nach, sondern zeigt die Vorschau der API', () => {
    expect(komponente).not.toMatch(/steerPrice|rate_steer_price/)
    expect(komponente).toMatch(/suggestedCent/)
  })

  it('schickt den Fingerabdruck der Vorschau mit', () => {
    expect(komponente).toMatch(/token: vorschau\.data\.token/)
  })

  it('schliesst mit Escape: Maske ueber Dialog, Auswahl und Verlauf ueber useEscape', () => {
    expect(komponente).toMatch(/<Dialog/)
    expect(komponente.match(/useEscape\(/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('haengt unter "Preise" als Reiter, nicht als eigener Bildschirm', () => {
    const preise = quelle('../routes/Rates.tsx')
    expect(preise).toMatch(/useReiter<Reiter>\('preise'/)
    expect(preise).toMatch(/<Preissteuerung /)
  })

  it('laedt die Vorschau in einem Aufruf ueber alle Plaene und Tage', () => {
    const abfragen = quelle('../lib/queries/rateSteering.ts')
    expect(abfragen.match(/rate-steering\/preview/g)).toHaveLength(1)
    expect(komponente).not.toMatch(/\.map\([^)]*useSteerPreview/)
  })
})
