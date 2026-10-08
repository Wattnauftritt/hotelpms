import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { StaffLocale } from '@hotelpms/contracts'
import { api } from '../lib/api.js'
import { fehlerText, usePT } from './texte.js'
import { FELD, Fehler, KNOPF, KNOPF_LEISE, Karte } from './teile.js'
import { CHIP_FARBE, CHIP_ZEICHEN, chipZustand, nachKraft } from '../lib/kontrollChips.js'

/**
 * Kontrolle durch die Hausdame (Baustein 4, Aufgabe 18 in Dokument 16).
 *
 * Je Kraft eine Karte mit ihren Abreisen und Bleibern als Chips, deren
 * Farbe den Stand zeigt (`lib/kontrollChips.ts`). Minuten stehen nicht da,
 * anders als in der alten App: sie gehoeren zur Abrechnung, und die
 * Hausdame sieht keine Arbeitszeit.
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
  waived: boolean
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

  // Je Kraft eine Karte, darin Abreisen und Bleiber als Chips; die Farbe
  // sagt den Stand (Sven, 08.10.2026, wie in der alten App). Ein Tipp auf
  // einen Chip klappt darunter auf, was die Hausdame damit tun kann.
  return <div className="space-y-3">
    <p className="text-sm text-neutral-600">{t('inspect.summary', {
      passed: teile.passed.length, open: teile.toCheck.length, todo: teile.waiting.length })}</p>
    <p className="text-xs text-neutral-500">{t('inspect.legend')}</p>
    {fehler !== null && <Fehler text={fehler} />}
    {nachKraft(rooms).map(g => {
      const gewaehlt = g.rooms.find(z => z.taskId === offen)
      return <section key={g.name ?? ''}
                      className="bg-white border border-neutral-200 rounded-lg p-2.5 space-y-2">
        <h2 className="font-semibold text-base">{g.name ?? t('inspect.unassigned')}</h2>
        {(['departure', 'stayover'] as const).map(art => {
          const liste = g.rooms.filter(z => z.kind === art)
          if (liste.length === 0) return null
          const rot = art === 'departure'
          return <div key={art}
                      className={`border-l-4 pl-2 ${rot ? 'border-red-500' : 'border-sky-500'}`}>
            <h3 className={`text-xs font-semibold mb-1 ${rot ? 'text-red-700' : 'text-sky-700'}`}>
              {t(rot ? 'room.departure' : 'room.stayover')}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {liste.map(z => {
                const zu = chipZustand(z)
                return <button key={z.taskId} type="button" aria-expanded={offen === z.taskId}
                               onClick={() => setOffen(offen === z.taskId ? null : z.taskId)}
                               className={`min-w-[3.5rem] min-h-[2.5rem] px-2 rounded-md border-2 text-base
                                           font-semibold tabular-nums ${CHIP_FARBE[zu]}
                                           ${offen === z.taskId ? 'ring-2 ring-neutral-900' : ''}`}>
                  {z.code}
                  {CHIP_ZEICHEN[zu] !== '' && <span className="ml-1 text-sm">{CHIP_ZEICHEN[zu]}</span>}
                  {z.arrivalToday && zu !== 'passed' && <span className="ml-0.5 text-xs">↘</span>}
                  {z.openProblems > 0 && <span className="ml-0.5 text-xs">⚠</span>}
                </button>
              })}
            </div>
          </div>
        })}
        {gewaehlt !== undefined
          && <KontrollKarte z={gewaehlt} laeuft={pruefen.isPending}
                            onPruefen={(result, note) =>
                              pruefen.mutate({ taskId: gewaehlt.taskId, result, note })} />}
      </section>
    })}
  </div>
}

function Marke({ farbe, children }: { farbe: string; children: React.ReactNode }): JSX.Element {
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${farbe}`}>
    {children}
  </span>
}

/** Was die Hausdame mit dem angetippten Zimmer tun kann. */
function KontrollKarte({ z, laeuft, onPruefen }: {
  z: KontrollZimmer; laeuft: boolean
  onPruefen: (result: 'passed' | 'rework' | null, note?: string) => void
}): JSX.Element {
  const t = usePT()
  const [nacharbeit, setNacharbeit] = useState(false)
  const [satz, setSatz] = useState('')
  const gereinigt = z.outcome === 'cleaned' || z.outcome === 'was_clean'

  return <div className={`rounded-lg border bg-white ${z.inspection === 'rework'
    ? 'border-red-300' : 'border-neutral-300'}`}>
    <div className="w-full text-left px-4 py-3 flex items-center gap-3">
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
    </div>
    {z.inspection === 'rework' && z.inspectionNote !== null
      && <p className="px-4 pb-3 -mt-1 text-sm text-red-900">„{z.inspectionNote}“</p>}
    <div className="px-4 pb-4 space-y-2">
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
    </div>
  </div>
}
