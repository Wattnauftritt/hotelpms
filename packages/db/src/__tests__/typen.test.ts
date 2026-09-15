import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ensureSchema, ownerPool } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'

/**
 * Was aus der Datenbank als Zahl ankommt — und was nicht.
 *
 * **Warum das einen Test verdient.** `bigint` liefert node-postgres als
 * Zeichenkette; `pool.ts` wandelt es deshalb in `number`, skalar wie als
 * Feld. `numeric` bleibt bewusst Zeichenkette, damit nichts still gerundet
 * wird — beliebige Genauigkeit passt nicht in ein `double`.
 *
 * Die Falle daran ist, dass **`sum()` über eine `bigint`-Spalte `numeric`
 * liefert**, nicht `bigint`. Eine Centsumme kommt damit als Zeichenkette
 * an, und das fällt nicht auf: sie zeigt sich richtig an, vergleicht sich
 * halbwegs richtig und rechnet sich falsch, sobald jemand sie addiert —
 * `"100" + 50` ist `"10050"`. Genau das ist beim Bau der Anzahlungssicht
 * passiert; ein Test fand es mit `expected '10000' to be 10000`.
 *
 * Geprüft wird beides zusammen, weil erst beides die Regel ergibt: **wer
 * eine Summe zurückgibt, castet sie** (`::bigint`). Der Parser zu ändern
 * wäre der falsche Weg — er nähme die Sicherung heraus, die es für echte
 * `numeric`-Spalten braucht, und die gibt es hier nur deshalb noch nicht,
 * weil noch niemand eine gebraucht hat.
 */

let owner: Pool

beforeAll(async () => { await ensureSchema(); owner = ownerPool() })
afterAll(async () => { await owner.end() })

describe('Typen aus der Datenbank', () => {
  it('liefert bigint als Zahl, skalar wie als Feld', async () => {
    const r = await owner.query<{ skalar: number; feld: number[] }>(
      `SELECT 9007199254740991::bigint AS skalar,
              ARRAY[9000,11000]::bigint[] AS feld`)
    expect(typeof r.rows[0]!.skalar).toBe('number')
    expect(r.rows[0]!.feld).toEqual([9000, 11000])
    expect(r.rows[0]!.feld.every(x => typeof x === 'number')).toBe(true)
  })

  it('liefert numeric als Zeichenkette, damit nichts still gerundet wird', async () => {
    const r = await owner.query<{ genau: string }>(
      `SELECT 0.1234567890123456789::numeric AS genau`)
    // Als `number` waere die Nachkommastelle weg. Als Zeichenkette ist sie
    // da, und wer sie braucht, entscheidet selbst, wie er sie liest.
    expect(typeof r.rows[0]!.genau).toBe('string')
    expect(r.rows[0]!.genau).toContain('0.1234567890123456789')
  })

  /**
   * Die eigentliche Falle. `sum()` ueber bigint ist numeric -- das steht so
   * im Handbuch von PostgreSQL und ueberrascht trotzdem jeden einmal.
   */
  it('macht aus der Summe von bigint numeric, also eine Zeichenkette', async () => {
    const roh = await owner.query<{ summe: string }>(
      `SELECT sum(x) AS summe FROM (VALUES (7000::bigint), (3000::bigint)) AS t(x)`)
    expect(typeof roh.rows[0]!.summe).toBe('string')

    // Und so sieht der Fehler aus, wenn niemand hinsieht: keine
    // Fehlermeldung, nur eine Zahl, die es nicht ist.
    // @ts-expect-error -- genau der Fehler, den der Cast verhindert
    expect(roh.rows[0]!.summe + 50).toBe('1000050')
  })

  it('macht ein ::bigint daraus wieder eine Zahl', async () => {
    const gecastet = await owner.query<{ summe: number }>(
      `SELECT sum(x)::bigint AS summe FROM (VALUES (7000::bigint), (3000::bigint)) AS t(x)`)
    expect(typeof gecastet.rows[0]!.summe).toBe('number')
    expect(gecastet.rows[0]!.summe + 50).toBe(10_050)
  })

  it('zaehlt mit count() dagegen schon als Zahl', async () => {
    // count() liefert bigint, nicht numeric -- deshalb faellt die Falle
    // beim Zaehlen nie auf und beim Summieren immer.
    const r = await owner.query<{ n: number }>(
      `SELECT count(*) AS n FROM (VALUES (1), (2), (3)) AS t(x)`)
    expect(typeof r.rows[0]!.n).toBe('number')
    expect(r.rows[0]!.n).toBe(3)
  })

  /**
   * Die Regel, nicht nur das Verhalten: kein Endpunkt gibt eine nackte
   * Summe zurueck. Geprueft wird der Bestand, damit die naechste
   * ungecastete Summe hier auffaellt und nicht beim Gast am Tresen.
   */
  it('gibt in keiner Route eine ungecastete Summe zurueck', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const wurzel = join(import.meta.dirname, '../../../../apps/api/src/routes')
    const verstoesse: string[] = []
    for (const datei of readdirSync(wurzel).filter(n => n.endsWith('.ts'))) {
      const zeilen = readFileSync(join(wurzel, datei), 'utf8').split('\n')
      zeilen.forEach((zeile, i) => {
        // Eine Summe, die im selben Ausdruck benannt wird (`AS "..."`),
        // ohne dass davor gecastet wurde.
        if (/\bsum\s*\(/i.test(zeile) && /\bAS\s+"/.test(zeile)
            && !/::(bigint|int|numeric|text)/i.test(zeile)) {
          verstoesse.push(`${datei}:${i + 1}: ${zeile.trim()}`)
        }
      })
    }
    expect(verstoesse, verstoesse.join('\n')).toEqual([])
  })
})
