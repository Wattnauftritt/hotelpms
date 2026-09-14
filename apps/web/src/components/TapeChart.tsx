import { useMemo } from 'react'
import type { TapeChart as TapeChartData } from '@hotelpms/contracts'
import { eachDay, isWeekend, daysBetween } from '../lib/dates.js'
import { useT, useLocale, formatDate, weekdayShort } from '../lib/i18n/index.js'

/**
 * Der Zimmerplan.
 *
 * Er ist der Bildschirm, auf den die Rezeption den ganzen Tag sieht, und
 * deshalb der einzige, bei dem die Darstellung selbst eine fachliche
 * Entscheidung ist:
 *
 * - **Ein Balken je Reservierung, nicht eine Zelle je Nacht.** Ein Aufenthalt
 *   ist eine Sache und wird als eine gelesen. Zellen zu färben sieht aus wie
 *   fünf einzelne Nächte.
 * - **Der Balken endet am Abreisetag, beginnt aber am Anreisetag.** Die
 *   Abreisenacht gibt es nicht; das Zimmer ist an dem Tag ab mittags wieder
 *   frei. Ein Balken, der bis in den Abreisetag hineinreicht, lässt ein
 *   verkäufliches Zimmer belegt aussehen.
 * - **Nicht zugewiesene Reservierungen stehen oben**, nicht unsichtbar unten.
 *   Sie sind die Arbeit des Tages.
 */

const SPALTE = 44        // Pixel je Tag
const ZEILE = 34

const FARBE: Record<string, string> = {
  Optional: 'bg-status-optional',
  Confirmed: 'bg-status-confirmed',
  InHouse: 'bg-status-inhouse'
}

interface Props {
  data: TapeChartData
  onSelect?: (reservationRef: string) => void
}

export function TapeChart({ data, onSelect }: Props): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const tage = useMemo(() => eachDay(data.from, data.to), [data.from, data.to])

  const nichtZugewiesen = useMemo(
    () => data.reservations.filter(r => r.resource_id === null),
    [data.reservations])

  const jeZimmer = useMemo(() => {
    const m = new Map<number, typeof data.reservations>()
    for (const r of data.reservations) {
      if (r.resource_id === null) continue
      const liste = m.get(r.resource_id)
      if (liste) liste.push(r); else m.set(r.resource_id, [r])
    }
    return m
  }, [data.reservations])

  const blockeJeZimmer = useMemo(() => {
    const m = new Map<number, typeof data.blocks>()
    for (const b of data.blocks) {
      const liste = m.get(b.resource_id)
      if (liste) liste.push(b); else m.set(b.resource_id, [b])
    }
    return m
  }, [data.blocks])

  /** Wo im Raster liegt ein Zeitraum, auf den sichtbaren Ausschnitt beschnitten. */
  const balken = (von: string, bis: string) => {
    const start = Math.max(0, daysBetween(data.from, von))
    const ende = Math.min(tage.length, daysBetween(data.from, bis))
    return { left: start * SPALTE, width: Math.max(ende - start, 0) * SPALTE - 4 }
  }

  return (
    <div className="overflow-auto border border-neutral-200 rounded">
      <div style={{ minWidth: 160 + tage.length * SPALTE }}>
        {/* Kopfzeile mit Tagen */}
        <div className="flex sticky top-0 z-20 bg-white border-b border-neutral-200">
          <div className="w-40 shrink-0 px-2 py-1 text-xs font-medium text-neutral-500
                          border-r border-neutral-200">
            {t('common.room')}
          </div>
          {tage.map(d => (
            <div key={d}
                 style={{ width: SPALTE }}
                 className={`shrink-0 text-center text-[11px] leading-tight py-1
                             border-r border-neutral-100
                             ${isWeekend(d) ? 'bg-neutral-50' : ''}`}>
              <div className="text-neutral-400">{weekdayShort(d, locale)}</div>
              <div className="tabular-nums">{d.slice(8)}</div>
            </div>
          ))}
        </div>

        {/* Ohne Zimmer: die Arbeit des Tages, deshalb oben. */}
        {nichtZugewiesen.length > 0 && (
          <div className="flex relative bg-amber-50 border-b border-amber-200"
               style={{ height: ZEILE * Math.min(nichtZugewiesen.length, 4) }}>
            <div className="w-40 shrink-0 px-2 py-1 text-xs text-amber-800
                            border-r border-amber-200">
              {t('today.needsRoom')} ({nichtZugewiesen.length})
            </div>
            <div className="relative grow">
              {nichtZugewiesen.slice(0, 4).map((r, i) => {
                const b = balken(r.arrival, r.departure)
                return (
                  <button key={r.id}
                          onClick={() => onSelect?.(r.public_ref)}
                          title={`${r.last_name ?? ''} · ${r.public_ref}`}
                          style={{ ...b, top: i * ZEILE + 4, height: ZEILE - 8 }}
                          className={`absolute rounded px-1 text-[11px] text-white
                                      truncate text-left ${FARBE[r.status] ?? 'bg-neutral-400'}`}>
                    {r.last_name ?? r.public_ref}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Eine Zeile je Zimmer */}
        {data.units.map(u => (
          <div key={u.id} className="flex relative border-b border-neutral-100"
               style={{ height: ZEILE }}>
            <div className="w-40 shrink-0 px-2 py-1 text-xs border-r border-neutral-200
                            flex items-center gap-2">
              <span className="font-medium tabular-nums">{u.code}</span>
              <span className="text-neutral-400 truncate">{u.category_name}</span>
            </div>
            <div className="relative grow">
              {tage.map((d, i) => (
                <div key={d}
                     style={{ left: i * SPALTE, width: SPALTE }}
                     className={`absolute inset-y-0 border-r border-neutral-100
                                 ${isWeekend(d) ? 'bg-neutral-50' : ''}`} />
              ))}
              {(blockeJeZimmer.get(u.id) ?? []).map((b, i) => (
                <div key={i}
                     style={{ ...balken(b.from_date, b.to_date), top: 4, height: ZEILE - 8 }}
                     title={b.reason}
                     className="absolute rounded bg-status-blocked/60 px-1 text-[11px]
                                text-white truncate
                                [background-image:repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(255,255,255,.35)_4px,rgba(255,255,255,.35)_8px)]">
                  {b.reason}
                </div>
              ))}
              {(jeZimmer.get(u.id) ?? []).map(r => (
                <button key={r.id}
                        onClick={() => onSelect?.(r.public_ref)}
                        title={`${r.last_name ?? ''} ${r.first_name ?? ''} · `
                             + `${formatDate(r.arrival, locale)} – `
                             + `${formatDate(r.departure, locale)} · `
                             + `${t(`status.${r.status}` as never)}`
                             + (r.notes ? ` · ${r.notes}` : '')}
                        style={{ ...balken(r.arrival, r.departure), top: 4, height: ZEILE - 8 }}
                        className={`absolute rounded px-1 text-[11px] text-white truncate
                                    text-left hover:ring-2 ring-black/30
                                    ${FARBE[r.status] ?? 'bg-neutral-400'}`}>
                  {/* Die Notiz ist der Grund, warum man den Balken anders
                      behandelt als jeden anderen -- deshalb ein Merkmal am
                      Balken selbst, nicht erst im Seitenfenster. */}
                  {r.notes && <span aria-hidden className="mr-0.5">📌</span>}
                  {r.last_name ?? r.public_ref}
                </button>
              ))}
            </div>
          </div>
        ))}

        {data.units.length === 0 && (
          <div className="p-6 text-sm text-neutral-500">{t('common.none')}</div>
        )}
      </div>
    </div>
  )
}
