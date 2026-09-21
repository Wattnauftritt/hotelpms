import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { zugangAusAdresse } from '../routes/Zugang.tsx'
import { kennwortZuKurz, KENNWORT_MIN } from '@hotelpms/contracts'

/**
 * Die Auswertung der Adresse, ueber die Einladung und Kennwortruecksetzung
 * gefunden werden.
 *
 * Warum das geprueft gehoert: gibt diese Funktion faelschlich etwas zurueck,
 * ersetzt die Zugangsseite die **ganze** Anwendung -- sie steht in main.tsx
 * vor allem anderen, auch vor der Frage, wer angemeldet ist. Ein zu
 * grosszuegiger Vergleich waere damit kein Schoenheitsfehler, sondern ein
 * Ausfall der Rezeption.
 */

describe('Zugang aus der Adresse', () => {
  it('laesst jeden anderen Pfad in Ruhe', () => {
    expect(zugangAusAdresse('/', '')).toBeNull()
    expect(zugangAusAdresse('/', '?property=1&screen=tape')).toBeNull()
    // Kein Praefixvergleich: sonst faenge /kennwortliste die Anwendung ab.
    expect(zugangAusAdresse('/kennwortliste', '?token=x')).toBeNull()
    expect(zugangAusAdresse('/einladungen', '')).toBeNull()
  })

  it('erkennt Einladung und Ruecksetzung samt Token', () => {
    expect(zugangAusAdresse('/einladung', '?token=abc'))
      .toEqual({ art: 'invite', token: 'abc' })
    expect(zugangAusAdresse('/kennwort', '?token=abc'))
      .toEqual({ art: 'reset', token: 'abc' })
  })

  it('vertraegt einen abschliessenden Schraegstrich', () => {
    // Kommt aus Mailprogrammen haeufiger vor, als man denkt.
    expect(zugangAusAdresse('/kennwort/', '?token=abc'))
      .toEqual({ art: 'reset', token: 'abc' })
  })

  it('behandelt ein leeres Token wie keines', () => {
    // Sonst liefe der Benutzer in ein Formular, das beim Absenden sicher
    // scheitert -- und bei der Ruecksetzung ist "kein Token" ohnehin der
    // richtige Fall: dann wird einer angefordert.
    expect(zugangAusAdresse('/kennwort', '?token=')).toEqual({ art: 'reset', token: null })
    expect(zugangAusAdresse('/kennwort', '')).toEqual({ art: 'reset', token: null })
  })

  it('gibt ein Token mit Sonderzeichen unveraendert weiter', () => {
    // base64url enthaelt - und _; wer hier zu streng liest, macht aus jedem
    // zweiten Link einen ungueltigen.
    const token = 'aB3-_xY9zQ'
    expect(zugangAusAdresse('/einladung', `?token=${token}`)?.token).toBe(token)
  })
})

describe('Kennwortregel', () => {
  it('misst die Laenge und sonst nichts', () => {
    expect(kennwortZuKurz('x'.repeat(KENNWORT_MIN - 1))).toBe(true)
    expect(kennwortZuKurz('x'.repeat(KENNWORT_MIN))).toBe(false)
    // Keine Regeln ueber Zeichenarten: ein langer, merkbarer Satz genuegt.
    expect(kennwortZuKurz('richtiges pferd batterie klammer')).toBe(false)
    // Und ein kurzes Kunstwort mit allem Drum und Dran genuegt nicht.
    expect(kennwortZuKurz('Passwort1!')).toBe(true)
  })

  it('zaehlt Zeichen, nicht Speichereinheiten', () => {
    // Mit .length zaehlte ein Emoji als zwei -- ein Kennwort abzulehnen, das
    // die Regel erfuellt, ist schwer zu erklaeren; eines anzunehmen, das sie
    // verfehlt, ist schlimmer.
    expect(kennwortZuKurz('🔑'.repeat(KENNWORT_MIN - 1))).toBe(true)
    expect(kennwortZuKurz('🔑'.repeat(KENNWORT_MIN))).toBe(false)
  })
})

/**
 * Abmelden muss den Bildschirm leeren, nicht nur die Sitzung.
 *
 * An einer Rezeption steht ein Rechner, an dem jemand aufsteht und weggeht.
 * Die Sitzung wurde schon immer zurueckgezogen (`revoked_at`, Cookie
 * geloescht) -- aber die Oberflaeche blieb stehen, mit Gastdaten darauf,
 * bis jemand von Hand neu lud. Handeln konnte der Naechste nicht mehr,
 * lesen schon.
 */
describe('Abmelden', () => {
  const einstieg = readFileSync(
    new URL('../main.tsx', import.meta.url), 'utf8')
  const caddy = readFileSync(
    new URL('../../../../ops/caddy/Caddyfile', import.meta.url), 'utf8')

  it('baut die Seite neu auf, statt im Zwischenspeicher aufzuraeumen', () => {
    /*
     * Hier stand `qc.clear()` und danach `invalidateQueries` auf `me` --
     * genau verkehrt herum: `clear()` wirft die Abfrage aus dem Speicher,
     * und `invalidateQueries` findet danach nichts mehr. Der Abruf, der 401
     * ergaebe, blieb aus.
     *
     * Der Neuaufbau ist ausserdem die bessere Bauform: er ist das Einzige,
     * was garantiert nichts stehen laesst -- React-Zustand, offene
     * Komponenten, abgeloestes DOM.
     */
    expect(einstieg).toContain('location.replace(location.pathname)')
    /*
     * Geprueft wird der **Rumpf** von `abmelden`, nicht das Vorkommen der
     * Zeichenkette: `qc.clear()` steht noch im Kommentar darueber, und zwar
     * absichtlich -- er erklaert, was dort stand und warum es falsch war.
     * Eine Zusicherung, die den eigenen Kommentar trifft, prueft nichts.
     */
    const rumpf = einstieg.slice(einstieg.indexOf('const abmelden ='),
                                 einstieg.indexOf('if (zugang !== null)'))
    expect(rumpf).not.toContain('qc.clear()')
    expect(rumpf).not.toContain('invalidateQueries')
  })

  it('legt den abgemeldeten Stand nicht in die Geschichte', () => {
    // `replace` und nicht `assign`: sonst holt ein Druck auf Zurueck ihn
    // wieder hervor.
    expect(einstieg).not.toContain('location.assign(')
    expect(einstieg).not.toMatch(/location\.href\s*=/)
  })

  it('baut auch dann neu auf, wenn der Aufruf scheitert', () => {
    // Der Bildschirm muss leer sein, auch wenn die Sitzung noch steht. Ist
    // die API nicht erreichbar, scheitert danach auch `me`.
    expect(einstieg).toMatch(/finally \{\s*\n\s*location\.replace/)
  })

  it('nimmt die Seite ueber no-store aus dem Vor-Zurueck-Speicher', () => {
    /*
     * Der Neuaufbau allein genuegt nicht. `no-cache` heisst "vor dem
     * Benutzen nachfragen" und laesst die Seite im Vor-Zurueck-Speicher des
     * Browsers zulaessig; ein Druck auf Zurueck holte sie vollstaendig
     * gezeichnet zurueck -- mit denselben Gastdaten und ohne eine einzige
     * Anfrage. Die Anwendung blaettert ueber `history.pushState`, es gibt
     * also Eintraege, auf die das zutraefe.
     */
    expect(caddy).toContain('header /index.html Cache-Control "no-store"')
    expect(caddy).not.toContain('header /index.html Cache-Control "no-cache"')
  })

  it('laesst die gehashten Dateien lange zwischengespeichert', () => {
    // Nur das eine Kilobyte index.html kostet den erneuten Abruf.
    expect(caddy).toContain('Cache-Control "public, max-age=31536000, immutable"')
  })
})
