import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { STAFF_LOCALES } from '@hotelpms/contracts'
import { istPersonalAdresse, nurPersonal, personalSeite } from '../personal/adresse.js'
import { fehlerText, personalKeys, startSprache, text } from '../personal/texte.js'
import { ApiError } from '../lib/api.js'
import { meinChip, type MeinZimmer } from '../personal/MeineZimmer.js'
import { abschnitt, type KontrollZimmer } from '../personal/Kontrolle.js'
import { tagName } from '../personal/Kueche.js'
import { chipZustand, nachKraft } from '../lib/kontrollChips.js'

/**
 * Die Personal-App (Baustein 1b, Aufgabe 18 in Dokument 16).
 *
 * Getestet wird, was still schiefgehen kann: ein falsch gelesener Pfad
 * schickte das Personal in die Rezeption, ein vergessener Platzhalter
 * verschluckte in einer Sprache die Mindestlaenge, und ein deutscher Satz
 * der Schnittstelle stuende vor jemandem, der kein Deutsch liest.
 */

const QUELLE = join(import.meta.dirname, '..')
const lies = (pfad: string): string => readFileSync(join(QUELLE, pfad), 'utf8')

describe('Adresse der Personal-App', () => {
  it('erkennt /personal und alles darunter, sonst nichts', () => {
    expect(istPersonalAdresse('/personal')).toBe(true)
    expect(istPersonalAdresse('/personal/')).toBe(true)
    expect(istPersonalAdresse('/personal/einladung')).toBe(true)
    expect(istPersonalAdresse('/')).toBe(false)
    expect(istPersonalAdresse('/personalien')).toBe(false)
    expect(istPersonalAdresse('/einladung')).toBe(false)
  })

  it('liest Einladung und Kennwortlink mit Token', () => {
    expect(personalSeite('/personal/einladung', '?token=abc'))
      .toEqual({ art: 'einladung', token: 'abc' })
    expect(personalSeite('/personal/kennwort/', '?token=xyz'))
      .toEqual({ art: 'kennwort', token: 'xyz' })
    // Ein leerer Parameter ist kein Token.
    expect(personalSeite('/personal/einladung', '?token='))
      .toEqual({ art: 'einladung', token: null })
    expect(personalSeite('/personal', '')).toEqual({ art: 'app' })
  })

  it('laedt je nach Pfad genau eine der beiden Anwendungen', () => {
    expect(lies('../index.html')).toContain('src="/src/boot.ts"')
    const boot = lies('boot.ts')
    expect(boot).toContain("import('./personal/main.tsx')")
    expect(boot).toContain("import('./main.tsx')")
  })

  it('installiert sich als eigene App unter /personal', () => {
    const m = JSON.parse(lies('../public/personal.webmanifest')) as Record<string, string>
    expect(m.start_url).toBe('/personal')
    expect(m.scope).toBe('/personal')
    expect(m.id).not.toBe('/')
    expect(lies('personal/main.tsx')).toContain("'/personal.webmanifest'")
  })

  it('schickt Personal ohne Bildschirm der Rezeption in die eigene App', () => {
    expect(lies('main.tsx')).toMatch(
      /permissions\.includes\('staff:app'\)\)\) \{\s*location\.replace\('\/personal'\)/)
  })
})

describe('Sprache der Personal-App', () => {
  it('nimmt die gespeicherte, sonst die des Telefons, sonst Deutsch', () => {
    expect(startSprache('uk', 'ru-RU')).toBe('uk')
    // Tuerkisch kann die Rezeption, diese App nicht: das Telefon entscheidet.
    expect(startSprache('tr', 'ru-RU')).toBe('ru')
    expect(startSprache(null, 'uk-UA')).toBe('uk')
    expect(startSprache(null, 'fr-FR')).toBe('de')
  })

  it('hat in jeder der vier Sprachen einen Satz mit denselben Platzhaltern', () => {
    const platzhalter = (s: string): string[] =>
      [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]!).sort()
    for (const key of personalKeys()) {
      const de = platzhalter(text(key, 'de'))
      for (const l of STAFF_LOCALES) {
        expect(text(key, l).trim().length, `${key} / ${l}`).toBeGreaterThan(0)
        expect(platzhalter(text(key, l)), `${key} / ${l}`).toEqual(de)
      }
    }
  })

  it('zeigt Fehler der Schnittstelle in der Sprache des Personals', () => {
    const falsch = new ApiError({ type: 'urn:staygrid:unauthorized', title: 'Nicht angemeldet',
      status: 401, detail: 'Anmeldung fehlgeschlagen', code: 'auth.badCredentials' }, 401)
    expect(fehlerText(falsch, 'uk')).toBe(text('error.auth.badCredentials', 'uk'))

    // Feldfehler mit Platzhalter, wie bei 422.
    const kurz = new ApiError({ type: 'urn:staygrid:validation', title: 'Ungueltig',
      status: 422, errorKeys: { password: ['auth.passwordTooShort'] },
      params: { min: 12 } }, 422)
    expect(fehlerText(kurz, 'ru')).toContain('12')

    // Unbekannt: der allgemeine Satz, nicht der deutsche der Schnittstelle --
    // ausser auf Deutsch, da ist der genaue Satz der bessere.
    const fremd = new ApiError({ type: 'x', title: 'Konflikt', status: 409,
      detail: 'Etwas Besonderes', code: 'reservation.conflict' }, 409)
    expect(fehlerText(fremd, 'ru')).toBe(text('error.generic', 'ru'))
    expect(fehlerText(fremd, 'de')).toBe('Etwas Besonderes')
    expect(fehlerText(new TypeError('Failed to fetch'), 'en'))
      .toBe(text('error.generic', 'en'))
  })
})

describe('Kein Gast- oder Personaldatum auf dem Telefon', () => {
  /*
   * Das Telefon gehoert nicht dem Haus. Was die App festhielte, laege nach
   * dem Abmelden weiter darauf, und niemand loescht es.
   */
  it('benutzt weder localStorage noch sessionStorage noch IndexedDB', () => {
    for (const datei of readdirSync(join(QUELLE, 'personal'))) {
      const q = lies(join('personal', datei))
      expect(q, datei).not.toMatch(/localStorage|sessionStorage|indexedDB/)
    }
  })
})

describe('Meine Zimmer', () => {
  const z = (code: string, teil: Partial<MeinZimmer>): MeinZimmer => ({
    taskId: Number(code), code, kind: 'departure', minutes: 30, status: 'open',
    outcome: null, free: true, arrivalToday: false, openProblems: 0, inspection: null,
    inspectionNote: null, ...teil })

  /*
   * Die Farbe der Kachel: gruen ist, was jetzt gereinigt werden kann. Eine
   * Abreise, deren Gast noch da ist, darf nicht gruen sein -- sonst steht
   * die Kraft vor einer besetzten Tuer.
   */
  it('zeigt frei, wartend, Bleiber, erledigt und Nacharbeit getrennt', () => {
    expect(meinChip(z('101', {}))).toBe('ready')
    expect(meinChip(z('102', { free: false }))).toBe('blocked')
    expect(meinChip(z('103', { kind: 'stayover' }))).toBe('stayover')
    expect(meinChip(z('104', { status: 'done', outcome: 'cleaned' }))).toBe('done')
    expect(meinChip(z('105', { status: 'done', outcome: 'cleaned', inspection: 'passed' })))
      .toBe('passed')
    expect(meinChip(z('106', { status: 'skipped', outcome: 'declined' }))).toBe('skipped')
    expect(meinChip(z('107', { status: 'done', outcome: 'cleaned', inspection: 'rework' })))
      .toBe('rework')
  })
})

describe('Kontrolle', () => {
  const k = (teil: Partial<KontrollZimmer>): KontrollZimmer => ({
    taskId: 1, code: '101', kind: 'departure', staffName: 'Anna', status: 'open',
    outcome: null, inspection: null, inspectionNote: null, free: true, arrivalToday: false,
    openProblems: 0, ...teil })

  /*
   * Nacharbeit gehoert zurueck zu "noch nicht gereinigt" -- die Kraft ist
   * dran, nicht die Hausdame. Ein Gast ohne Reinigungswunsch hat nichts
   * abzunehmen.
   */
  it('sortiert in zu kontrollieren, noch nicht gereinigt, kontrolliert', () => {
    expect(abschnitt(k({}))).toBe('waiting')
    expect(abschnitt(k({ status: 'done', outcome: 'cleaned' }))).toBe('toCheck')
    expect(abschnitt(k({ status: 'skipped', outcome: 'was_clean' }))).toBe('toCheck')
    expect(abschnitt(k({ status: 'done', outcome: 'cleaned', inspection: 'rework' })))
      .toBe('waiting')
    expect(abschnitt(k({ status: 'done', outcome: 'cleaned', inspection: 'passed' })))
      .toBe('passed')
    expect(abschnitt(k({ status: 'skipped', outcome: 'declined' }))).toBe('passed')
  })
})

describe('Kueche', () => {
  /*
   * Die Kueche hat an der Rezeption den Bildschirm Fruehstueck, gehoert aber
   * in die Personal-App. Die Hausdame hat mehr und bleibt, wo sie ist.
   */
  it('erkennt, wer nur Personalrechte hat', () => {
    expect(nurPersonal([{ permissions: ['staff:app', 'kitchen:breakfast'] }])).toBe(true)
    expect(nurPersonal([{ permissions: ['staff:app'] }])).toBe(true)
    expect(nurPersonal([{ permissions: ['staff:app', 'kitchen:breakfast',
                                        'housekeeping:inspect'] }])).toBe(false)
    expect(nurPersonal([{ permissions: ['kitchen:breakfast'] }])).toBe(false)
  })

  it('nennt den Tag ohne Verschiebung durch die Zeitzone', () => {
    expect(tagName('2026-10-01', 'de')).toContain('1.10')
  })
})

describe('Arbeitszeit', () => {
  it('schreibt Minuten als Stunden:Minuten, auch negativ', async () => {
    const { hm, monatPlus } = await import('../lib/arbeitszeit.js')
    expect(hm(125)).toBe('2:05')
    expect(hm(-20)).toBe('-0:20')
    expect(hm(0)).toBe('0:00')
    expect(monatPlus('2026-01', -1)).toBe('2025-12')
    expect(monatPlus('2026-12', 1)).toBe('2027-01')
  })
})

describe('Kontrolle als Chips', () => {
  const k = (teil: Partial<KontrollZimmer>): KontrollZimmer => ({
    taskId: 1, code: '101', kind: 'departure', staffName: 'Anna', status: 'open',
    outcome: null, inspection: null, inspectionNote: null, free: true, arrivalToday: false,
    openProblems: 0, ...teil })

  it('faerbt nach Stand und haelt Nacharbeit ueber allem', () => {
    expect(chipZustand(k({}))).toBe('open')
    expect(chipZustand(k({ free: false }))).toBe('blocked')
    expect(chipZustand(k({ kind: 'stayover', free: false }))).toBe('open')
    expect(chipZustand(k({ status: 'done', outcome: 'cleaned' }))).toBe('toCheck')
    expect(chipZustand(k({ status: 'skipped', outcome: 'was_clean' }))).toBe('toCheck')
    expect(chipZustand(k({ status: 'done', outcome: 'cleaned', inspection: 'passed' })))
      .toBe('passed')
    expect(chipZustand(k({ status: 'done', outcome: 'cleaned', inspection: 'rework' })))
      .toBe('rework')
    expect(chipZustand(k({ status: 'skipped', outcome: 'declined' }))).toBe('declined')
  })

  it('gibt jeder Kraft eine Karte, nach Namen, Unzugeteiltes zuletzt', () => {
    const liste = [k({ taskId: 1, staffName: 'Olga' }), k({ taskId: 2, staffName: null }),
                   k({ taskId: 3, staffName: 'Angela' }), k({ taskId: 4, staffName: 'Olga' })]
    expect(nachKraft(liste).map(g => [g.name, g.rooms.map(z => z.taskId)]))
      .toEqual([['Angela', [3]], ['Olga', [1, 4]], [null, [2]]])
  })
})
