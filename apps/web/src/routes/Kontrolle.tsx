import { useState } from 'react'
import { useT, type TextKey } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { useKontrolle, useKontrollieren, type KontrollZimmer }
  from '../lib/queries/kontrolle.js'
import { CHIP_FARBE, CHIP_ZEICHEN, chipZustand, nachKraft, type ChipZustand }
  from '../lib/kontrollChips.js'

/**
 * Kontrolle (Aufgabe 18, Baustein 4) -- die Seite der Personal-App fuer
 * die Hausdame am Rechner (Sven, 07.10.2026: dieselben Seiten in beiden
 * Oberflaechen).
 *
 * Je Kraft eine Karte mit Chips, wie in der Personal-App
 * (`lib/kontrollChips.ts`). Minuten stehen nicht da: die Hausdame sieht
 * Zimmer, nicht die Arbeitszeit der Kraefte.
 */

type Abschnitt = 'toCheck' | 'waiting' | 'passed'

function abschnitt(z: KontrollZimmer): Abschnitt {
  if (z.inspection === 'passed' || z.outcome === 'declined') return 'passed'
  if (z.inspection === 'rework') return 'waiting'
  if (z.outcome === 'cleaned' || z.outcome === 'was_clean') return 'toCheck'
  return 'waiting'
}

const AUSGANG: Record<NonNullable<KontrollZimmer['outcome']>, TextKey> = {
  cleaned: 'inspection.cleaned', declined: 'inspection.declined',
  was_clean: 'inspection.wasClean'
}

export function Kontrolle({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const q = useKontrolle(propertyId)
  const [offen, setOffen] = useState<number | null>(null)
  if (q.isError && q.data === undefined) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const rooms = q.data.rooms
  const zahl = (a: Abschnitt): number => rooms.filter(z => abschnitt(z) === a).length

  // Je Kraft eine Karte mit Chips, deren Farbe den Stand zeigt (Sven,
  // 08.10.2026). Ein Klick auf einen Chip zeigt darunter, was zu tun ist.
  return <div className="space-y-4">
    <p className="text-sm text-neutral-600 max-w-prose">{t('inspection.hint')}</p>
    {rooms.length === 0
      ? <p className="text-sm text-neutral-500">{t('inspection.empty')}</p>
      : <>
        <p className="text-sm font-medium">{t('inspection.summary', {
          passed: zahl('passed'), open: zahl('toCheck'), todo: zahl('waiting') })}</p>
        <p className="text-xs text-neutral-500">{t('inspection.legend')}</p>
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {nachKraft(rooms).map(g => {
            const gewaehlt = g.rooms.find(z => z.taskId === offen)
            return <section key={g.name ?? ''}
                            className="rounded-sm border border-neutral-200 bg-white p-3 space-y-2">
              <h2 className="font-semibold">{g.name ?? t('inspection.unassigned')}</h2>
              {(['departure', 'stayover'] as const).map(art => {
                const liste = g.rooms.filter(z => z.kind === art)
                if (liste.length === 0) return null
                const rot = art === 'departure'
                return <div key={art}
                            className={`border-l-2 pl-2 ${rot ? 'border-red-400' : 'border-sky-400'}`}>
                  <div className={`text-xs font-semibold mb-1 ${rot ? 'text-red-800' : 'text-sky-800'}`}>
                    {t(rot ? 'cleaningPlan.departures' : 'cleaningPlan.stayovers')}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {liste.map(z => {
                      const zu = chipZustand(z)
                      return <button key={z.taskId} type="button"
                                     aria-expanded={offen === z.taskId}
                                     title={t(ZUSTAND[zu])}
                                     onClick={() => setOffen(offen === z.taskId ? null : z.taskId)}
                                     className={`min-w-[3.25rem] px-2 py-1 rounded-sm border text-sm
                                                 font-medium tabular-nums ${CHIP_FARBE[zu]}
                                                 ${offen === z.taskId ? 'ring-2 ring-neutral-900' : ''}`}>
                        {z.code}
                        {CHIP_ZEICHEN[zu] !== '' && <span className="ml-1">{CHIP_ZEICHEN[zu]}</span>}
                        {z.arrivalToday && zu !== 'passed' && <span className="ml-1 text-xs">↘</span>}
                        {z.openProblems > 0 && <span className="ml-1 text-xs">⚠</span>}
                      </button>
                    })}
                  </div>
                </div>
              })}
              {gewaehlt !== undefined
                && <Aktionen key={gewaehlt.taskId} z={gewaehlt} propertyId={propertyId}
                             fertig={() => setOffen(null)} />}
            </section>
          })}
        </div>
      </>}
  </div>
}

const ZUSTAND: Record<ChipZustand, TextKey> = {
  open: 'inspection.notCleaned', blocked: 'inspection.waitingCheckout',
  toCheck: 'inspection.cleaned', passed: 'inspection.passed', rework: 'inspection.rework',
  declined: 'inspection.declined', waived: 'inspection.declined'
}

/** Was die Hausdame mit dem angeklickten Zimmer tun kann. */
function Aktionen({ z, propertyId, fertig }: {
  z: KontrollZimmer; propertyId: number; fertig: () => void
}): JSX.Element {
  const t = useT()
  const online = useOnline()
  const pruefen = useKontrollieren(propertyId)
  const [satz, setSatz] = useState<string | null>(null)
  const gereinigt = z.outcome === 'cleaned' || z.outcome === 'was_clean'
  const sperre = !online || pruefen.isPending
  const los = (result: 'passed' | 'rework' | null, note?: string): void => {
    pruefen.mutate({ taskId: z.taskId, result, note }, { onSuccess: fertig })
  }

  return <div className="border-t border-neutral-200 pt-2 space-y-2 text-sm">
    <div>
      <span className="font-semibold tabular-nums">{z.code}</span>
      <span className="ml-2 text-neutral-500">
        {t(z.kind === 'departure' ? 'cleaningPlan.departure' : 'cleaningPlan.stayover')}
      </span>
      <span className="ml-2">
        {z.outcome !== null ? t(AUSGANG[z.outcome])
          : t(z.kind === 'departure' && !z.free ? 'inspection.waitingCheckout'
                                                : 'inspection.notCleaned')}
      </span>
      {z.arrivalToday && z.inspection !== 'passed'
        && <span className="ml-2 text-purple-800">{t('cleaningPlan.arrival')}</span>}
      {z.openProblems > 0 && <span className="ml-2 text-red-800">
        {t('inspection.problems', { n: z.openProblems })}</span>}
    </div>
    {z.inspection === 'rework' && z.inspectionNote !== null
      && <div className="text-red-900">„{z.inspectionNote}“</div>}
    {pruefen.isError && <Fehler error={pruefen.error} />}
    {satz !== null
      ? <form className="flex flex-wrap gap-2" onSubmit={e => {
          e.preventDefault()
          los('rework', satz.trim())
        }}>
          <input autoFocus required maxLength={500} value={satz}
                 placeholder={t('inspection.reworkPlaceholder')}
                 onChange={e => setSatz(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1 grow min-w-0" />
          <button type="submit" disabled={sperre || satz.trim() === ''}
                  className="px-2 py-1 rounded bg-red-700 text-white disabled:bg-neutral-300">
            {t('inspection.rework')}</button>
          <button type="button" onClick={() => setSatz(null)}
                  className="px-2 py-1 rounded border border-neutral-300">
            {t('inspection.cancel')}</button>
        </form>
      : <div className="flex flex-wrap gap-2">
          {gereinigt && z.inspection === null && <>
            <button type="button" disabled={sperre} onClick={() => los('passed')}
                    className="px-2 py-1 rounded bg-neutral-900 text-white
                               disabled:bg-neutral-300">{t('inspection.passed')}</button>
            <button type="button" disabled={sperre} onClick={() => setSatz('')}
                    className="px-2 py-1 rounded border border-neutral-300 text-red-800">
              {t('inspection.rework')}</button>
          </>}
          {z.inspection !== null && <button type="button" disabled={sperre}
                    onClick={() => los(null)}
                    className="px-2 py-1 rounded border border-neutral-300">
              {t('inspection.undo')}</button>}
        </div>}
  </div>
}
