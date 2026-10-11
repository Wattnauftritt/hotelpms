import { useMemo, type JSX } from 'react'
import { useT, useLocale, formatDate, intlTag } from '../lib/i18n/index.js'
import { daysBetween, eachDay, isWeekend } from '../lib/dates.js'
import type { SortierAufenthalt, SortierVorschau, SortierZimmer }
  from '../lib/queries/zimmerSortieren.js'

/**
 * Die Vorschau des Sortierers als kleiner Zimmerplan.
 *
 * **Warum nicht die Liste.** Sven, 11.10.2026, vor einer Liste mit 34
 * Umsetzungen: "so hat man ja absolut keinen Ueberblick". Ob ein Ergebnis
 * besser ist, sieht man nicht an "34 → 29", sondern daran, ob die Luecken
 * kleiner werden und die langen Aufenthalte in den guten Zimmern liegen --
 * also am Plan. Deshalb derselbe Aufbau wie der Zimmerplan: Zimmer als
 * Zeilen in seiner Reihenfolge, Tage als Spalten, und ein Wechsel zwischen
 * vorher und nachher, damit das Auge springen kann.
 *
 * **Was hervorgehoben ist.** Umgesetzte Gaeste sind in beiden Ansichten
 * farbig, damit man sie vorher in ihrem alten und nachher in ihrem neuen
 * Zimmer findet; der Balken nennt das jeweils andere Zimmer. Feste Gaeste
 * sind grau -- sie hat der Sortierer nicht angefasst und durfte es nicht.
 *
 * **Nur die betroffenen Gruppen**, wenn gewuenscht: ein Haus mit 35
 * Zimmern und 3 Umsetzungen im EZ braucht nicht 30 unveraenderte Zeilen DZ.
 * Getauscht wird ohnehin nur innerhalb einer Gruppe.
 */

/**
 * Breite einer Tagesspalte: so breit, dass zwei Wochen das Fenster fuellen,
 * und so schmal, dass 62 Tage noch rollbar bleiben.
 */
function tagBreite(n: number): number {
  if (n <= 14) return 64
  if (n <= 21) return 46
  if (n <= 28) return 34
  return 28
}
/** Hoehe einer Bahn; liegen Aufenthalte uebereinander, bekommt jeder eine. */
const BAHN_PX = 24

/**
 * Aufenthalte einer Zeile auf Bahnen verteilen. In der Zeile "ohne Zimmer"
 * liegen viele zugleich, und uebereinander gezeichnet sah man nur den
 * obersten.
 */
function bahnen(stays: SortierAufenthalt[]): Array<{ s: SortierAufenthalt; bahn: number }> {
  const enden: string[] = []
  return [...stays]
    .sort((a, b) => a.arrival.localeCompare(b.arrival) || a.reservationRef.localeCompare(b.reservationRef))
    .map(s => {
      let bahn = enden.findIndex(e => e <= s.arrival)
      if (bahn === -1) { bahn = enden.length; enden.push(s.departure) } else enden[bahn] = s.departure
      return { s, bahn }
    })
}

export function SortierKalender({ vorschau, nachher, nurBetroffene }: {
  vorschau: SortierVorschau
  nachher: boolean
  nurBetroffene: boolean
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const tage = useMemo(() => eachDay(vorschau.from, vorschau.to), [vorschau])
  const n = tage.length
  const TAG_PX = tagBreite(n)

  const zimmerNach = useMemo(() => new Map(vorschau.rooms.map(z => [z.id, z])), [vorschau])
  const anderesZimmer = (s: SortierAufenthalt) => {
    const id = nachher ? s.fromRoomId : s.toRoomId
    return id === null ? t('roomSort.unassigned') : zimmerNach.get(id)?.code ?? '?'
  }

  const betroffen = useMemo(() => {
    const ids = new Set<number>()
    for (const s of vorschau.stays) {
      if (!s.moved) continue
      for (const r of [s.fromRoomId, s.toRoomId]) {
        const z = r === null ? undefined : zimmerNach.get(r)
        if (z !== undefined) ids.add(z.categoryId)
      }
    }
    return ids
  }, [vorschau, zimmerNach])

  const zimmer = vorschau.rooms.filter(z => !nurBetroffene || betroffen.has(z.categoryId))
  const jeZimmer = useMemo(() => {
    const m = new Map<number | null, SortierAufenthalt[]>()
    for (const s of vorschau.stays) {
      const r = nachher ? s.toRoomId : s.fromRoomId
      const l = m.get(r) ?? []
      l.push(s)
      m.set(r, l)
    }
    return m
  }, [vorschau, nachher])
  const ohneZimmer = jeZimmer.get(null) ?? []

  // Gruppenkopf vor dem ersten Zimmer jeder Gruppe, wie im Zimmerplan.
  const zeilen: Array<{ art: 'gruppe'; name: string; key: string }
                    | { art: 'zimmer'; z: SortierZimmer; key: string }> = []
  let letzte: number | null = null
  for (const z of zimmer) {
    if (z.categoryId !== letzte) {
      zeilen.push({ art: 'gruppe', name: z.categoryName, key: `g${z.categoryId}` })
      letzte = z.categoryId
    }
    zeilen.push({ art: 'zimmer', z, key: `z${z.id}` })
  }

  const wochentag = (d: string) => new Date(`${d}T00:00:00Z`)
    .toLocaleDateString(intlTag(locale), { weekday: 'narrow', timeZone: 'UTC' })

  /** Wie im Zimmerplan: Anreise ab Mittag, Abreise bis Mittag. */
  const lage = (s: SortierAufenthalt): { links: number; breite: number } => {
    const a = s.arrival < vorschau.from ? 0 : daysBetween(vorschau.from, s.arrival) + 0.5
    const e = s.departure > vorschau.to ? n : Math.min(n, daysBetween(vorschau.from, s.departure) + 0.5)
    return { links: a * TAG_PX, breite: Math.max(6, (e - a) * TAG_PX - 2) }
  }

  const balken = (s: SortierAufenthalt, bahn: number) => {
    const { links, breite } = lage(s)
    const farbe = s.moved
      ? 'bg-amber-400 text-amber-950 ring-1 ring-amber-600'
      : s.fixed ? 'bg-neutral-300 text-neutral-700' : 'bg-sky-100 text-sky-900'
    const name = s.guestName ?? s.reservationRef
    const hinweis = s.moved
      ? (nachher ? t('roomSort.barFrom', { room: anderesZimmer(s) })
                 : t('roomSort.barTo', { room: anderesZimmer(s) }))
      : null
    return (
      <div key={s.reservationRef}
           title={`${name}, ${formatDate(s.arrival, locale)} – ${formatDate(s.departure, locale)}`
                  + (hinweis === null ? '' : ` (${hinweis})`)}
           className={`absolute rounded-sm px-1 text-[11px] leading-5 truncate ${farbe}`}
           style={{ left: links, width: breite, top: bahn * BAHN_PX + 2, height: BAHN_PX - 4 }}>
        {name}{hinweis !== null && <span className="opacity-75"> · {nachher ? '←' : '→'} {anderesZimmer(s)}</span>}
      </div>
    )
  }

  const spur = (stays: SortierAufenthalt[]) => {
    const verteilt = bahnen(stays)
    const hoehe = Math.max(1, ...verteilt.map(v => v.bahn + 1)) * BAHN_PX
    return (
    <div className="relative" style={{ width: n * TAG_PX, height: hoehe }}>
      {tage.map((d, i) => isWeekend(d) && (
        <div key={d} className="absolute inset-y-0 bg-neutral-100"
             style={{ left: i * TAG_PX, width: TAG_PX }} />
      ))}
      {verteilt.map(v => balken(v.s, v.bahn))}
    </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3 text-xs text-neutral-600">
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-3 rounded-sm bg-amber-400 ring-1 ring-amber-600" />
          {t('roomSort.legendMoved')}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-3 rounded-sm bg-sky-100" />
          {t('roomSort.legendStays')}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-4 h-3 rounded-sm bg-neutral-300" />
          {t('roomSort.legendFixed')}
        </span>
      </div>

      <div className="border border-neutral-200 rounded-sm overflow-auto max-h-[55vh]"
           data-testid="sortier-kalender">
        <div className="min-w-max">
          <div className="flex sticky top-0 z-10 bg-white border-b border-neutral-200">
            <div className="w-28 shrink-0 sticky left-0 bg-white" />
            {tage.map(d => (
              <div key={d} className={`text-center text-[10px] leading-3 py-1 tabular-nums
                                       ${isWeekend(d) ? 'bg-neutral-100' : ''}`}
                   style={{ width: TAG_PX }}>
                <div className="text-neutral-500">{wochentag(d)}</div>
                <div>{d.slice(8, 10)}</div>
              </div>
            ))}
          </div>

          {ohneZimmer.length > 0 && (
            <div className="flex border-b border-neutral-200 bg-amber-50">
              <div className="w-28 shrink-0 sticky left-0 bg-amber-50 px-2 text-xs leading-6
                              text-amber-900 truncate">
                {t('roomSort.noRoomRow')}
              </div>
              {spur(ohneZimmer)}
            </div>
          )}

          {zeilen.map(zeile => zeile.art === 'gruppe'
            ? (
              <div key={zeile.key} className="sticky left-0 px-2 py-0.5 text-[11px] font-medium
                                              text-neutral-600 bg-neutral-50 border-b
                                              border-neutral-200">
                {zeile.name}
              </div>
            )
            : (
              <div key={zeile.key} className="flex border-b border-neutral-100">
                <div className="w-28 shrink-0 sticky left-0 z-[1] bg-white px-2 text-xs leading-6
                                truncate" title={zeile.z.name ?? zeile.z.code}>
                  {zeile.z.code}{zeile.z.name !== null && zeile.z.name !== zeile.z.code
                    && <span className="text-neutral-500"> {zeile.z.name}</span>}
                </div>
                {spur(jeZimmer.get(zeile.z.id) ?? [])}
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
