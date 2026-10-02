import type { SteerRounding } from '@hotelpms/contracts'
import type { Cent } from './money.js'

/**
 * Preissteuerung (Dokument 32): die Rechnung je Belegungsstufe.
 *
 * **Gerechnet wird in der Datenbank** (`rate_steer_price`, Migration 0066),
 * mengenbasiert ueber alle Tage und Plaene in einer Anweisung. Die Rechnung
 * steht hier ein zweites Mal, aus demselben Grund wie `derivePrice`: Rundung
 * und Leitplanken lassen sich hier ohne Datenbank pruefen, und ein Test
 * vergleicht beide Fassungen an denselben Eingaben. Laufen sie auseinander,
 * faellt das dort auf und nicht an einem Preis auf Booking.com.
 *
 * Die Begriffe (Modus, Quelle, Rundung, Ausloeser) stehen im Vertrag
 * (`@hotelpms/contracts`), weil API und Oberflaeche sie teilen.
 */

type Richtung = 'nearest' | 'up' | 'down'

/** Rasterwert der Rundung, wie `rate_steer_grid`. Nur fuer Werte ab null. */
export function steerGrid(x: Cent, rounding: SteerRounding, dir: Richtung = 'nearest'): Cent {
  const v = Math.max(x, 0)
  // Ganzzahldivision wie in SQL: fuer nichtnegative Werte ist das Abrunden.
  const div = (a: number): number => Math.floor(a / 100) * 100
  switch (rounding) {
    case 'euro':
      return dir === 'up' ? div(v + 99) : dir === 'down' ? div(v) : div(v + 50)
    case 'ninety':
      return Math.max(
        dir === 'up' ? div(v + 109) - 10 : dir === 'down' ? div(v + 10) - 10 : div(v + 60) - 10,
        0)
    default:
      return v
  }
}

function clamp(t: Cent, lo: Cent, hi: Cent | null, rounding: SteerRounding): Cent {
  let r = t
  if (r < lo) {
    const u = steerGrid(lo, rounding, 'up')
    r = hi === null || u <= hi ? u : lo
  }
  if (hi !== null && r > hi) {
    const u = steerGrid(hi, rounding, 'down')
    r = u >= lo ? u : hi
  }
  return r
}

/** Kaufmaennisch auf ganze Zahlen, symmetrisch um null -- wie round() in SQL. */
function rundeHalbWeg(zaehler: number, nenner: number): number {
  const q = Math.abs(zaehler) / nenner
  return Math.sign(zaehler) * Math.round(q)
}

export interface SteerInput {
  /** Grundpreis -- nie der zuletzt gesteuerte (Migration 0065, Kopf). */
  baseCent: Cent
  /** Aktueller Verkaufspreis, nur fuer die Schrittgrenze. */
  currentCent: Cent | null
  /** Summe der Prozentwirkungen in Basispunkten (2000 = +20 %). */
  percentBp: number
  /** Summe der Betragswirkungen in Cent. */
  amountCent: Cent
  minCent: Cent | null
  maxCent: Cent | null
  rounding: SteerRounding
  /** Hoechste Aenderung je Lauf in Basispunkten des aktuellen Preises. */
  maxStepBp: number | null
}

/**
 * Der gesteuerte Preis einer Belegungsstufe. Reihenfolge und Begruendung
 * stehen an `rate_steer_price` in Migration 0066.
 */
export function steerPrice(i: SteerInput): Cent {
  const base = i.baseCent
  let t: Cent
  if (i.percentBp !== 0 || i.amountCent !== 0) {
    t = base + rundeHalbWeg(base * i.percentBp, 10_000) + i.amountCent
    t = steerGrid(Math.max(t, 0), i.rounding, 'nearest')
  } else {
    t = base
  }

  const lo = i.minCent === null ? 0 : Math.min(base, i.minCent)
  const hi = i.maxCent === null ? null : Math.max(base, i.maxCent)
  t = clamp(t, lo, hi, i.rounding)

  const c = i.currentCent
  if (i.maxStepBp !== null && c !== null && c > 0 && t !== c) {
    const d = Math.floor((c * i.maxStepBp) / 10_000)
    if (t > c + d) {
      let s = steerGrid(c + d, i.rounding, 'down')
      if (s <= c) s = steerGrid(c + 1, i.rounding, 'up')
      t = Math.min(s, t)
    } else if (t < c - d) {
      let s = steerGrid(c - d, i.rounding, 'up')
      if (s >= c) s = steerGrid(c - 1, i.rounding, 'down')
      t = Math.max(s, t)
    }
    t = clamp(t, lo, hi, i.rounding)
  }
  return t
}
