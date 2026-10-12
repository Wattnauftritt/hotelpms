import type { JSX } from 'react'
import type { CleaningWaiverView } from '@hotelpms/contracts'

/**
 * Die Bleibetage mit je einem Haken "keine Reinigung" (Migration 0115), ohne
 * Katalog: wer sie zeigt, reicht Beschriftung und Datumsform herein.
 *
 * Eigene Datei, weil die Gaestemappe sie auch zeigt (0148) und ihren eigenen
 * Katalog hat. Eine Komponente, die den Katalog der Rezeption laedt, zoege
 * ihn auf das Telefon des Gastes mit.
 */
export function VerzichtListe({ view, onSet, busy, gross = false, tag, erledigt }: {
  view: CleaningWaiverView
  onSet: (date: string, waived: boolean) => void
  busy: boolean
  gross?: boolean
  /** Der Tag so, wie ihn der Aufrufer schreibt, etwa "Di 14.10.2026". */
  tag: (date: string) => string
  /** Der Zusatz an einem Tag, den die Kraft schon gemeldet hat. */
  erledigt: string
}): JSX.Element {
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
              {tag(d.date)}
              {d.locked && <span className="text-neutral-500"> · {erledigt}</span>}
            </span>
          </label>
        </li>
      ))}
    </ul>
  )
}
