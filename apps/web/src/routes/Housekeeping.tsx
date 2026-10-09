import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { HousekeepingState } from '@hotelpms/contracts'
import { useHousekeeping, useSetHousekeeping, useGenerateTasks, useFinishTask }
  from '../lib/queries.js'
import { useKontrolle, useKontrollieren, type KontrollZimmer }
  from '../lib/queries/kontrolle.js'
import { CHIP_FARBE, CHIP_ZEICHEN, chipZustand, jeZimmer, kachelSichtbar, nachKraft,
         type ChipZustand } from '../lib/kontrollChips.js'
import { useT, type TextKey } from '../lib/i18n/index.js'
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

/** Steht im Filter fuer „nicht zugeteilt"; ein Name kann es nicht sein. */
const OHNE_KRAFT = '\u0000'

/** Wie die Kontrolle den Stand eines Zimmers nennt; dieselben Worte wie die Personal-App. */
const ZUSTAND: Record<ChipZustand, TextKey> = {
  open: 'inspection.notCleaned', blocked: 'inspection.waitingCheckout',
  toCheck: 'inspection.cleaned', passed: 'inspection.passed', rework: 'inspection.rework',
  declined: 'inspection.declined', waived: 'inspection.declined'
}

/**
 * Der Zimmerstatus als Kachelraster.
 *
 * Housekeeping läuft mit dem Telefon durchs Haus, oft über schlechtes WLAN.
 * Deshalb: eine Anfrage für alle Zimmer, lokal zwischengespeichert, und
 * Mehrfachauswahl, damit eine ganze Etage in einem Aufruf umgestellt wird
 * statt in dreißig.
 *
 * **Die Kontrolle steht mit darin** (Sven, 09.10.2026: „Housekeeping ist
 * schöner"). Vorher gab es dafür einen eigenen Bildschirm, der dieselben
 * Zimmer ein zweites Mal zeigte. Wer `housekeeping:inspect` hat, sieht auf
 * der Kachel die Kraft, den Stand der Reinigung und kann abnehmen oder mit
 * einem Satz zur Nacharbeit zurückschicken; der Filter nach Kraft ersetzt
 * die Karten je Kraft. Die Kontrolle gilt für den Geschäftstag, den die
 * Schnittstelle nennt — an einem anderen Tag zeigt die Kachel nur den
 * Zimmerstand.
 */
export function Housekeeping(
  { propertyId, permissions }: { propertyId: number; permissions: readonly string[] }
): JSX.Element {
  const [datum, setDatum] = useState(today())
  const [gewaehlt, setGewaehlt] = useState<Set<number>>(new Set())
  const [kraft, setKraft] = useState<string | null | undefined>(undefined)
  const [nurPruefen, setNurPruefen] = useState(false)
  const [nacharbeit, setNacharbeit] = useState<{ z: KontrollZimmer; satz: string } | null>(null)
  const t = useT()
  const online = useOnline()
  const q = useHousekeeping(propertyId, datum)
  const setzen = useSetHousekeeping(propertyId, datum)
  const erzeugen = useGenerateTasks(propertyId, datum)
  const erledigen = useFinishTask(propertyId, datum)
  const darfPruefen = permissions.includes('housekeeping:inspect')
  const kontrolle = useKontrolle(propertyId, darfPruefen)
  const pruefen = useKontrollieren(propertyId)

  if (q.isError && q.data === undefined) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />

  const tag = darfPruefen && kontrolle.data !== undefined && kontrolle.data.date === datum
    ? kontrolle.data.rooms : []
  const aufgaben = jeZimmer(tag)
  // Das Bad des Gaestehauses und andere Bereiche: kein Zimmerstand, aber
  // zu kontrollieren wie ein Zimmer.
  const bereiche = tag.filter(z => z.resourceId === null
    && kachelSichtbar(z, kraft, nurPruefen))
  const kraefte = nachKraft(tag).map(g => g.name)
  const zahl = (zs: readonly ChipZustand[]): number =>
    tag.filter(z => zs.includes(chipZustand(z))).length
  const sperre = !online || pruefen.isPending
  const pruefe = (z: KontrollZimmer, result: 'passed' | 'rework' | null, note?: string) =>
    pruefen.mutate({ taskId: z.taskId, result, note },
      { onSuccess: () => setNacharbeit(null) })

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
                  className={`text-sm px-3 py-1 rounded-sm border ${FARBE[s]}
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
                className="text-sm px-3 py-1 rounded-sm border border-neutral-300
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

      {tag.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium">{t('inspection.summary', {
            passed: zahl(['passed', 'declined']), open: zahl(['toCheck']),
            todo: zahl(['open', 'blocked', 'rework', 'waived']) })}</span>
          <span className="text-xs text-neutral-500">{t('inspection.legend')}</span>
          <div className="grow" />
          <label className="flex items-center gap-1">
            <span className="text-neutral-600">{t('inspection.staff')}</span>
            <select value={kraft === undefined ? '' : kraft ?? OHNE_KRAFT}
                    onChange={e => setKraft(e.target.value === '' ? undefined
                      : e.target.value === OHNE_KRAFT ? null : e.target.value)}
                    className="border border-neutral-300 rounded-sm px-2 py-1">
              <option value="">{t('hk.allStaff')}</option>
              {kraefte.map(k => (
                <option key={k ?? ''} value={k ?? OHNE_KRAFT}>
                  {k ?? t('inspection.unassigned')}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={nurPruefen}
                   onChange={e => setNurPruefen(e.target.checked)} />
            {t('inspection.filterOpen')}
          </label>
        </div>
      )}
      {pruefen.isError && <Fehler error={pruefen.error} />}
      {nacharbeit !== null && (
        <form className="flex flex-wrap items-center gap-2 text-sm"
              onSubmit={e => { e.preventDefault(); pruefe(nacharbeit.z, 'rework', nacharbeit.satz.trim()) }}>
          <span className="font-semibold tabular-nums">{nacharbeit.z.code}</span>
          <input autoFocus required maxLength={500} value={nacharbeit.satz}
                 placeholder={t('inspection.reworkPlaceholder')}
                 onChange={e => setNacharbeit({ ...nacharbeit, satz: e.target.value })}
                 className="border border-neutral-300 rounded-sm px-2 py-1 grow min-w-0 max-w-md" />
          <button type="submit" disabled={sperre || nacharbeit.satz.trim() === ''}
                  className="px-2 py-1 rounded-sm bg-red-700 text-white disabled:bg-neutral-300">
            {t('inspection.rework')}</button>
          <button type="button" onClick={() => setNacharbeit(null)}
                  className="px-2 py-1 rounded-sm border border-neutral-300">
            {t('inspection.cancel')}</button>
        </form>
      )}

      <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(120px,1fr))]">
        {q.data.rooms.filter(r => kachelSichtbar(aufgaben.get(r.resourceId), kraft, nurPruefen))
          .map(r => { const k = aufgaben.get(r.resourceId); return (
          <button key={r.resourceId}
                  onClick={() => umschalten(r.resourceId)}
                  aria-pressed={gewaehlt.has(r.resourceId)}
                  className={`text-left border rounded-sm p-2 ${FARBE[r.status]}
                              ${gewaehlt.has(r.resourceId)
                                ? 'ring-2 ring-neutral-900' : ''}`}>
            <div className="flex items-baseline justify-between">
              <span className="font-medium tabular-nums">{r.code}</span>
              <span className="text-[11px] opacity-70">{r.categoryCode}</span>
            </div>
            <div className="text-[11px]">{t(LABEL[r.status])}</div>
            <div className="mt-1 space-y-0.5 text-[11px] opacity-80">
              {r.departureRef !== null && <div>↗ {t('hk.departureToday')}</div>}
              {r.stayoverRef !== null && <div>● {t('hk.stayover')}</div>}
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
                              rounded-sm py-0.5 hover:bg-white/50 cursor-pointer">
                {t('hk.finishTask')}
              </div>
            )}
            {k !== undefined && (
              <KontrollZeile z={k} sperre={sperre}
                             abnehmen={() => pruefe(k, 'passed')}
                             zuruecknehmen={() => pruefe(k, null)}
                             nacharbeiten={() => setNacharbeit({ z: k, satz: '' })} />
            )}
          </button>
        ) })}
      </div>
      {bereiche.length > 0 && (
        <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(120px,1fr))]">
          {bereiche.map(z => (
            <div key={z.taskId}
                 className="border border-dashed border-neutral-300 rounded-sm p-2 bg-white">
              <span className="font-medium">{z.code}</span>
              <KontrollZeile z={z} sperre={sperre}
                             abnehmen={() => pruefe(z, 'passed')}
                             zuruecknehmen={() => pruefe(z, null)}
                             nacharbeiten={() => setNacharbeit({ z, satz: '' })} />
            </div>
          ))}
        </div>
      )}
      {q.data.rooms.length === 0 && (
        <p className="text-sm text-neutral-500">{t('common.none')}</p>
      )}
    </div>
  )
}

/**
 * Ein Knopf in der Kachel. Wie „Erledigt" ein div mit role=button: die
 * Kachel ist selbst ein Knopf, und ein Druck darauf soll das Zimmer nicht
 * mit auswaehlen.
 */
function KachelKnopf(
  { text, aus, onDruck, art }:
  { text: string; aus: boolean; onDruck: () => void; art: 'voll' | 'rot' | 'leer' }
): JSX.Element {
  const los = (e: MouseEvent | KeyboardEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    if (!aus) onDruck()
  }
  return (
    <div role="button" tabIndex={aus ? -1 : 0} aria-disabled={aus}
         onClick={los}
         onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') los(e) }}
         className={`grow text-[11px] text-center rounded-sm py-0.5 px-1 cursor-pointer
                     ${aus ? 'opacity-40 cursor-default' : ''}
                     ${art === 'voll' ? 'bg-neutral-900 text-white'
                       : art === 'rot' ? 'border border-red-300 bg-white text-red-800'
                         : 'border border-current/40 hover:bg-white/50'}`}>
      {text}
    </div>
  )
}

/** Kraft, Stand der Reinigung und die Knoepfe der Hausdame. */
function KontrollZeile(
  { z, sperre, abnehmen, zuruecknehmen, nacharbeiten }:
  { z: KontrollZimmer; sperre: boolean; abnehmen: () => void; zuruecknehmen: () => void
    nacharbeiten: () => void }
): JSX.Element {
  const t = useT()
  const zu = chipZustand(z)
  return (
    <div className="mt-1 space-y-1 text-[11px]">
      <div className="flex items-center gap-1">
        <span className={`shrink-0 rounded-sm border px-1 ${CHIP_FARBE[zu]}`}>
          {CHIP_ZEICHEN[zu] === '' ? '·' : CHIP_ZEICHEN[zu]}
        </span>
        <span className="truncate">{t(ZUSTAND[zu])}</span>
      </div>
      <div className="truncate opacity-80">👤 {z.staffName ?? t('inspection.unassigned')}</div>
      {z.inspection === 'rework' && z.inspectionNote !== null && (
        <div className="text-red-900">„{z.inspectionNote}“</div>
      )}
      {z.openProblems > 0 && (
        <div className="text-red-800">⚠ {t('inspection.problems', { n: z.openProblems })}</div>
      )}
      {/* Untereinander: nebeneinander passen beide nicht in 120 Pixel. */}
      {zu === 'toCheck' && (
        <div className="flex flex-col gap-1">
          <KachelKnopf text={t('inspection.passed')} aus={sperre} onDruck={abnehmen} art="voll" />
          <KachelKnopf text={t('inspection.rework')} aus={sperre} onDruck={nacharbeiten} art="rot" />
        </div>
      )}
      {z.inspection !== null && (
        <div className="flex">
          <KachelKnopf text={t('inspection.undo')} aus={sperre} onDruck={zuruecknehmen} art="leer" />
        </div>
      )}
    </div>
  )
}
