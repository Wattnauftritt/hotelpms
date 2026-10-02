import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { depositFromPercent, DEPOSIT_REQUEST_STATES } from '@hotelpms/domain/depositRequest'
import { prozentAusEingabe, anforderungsBetrag,
         faelligkeitVorschlag } from '../lib/vorauszahlung.js'
import { textKeys } from '../lib/i18n/index.js'

/**
 * Anzahlung und Zahlungslink in der Oberflaeche (Migration 0060).
 *
 * Geprueft wird, was man der Maske nicht ansieht: dass sie denselben Cent
 * zeigt, den die API festschreibt; dass Knoepfe an Rechten haengen; dass ein
 * Uebungshaus erklaert statt scheitert; und dass nirgends etwas steht, das
 * nach Kartendaten aussieht.
 */

const SRC = join(import.meta.dirname, '..')
const lies = (pfad: string): string => readFileSync(join(SRC, pfad), 'utf8')

const anzahlung = lies('components/Anzahlung.tsx')
const zahlungslink = lies('components/Zahlungslink.tsx')
const vorauszahlung = lies('components/Vorauszahlung.tsx')
const panel = lies('components/ReservationPanel.tsx')
const lib = lies('lib/vorauszahlung.ts')

describe('Prozentsatz aus der Eingabe', () => {
  it('liest Komma, Punkt und Prozentzeichen in Basispunkten', () => {
    expect(prozentAusEingabe('30')).toBe(3_000)
    expect(prozentAusEingabe('12,5')).toBe(1_250)
    expect(prozentAusEingabe('12.35')).toBe(1_235)
    expect(prozentAusEingabe(' 50 % ')).toBe(5_000)
    expect(prozentAusEingabe('100')).toBe(10_000)
  })

  it('nimmt keinen Satz, den niemand meint', () => {
    for (const unsinn of ['', '0', '0,00', '100,01', '101', '12,345', 'abc', '-5', '1e2']) {
      expect(prozentAusEingabe(unsinn), unsinn).toBeNull()
    }
  })
})

describe('Betrag einer Anforderung', () => {
  it('zeigt bei Prozent genau den Betrag, den die API festschreibt', () => {
    // Dieselbe Funktion wie die Route -- und damit auf den Cent dasselbe.
    for (const [preis, eingabe] of [[33_333, '30'], [12_345, '12,5'], [99_999, '33,33']] as const) {
      expect(anforderungsBetrag('percent', eingabe, preis))
        .toBe(depositFromPercent(preis, prozentAusEingabe(eingabe)!))
    }
    expect(anforderungsBetrag('percent', '30', 33_333)).toBe(9_999)
  })

  it('rechnet Prozent nur mit einem Aufenthaltspreis', () => {
    expect(anforderungsBetrag('percent', '30', null)).toBeNull()
    expect(anforderungsBetrag('percent', '30', 0)).toBeNull()
  })

  it('nimmt einen Betrag in Cent und nie ueber Fliesskomma', () => {
    expect(anforderungsBetrag('amount', '0,07', null)).toBe(7)
    expect(anforderungsBetrag('amount', '1.234,50', null)).toBe(123_450)
    expect(anforderungsBetrag('amount', '0', null)).toBeNull()
  })

  it('holt die Rundung aus dem Unterpfad und nicht aus dem Barrel', () => {
    // Das Barrel der Domaene zieht node:crypto mit, und das gibt es im
    // Browser nicht -- der Build der Oberflaeche braeche.
    expect(lib).toContain("from '@hotelpms/domain/depositRequest'")
    for (const quelle of [lib, anzahlung, zahlungslink, vorauszahlung]) {
      expect(quelle).not.toMatch(/from '@hotelpms\/domain'/)
    }
  })
})

describe('Faelligkeit', () => {
  it('schlaegt eine Woche vor, aber nicht nach der Anreise und nie vor dem Geschaeftstag', () => {
    expect(faelligkeitVorschlag('2026-10-01', '2026-10-20')).toBe('2026-10-08')
    expect(faelligkeitVorschlag('2026-10-01', '2026-10-04')).toBe('2026-10-04')
    // Schon angereist: dann der Geschaeftstag selbst, nicht die Vergangenheit.
    expect(faelligkeitVorschlag('2026-10-01', '2026-09-28')).toBe('2026-10-01')
    expect(faelligkeitVorschlag('2026-12-28', null)).toBe('2027-01-04')
    // Ueber die Zeitumstellung, ohne einen Tag zu verlieren.
    expect(faelligkeitVorschlag('2026-03-25', null)).toBe('2026-04-01')
  })

  it('reicht das Datum als Kalendertag weiter und nie durch new Date()', () => {
    expect(anzahlung).toContain('type="date"')
    expect(anzahlung).toContain('min={v.businessDate}')
    expect(anzahlung).not.toMatch(/new Date\(faellig/)
  })
})

describe('Rechte', () => {
  it('haengt jeden Knopf an das Recht im Haus des Folios', () => {
    expect(anzahlung).toContain('useHausrechte(v.propertyId)')
    expect(anzahlung).toContain("darf('folio:post')")
    expect(anzahlung).toContain("darf('email:send')")
    expect(anzahlung).toContain("darf('invoice:issue')")
    expect(vorauszahlung).toContain("darf('folio:post')")
    expect(vorauszahlung).toContain("rechte.darf('invoice:issue')")
  })

  it('zeigt das Widerrufen nur dem, der buchen darf, und nur fuer eigene Links', () => {
    // Alte Checkouts von vor 0059 laufen beim Anbieter von selbst ab.
    expect(zahlungslink).toMatch(/darfBuchen && !l\.legacy && l\.status === 'pending'/)
  })
})

describe('Uebungshaus und Gastpost', () => {
  it('erklaert im Uebungshaus, statt einen Knopf zu zeigen, der scheitert', () => {
    expect(zahlungslink).toMatch(/if \(v\.isTraining\) \{\s*return <p[^>]*>\{t\('vz\.link\.training'\)\}/)
    expect(anzahlung).toContain("t('anz.trainingHint')")
    // Der Knopf "Zahlungslink" an der Anforderung fehlt dort ganz.
    expect(anzahlung).toMatch(
      /\{!v\.isTraining && !linkUnterwegs && \(\s*<button[^>]*onClick=\{\(\) => setOffen\('link'\)\}/)
  })

  it('sagt vorher, warum nicht verschickt werden kann', () => {
    for (const grund of ['training', 'noRight', 'disabled', 'sender', 'noAddress']) {
      expect(zahlungslink).toContain(`'vz.link.mail.${grund}'`)
    }
    // Das Ankreuzfeld ist gesperrt, solange ein Hindernis besteht.
    expect(zahlungslink).toContain('disabled={hindernis !== null}')
  })

  it('schickt den Link nur beim Erzeugen, nicht nachtraeglich', () => {
    // Die Adresse wird nicht gespeichert; ein spaeteres Senden muesste sie
    // sich vom Aufrufer geben lassen.
    const queries = lies('lib/queries/billing.ts')
    expect(queries).not.toMatch(/payment-links\/\$\{[^}]+\}\/send/)
    expect(queries).toContain("sendEmail: true")
  })
})

describe('Der dauerhafte Link (0059)', () => {
  it('zeigt die Frist als Kalendertag und bietet keinen zweiten Link an', () => {
    expect(zahlungslink).toContain("t('vz.link.validUntilDay', { date: formatDate(")
    expect(anzahlung).toContain("t('anz.linkActive')")
  })

  it('kommt mit einer Wiederholung ohne Adresse zurecht', () => {
    // Der Idempotenzspeicher haelt das Token nicht; eine Wiederholung
    // bekommt url: null und erklaert das, statt ein leeres Feld zu zeigen.
    expect(zahlungslink).toContain('erzeugen.data.url === null')
    expect(zahlungslink).toContain("t('vz.link.replayed')")
  })
})

describe('Keine Kartendaten', () => {
  it('hat kein Feld, das nach einer Karte aussieht', () => {
    for (const quelle of [anzahlung, zahlungslink, vorauszahlung]) {
      expect(quelle).not.toMatch(/autoComplete=["']cc-/i)
      expect(quelle).not.toMatch(/\b(cvc|cvv|iban|cardNumber|kartennummer|pan)\b/i)
    }
  })
})

describe('Einbau', () => {
  it('steht im Reservierungsfenster und im Folio, aus einem Aufruf', () => {
    expect(panel).toContain('<Anzahlung folioRef={r.folioRef} />')
    expect(vorauszahlung).toContain('<Anforderungen folioRef={folioRef} v={v} />')
    // Ein Aufruf je Bildschirmteil: die Anforderungen holen nichts je Zeile.
    expect(anzahlung.match(/usePrepayments\(/g)).toHaveLength(1)
  })

  it('schliesst offene Formulare mit Escape, eines nach dem anderen', () => {
    expect(anzahlung).toContain('useEscape(onSchliessen)')
    expect(zahlungslink).toContain('useEscape(() => onSchliessen?.(), onSchliessen !== undefined)')
  })

  it('beschriftet jeden Zustand einer Anforderung und eines Links', () => {
    const vorhanden = new Set<string>(textKeys())
    for (const zustand of DEPOSIT_REQUEST_STATES) {
      expect(vorhanden.has(`anz.state.${zustand}`), zustand).toBe(true)
    }
    for (const zustand of ['pending', 'succeeded', 'failed', 'canceled', 'expired']) {
      expect(vorhanden.has(`vz.link.status.${zustand}`), zustand).toBe(true)
    }
    for (const post of ['pending', 'sent', 'failed', 'canceled']) {
      expect(vorhanden.has(`vz.link.mail.${post}`), post).toBe(true)
    }
  })
})
