import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PlanPayment } from '@hotelpms/contracts'
import { REINIGUNG, ZAHLUNG, zahlungsTitel, reinigungsZiele, angeboteneStaende,
         REINIGUNG_SETZBAR, preisUndNotizen, personenzahl } from '../lib/planStatus.js'
import { gruppeVerschieben } from '../components/Stammdaten.tsx'
import { textFor, type TextKey } from '../lib/i18n/index.js'

/**
 * Reinigungs- und Zahlungsstand im Belegungsplan.
 *
 * Zwei Dinge koennen hier still schiefgehen: ein Zeichen, das nur ueber
 * die Farbe unterscheidet (und fuer jemanden mit Rot-Gruen-Schwaeche
 * "schmutzig" und "sauber" gleich aussehen laesst), und ein Menue, das bei
 * einer Mehrfachmarkierung nur eines der markierten Zimmer trifft.
 */

const lies = (pfad: string): string =>
  readFileSync(new URL(`../${pfad}`, import.meta.url), 'utf8')

const t = (key: TextKey, params?: Record<string, string | number>): string => {
  const text = textFor(key, 'de')
  return params === undefined ? text
    : text.replace(/\{(\w+)\}/g, (_g, n: string) => String(params[n]))
}
const geld = (cent: number): string =>
  `${(cent / 100).toFixed(2).replace('.', ',')} €`

describe('Zeichen: Form und Farbe, nie Farbe allein', () => {
  it('gibt jedem sichtbaren Reinigungsstand ein eigenes Symbol', () => {
    const sichtbar = Object.values(REINIGUNG).filter(z => z !== null)
    expect(sichtbar).toHaveLength(3)
    expect(new Set(sichtbar.map(z => z!.symbol)).size).toBe(3)
    expect(new Set(sichtbar.map(z => z!.farbe)).size).toBe(3)
  })

  it('laesst "belegt" ohne Zeichen -- das sagt schon der Balken', () => {
    expect(REINIGUNG.occupied).toBeNull()
  })

  it('gibt jedem Zahlungsstand ausser "nichts" ein eigenes Symbol mit Euro', () => {
    expect(ZAHLUNG.none).toBeNull()
    const sichtbar = Object.values(ZAHLUNG).filter(z => z !== null)
    expect(sichtbar).toHaveLength(5)
    expect(new Set(sichtbar.map(z => z!.symbol)).size).toBe(5)
    expect(sichtbar.every(z => z!.symbol.startsWith('€'))).toBe(true)
  })

  it('nennt den Zustand in Worten, als Name fuer Bildschirmleser und als Titel', () => {
    const z = lies('components/PlanZeichen.tsx')
    expect(z).toContain('role="img" aria-label={text} title={text}')
    expect(z).toContain('role="img" aria-label={t(ZAHLUNG_TEXT[zahlung.state])}')
  })
})

describe('Der Titel am Balken', () => {
  const basis: PlanPayment = {
    state: 'partial', charged_cent: 20_000, settled_cent: 20_000, balance_cent: 0,
    expected_cent: 50_000, unposted_nights: 3, deposit_cent: 0, requested_cent: 0,
    routed: false, group: null }

  it('nennt Zustand, Gezahltes, Erwartetes und Saldo aus ganzen Cent', () => {
    const titel = zahlungsTitel(basis, t, geld)
    expect(titel).toContain('Zahlung: Teilweise bezahlt')
    expect(titel).toContain('gezahlt 200,00 € von 500,00 € erwartet · Saldo 0,00 €')
    expect(titel).toContain('3 Nächte noch nicht aufs Konto gebucht')
  })

  it('sagt "eine Nacht" und nicht "1 Naechte"', () => {
    const titel = zahlungsTitel({ ...basis, unposted_nights: 1 }, t, geld)
    expect(titel).toContain('Eine Nacht noch nicht aufs Konto gebucht')
    expect(titel).not.toContain('1 Nächte')
  })

  it('nennt bei einer Gruppe die Rechnung ueber alle Zimmer', () => {
    const titel = zahlungsTitel({ ...basis, group: {
      state: 'paid', rooms: 4, expected_cent: 80_000, settled_cent: 80_000,
      balance_cent: 0 } }, t, geld)
    expect(titel).toContain('Gruppe (4 Zimmer): Bezahlt · gezahlt 800,00 € von 800,00 €')
  })

  it('nennt Anzahlungsrechnung, offenen Link und Umleitung nur, wenn es sie gibt', () => {
    const ohne = zahlungsTitel(basis, t, geld)
    expect(ohne).not.toContain('Anzahlungsrechnung')
    expect(ohne).not.toContain('Zahlungslink')
    const mit = zahlungsTitel({ ...basis, deposit_cent: 5_000, requested_cent: 7_000,
                                routed: true }, t, geld)
    expect(mit).toContain('davon über Anzahlungsrechnung 50,00 €')
    expect(mit).toContain('Zahlungslink offen über 70,00 €')
    expect(mit).toContain('Logis geht auf ein anderes Konto')
  })

  it('haengt den Zahlungsstand an beide Balkenarten, den im Band und den im Zimmer', () => {
    const plan = lies('components/TapeChart.tsx')
    expect(plan.match(/\+ zahlungsTitel\(r\.payment\)/g)).toHaveLength(2)
    expect(plan.match(/<ZahlungsZeichen zahlung=\{r\.payment\} \/>/g)).toHaveLength(2)
  })

  it('setzt das Zeichen vor den Namen, damit es nicht abgeschnitten wird', () => {
    const plan = lies('components/TapeChart.tsx')
    // Dazwischen nur die Personenzahl, die aus demselben Grund vorn steht.
    expect(plan).toMatch(
      /<ZahlungsZeichen zahlung=\{r\.payment\} \/>\n\s*<PersonenZeichen r=\{r\} \/>\n\s*\{r\.last_name/)
  })
})

describe('Reinigungsstand an der Zimmernummer', () => {
  it('steht direkt hinter der Nummer', () => {
    const plan = lies('components/TapeChart.tsx')
    expect(plan).toMatch(/\{u\.code\}<\/span>[\s\S]{0,300}<ReinigungsZeichen stand=\{u\.housekeeping\} \/>/)
  })

  it('oeffnet auf der Nummer ein eigenes Menue', () => {
    const plan = lies('components/TapeChart.tsx')
    expect(plan).toContain('onContextMenu={e => p.onZimmerKontext(u.id, e)}')
    expect(plan).toContain("art: 'zimmer'")
  })
})

describe('Reinigungsstand setzen aus dem Kontextmenue', () => {
  const menue = lies('components/PlanKontextmenue.tsx')

  it('bietet die Eintraege nur mit dem Recht an', () => {
    expect(menue).toContain("rechte.darf('housekeeping:write')")
  })

  it('meint alle markierten Zimmer -- auf der Flaeche wie auf der Nummer', () => {
    expect(menue).toContain(
      "reinigungsZiele(ziel.art === 'zimmer' ? ziel.zimmer\n      : (ziel.auswahl ?? [ziel]))")
    // Die Zeile gehoert zur Markierung: dann alle markierten Zimmer.
    const plan = lies('components/TapeChart.tsx')
    expect(plan).toContain(
      'const ids = inAuswahl && auswahl !== null ? auswahl.map(z => z.resourceId) : [resourceId]')
  })

  it('schickt einen Aufruf fuer alle, nicht einen je Zimmer', () => {
    expect(menue).toContain('onClick: () => onReinigung(ids, stand)')
    expect(menue).not.toMatch(/ids\.forEach|for \(const id of ids\)/)
  })

  it('sagt vor dem Klick, wie viele Zimmer er trifft', () => {
    expect(menue).toContain('t(mehrere, { n: ids.length })')
  })

  it('zaehlt ein Zimmer mit zwei Zeitraeumen in der Markierung einmal', () => {
    expect(reinigungsZiele([
      { resourceId: 1, roomCode: '101' }, { resourceId: 2, roomCode: '102' },
      { resourceId: 1, roomCode: '101' }])).toEqual([
      { resourceId: 1, roomCode: '101' }, { resourceId: 2, roomCode: '102' }])
  })

  it('laesst weg, was nichts aendern wuerde, und bietet "belegt" nie an', () => {
    expect(angeboteneStaende(['clean', 'clean'])).toEqual(['dirty', 'inspected'])
    expect(angeboteneStaende(['clean', 'dirty'])).toEqual(['clean', 'dirty', 'inspected'])
    expect(REINIGUNG_SETZBAR).not.toContain('occupied')
  })

  it('geht ueber die bestehende Housekeeping-Route und laedt den Plan nach', () => {
    const q = lies('lib/queries/housekeeping.ts')
    expect(q).toContain("api.put('/v1/housekeeping/status', { propertyId, ...body })")
    expect(q).toContain("queryKey: ['tape', propertyId]")
  })

  it('zeigt einen Fehler im Bildschirm, nicht im schon geschlossenen Menue', () => {
    const tape = lies('routes/Tape.tsx')
    expect(tape).toContain('{reinigung.error !== null && <Fehler error={reinigung.error} />}')
    expect(tape).toContain('reinigung.mutate({ resourceIds, status })')
  })

  it('schliesst mit Escape wie jedes andere Menue des Plans', () => {
    // Die Eintraege landen im gemeinsamen Menue; dort haengt useEscape.
    expect(menue).toContain('<Kontextmenue punkt={ziel.punkt} eintraege={eintraege}')
    expect(lies('components/Kontextmenue.tsx')).toContain('useEscape(onClose)')
  })
})

describe('Legende', () => {
  it('erklaert nur, was der Benutzer auch zu sehen bekommt', () => {
    const tape = lies('routes/Tape.tsx')
    expect(tape).toContain("reinigung={rechte.darf('housekeeping:read')}")
    expect(tape).toContain("zahlung={rechte.darf('folio:read')}")
  })
})

describe('Preis und Notizen im Titel des Balkens', () => {
  const basis = { nights: 3, stay_price_cent: 26_700, night_price_min_cent: 8_900,
                  night_price_max_cent: 8_900, short_note: null, notes: null }

  it('nennt Preis pro Nacht und Gesamtpreis', () => {
    const titel = preisUndNotizen(basis, t, geld)
    expect(titel).toContain('Preis pro Nacht: 89,00 €')
    expect(titel).toContain('Gesamtpreis (3 Nächte): 267,00 €')
  })

  it('nennt die Spanne statt eines Durchschnitts, wenn die Naechte verschieden kosten', () => {
    const titel = preisUndNotizen(
      { ...basis, stay_price_cent: 29_700, night_price_max_cent: 11_900 }, t, geld)
    expect(titel).toContain('Preis pro Nacht: 89,00 € bis 119,00 €')
    expect(titel).not.toContain('99,00')
  })

  it('zeigt ohne Naechte keinen Preis -- null Euro waere eine falsche Aussage', () => {
    expect(preisUndNotizen({ ...basis, nights: 0, stay_price_cent: 0,
      night_price_min_cent: 0, night_price_max_cent: 0 }, t, geld)).toBe('')
  })

  it('zeigt ohne Folio-Recht keinen Preis, die Notizen aber schon', () => {
    const titel = preisUndNotizen({ short_note: 'Balkon', notes: null }, t, geld)
    expect(titel).not.toContain('€')
    expect(titel).toContain('Balkon')
  })

  it('zeigt alle Notizen: Kurznotiz, Vorgang und jede Hausnotiz zum Gast', () => {
    const titel = preisUndNotizen({ ...basis, short_note: 'Balkon',
      notes: 'Ruft vor Anreise an', guest_notes: ['ebenerdig', 'Allergie: Nuesse'] }, t, geld)
    for (const teil of ['Notiz zur Reservierung:', 'Balkon', 'Ruft vor Anreise an',
                        'Notizen zum Gast:', '• ebenerdig', '• Allergie: Nuesse']) {
      expect(titel).toContain(teil)
    }
  })
})

describe('Zimmergruppen sortieren', () => {
  it('tauscht mit dem Nachbarn', () => {
    expect(gruppeVerschieben([1, 2, 3], [1, 2, 3], 3, -1)).toEqual([1, 3, 2])
    expect(gruppeVerschieben([1, 2, 3], [1, 2, 3], 1, 1)).toEqual([2, 1, 3])
  })

  it('springt ueber eine ausgeblendete Gruppe, die ihren Platz behaelt', () => {
    expect(gruppeVerschieben([1, 2, 3], [1, 3], 3, -1)).toEqual([3, 2, 1])
  })

  it('tut am Rand nichts', () => {
    expect(gruppeVerschieben([1, 2], [1, 2], 1, -1)).toBeNull()
    expect(gruppeVerschieben([1, 2], [1, 2], 2, 1)).toBeNull()
  })
})

describe('Scrollleiste unter dem Plan', () => {
  it('reicht ein Jahr zurueck und zwei voraus', async () => {
    const { leistenBereich } = await import('../lib/tapeGeometrie.js')
    const b = leistenBereich('2026-10-04', '2026-10-04', 30)
    expect(b.anfang).toBe('2025-10-04')
    expect(b.tageGesamt).toBe(365 + 730)
  })

  it('waechst mit, wenn der Plan ausserhalb steht', async () => {
    const { leistenBereich } = await import('../lib/tapeGeometrie.js')
    expect(leistenBereich('2026-10-04', '2024-01-01', 30).anfang).toBe('2024-01-01')
    const weit = leistenBereich('2026-10-04', '2030-01-01', 60)
    expect(weit.tageGesamt).toBeGreaterThan(365 + 730)
  })
})

describe('Personenzahl am Balken', () => {
  it('nimmt die gebuchte Zahl, sonst die erfassten Mitreisenden', () => {
    expect(personenzahl({ guest_count: 3, occupants: 1 })).toBe(3)
    expect(personenzahl({ guest_count: null, occupants: 2 })).toBe(2)
  })

  it('zeigt ohne Angabe keine Null', () => {
    expect(personenzahl({ guest_count: null, occupants: 0 })).toBeNull()
  })

  it('steht vor dem Namen, damit truncate sie nicht abschneidet', () => {
    const plan = lies('components/TapeChart.tsx')
    expect(plan.match(/<PersonenZeichen r=\{r\} \/>\s*\{r\.last_name/g)).toHaveLength(2)
  })
})
