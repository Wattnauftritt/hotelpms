import { useMemo } from 'react'
import type { AvailabilityDay, Category } from '@hotelpms/contracts'
import { eachDay, isWeekend } from '../lib/dates.js'
import { useT, useLocale, weekdayShort } from '../lib/i18n/index.js'

const SPALTE = 44
const LABEL_BREITE = 160

/**
 * Verfügbarkeitsraster: Zimmergruppe × Tag (A8).
 *
 * Die Frage, die dieses Raster beantwortet, ist nicht "wer liegt wo"
 * (das ist der Zimmerplan), sondern "was kann ich noch verkaufen". Eine
 * Zelle führt deshalb direkt in den Buchungsdialog, nicht erst über den
 * Umweg eines einzelnen Zimmers.
 */
export function AvailabilityGrid({ from, to, days, categories, onSelect }: {
  from: string; to: string
  days: AvailabilityDay[]
  categories: Category[]
  onSelect?: (sel: { categoryId: number; categoryName: string; date: string }) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const tage = useMemo(() => eachDay(from, to), [from, to])

  const jeKategorie = useMemo(() => {
    const m = new Map<number, Map<string, AvailabilityDay>>()
    for (const d of days) {
      let byDate = m.get(d.category_id)
      if (!byDate) { byDate = new Map(); m.set(d.category_id, byDate) }
      byDate.set(d.date, d)
    }
    return m
  }, [days])

  return (
    <div className="overflow-auto border border-neutral-200 rounded">
      <div style={{ minWidth: LABEL_BREITE + tage.length * SPALTE }}>
        <div className="flex sticky top-0 z-20 bg-white border-b border-neutral-200">
          <div className="w-40 shrink-0 px-2 py-1 text-xs font-medium text-neutral-500
                          border-r border-neutral-200">
            {t('availability.category')}
          </div>
          {tage.map(d => (
            <div key={d} style={{ width: SPALTE }}
                 className={`shrink-0 text-center text-[11px] leading-tight py-1
                             border-r border-neutral-100
                             ${isWeekend(d) ? 'bg-neutral-50' : ''}`}>
              <div className="text-neutral-400">{weekdayShort(d, locale)}</div>
              <div className="tabular-nums">{d.slice(8)}</div>
            </div>
          ))}
        </div>

        {categories.map(k => {
          const byDate = jeKategorie.get(k.id) ?? new Map<string, AvailabilityDay>()
          return (
            <div key={k.id} className="flex border-b border-neutral-100">
              <div className="w-40 shrink-0 px-2 py-1 text-xs border-r border-neutral-200
                              flex items-center truncate">
                {k.name}
              </div>
              {tage.map(d => {
                const zelle = byDate.get(d)
                const frei = zelle?.available ?? null
                return (
                  <button key={d} type="button"
                          disabled={frei === null || frei <= 0}
                          onClick={() => onSelect?.({
                            categoryId: k.id, categoryName: k.name, date: d })}
                          title={frei === null ? '' : `${frei} ${t('availability.free')}`}
                          style={{ width: SPALTE }}
                          className={`shrink-0 py-1 text-[11px] text-center tabular-nums
                                      border-r border-neutral-100
                                      ${frei === null ? 'text-neutral-300'
                                        : frei <= 0 ? 'bg-red-50 text-red-700'
                                        : 'hover:bg-emerald-50 text-emerald-800'}`}>
                    {frei ?? '–'}
                  </button>
                )
              })}
            </div>
          )
        })}

        {categories.length === 0 && (
          <div className="p-6 text-sm text-neutral-500">{t('common.none')}</div>
        )}
      </div>
    </div>
  )
}
