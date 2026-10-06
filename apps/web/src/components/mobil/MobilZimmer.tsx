import { useState } from 'react'
import type { HousekeepingRoom, HousekeepingState } from '@hotelpms/contracts'
import { useHousekeeping, useSetHousekeeping, useFinishTask } from '../../lib/queries.js'
import { useT } from '../../lib/i18n/index.js'
import { useOnline } from '../../lib/offline.js'
import { today } from '../../lib/dates.js'
import { Fehler, Laedt } from '../Shell.tsx'

type Filter = 'alle' | HousekeepingState

const LABEL: Record<HousekeepingState, 'hk.dirty' | 'hk.clean' | 'hk.inspected' | 'hk.occupied'> = {
  dirty: 'hk.dirty', clean: 'hk.clean', inspected: 'hk.inspected', occupied: 'hk.occupied'
}

const FARBE: Record<HousekeepingState, string> = {
  dirty: 'bg-red-100 text-red-800',
  clean: 'bg-emerald-100 text-emerald-800',
  inspected: 'bg-blue-100 text-blue-800',
  occupied: 'bg-neutral-100 text-neutral-700'
}

/**
 * Vorrang hat ein schmutziges Zimmer, in das heute jemand anreist. Es steht
 * oben, weil an ihm der Check-in haengt; alles andere kann warten.
 */
export function vorrang(r: Pick<HousekeepingRoom, 'status' | 'arrivalRef'>): boolean {
  return r.status === 'dirty' && r.arrivalRef !== null
}

/**
 * Der Zimmerstatus am Telefon.
 *
 * Housekeeping geht mit dem Telefon durchs Haus und will wissen: welche
 * Zimmer sind noch schmutzig, und welche davon zuerst. Deshalb steht
 * "Schmutzig" vorgewaehlt, Zimmer mit Anreise heute stehen oben, und je
 * Zeile gibt es **einen** Knopf, der den naechsten Schritt setzt: schmutzig
 * wird sauber, sauber wird kontrolliert.
 *
 * Die Mehrfachauswahl des Desktops (eine Etage in einem Aufruf) fehlt hier
 * mit Absicht: am Telefon steht man vor **einem** Zimmer.
 */
export function MobilZimmer({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const datum = today()
  // Ohne eigene Wahl: "Schmutzig", solange es das gibt, sonst alle. Ein
  // leerer Bildschirm am Morgen sagte "nichts da" statt "alles sauber".
  const [gewaehlt, setFilter] = useState<Filter | null>(null)
  const q = useHousekeeping(propertyId, datum)
  const setzen = useSetHousekeeping(propertyId, datum)
  const erledigen = useFinishTask(propertyId, datum)

  if (q.isError && q.data === undefined) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />

  const zimmer = q.data.rooms
  const anzahl = (s: HousekeepingState): number => zimmer.filter(r => r.status === s).length
  const filter: Filter = gewaehlt ?? (anzahl('dirty') > 0 ? 'dirty' : 'alle')
  const gezeigt = zimmer
    .filter(r => filter === 'alle' || r.status === filter)
    // Stabil sortiert: Vorrang nach oben, sonst die Reihenfolge des Hauses.
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(vorrang(b.r)) - Number(vorrang(a.r)) || a.i - b.i)
    .map(x => x.r)

  const filterListe: ReadonlyArray<{ key: Filter; text: string }> = [
    { key: 'dirty', text: `${t('hk.dirty')} ${anzahl('dirty')}` },
    { key: 'clean', text: `${t('hk.clean')} ${anzahl('clean')}` },
    { key: 'inspected', text: `${t('hk.inspected')} ${anzahl('inspected')}` },
    { key: 'alle', text: t('mobil.hk.all') }
  ]

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs text-neutral-500">{t('nav.housekeeping')}</div>
        <h1 className="text-lg font-semibold">{t('mobil.tab.rooms')}</h1>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {filterListe.map(f => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)}
                  aria-pressed={filter === f.key}
                  className={`h-8 shrink-0 whitespace-nowrap rounded-full border px-3 text-xs
                              ${filter === f.key ? 'border-neutral-900 bg-neutral-900 text-white'
                                                 : 'border-neutral-300 bg-white'}`}>
            {f.text}
          </button>
        ))}
      </div>

      {setzen.isError && <Fehler error={setzen.error} />}
      {erledigen.isError && <Fehler error={erledigen.error} />}

      <ul className="space-y-2">
        {gezeigt.map(r => {
          const naechster: HousekeepingState | null =
            r.status === 'dirty' ? 'clean' : r.status === 'clean' ? 'inspected' : null
          return (
            <li key={r.resourceId}
                className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-3">
              <span className="grid h-11 min-w-11 shrink-0 place-items-center rounded-lg bg-violet-50
                               px-1 font-bold tabular-nums text-violet-800">
                {r.code}
              </span>
              <div className="min-w-0 grow">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{r.categoryCode}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] ${FARBE[r.status]}`}>
                    {t(LABEL[r.status])}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-neutral-500">
                  {r.departureRef !== null && <span>↗ {t('hk.departureToday')}</span>}
                  {r.stayoverRef !== null && <span>● {t('hk.stayover')}</span>}
                  {r.arrivalRef !== null && <span>↘ {t('hk.arrivalToday')}</span>}
                  {r.openTickets > 0 && (
                    <span className="text-red-700">🔧 {r.openTickets} {t('hk.openTickets')}</span>
                  )}
                  {r.taskKind !== null && (
                    <span className={r.taskStatus === 'done' ? 'line-through' : ''}>
                      {t(r.taskKind === 'departure' ? 'hk.taskDeparture' : 'hk.taskStayover')}
                    </span>
                  )}
                </div>
                {vorrang(r) && (
                  <span className="mt-1 inline-block rounded bg-red-600 px-1.5 py-0.5 text-[11px]
                                   font-semibold text-white">
                    {t('mobil.hk.priority')}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                {naechster !== null && (
                  <button type="button" disabled={!online || setzen.isPending}
                          onClick={() => setzen.mutate({ resourceIds: [r.resourceId],
                                                         status: naechster })}
                          className="h-11 rounded-lg bg-neutral-900 px-3 text-sm font-semibold text-white
                                     disabled:bg-neutral-200 disabled:text-neutral-500">
                    ✓ {t(naechster === 'clean' ? 'mobil.hk.toClean' : 'mobil.hk.toInspected')}
                  </button>
                )}
                {r.taskId !== null && r.taskStatus === 'open' && (
                  <button type="button" disabled={!online || erledigen.isPending}
                          onClick={() => erledigen.mutate(r.taskId!)}
                          className="h-9 rounded-lg border border-neutral-300 px-3 text-xs
                                     disabled:opacity-40">
                    {t('hk.finishTask')}
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {gezeigt.length === 0 && (
        <p className="py-6 text-center text-sm text-neutral-500">{t('common.none')}</p>
      )}
    </div>
  )
}
