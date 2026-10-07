import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { STAFF_LOCALES } from '@hotelpms/contracts'
import { istPersonalAdresse, personalSeite } from '../personal/adresse.js'
import { fehlerText, personalKeys, startSprache, text } from '../personal/texte.js'
import { ApiError } from '../lib/api.js'
import { ordneZimmer, type MeinZimmer } from '../personal/MeineZimmer.js'
import { abschnitt, type KontrollZimmer } from '../personal/Kontrolle.js'

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
   * Ein Zimmer, in das heute jemand einzieht, zuerst; eines, dessen Gast
   * noch da ist, hinter die freien; Erledigtes ans Ende. Sonst bleibt die
   * Reihenfolge des Hauses, damit niemand quer ueber die Etagen laeuft.
   */
  it('ordnet Anreise, frei, wartend, erledigt -- sonst wie im Haus', () => {
    const liste = [
      z('101', { status: 'done', outcome: 'cleaned' }),
      z('102', { free: false }),
      z('103', {}),
      z('104', { arrivalToday: true }),
      z('105', { kind: 'stayover' })]
    expect(ordneZimmer(liste).map(x => x.code)).toEqual(['104', '103', '105', '102', '101'])
  })

  it('stellt Nacharbeit vor alles andere', () => {
    const liste = [z('101', {}), z('102', { status: 'done', outcome: 'cleaned',
                                           inspection: 'rework', inspectionNote: 'Spiegel' })]
    expect(ordneZimmer(liste).map(x => x.code)).toEqual(['102', '101'])
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
