import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { visibleScreens, resolveScreen, screenByKey } from '../screens.js'

/**
 * Der Zugang zum Adminpanel.
 *
 * Der Befund dahinter: die Konsole war nur an einer Stelle zu sehen -- dort,
 * wo sonst "diesem Benutzer ist kein Haus zugeordnet" stuende. Wer als
 * Plattformpersonal eine freigegebene Support-Sitzung hatte, bekam ein Haus
 * und damit die gewoehnliche Oberflaeche; das Panel war weg, samt
 * Ausrollknopf. Erreichbar sein und zufaellig sichtbar sein ist nicht
 * dasselbe.
 */
describe('Adminpanel in der Navigation', () => {
  const rezeption = ['reservation:read', 'guest:read']

  it('erscheint fuer Plattformpersonal, auch wenn es ein Haus hat', () => {
    const mit = visibleScreens(rezeption, true).map(s => s.key)
    expect(mit).toContain('admin')
  })

  it('erscheint sonst bei niemandem', () => {
    // Auch nicht bei der Hausleitung mit allen Rechten am Haus: die
    // Plattformrechte haengen nicht an einer Property.
    const alle = ['reservation:read', 'settings:property', 'settings:account',
      'user:manage', 'folio:read', 'report:revenue']
    expect(visibleScreens(alle, false).map(s => s.key)).not.toContain('admin')
    expect(visibleScreens(rezeption).map(s => s.key)).not.toContain('admin')
  })

  it('ist nie der Startbildschirm', () => {
    /*
     * Ohne Adresse zeigt der Rahmen den ersten erlaubten Bildschirm. Fuer
     * jemanden, der beides darf, waere das Panel der falsche Einstieg: er
     * arbeitet im Haus und verwaltet die Plattform nebenbei.
     */
    expect(resolveScreen(null, rezeption, true)?.key).not.toBe('admin')
  })

  it('bleibt ueber die Adresse erreichbar', () => {
    expect(resolveScreen('admin', rezeption, true)?.key).toBe('admin')
    // Und fuer alle anderen faellt die Adresse still zurueck, statt in eine
    // Fehlerseite zu laufen -- ein Lesezeichen ueberlebt den Entzug.
    expect(resolveScreen('admin', rezeption, false)?.key).not.toBe('admin')
  })

  it('kennt den Schluessel im Verzeichnis der Bildschirme', () => {
    expect(screenByKey('admin')).toBeDefined()
  })
})

/**
 * Was das Panel nicht zeigen darf.
 *
 * Es steht Plattformpersonal offen, ohne dass ein Kunde etwas freigegeben
 * hat. Alles, was ueber Namen, Zustaende und Zahlen hinausgeht, gehoert
 * deshalb hinter eine Support-Sitzung -- und nicht hierher.
 */
describe('Das Panel bleibt ohne Kundendaten', () => {
  const quelle = readFileSync(
    new URL('../routes/Adminpanel.tsx', import.meta.url), 'utf8')
  const abfragen = readFileSync(
    new URL('../lib/queries/platform.ts', import.meta.url), 'utf8')

  it('ruft keine Fachroute eines Hauses auf', () => {
    // Reservierungen, Folios, Gaeste, Rechnungen: alles Wege in die Daten
    // eines Kunden. Hier hat keiner davon etwas zu suchen.
    expect(abfragen).not.toMatch(/\/v1\/(reservations|folios|guests|invoices)/)
  })

  it('fragt ausschliesslich Plattformrouten', () => {
    const pfade = [...abfragen.matchAll(/'(\/v1\/[^']+)'|`(\/v1\/[^`$]*)/g)]
      .map(m => m[1] ?? m[2] ?? '')
    expect(pfade.length).toBeGreaterThan(0)
    for (const p of pfade) expect(p.startsWith('/v1/platform/')).toBe(true)
  })

  it('fragt vor dem Sperren mit einem Satz, der sagt, was passiert', () => {
    /*
     * Eine Sperre wirkt sofort und trifft die Rezeption mitten im Check-in.
     * "Sind Sie sicher?" waere dafuer die falsche Frage -- sie sagt nichts.
     */
    expect(quelle).toContain('admin.accounts.suspendConfirm')
    expect(quelle).toContain('window.confirm')
  })

  it('zeigt am eigenen Zugang keinen Stilllegeknopf', () => {
    // Die Route weist es ohnehin ab. Ein Knopf, der nur 409 sagt, ist eine
    // Falle und keine Sicherung.
    expect(quelle).toContain('admin.staff.you')
  })
})

/**
 * Die Handgriffe des Supports -- was die Oberflaeche dabei nie tut.
 */
describe('Die Handgriffe des Supports', () => {
  const quelle = readFileSync(
    new URL('../routes/Adminpanel.tsx', import.meta.url), 'utf8')
  const abfragen = readFileSync(
    new URL('../lib/queries/platform.ts', import.meta.url), 'utf8')

  it('setzt nie ein Kennwort, sondern schickt einen Link', () => {
    // Ein Kennwort, das durch ein Telefonat ging, bleibt dort stehen.
    expect(abfragen).not.toMatch(/password['"]?\s*:/)
    expect(abfragen).toContain('/access-link')
  })

  it('fragt vor dem Abmelden mit dem Satz, der sagt, was passiert', () => {
    expect(quelle).toContain('admin.user.revokeConfirm')
  })

  it('zeigt am Benutzer, ob die letzte Post ankam', () => {
    // "Die Einladung ist nie angekommen" ist die zweithaeufigste Frage.
    expect(quelle).toContain('lastMail')
    expect(quelle).toContain('admin.mail.failed')
  })

  it('nimmt fuer den Kunden keine Plattformrolle in die Auswahl', () => {
    // KUNDEN_ROLLEN ist die Liste des Kunden. Steht dort einmal
    // platform_admin, ist das Panel der Weg vom Kunden zur Plattform.
    const block = quelle.slice(quelle.indexOf('const KUNDEN_ROLLEN'),
                               quelle.indexOf('const SITZUNG_ZUSTAND'))
    expect(block).not.toMatch(/platform_/)
  })

  it('belegt die Support-Anfrage aus der Kundenkarte vor', () => {
    // Bis hierher tippte man die numerische Kennung von Hand ein.
    expect(quelle).toMatch(/<Anfrage accountId=\{accountId\}/)
  })

  it('aendert die Rollen eines Kundenbenutzers je Haus und fuer den Betrieb', () => {
    // Bis hierher stand die Rolle nur als Text in der Kundenkarte; aendern
    // konnte sie nur der Kunde selbst.
    expect(quelle).toContain('useSetCustomerPropertyRoles')
    expect(quelle).toContain('useSetCustomerAccountRoles')
    expect(quelle).toMatch(/<RollenEditor accountId=\{accountId\} u=\{u\}/)
  })

  it('zeigt die Aufsicht nur dem Admin', () => {
    expect(quelle).toMatch(/darfAufsicht && <Aufsicht/)
  })
})
