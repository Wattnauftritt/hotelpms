import { useState } from 'react'
import type { HousekeepingState } from '@hotelpms/contracts'
import { useHousekeeping, useSetHousekeeping, useGenerateTasks, useFinishTask }
  from '../lib/queries.js'
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
  const erzeugen = useGenerateTasks(propertyId, datum)
  const erledigen = useFinishTask(propertyId, datum)

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
        {/*
          * Aufgaben erzeugen: Abreise oder Bleibegast je belegtem Zimmer.
          * Ein zweiter Klick schadet nicht -- die Route ist idempotent und
          * ergaenzt nur, was seit dem ersten dazugekommen ist.
          */}
        <button onClick={() => erzeugen.mutate()}
                disabled={!online || erzeugen.isPending}
                className="text-sm px-3 py-1 rounded border border-neutral-300
                           disabled:opacity-40">
          {t(erzeugen.isPending ? 'common.loading' : 'hk.generateTasks')}
        </button>
      </div>
      {setzen.isError && <Fehler error={setzen.error} />}
      {erzeugen.isError && <Fehler error={erzeugen.error} />}
      {erledigen.isError && <Fehler error={erledigen.error} />}
      {erzeugen.isSuccess && (
        <p className="text-sm text-neutral-600">
          {t('hk.tasksCreated', { n: erzeugen.data.created })}
        </p>
      )}

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
              {r.taskKind !== null && (
                <div className={r.taskStatus === 'done' ? 'line-through opacity-60' : ''}>
                  {t(r.taskKind === 'departure' ? 'hk.taskDeparture' : 'hk.taskStayover')}
                </div>
              )}
            </div>
            {/*
              * Der Erledigen-Knopf liegt IN der Kachel, aber ausserhalb ihrer
              * Auswahl: stopPropagation, sonst waehlte jeder Klick darauf das
              * Zimmer mit aus und die naechste Massenaenderung traefe es.
              *
              * Als div mit role=button, nicht als <button>: die Kachel ist
              * selbst schon ein Knopf, und ein Knopf im Knopf ist ungueltiges
              * HTML -- der Browser zieht ihn heraus, und dann sitzt er
              * woanders als gedacht.
              */}
            {r.taskId !== null && r.taskStatus === 'open' && (
              <div role="button" tabIndex={0}
                   aria-label={t('hk.finishTask')}
                   onClick={e => { e.stopPropagation(); erledigen.mutate(r.taskId!) }}
                   onKeyDown={e => {
                     if (e.key !== 'Enter' && e.key !== ' ') return
                     e.preventDefault()
                     e.stopPropagation()
                     erledigen.mutate(r.taskId!)
                   }}
                   className="mt-1 text-[11px] text-center border border-current/40
                              rounded py-0.5 hover:bg-white/50 cursor-pointer">
                {t('hk.finishTask')}
              </div>
            )}
          </button>
        ))}
      </div>
      {q.data.rooms.length === 0 && (
        <p className="text-sm text-neutral-500">{t('common.none')}</p>
      )}
    </div>
  )
}
