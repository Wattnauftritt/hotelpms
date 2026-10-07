import { useState } from 'react'
import { useT, type TextKey } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { useKontrolle, useKontrollieren, type KontrollZimmer }
  from '../lib/queries/kontrolle.js'

/**
 * Kontrolle (Aufgabe 18, Baustein 4) -- die Seite der Personal-App fuer
 * die Hausdame am Rechner (Sven, 07.10.2026: dieselben Seiten in beiden
 * Oberflaechen).
 *
 * Gereinigtes, das auf sie wartet, steht oben; ein Haken blendet den Rest
 * aus. Minuten stehen nicht da: die Hausdame sieht Zimmer, nicht die
 * Arbeitszeit der Kraefte.
 */

type Abschnitt = 'toCheck' | 'waiting' | 'passed'

function abschnitt(z: KontrollZimmer): Abschnitt {
  if (z.inspection === 'passed' || z.outcome === 'declined') return 'passed'
  if (z.inspection === 'rework') return 'waiting'
  if (z.outcome === 'cleaned' || z.outcome === 'was_clean') return 'toCheck'
  return 'waiting'
}
const RANG: Record<Abschnitt, number> = { toCheck: 0, waiting: 1, passed: 2 }

const AUSGANG: Record<NonNullable<KontrollZimmer['outcome']>, TextKey> = {
  cleaned: 'inspection.cleaned', declined: 'inspection.declined',
  was_clean: 'inspection.wasClean'
}

export function Kontrolle({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const q = useKontrolle(propertyId)
  const [nurOffen, setNurOffen] = useState(false)
  if (q.isError && q.data === undefined) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const rooms = q.data.rooms
  const zahl = (a: Abschnitt): number => rooms.filter(z => abschnitt(z) === a).length
  const sichtbar = rooms
    .map((z, i) => ({ z, i }))
    .filter(({ z }) => !nurOffen || abschnitt(z) === 'toCheck')
    .sort((a, b) => RANG[abschnitt(a.z)] - RANG[abschnitt(b.z)] || a.i - b.i)
    .map(x => x.z)

  return <div className="space-y-4">
    <p className="text-sm text-neutral-600 max-w-prose">{t('inspection.hint')}</p>
    {rooms.length === 0
      ? <p className="text-sm text-neutral-500">{t('inspection.empty')}</p>
      : <>
        <div className="flex flex-wrap items-center gap-4">
          <p className="text-sm font-medium">{t('inspection.summary', {
            passed: zahl('passed'), open: zahl('toCheck'), todo: zahl('waiting') })}</p>
          <label className="text-sm flex items-center gap-2">
            <input type="checkbox" checked={nurOffen}
                   onChange={e => setNurOffen(e.target.checked)} />
            {t('inspection.filterOpen')}
          </label>
        </div>
        <table className="w-full text-sm border-collapse">
          <thead className="text-left text-neutral-500 border-b border-neutral-200">
            <tr>
              <th className="py-2 pr-3 font-medium">{t('inspection.room')}</th>
              <th className="py-2 pr-3 font-medium">{t('inspection.staff')}</th>
              <th className="py-2 pr-3 font-medium">{t('inspection.state')}</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {sichtbar.map(z => <Zeile key={z.taskId} z={z} propertyId={propertyId} />)}
          </tbody>
        </table>
      </>}
  </div>
}

function Zeile({ z, propertyId }: { z: KontrollZimmer; propertyId: number }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const pruefen = useKontrollieren(propertyId)
  const [satz, setSatz] = useState<string | null>(null)
  const gereinigt = z.outcome === 'cleaned' || z.outcome === 'was_clean'
  const sperre = !online || pruefen.isPending

  return <tr className="border-b border-neutral-100 align-top">
    <td className="py-2 pr-3">
      <span className="font-semibold tabular-nums">{z.code}</span>
      <span className="ml-2 text-neutral-500">
        {t(z.kind === 'departure' ? 'cleaningPlan.departure' : 'cleaningPlan.stayover')}
      </span>
      {z.arrivalToday && z.inspection !== 'passed'
        && <span className="ml-2 text-purple-800">{t('cleaningPlan.arrival')}</span>}
    </td>
    <td className="py-2 pr-3">{z.staffName
      ?? <span className="text-neutral-400">{t('inspection.unassigned')}</span>}</td>
    <td className="py-2 pr-3 space-y-1">
      <div>
        {z.outcome !== null
          ? <span className="text-green-800">{t(AUSGANG[z.outcome])}</span>
          : <span className="text-neutral-500">
              {t(z.kind === 'departure' && !z.free
                ? 'inspection.waitingCheckout' : 'inspection.notCleaned')}
            </span>}
        {z.inspection === 'passed'
          && <span className="ml-2 px-1.5 py-0.5 rounded bg-green-600 text-white text-xs">
            {t('inspection.passed')}</span>}
        {z.inspection === 'rework'
          && <span className="ml-2 px-1.5 py-0.5 rounded bg-red-600 text-white text-xs">
            {t('inspection.rework')}</span>}
        {z.openProblems > 0 && <span className="ml-2 text-red-800">
          {t('inspection.problems', { n: z.openProblems })}</span>}
      </div>
      {z.inspection === 'rework' && z.inspectionNote !== null
        && <div className="text-red-900">„{z.inspectionNote}“</div>}
      {pruefen.isError && <Fehler error={pruefen.error} />}
    </td>
    <td className="py-2 text-right whitespace-nowrap">
      {satz !== null
        ? <form className="inline-flex gap-2" onSubmit={e => {
            e.preventDefault()
            pruefen.mutate({ taskId: z.taskId, result: 'rework', note: satz.trim() },
              { onSuccess: () => setSatz(null) })
          }}>
            <input autoFocus required maxLength={500} value={satz}
                   placeholder={t('inspection.reworkPlaceholder')}
                   onChange={e => setSatz(e.target.value)}
                   className="border border-neutral-300 rounded px-2 py-1 w-56" />
            <button type="submit" disabled={sperre || satz.trim() === ''}
                    className="px-2 py-1 rounded bg-red-700 text-white disabled:bg-neutral-300">
              {t('inspection.rework')}</button>
            <button type="button" onClick={() => setSatz(null)}
                    className="px-2 py-1 rounded border border-neutral-300">
              {t('inspection.cancel')}</button>
          </form>
        : <div className="inline-flex gap-2">
            {gereinigt && z.inspection === null && <>
              <button type="button" disabled={sperre}
                      onClick={() => pruefen.mutate({ taskId: z.taskId, result: 'passed' })}
                      className="px-2 py-1 rounded bg-neutral-900 text-white
                                 disabled:bg-neutral-300">{t('inspection.passed')}</button>
              <button type="button" disabled={sperre} onClick={() => setSatz('')}
                      className="px-2 py-1 rounded border border-neutral-300 text-red-800">
                {t('inspection.rework')}</button>
            </>}
            {z.inspection !== null && <button type="button" disabled={sperre}
                      onClick={() => pruefen.mutate({ taskId: z.taskId, result: null })}
                      className="px-2 py-1 rounded border border-neutral-300">
                {t('inspection.undo')}</button>}
          </div>}
    </td>
  </tr>
}
