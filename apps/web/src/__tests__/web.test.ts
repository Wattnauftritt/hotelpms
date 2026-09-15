import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { today, addDays, daysBetween, eachDay, isWeekend } from '../lib/dates.js'
import { formatMoney, formatDate, weekdayShort } from '../lib/i18n/index.js'
import { SCREENS, visibleScreens, resolveScreen } from '../screens.js'

/**
 * Geprueft wird hier die Logik, bei der ein Fehler echtes Geld oder echte
 * Zimmer kostet: Datumsrechnung und Geldanzeige. Die Darstellung selbst
 * wird nicht getestet; ein Test, der prueft, dass ein Kasten blau ist,
 * bricht bei jeder Gestaltungsaenderung und faengt nie einen Fehler.
 */

describe('Kalenderdaten', () => {
  it('rechnet ueber Monats- und Jahresgrenzen', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  })

  /**
   * Der Fehler, den diese Zeile verhindert: `new Date('2026-03-29')` ist
   * Mitternacht UTC, und in Europa/Berlin ist das an dem Tag 01:00 vor der
   * Umstellung. Wer mit Ortszeit rechnet, verliert oder gewinnt hier einen
   * Tag, und eine Reservierung verschiebt sich lautlos.
   */
  it('haelt die Sommerzeitumstellung aus', () => {
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29')
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30')
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2)
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25')
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
  })

  it('zaehlt Naechte, nicht Tage', () => {
    // Anreise 1., Abreise 4.: drei Naechte.
    expect(daysBetween('2026-10-01', '2026-10-04')).toBe(3)
    expect(eachDay('2026-10-01', '2026-10-04'))
      .toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
  })

  it('erkennt das Wochenende in UTC, nicht in der Ortszeit', () => {
    expect(isWeekend('2026-10-03')).toBe(true)   // Samstag
    expect(isWeekend('2026-10-04')).toBe(true)   // Sonntag
    expect(isWeekend('2026-10-05')).toBe(false)  // Montag
  })

  it('liefert heute im selben Format', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('Anzeige', () => {
  it('zeigt Cent als Betrag der jeweiligen Sprache', () => {
    // Nicht auf das Trennzeichen festnageln: Intl aendert es zwischen
    // Node-Fassungen. Geprueft wird, dass aus Cent Euro werden.
    expect(formatMoney(11_770, 'de')).toContain('117,70')
    expect(formatMoney(11_770, 'en')).toContain('117.70')
    expect(formatMoney(0, 'de')).toContain('0,00')
    expect(formatMoney(-5_000, 'de')).toContain('50,00')
  })

  it('stellt Datum sprachgerecht dar, ohne es zu verschieben', () => {
    expect(formatDate('2026-10-01', 'de')).toBe('01.10.2026')
    expect(formatDate('2026-10-01', 'en')).toBe('2026-10-01')
    // Auch der 1. Januar bleibt der 1. Januar, egal in welcher Zeitzone
    // der Browser steht.
    expect(formatDate('2026-01-01', 'de')).toBe('01.01.2026')
  })

  it('benennt den Wochentag in beiden Sprachen', () => {
    expect(weekdayShort('2026-10-05', 'de')).toMatch(/Mo/)
    expect(weekdayShort('2026-10-05', 'en')).toMatch(/Mon/)
  })
})

describe('Bildschirme und Rechte', () => {
  it('zeigt nur, was der Benutzer auch benutzen darf', () => {
    // Ein Housekeeping-Konto sieht den Zimmerplan nicht. Nicht aus
    // Geheimhaltung -- die Sicherheit liegt in der API --, sondern weil
    // ein Knopf, der 403 antwortet, schlechter ist als kein Knopf.
    // Die Wartungsliste steht bewusst mit dabei: sie haengt an
    // `housekeeping:read`, und wer die Zimmer macht, findet die Schaeden.
    // Anlegen und Erledigen bleiben ohne `maintenance:write` verborgen.
    const nurHk = visibleScreens(['housekeeping:read']).map(s => s.key)
    expect(nurHk).toEqual(['housekeeping', 'maintenance'])

    const rezeption = visibleScreens(
      ['reservation:read', 'housekeeping:read', 'inventory:read']).map(s => s.key)
    expect(rezeption).toEqual(
      ['tape', 'today', 'housekeeping', 'blocks', 'maintenance', 'availability'])
    expect(rezeption).not.toContain('setup')
  })

  it('nimmt den Bildschirm aus der Adresse, wenn er erlaubt ist', () => {
    expect(resolveScreen('today', ['reservation:read'])?.key).toBe('today')
  })

  it('faellt still zurueck statt in eine Fehlerseite', () => {
    // Ein Lesezeichen ueberlebt damit eine Umbenennung ...
    expect(resolveScreen('gibtesnicht', ['reservation:read'])?.key).toBe('tape')
    // ... und den Entzug eines Rechts.
    expect(resolveScreen('setup', ['housekeeping:read'])?.key).toBe('housekeeping')
  })

  it('sagt es, statt einen leeren Rahmen zu zeigen, wenn nichts erlaubt ist', () => {
    expect(resolveScreen('tape', [])).toBeUndefined()
  })

  it('haelt die Schluessel stabil: es gibt Lesezeichen darauf', () => {
    /*
     * Geprueft wird, dass die bekannten Schluessel weder umbenannt noch
     * umgestellt werden -- daran haengen Lesezeichen. Ein **angehaengter**
     * Bildschirm ist dagegen der vorgesehene Weg (Dokument 20, Abschnitt 2:
     * anhaengen, nie einfuegen). Als feste Gesamtliste wurde die Pruefung
     * bei jeder der drei Spuren rot, sobald sie ihren naechsten Bildschirm
     * brachte -- an einer Stelle, die keiner von ihnen gehoert. Als
     * Anfangsstueck haelt sie dasselbe fest und steht niemandem im Weg.
     */
    const bekannt = ['tape', 'today', 'housekeeping', 'blocks', 'setup',
                     'reports', 'maintenance', 'settings', 'integrations']
    expect(SCREENS.map(s => s.key).slice(0, bekannt.length)).toEqual(bekannt)
    // Kein Schluessel doppelt: zwei gleiche waeren in der Adresse nicht
    // unterscheidbar, und `screenByKey` faende immer nur den ersten.
    expect(new Set(SCREENS.map(s => s.key)).size).toBe(SCREENS.length)
  })

  /**
   * Die Rechte kommen vom Rahmen, nicht aus einem zweiten Blick in den
   * Zwischenspeicher.
   *
   * Vorher standen sie nur in `main.tsx`; ein Bildschirm kam nicht an sie
   * heran und las deshalb dieselbe Antwort (`/v1/auth/me`) noch einmal aus
   * dem Cache von React Query. Das funktionierte, war aber eine Umgehung:
   * der Rahmen wusste es und reichte es nicht weiter, und wer den
   * Schluessel `['me']` einmal umbenannt haette, haette zwei Bildschirme
   * stumm entrechtet -- ohne Fehlermeldung, nur mit verschwundenen Knoepfen.
   *
   * Geprueft wird die Ursache: dass es die Umgehung nicht mehr gibt.
   */
  it('reicht die Rechte durch, statt sie im Zwischenspeicher nachzuschlagen', () => {
    const web = join(import.meta.dirname, '..')
    expect(existsSync(join(web, 'lib/queries/rechte.ts')),
      'lib/queries/rechte.ts sollte es nicht mehr geben').toBe(false)

    for (const datei of readdirSync(join(web, 'routes'))) {
      const inhalt = readFileSync(join(web, 'routes', datei), 'utf8')
      expect(inhalt, `${datei} liest die Rechte selbst`).not.toContain("queryKey: ['me']")
      expect(inhalt, `${datei} benutzt useRechte`).not.toContain('useRechte')
    }
  })
})
