import type { CleaningWaiverView } from '@hotelpms/contracts'
import { useT, useLocale, formatDate, weekdayShort } from '../lib/i18n/index.js'

/**
 * Die Bleibetage mit je einem Haken "keine Reinigung" (Migration 0115).
 *
 * Eine Komponente fuer die Gastseite und das Seitenfenster der Rezeption:
 * was der Gast sieht, soll die Rezeption am Telefon genauso vor sich haben.
 * Wer was mit dem Haken tut, entscheidet der Aufrufer (`onSet`) -- der Gast
 * mit seinem Link, die Rezeption mit ihrer Sitzung.
 */
export function VerzichtTage({ view, onSet, busy, gross = false }: {
  view: CleaningWaiverView
  onSet: (date: string, waived: boolean) => void
  busy: boolean
  gross?: boolean
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  return (
    <ul className={`flex flex-wrap ${gross ? 'gap-3' : 'gap-2'}`}>
      {view.days.map(d => (
        <li key={d.date}>
          <label className={`flex items-center gap-2 rounded-sm border
                             ${gross ? 'px-4 py-3' : 'px-2 py-1 text-xs'}
                             ${d.waived ? 'border-emerald-600 bg-emerald-50' : 'border-neutral-300 bg-white'}
                             ${d.locked || !view.mayEdit ? 'opacity-60' : 'cursor-pointer'}`}>
            <input type="checkbox" checked={d.waived}
                   disabled={busy || d.locked || !view.mayEdit}
                   onChange={e => onSet(d.date, e.currentTarget.checked)}
                   className={gross ? 'h-6 w-6' : ''} />
            <span>
              {weekdayShort(d.date, locale)} {formatDate(d.date, locale)}
              {d.locked && <span className="text-neutral-500"> · {t('gastCheckin.waiver.locked')}</span>}
            </span>
          </label>
        </li>
      ))}
    </ul>
  )
}
