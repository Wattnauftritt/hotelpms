import { useEffect, useState } from 'react'
import type { TapeChart } from '@hotelpms/contracts'
import { addDays, daysBetween, type IsoDate } from './dates.js'

/**
 * Die Mobilansicht: was unter einer Breite anders gezeigt wird, und die
 * Rechnung dahinter.
 *
 * **Warum eine eigene Ansicht und kein verkleinerter Desktop.** Der
 * Zimmerplan zeigt am Desktop dreissig Tage und mehr; auf 390 Pixeln waeren
 * das 11 Pixel je Tag. Die Cloud-PMS, die es mobil gut machen (Cloudbeds,
 * Mews, Little Hotelier), zeigen am Telefon den Tag und eine kurze Woche und
 * lassen das Ziehen weg: ein Daumen trifft auf 26 Pixel hohen Zeilen zu oft
 * das Zimmer daneben. Gearbeitet wird durch Antippen, die Handlung steht im
 * Seitenfenster der Reservierung, das es schon gibt.
 *
 * Die Rechnung steht hier und nicht in den Komponenten, damit ein Test sie
 * ohne Browser pruefen kann -- ein Balken, der einen Tag zu frueh beginnt,
 * sieht plausibel aus und ist falsch.
 */

/**
 * Unterhalb davon gilt die Mobilansicht. Tailwinds `md` liegt auf
 * derselben Grenze; ein Tablet im Hochformat (768) bekommt den Desktop.
 */
export const MOBIL_BIS_PX = 767

const ANFRAGE = `(max-width: ${MOBIL_BIS_PX}px)`

/**
 * Ist das Fenster schmal genug fuer die Mobilansicht?
 *
 * Ueber `matchMedia` und nicht ueber die Fensterbreite beim Start: ein
 * Telefon, das man quer dreht, und ein Browserfenster, das man schmal zieht,
 * sollen umschalten, ohne neu zu laden.
 */
export function useSchmal(): boolean {
  const [schmal, setSchmal] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(ANFRAGE).matches)
  useEffect(() => {
    const m = window.matchMedia(ANFRAGE)
    const aendern = (): void => { setSchmal(m.matches) }
    aendern()
    m.addEventListener('change', aendern)
    return () => { m.removeEventListener('change', aendern) }
  }, [])
  return schmal
}

/** Tage der Wochenansicht. Sieben passen auf 390 Pixel mit lesbaren Namen. */
export const WOCHE_TAGE = 7

/**
 * Die Zustaende, die im Plan einen Balken haben. Storno und No-Show nicht:
 * sie binden kein Zimmer, und ein Balken dafuer laese sich wie belegt.
 */
const IM_PLAN = new Set(['Optional', 'Confirmed', 'InHouse', 'CheckedOut'])

/** Diese binden ein Zimmer; eine abgereiste Buchung tut es nicht mehr. */
const BINDEND = new Set(['Optional', 'Confirmed', 'InHouse'])

type Einheit = TapeChart['units'][number]
type Reservierung = TapeChart['reservations'][number]
type Sperre = TapeChart['blocks'][number]

/**
 * Wo ein Aufenthalt in einem Fenster von `tage` Tagen ab `von` liegt, als
 * Anteil der Breite.
 *
 * Ein Balken laeuft von der Mitte des Anreisetags bis zur Mitte des
 * Abreisetags, wie am Desktop: am Wechseltag stehen Abreise und Anreise
 * nebeneinander in derselben Spalte, und man sieht, dass dazwischen
 * gereinigt wird. Was ueber den Rand ragt, wird abgeschnitten; `offenLinks`
 * und `offenRechts` sagen, dass es dort weitergeht.
 *
 * `null`, wenn der Aufenthalt das Fenster nicht beruehrt.
 */
export function balkenSpanne(
  von: IsoDate, tage: number, anreise: IsoDate, abreise: IsoDate
): { start: number; ende: number; offenLinks: boolean; offenRechts: boolean } | null {
  const a = daysBetween(von, anreise) + 0.5
  const b = daysBetween(von, abreise) + 0.5
  if (b <= 0 || a >= tage) return null
  return {
    start: Math.max(a, 0) / tage,
    ende: Math.min(b, tage) / tage,
    offenLinks: a < 0,
    offenRechts: b > tage
  }
}

/** Was an einem Tag in einem Zimmer los ist. */
export type TagesLage = 'frei' | 'belegt' | 'anreise' | 'abreise' | 'wechsel' | 'gesperrt'

export interface ZimmerTag {
  lage: TagesLage
  /** Wer bleibt oder ankommt; sonst, wer abreist. Das oeffnet ein Antippen. */
  reservierung: Reservierung | null
}

/**
 * Die Lage eines Zimmers an einem Tag.
 *
 * Eine Sperre geht vor: ein gesperrtes Zimmer mit einer Buchung darauf ist
 * ein Fehler, den der Desktop-Plan meldet, und hier soll niemand es fuer
 * frei halten. Abgereiste zaehlen nur am Abreisetag selbst -- danach bindet
 * die Buchung nichts mehr, und das Zimmer ist wieder frei.
 */
export function zimmerAmTag(
  zimmerId: number, tag: IsoDate,
  reservierungen: readonly Reservierung[], sperren: readonly Sperre[]
): ZimmerTag {
  const gesperrt = sperren.some(s =>
    s.resource_id === zimmerId && s.from_date <= tag && s.to_date > tag)
  const hier = reservierungen.filter(r =>
    r.resource_id === zimmerId && IM_PLAN.has(r.status))
  const bleibt = hier.find(r => r.arrival < tag && r.departure > tag)
  const kommt = hier.find(r => r.arrival === tag && BINDEND.has(r.status))
  const geht = hier.find(r => r.departure === tag)

  if (gesperrt) return { lage: 'gesperrt', reservierung: bleibt ?? kommt ?? null }
  if (bleibt !== undefined) return { lage: 'belegt', reservierung: bleibt }
  if (kommt !== undefined && geht !== undefined) return { lage: 'wechsel', reservierung: kommt }
  if (kommt !== undefined) return { lage: 'anreise', reservierung: kommt }
  if (geht !== undefined) return { lage: 'abreise', reservierung: geht }
  return { lage: 'frei', reservierung: null }
}

/** Frei heisst: heute Nacht kann hier jemand schlafen. */
export function istFrei(lage: TagesLage): boolean {
  return lage === 'frei' || lage === 'abreise'
}

export interface ZimmerGruppe {
  /** Etage oder, wo keine gepflegt ist, die Zimmergruppe. */
  name: string
  zimmer: Einheit[]
}

/**
 * Die Zimmer in Gruppen, in der Reihenfolge des Plans.
 *
 * Nach Etage, weil das Haus so gebaut ist und Housekeeping so laeuft; wo
 * keine Etage gepflegt ist -- bei einem frisch eingerichteten Haus der
 * Normalfall --, nach Zimmergruppe. Gemischt waere es nur verwirrend: eine
 * Gruppe "1. OG" neben einer Gruppe "Doppelzimmer". Zimmer ohne Etage in
 * einem Haus mit Etagen landen deshalb in einer eigenen Gruppe ohne Namen.
 */
export function zimmerGruppen(
  einheiten: readonly Einheit[], ohneEtage: string, etage: (nummer: string) => string
): ZimmerGruppe[] {
  const nachEtage = einheiten.some(e => e.floor !== null && e.floor !== '')
  const gruppen = new Map<string, Einheit[]>()
  for (const e of einheiten) {
    /*
     * Eine blosse Zahl bekommt ihr Wort davor: "1" ueber einer Reihe von
     * Zimmernummern liest sich wie ein weiteres Zimmer. Was schon ein Wort
     * ist -- "1. OG", "Gaestehaus" --, bleibt, wie das Haus es gepflegt hat.
     */
    const name = nachEtage
      ? (e.floor !== null && e.floor !== ''
          ? (/^-?\d+$/.test(e.floor) ? etage(e.floor) : e.floor)
          : ohneEtage)
      : e.category_name
    const liste = gruppen.get(name)
    if (liste === undefined) gruppen.set(name, [e])
    else liste.push(e)
  }
  return [...gruppen].map(([name, zimmer]) => ({ name, zimmer }))
}

/** Naechte zwischen zwei Kalenderdaten, fuer die Karten in "Heute". */
export function naechte(anreise: IsoDate, abreise: IsoDate): number {
  return daysBetween(anreise, abreise)
}

/**
 * Das Fenster, das die Mobilansicht holt: einen Tag vor dem ersten
 * gezeigten, damit die Abreise am ersten Tag mitkommt, und die Woche danach.
 * Tag- und Wochenansicht teilen sich damit **eine** Anfrage.
 */
export function mobilFenster(start: IsoDate): { von: IsoDate; bis: IsoDate } {
  return { von: addDays(start, -1), bis: addDays(start, WOCHE_TAGE) }
}
