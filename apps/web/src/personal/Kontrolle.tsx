import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { StaffLocale } from '@hotelpms/contracts'
import { api } from '../lib/api.js'
import { fehlerText, usePT } from './texte.js'
import { FELD, Fehler, KNOPF, KNOPF_LEISE, Karte } from './teile.js'

/**
 * Kontrolle durch die Hausdame (Baustein 4, Aufgabe 18 in Dokument 16).
 *
 * Drei Abschnitte in der Reihenfolge, in der sie die Hausdame brauchen:
 * was gereinigt ist und auf sie wartet, was noch nicht gereinigt ist, was
 * sie schon abgenommen hat. An jedem Zimmer steht, wer es hat -- Minuten
 * stehen nicht da, die gehoeren zur Abrechnung, nicht zur Kontrolle.
 */

export interface KontrollZimmer {
  taskId: number
  code: string
  kind: 'departure' | 'stayover'
  staffName: string | null
  status: 'open' | 'done' | 'skipped'
  outcome: 'cleaned' | 'declined' | 'was_clean' | null
  inspection: 'passed' | 'rework' | null
  inspectionNote: string | null
  free: boolean
  arrivalToday: boolean
  openProblems: number
}
interface Tag { date: string; rooms: KontrollZimmer[] }

export type Abschnitt = 'toCheck' | 'waiting' | 'passed'

/**
 * Wohin ein Zimmer gehoert. Nacharbeit zaehlt als "noch nicht gereinigt":
 * die Kraft ist wieder dran. "Gast will keine Reinigung" gibt es nichts
 * abzunehmen; es steht bei den erledigten, damit die Liste aufgeht.
 */
export function abschnitt(z: KontrollZimmer): Abschnitt {
  if (z.inspection === 'passed' || z.outcome === 'declined') return 'passed'
  if (z.inspection === 'rework') return 'waiting'
  if (z.outcome === 'cleaned' || z.outcome === 'was_clean') return 'toCheck'
  return 'waiting'
}

export function Kontrolle({ propertyId, locale }: {
  propertyId: number; locale: StaffLocale
}): JSX.Element {
  const t = usePT()
  const qc = useQueryClient()
  const key = ['inspection', propertyId]
  const tag = useQuery<Tag>({
    queryKey: key,
    queryFn: () => api.get<Tag>(`/v1/properties/${propertyId}/inspection`),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true
  })
  const [offen, setOffen] = useState<number | null>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  const pruefen = useMutation({
    mutationFn: (a: { taskId: number; result: 'passed' | 'rework' | null; note?: string }) =>
      api.post<Tag>(`/v1/properties/${propertyId}/inspection/${a.taskId}`,
        { result: a.result, note: a.note }),
    onSuccess: neu => { qc.setQueryData(key, neu); setOffen(null); setFehler(null) },
    onError: e => {
      setFehler(fehlerText(e, locale))
      void qc.invalidateQueries({ queryKey: key })
    }
  })

  if (tag.isPending) return <Karte><p>{t('app.loading')}</p></Karte>
  if (tag.isError) {
    return <Karte>
      <Fehler text={fehlerText(tag.error, locale)} />
      <button type="button" className={KNOPF_LEISE} onClick={() => { void tag.refetch() }}>
        {t('app.retry')}
      </button>
    </Karte>
  }
  const rooms = tag.data.rooms
  if (rooms.length === 0) {
    return <Karte><p className="text-base text-neutral-700">{t('inspect.empty')}</p></Karte>
  }
  const teile: Record<Abschnitt, KontrollZimmer[]> = { toCheck: [], waiting: [], passed: [] }
  for (const z of rooms) teile[abschnitt(z)].push(z)

  return <div className="space-y-3">
    <p className="text-sm text-neutral-600">{t('inspect.summary', {
      passed: teile.passed.length, open: teile.toCheck.length, todo: teile.waiting.length })}</p>
    {fehler !== null && <Fehler text={fehler} />}
    {(['toCheck', 'waiting', 'passed'] as const).map(a => teile[a].length > 0 &&
      <section key={a} className="space-y-2">
        <h2 className="text-sm font-semibold text-neutral-500 pt-2">
          {t(a === 'toCheck' ? 'inspect.toCheck' : a === 'waiting' ? 'inspect.waiting'
             : 'inspect.passed')}
        </h2>
        <ul className="space-y-2">
          {teile[a].map(z => <li key={z.taskId}>
            <KontrollKarte z={z} offen={offen === z.taskId} laeuft={pruefen.isPending}
                           onToggle={() => setOffen(offen === z.taskId ? null : z.taskId)}
                           onPruefen={(result, note) =>
                             pruefen.mutate({ taskId: z.taskId, result, note })} />
          </li>)}
        </ul>
      </section>)}
  </div>
}

function Marke({ farbe, children }: { farbe: string; children: React.ReactNode }): JSX.Element {
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${farbe}`}>
    {children}
  </span>
}

function KontrollKarte({ z, offen, laeuft, onToggle, onPruefen }: {
  z: KontrollZimmer; offen: boolean; laeuft: boolean; onToggle: () => void
  onPruefen: (result: 'passed' | 'rework' | null, note?: string) => void
}): JSX.Element {
  const t = usePT()
  const [nacharbeit, setNacharbeit] = useState(false)
  const [satz, setSatz] = useState('')
  const gereinigt = z.outcome === 'cleaned' || z.outcome === 'was_clean'

  return <div className={`rounded-lg border bg-white ${z.inspection === 'rework'
    ? 'border-red-300' : 'border-neutral-300'}`}>
    <button type="button" onClick={onToggle} aria-expanded={offen}
            className="w-full text-left px-4 py-3 flex items-center gap-3">
      <span className="text-2xl font-semibold tabular-nums min-w-[3.5rem]">{z.code}</span>
      <span className="flex flex-wrap gap-1.5 flex-1">
        <Marke farbe={z.kind === 'departure' ? 'bg-blue-100 text-blue-900'
                                             : 'bg-neutral-100 text-neutral-800'}>
          {t(z.kind === 'departure' ? 'room.departure' : 'room.stayover')}
        </Marke>
        {z.outcome !== null
          && <Marke farbe="bg-green-100 text-green-900">{t(`outcome.${z.outcome}`)}</Marke>}
        {z.inspection === 'rework'
          && <Marke farbe="bg-red-600 text-white">{t('inspect.rework')}</Marke>}
        {z.inspection === 'passed'
          && <Marke farbe="bg-green-600 text-white">{t('inspect.passed')}</Marke>}
        {z.outcome === null && z.kind === 'departure' && !z.free
          && <Marke farbe="bg-amber-100 text-amber-900">{t('room.waiting')}</Marke>}
        {z.arrivalToday && z.inspection !== 'passed'
          && <Marke farbe="bg-purple-100 text-purple-900">{t('room.arrival')}</Marke>}
        {z.openProblems > 0
          && <Marke farbe="bg-red-100 text-red-900">{t('room.problems', { n: z.openProblems })}</Marke>}
      </span>
      <span className="text-sm text-neutral-500 text-right">
        {z.staffName ?? t('inspect.unassigned')}</span>
    </button>
    {z.inspection === 'rework' && z.inspectionNote !== null
      && <p className="px-4 pb-3 -mt-1 text-sm text-red-900">„{z.inspectionNote}“</p>}
    {offen && <div className="px-4 pb-4 space-y-2">
      {gereinigt && z.inspection === null && !nacharbeit && <>
        <button type="button" disabled={laeuft} className={KNOPF}
                onClick={() => onPruefen('passed')}>{t('inspect.passed')}</button>
        <button type="button" className={`${KNOPF_LEISE} text-red-800`}
                onClick={() => setNacharbeit(true)}>{t('inspect.rework')}</button>
      </>}
      {nacharbeit && <form className="space-y-2" onSubmit={e => {
        e.preventDefault(); onPruefen('rework', satz.trim())
      }}>
        <label className="block">
          <span className="block text-sm text-neutral-600">{t('inspect.reworkHint')}</span>
          <textarea required maxLength={500} rows={2} value={satz}
                    onChange={e => setSatz(e.target.value)} className={FELD} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className={KNOPF_LEISE}
                  onClick={() => setNacharbeit(false)}>{t('problem.cancel')}</button>
          <button type="submit" className={KNOPF}
                  disabled={laeuft || satz.trim() === ''}>{t('inspect.rework')}</button>
        </div>
      </form>}
      {z.inspection !== null && <button type="button" disabled={laeuft} className={KNOPF_LEISE}
                                        onClick={() => onPruefen(null)}>{t('inspect.undo')}</button>}
      {!gereinigt && z.inspection === null
        && <p className="text-sm text-neutral-600">{t('inspect.waiting')}</p>}
    </div>}
  </div>
}
