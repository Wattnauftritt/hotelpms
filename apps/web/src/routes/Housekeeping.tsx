import { useState } from 'react'
import type { HousekeepingState } from '@hotelpms/contracts'
import { useHousekeeping, useSetHousekeeping } from '../lib/queries.js'
import { useT } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { today } from '../lib/dates.js'
import { Fehler, Laedt, DatumsWahl } from '../components/Shell.tsx'

const FARBE: Record<HousekeepingState, string> = {
  dirty: 'bg-red-100 border-red-300 text-red-900',
  clean: 'bg-emerald-50 border-emerald-300 text-emerald-900',
  inspected: 'bg-emerald-100 border-emerald-400 text-emerald-900',
  occupied: 'bg-blue-50 border-blue-300 text-blue-900'
}
const LABEL: Record<HousekeepingState, 'hk.dirty' | 'hk.clean' | 'hk.inspected'
                                     | 'hk.occupied'> = {
  dirty: 'hk.dirty', clean: 'hk.clean', inspected: 'hk.inspected', occupied: 'hk.occupied'
}

/**
 * Der Zimmerstatus als Kachelraster.
 *
 * Housekeeping läuft mit dem Telefon durchs Haus, oft über schlechtes WLAN.
 * Deshalb: eine Anfrage für alle Zimmer, lokal zwischengespeichert, und
 * Mehrfachauswahl, damit eine ganze Etage in einem Aufruf umgestellt wird
 * statt in dreißig.
 */
export function Housekeeping({ propertyId }: { propertyId: number }): JSX.Element {
  const [datum, setDatum] = useState(today())
  const [gewaehlt, setGewaehlt] = useState<Set<number>>(new Set())
  const t = useT()
  const online = useOnline()
  const q = useHousekeeping(propertyId, datum)
  const setzen = useSetHousekeeping(propertyId, datum)

  if (q.isError && q.data === undefined) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />

  const umschalten = (id: number) => setGewaehlt(alt => {
    const neu = new Set(alt)
    if (neu.has(id)) neu.delete(id); else neu.add(id)
    return neu
  })

  const anwenden = (status: HousekeepingState) => {
    if (gewaehlt.size === 0) return
    setzen.mutate({ resourceIds: [...gewaehlt], status },
      { onSuccess: () => setGewaehlt(new Set()) })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <DatumsWahl value={datum} onChange={setDatum} />
        <div className="grow" />
        <span className="text-sm text-neutral-500">{gewaehlt.size} {t('common.rooms')}</span>
        {(['dirty', 'clean', 'inspected'] as const).map(s => (
          <button key={s} onClick={() => anwenden(s)}
                  disabled={!online || gewaehlt.size === 0 || setzen.isPending}
                  className={`text-sm px-3 py-1 rounded border ${FARBE[s]}
                              disabled:opacity-40`}>
            {t(LABEL[s])}
          </button>
        ))}
      </div>
      {setzen.isError && <Fehler error={setzen.error} />}

      <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(120px,1fr))]">
        {q.data.rooms.map(r => (
          <button key={r.resourceId}
                  onClick={() => umschalten(r.resourceId)}
                  aria-pressed={gewaehlt.has(r.resourceId)}
                  className={`text-left border rounded p-2 ${FARBE[r.status]}
                              ${gewaehlt.has(r.resourceId)
                                ? 'ring-2 ring-neutral-900' : ''}`}>
            <div className="flex items-baseline justify-between">
              <span className="font-medium tabular-nums">{r.code}</span>
              <span className="text-[11px] opacity-70">{r.categoryCode}</span>
            </div>
            <div className="text-[11px]">{t(LABEL[r.status])}</div>
            <div className="mt-1 space-y-0.5 text-[11px] opacity-80">
              {r.departureRef !== null && <div>↗ {t('hk.departureToday')}</div>}
              {r.arrivalRef !== null && <div>↘ {t('hk.arrivalToday')}</div>}
              {r.openTickets > 0 && (
                <div className="text-red-800">🔧 {r.openTickets} {t('hk.openTickets')}</div>
              )}
            </div>
          </button>
        ))}
      </div>
      {q.data.rooms.length === 0 && (
        <p className="text-sm text-neutral-500">{t('common.none')}</p>
      )}
    </div>
  )
}
