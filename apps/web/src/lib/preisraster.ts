import type { RateGridCell, SetRates, SetRestrictions } from '@hotelpms/contracts'

/**
 * Die Rechenarbeit hinter dem Preisraster, ohne React und ohne Netz.
 *
 * Hier liegt, was falsch sein kann, ohne dass man es sieht: die Umrechnung
 * einer Eingabe in ganze Cent, die Auswahl der betroffenen Tage und die
 * Vorschau. Getestet wird deshalb das und nicht die Darstellung.
 */

/** Wochentag als Index mit Montag = 0, wie ihn die API erwartet (isodow - 1). */
export function wochentagIndex(iso: string): number {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7
}

/**
 * Eine Eingabe in ganze Cent.
 *
 * **Nie über Fließkomma.** `parseFloat('89.95') * 100` ist 8994.999…, und
 * gerundet wird daraus je nach Weg ein Cent zu wenig. Gerechnet wird
 * deshalb auf den Ziffern: Euro-Teil mal hundert plus Cent-Teil.
 *
 * Angenommen werden Komma und Punkt als Dezimaltrenner, weil an einer
 * deutschen Rezeption beides getippt wird. Stehen **beide** in der Zahl, ist
 * der rechte der Dezimaltrenner und der linke Tausenderpunkt. Ein einzelner
 * Punkt ist der Dezimaltrenner: „1.234" bedeutet hier 1,234 und wird
 * abgewiesen, nicht stillschweigend als 1234 Euro gelesen.
 *
 * `null` heißt: keine gültige Eingabe. Nicht null Euro.
 */
export function centAusEingabe(text: string): number | null {
  let s = text.trim().replace(/[\s€]/g, '')
  if (s === '') return null

  const letztesKomma = s.lastIndexOf(',')
  const letzterPunkt = s.lastIndexOf('.')
  if (letztesKomma >= 0 && letzterPunkt >= 0) {
    // Der rechte Trenner ist der Dezimaltrenner, der linke gruppiert.
    const gruppierung = letztesKomma > letzterPunkt ? '.' : ','
    s = s.split(gruppierung).join('')
  }
  s = s.replace(',', '.')

  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s)
  if (m === null) return null
  const nachkomma = (m[2] ?? '').padEnd(2, '0')
  return Number(m[1]) * 100 + Number(nachkomma)
}

/** Cent als Eingabetext mit Komma. Für das Vorbelegen eines Feldes. */
export function eingabeAusCent(cent: number): string {
  const v = Math.abs(cent)
  return `${cent < 0 ? '-' : ''}${Math.floor(v / 100)},${String(v % 100).padStart(2, '0')}`
}

/**
 * Die Tage, die eine Massenänderung tatsächlich trifft.
 *
 * Der Wochentagsfilter ist der Grund, warum die Zahl nicht einfach die
 * Länge des Zeitraums ist: „alle Freitage und Samstage im Sommer" sind aus
 * 92 Tagen 26. Wer das nicht sieht, ändert 92.
 */
export function betroffeneTage(
  tage: readonly string[], weekdays: readonly number[] | null
): string[] {
  if (weekdays === null || weekdays.length === 7) return [...tage]
  return tage.filter(d => weekdays.includes(wochentagIndex(d)))
}

export interface Vorschau {
  /** Tage, auf die geschrieben wird. */
  tage: number
  /** Davon solche, die heute etwas anderes tragen. */
  geaendert: number
  /** Davon solche, die den Wert schon haben. */
  unveraendert: number
  erster: string | null
  letzter: string | null
}

/** Vergleicht zwei Preisvektoren stellenweise. */
function gleich(a: readonly number[] | null, b: readonly number[]): boolean {
  return a !== null && a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Was die Massenänderung bewirken würde, gerechnet aus dem Raster, das
 * ohnehin schon geladen ist -- ohne zusätzliche Anfrage.
 */
export function preisVorschau(
  tage: readonly string[], zellen: readonly RateGridCell[],
  ratePlanId: number, priceCent: readonly number[]
): Vorschau {
  const nachDatum = new Map<string, RateGridCell>()
  for (const z of zellen) {
    if (z.ratePlanId === ratePlanId) nachDatum.set(z.date, z)
  }
  let unveraendert = 0
  for (const d of tage) {
    if (gleich(nachDatum.get(d)?.priceCent ?? null, priceCent)) unveraendert++
  }
  return {
    tage: tage.length,
    geaendert: tage.length - unveraendert,
    unveraendert,
    erster: tage[0] ?? null,
    letzter: tage[tage.length - 1] ?? null
  }
}

export interface PreisEingabe {
  propertyId: number
  ratePlanId: number
  from: string
  to: string
  weekdays: readonly number[] | null
  priceCent: readonly number[]
}

/**
 * Die Nutzlast für `PUT /v1/rates/bulk`.
 *
 * `priceCent` ersetzt den **ganzen** Preisvektor des Tages. Wer nur den
 * Preis für zwei Personen ändert und die übrigen Stufen wegließe, löschte
 * sie -- deshalb trägt die Maske alle Stufen und schickt alle mit.
 *
 * Der Wochentagsfilter wird weggelassen, wenn er alle Tage umfasst: die API
 * versteht „ohne Angabe" als „alle", und eine leere Liste hieße „keine".
 */
export function preisNutzlast(e: PreisEingabe): SetRates {
  return {
    propertyId: e.propertyId,
    ratePlanId: e.ratePlanId,
    from: e.from,
    to: e.to,
    ...(e.weekdays === null || e.weekdays.length === 7
      ? {} : { weekdays: [...e.weekdays] }),
    priceCent: [...e.priceCent]
  }
}

export interface RestriktionsEingabe {
  propertyId: number
  ratePlanId: number
  from: string
  to: string
  weekdays: readonly number[] | null
  minLos: number | null
  maxLos: number | null
  closed: boolean
  closedToArrival: boolean
  closedToDeparture: boolean
}

/**
 * Die Nutzlast für `PUT /v1/restrictions/bulk`.
 *
 * Auch hier ersetzt der Aufruf die ganze Zeile des Tages. Ein nicht
 * gesetzter Mindestaufenthalt wird deshalb ausdrücklich als `null`
 * geschickt und nicht weggelassen: weggelassen hieße für die API dasselbe,
 * aber die Absicht „hier steht künftig keine Grenze" soll in der Nutzlast
 * stehen und nicht aus einer Auslassung erschlossen werden.
 */
export function restriktionsNutzlast(e: RestriktionsEingabe): SetRestrictions {
  return {
    propertyId: e.propertyId,
    ratePlanId: e.ratePlanId,
    from: e.from,
    to: e.to,
    ...(e.weekdays === null || e.weekdays.length === 7
      ? {} : { weekdays: [...e.weekdays] }),
    minLos: e.minLos,
    maxLos: e.maxLos,
    closed: e.closed,
    closedToArrival: e.closedToArrival,
    closedToDeparture: e.closedToDeparture
  }
}


/**
 * Das Kürzel eines Wochentags in der Sprache des Betrachters, Montag = 0.
 *
 * Gerechnet wird über eine bekannte Woche im Januar 2026, deren Montag der
 * 5. ist. Zusammengesetzt wird das Datum mit `padStart` und nicht mit einer
 * führenden Null im Textbaustein: `\`2026-01-0${5 + 5}\`` ergibt
 * „2026-01-010", ein ungültiges Datum, und `Intl` wirft darauf. Genau das
 * ist hier passiert -- Typprüfung, Lint und die Tests waren grün, und der
 * Bildschirm stürzte beim ersten Klick ab.
 */
export function wochentagKuerzel(index: number, locale: 'de' | 'en'): string {
  let woche = wochenKuerzel.get(locale)
  if (woche === undefined) {
    const f = new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB',
      { weekday: 'short', timeZone: 'UTC' })
    woche = Array.from({ length: 7 }, (_, i) =>
      f.format(new Date(`2026-01-${String(5 + i).padStart(2, '0')}T00:00:00Z`)))
    wochenKuerzel.set(locale, woche)
  }
  return woche[index] ?? ''
}

/** Sieben Kürzel je Sprache. Mehr gibt es nicht, also wird es einmal gebaut. */
const wochenKuerzel = new Map<'de' | 'en', string[]>()

/** Kurzzeichen einer Zelle: was an Restriktionen an diesem Tag gilt. */
export function restriktionsZeichen(z: RateGridCell): string {
  const teile: string[] = []
  if (z.closed) teile.push('G')
  if (z.closedToArrival) teile.push('A')
  if (z.closedToDeparture) teile.push('B')
  if (z.minLos !== null && z.minLos > 1) teile.push(String(z.minLos))
  return teile.join('')
}
