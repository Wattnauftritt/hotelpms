import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Der Aenderungsverlauf in der Oberflaeche.
 *
 * Geprueft wird, was ihn brauchbar oder gefaehrlich macht: dass aus einer
 * Kennung eine Zimmernummer wird, dass ein redigiertes Feld als "geaendert"
 * erscheint und nicht als Inhalt -- und dass die Beschriftungen aus dem
 * getippten Katalog kommen und nicht aus einem zusammengesetzten Schluessel,
 * der jede Pruefung umgeht.
 */

const verlauf = readFileSync(
  new URL('../components/Verlauf.tsx', import.meta.url), 'utf8')
const texte = readFileSync(
  new URL('../lib/i18n/plan.ts', import.meta.url), 'utf8')

describe('Der Verlauf zeigt Namen, nicht Kennungen', () => {
  it('loest Zimmer und Zimmergruppe ueber die mitgelieferten Listen auf', () => {
    /*
     * Im Protokoll steht `resource_id: 7 → 9`, und niemand kennt die 7. Die
     * Listen kommen mit der Antwort mit -- sie je Zeile nachzuschlagen waere
     * eine Runde je Eintrag fuer Daten, die in einen Satz passen.
     */
    expect(verlauf).toContain("daten.rooms[String(v)] ?? `#${String(v)}`")
    expect(verlauf).toContain("daten.categories[String(v)] ?? `#${String(v)}`")
  })

  it('zeigt Geld als Betrag und Daten als Datum', () => {
    expect(verlauf).toContain('GELD_FELDER.has(name)) return formatMoney(')
    expect(verlauf).toContain('DATUM_FELDER.has(name)')
  })

  it('nennt bei einer Nacht den Tag', () => {
    // "Preis 90 → 100" ohne den Tag ist keine Auskunft. Der Tag steht im
    // zusammengesetzten Schluessel der Zeile.
    expect(verlauf).toContain("typeof a.rowKey.date === 'string'")
  })

  it('verschweigt den Inhalt redigierter Felder', () => {
    /*
     * Der Trigger legt sie seit Migration 0044 als `[redigiert]` ab: der
     * Schluessel bleibt, der Wert faellt. Die Oberflaeche sagt deshalb, dass
     * jemand die Notiz angefasst hat, und nicht, was darin stand -- sonst
     * laesst die Loeschung nach Art. 17 eine Kopie zurueck.
     */
    expect(verlauf).toContain("if (v === '[redigiert]') return t('verlauf.redigiert')")
  })

  it('nimmt die Beschriftungen aus dem getippten Katalog', () => {
    /*
     * Kein `t(\`verlauf.feld.${name}\`)`: ein zusammengesetzter Schluessel
     * umgeht genau die Pruefung, die eine fehlende Uebersetzung zum
     * Typfehler macht. Was in der Tabelle fehlt, erscheint als Spaltenname --
     * lesbar genug, um es zu bemerken.
     */
    expect(verlauf).toContain('const FELD_TEXT: Record<string, TextKey>')
    expect(verlauf).not.toMatch(/t\(`verlauf\.feld\./)
    expect(verlauf).toContain('schluessel === undefined ? name : t(schluessel)')
  })

  it('haelt eine Beschriftung fuer jedes Feld bereit, das die Route zeigt', () => {
    /*
     * Die Liste in der Route (`FELDER`) und die hier muessen zusammenpassen;
     * laufen sie auseinander, steht im Verlauf eine Spaltenueberschrift aus
     * der Datenbank. Geprueft gegen die Route selbst, nicht gegen eine
     * Abschrift.
     */
    const route = readFileSync(
      new URL('../../../api/src/routes/history.ts', import.meta.url), 'utf8')
    const felder = [...route.matchAll(/'([a-z_]+)'/g)].map(m => m[1]!)
    const inRoute = new Set(felder.filter(f => f.includes('_') || f === 'status'
      || f === 'arrival' || f === 'departure' || f === 'quantity'
      || f === 'description' || f === 'kind' || f === 'reason' || f === 'source'))
    for (const feld of ['arrival', 'departure', 'resource_id', 'category_id',
                        'status', 'price_cent', 'net_cent', 'gross_cent',
                        'business_date', 'kind', 'reason']) {
      expect(inRoute.has(feld), `${feld} fehlt in der Route`).toBe(true)
      expect(verlauf, `${feld} ohne Beschriftung`).toContain(`${feld}: '`)
    }
  })

  it('bringt alle drei Sprachen mit', () => {
    // Eine vergessene Sprache ist sonst ein Typfehler -- aber erst, wenn der
    // Schluessel ueberhaupt im Katalog steht.
    expect(texte).toContain("'verlauf.title'")
    expect(texte).toContain("'verlauf.redigiert'")
    expect(texte).toContain("'verlauf.tabelle.night'")
  })
})

describe('Der Verlauf ist dort, wo die Frage entsteht', () => {
  it('steht an der Reservierung, an der Gruppe und am Plan', () => {
    for (const [datei, art] of [
      ['../components/ReservationPanel.tsx', "art: 'reservierung'"],
      ['../components/GroupPanel.tsx', "art: 'buchung'"],
      ['../routes/Tape.tsx', "art: 'haus'"]
    ] as const) {
      const quelle = readFileSync(new URL(datei, import.meta.url), 'utf8')
      expect(quelle, datei).toContain('VerlaufDialog')
      expect(quelle, datei).toContain(art)
    }
  })
})
