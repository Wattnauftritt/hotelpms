import { addDays } from './dates.js'

/**
 * Die Tage "verkauft als" (Migration 0197) fuer den Plan.
 *
 * Die Schnittstelle liefert einen Tag je Zeile, weil die Datenbank so
 * rechnet. Der Plan zeigt Strecken: drei Tage als Doppelzimmer sind ein
 * Band, nicht drei Kaestchen.
 */
export interface VerkauftAlsTag {
  resource_id: number; date: string
  category_id: number; category_code: string; category_name: string
}

/** Eine Strecke aufeinanderfolgender Tage in derselben Kategorie; `to` ist der Tag danach. */
export interface VerkauftAlsStrecke {
  from: string; to: string
  categoryId: number; categoryCode: string; categoryName: string
}

export function verkauftAlsStrecken(
  tage: readonly VerkauftAlsTag[]
): Map<number, VerkauftAlsStrecke[]> {
  const out = new Map<number, VerkauftAlsStrecke[]>()
  const sortiert = [...tage].sort((a, b) =>
    a.resource_id - b.resource_id || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  for (const t of sortiert) {
    const liste = out.get(t.resource_id) ?? []
    const letzte = liste[liste.length - 1]
    if (letzte !== undefined && letzte.to === t.date && letzte.categoryId === t.category_id) {
      letzte.to = addDays(t.date, 1)
    } else {
      liste.push({ from: t.date, to: addDays(t.date, 1), categoryId: t.category_id,
                   categoryCode: t.category_code, categoryName: t.category_name })
    }
    out.set(t.resource_id, liste)
  }
  return out
}

/**
 * In welcher Kategorie eine neue Buchung in diesem Zimmer liegt.
 *
 * Wird es an **jeder** Nacht des Zeitraums als dieselbe andere Kategorie
 * verkauft, ist es diese: wer am Plan im als Doppelzimmer verkauften
 * Vierbettzimmer bucht, bucht ein Doppelzimmer -- zum Preis und mit dem
 * Bestand des Doppelzimmers. Sonst die eigene Gruppe des Zimmers, wie
 * bisher; ein Zeitraum halb so, halb so ist keine der beiden, und die Maske
 * laesst die Kategorie ohnehin waehlen.
 */
export function kategorieImZimmer(
  strecken: readonly VerkauftAlsStrecke[] | undefined, eigene: number,
  arrival: string, departure: string
): number {
  if (strecken === undefined || arrival >= departure) return eigene
  const s = strecken.find(x => x.from <= arrival && x.to > arrival)
  if (s === undefined) return eigene
  // Strecken derselben Kategorie stossen nie aneinander -- sie waeren eine.
  return s.to >= departure ? s.categoryId : eigene
}

/** Die Strecken, die einen Zeitraum beruehren. */
export function streckenIm(
  strecken: readonly VerkauftAlsStrecke[] | undefined, from: string, to: string
): VerkauftAlsStrecke[] {
  return (strecken ?? []).filter(s => s.from < to && s.to > from)
}
