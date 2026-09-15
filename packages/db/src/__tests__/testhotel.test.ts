import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, ownerPool } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { testhotelAnlegen } from '../cli/testhotel.js'

/**
 * Das Uebungshaus aus `pnpm db:testhotel`.
 *
 * Geprueft wird nicht, dass es 24 Zimmer hat -- das waere eine Abschrift des
 * Skripts. Geprueft wird, dass die Zahlen darin **stimmen**: ein Testhaus,
 * das falsche Belegung meldet, ist schlimmer als keines. Wer damit uebt,
 * lernt eine Zahl als richtig kennen, die es nicht ist, und merkt den
 * Unterschied erst am echten Haus.
 */

let owner: Pool

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
})
afterAll(async () => { await owner.end() })

beforeEach(async () => {
  await truncateAll()
  process.env.TESTHOTEL_PASSWORD = 'ein-kennwort-lang-genug'
  await testhotelAnlegen()
})

async function property(): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `SELECT id FROM property WHERE code = 'TEST'`)
  return r.rows[0]!.id
}

describe('Bestandszaehler des Testhotels', () => {
  /**
   * Der Befund, der diesen Test ausgeloest hat.
   *
   * inventory_day fuehrt je Tag eine Zeile je Kategorie **und** eine mit
   * category_id = 0 fuer das ganze Haus; inventory_reserve erhoeht im
   * Betrieb immer beide. Der Saatlauf rechnete den Zaehler aber nur je
   * Kategorie nach -- die Hauszeile wurde von keiner Gruppe getroffen und
   * blieb auf null.
   *
   * Sichtbar war das nirgends: die Verfuegbarkeit auf Hausebene meldete alle
   * 24 Zimmer frei, waehrend sechs belegt waren, und der taegliche Abgleich
   * des Workers filtert ausdruecklich category_id <> 0.
   */
  it('haelt die Hauszeile mit der Summe der Kategorien gleich', async () => {
    const p = await property()
    const abweichend = await owner.query<{ date: string; haus: number; summe: number }>(
      `SELECT h.date::text,
              h.sold AS haus,
              COALESCE(k.summe, 0)::int AS summe
         FROM inventory_day h
         LEFT JOIN (SELECT date, sum(sold)::int AS summe
                      FROM inventory_day
                     WHERE property_id = $1 AND category_id <> 0
                     GROUP BY date) k ON k.date = h.date
        WHERE h.property_id = $1 AND h.category_id = 0
          AND h.sold IS DISTINCT FROM COALESCE(k.summe, 0)
        ORDER BY h.date
        LIMIT 5`, [p])
    expect(abweichend.rows).toEqual([])
  })

  it('zaehlt heute genau die Reservierungen, die heute im Haus liegen', async () => {
    const p = await property()
    // Gegen die Reservierungen gerechnet, nicht gegen eine feste Zahl: das
    // Skript streut die Aufenthalte um den heutigen Tag, und eine
    // abgeschriebene Zahl waere morgen falsch.
    const erwartet = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reservation
        WHERE property_id = $1
          AND status IN ('Optional','Confirmed','InHouse')
          AND arrival <= current_date AND departure > current_date`, [p])
    const haus = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day
        WHERE property_id = $1 AND category_id = 0 AND date = current_date`, [p])
    expect(haus.rows[0]!.sold).toBe(erwartet.rows[0]!.n)
  })

  it('bleibt in der Kapazitaet -- kein Zimmer doppelt belegt', async () => {
    const p = await property()
    // Ein Uebungshaus, das ueberbucht anfaengt, bringt der Rezeption das
    // Falsche bei.
    const ueber = await owner.query(
      `SELECT 1 FROM inventory_day
        WHERE property_id = $1 AND sold > capacity LIMIT 1`, [p])
    expect(ueber.rowCount).toBe(0)
  })
})

describe('Was das Uebungshaus nicht tut', () => {
  it('ist als Uebungshaus gekennzeichnet', async () => {
    // Ohne is_training schiebt ein Testhaus frueher oder spaeter eine
    // Uebungsrechnung in die echte Buchhaltung.
    const r = await owner.query<{ is_training: boolean }>(
      `SELECT is_training FROM property WHERE code = 'TEST'`)
    expect(r.rows[0]!.is_training).toBe(true)
  })

  it('traegt die Pflichtangaben nach § 14 UStG', async () => {
    // Ein Testhaus ohne sie verdeckt eine Luecke, die jedes echte Haus hat.
    const r = await owner.query<{ tax_number: string | null
                                  address_line1: string | null
                                  city: string | null }>(
      `SELECT tax_number, address_line1, city FROM property WHERE code = 'TEST'`)
    expect(r.rows[0]!.tax_number).toBeTruthy()
    expect(r.rows[0]!.address_line1).toBeTruthy()
    expect(r.rows[0]!.city).toBeTruthy()
  })

  it('legt kein zweites Haus mit demselben Kuerzel an', async () => {
    /*
     * Der zweite Lauf schreibt nicht stillschweigend daneben. Er wirft
     * allerdings auch nicht, sondern meldet sich auf der Fehlerausgabe und
     * setzt process.exitCode -- fuer ein Programm der richtige Weg, denn ein
     * Stapelabzug waere hier keine Hilfe, sondern Laerm.
     */
    const vorher = process.exitCode
    process.exitCode = 0
    try {
      await testhotelAnlegen()
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = vorher
    }

    const r = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM property WHERE code = 'TEST'`)
    expect(r.rows[0]!.n).toBe(1)
  })
})
