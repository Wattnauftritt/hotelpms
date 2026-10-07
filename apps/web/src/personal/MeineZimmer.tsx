import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { StaffLocale } from '@hotelpms/contracts'
import { api, ApiError } from '../lib/api.js'
import { fehlerText, usePT } from './texte.js'
import { FELD, Fehler, KNOPF, KNOPF_LEISE, Karte } from './teile.js'

/**
 * Meine Zimmer (Baustein 3, Aufgabe 18 in Dokument 16).
 *
 * Die Liste des Tages so, wie man durchs Haus geht, offene oben. Ein Tipp
 * auf ein Zimmer klappt die Ausgaenge auf; "Gereinigt" ist der grosse
 * Knopf, weil es der haeufigste ist. Jede Antwort der Schnittstelle bringt
 * die ganze Liste mit, also gibt es nach dem Tippen keine zweite Runde.
 *
 * Neu geladen wird jede Minute und beim Zurueckkehren in die App -- so
 * wird eine Abreise frei, ohne dass jemand zieht. Gespeichert wird nichts:
 * die Liste lebt nur im Speicher dieser Seite (Dokument 16, Aufgabe 18).
 *
 * **Alle Haeuser in einer Liste** (0116): dieselben Kraefte reinigen Hotel
 * und Gaestehaus. Ein Abruf bringt die Zimmer aller Haeuser, in denen die
 * Kraft die App benutzt; arbeitet sie in mehreren, steht jedes Haus mit
 * Ueberschrift da. Gesetzt wird am Haus der Aufgabe, und dessen Antwort
 * ersetzt nur seinen Teil der Liste.
 */

type Ausgang = 'cleaned' | 'declined' | 'was_clean'

export interface MeinZimmer {
  taskId: number
  code: string
  /** Ein Bereich wie das Gemeinschaftsbad statt eines Zimmers (0116). */
  areaId?: number | null
  kind: 'departure' | 'stayover'
  minutes: number | null
  status: 'open' | 'done' | 'skipped'
  outcome: Ausgang | null
  free: boolean
  arrivalToday: boolean
  openProblems: number
  inspection: 'passed' | 'rework' | null
  inspectionNote: string | null
  inspectionNoteTranslated?: string | null
  /** Der Gast verzichtet heute (0115); `water`: es gibt eine Flasche dafuer. */
  waiver?: { water: boolean; delivered: boolean } | null
}
interface Tag { date: string; rooms: MeinZimmer[]; minutes: number }
interface Haus extends Tag { propertyId: number; name: string }
interface Alle { houses: Haus[] }
const KEY = ['my-rooms']

/**
 * Nacharbeit ganz oben -- die Hausdame wartet darauf. Dann offene, darin
 * freie vor wartenden und Anreisen vor dem Rest: ein Zimmer, in das heute
 * jemand einzieht, soll nicht als letztes dran sein. Sonst bleibt die
 * Reihenfolge des Hauses.
 */
export function ordneZimmer(rooms: readonly MeinZimmer[]): MeinZimmer[] {
  const rang = (z: MeinZimmer): number =>
    z.inspection === 'rework' ? -1
      : z.status !== 'open' ? 3 : !z.free ? 2 : z.arrivalToday ? 0 : 1
  return rooms.map((z, i) => ({ z, i }))
    .sort((a, b) => rang(a.z) - rang(b.z) || a.i - b.i)
    .map(x => x.z)
}

export function MeineZimmer({ locale }: { locale: StaffLocale }): JSX.Element {
  const t = usePT()
  const alle = useQuery<Alle>({
    queryKey: KEY,
    queryFn: () => api.get<Alle>('/v1/my-rooms'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true
  })
  if (alle.isPending) return <Karte><p>{t('app.loading')}</p></Karte>
  if (alle.isError) {
    return <Karte>
      <Fehler text={fehlerText(alle.error, locale)} />
      <button type="button" className={KNOPF_LEISE} onClick={() => { void alle.refetch() }}>
        {t('app.retry')}
      </button>
    </Karte>
  }
  const mitZimmern = alle.data.houses.filter(h => h.rooms.length > 0)
  if (mitZimmern.length === 0) {
    return <Karte><p className="text-base text-neutral-700">{t('today.empty')}</p></Karte>
  }
  const rooms = mitZimmern.flatMap(h => h.rooms)
  const fertig = (z: MeinZimmer): boolean => z.status !== 'open' && z.inspection !== 'rework'
  const erledigt = rooms.filter(fertig).length
  const minutes = mitZimmern.reduce((s, h) => s + h.minutes, 0)
  return <div className="space-y-3">
    <div className="flex items-baseline justify-between text-base">
      <span className="font-medium">{t('today.progress', { done: erledigt, total: rooms.length })}</span>
      <span className="text-neutral-600">{t('today.minutes', { minutes })}</span>
    </div>
    <div className="h-2 bg-neutral-200 rounded-full overflow-hidden" aria-hidden>
      <div className="h-full bg-green-600 transition-all"
           style={{ width: `${Math.round(erledigt / rooms.length * 100)}%` }} />
    </div>
    {mitZimmern.map(h => <HausListe key={h.propertyId} haus={h} locale={locale}
                                    ueberschrift={mitZimmern.length > 1} />)}
  </div>
}

function HausListe({ haus, locale, ueberschrift }: {
  haus: Haus; locale: StaffLocale; ueberschrift: boolean
}): JSX.Element {
  const t = usePT()
  const qc = useQueryClient()
  const propertyId = haus.propertyId
  const [offen, setOffen] = useState<number | null>(null)
  const [hinweis, setHinweis] = useState<string | null>(null)

  // Die Antwort eines Hauses ersetzt nur dessen Teil der Liste.
  const uebernehmen = (neu: Tag): void => {
    qc.setQueryData<Alle>(KEY, alt => alt === undefined ? alt : {
      houses: alt.houses.map(h => h.propertyId === propertyId ? { ...h, ...neu } : h)
    })
  }
  const fehler = (e: unknown): void => {
    if (e instanceof ApiError && e.status === 404) {
      setHinweis(t('room.gone'))
      void qc.invalidateQueries({ queryKey: KEY })
    } else {
      setHinweis(fehlerText(e, locale))
    }
  }
  const fertigMit = (neu: Tag): void => { uebernehmen(neu); setOffen(null); setHinweis(null) }
  const nachgearbeitet = useMutation({
    mutationFn: (taskId: number) =>
      api.post<Tag>(`/v1/properties/${propertyId}/my-rooms/${taskId}/reworked`),
    onSuccess: fertigMit,
    onError: fehler
  })
  const wasser = useMutation({
    mutationFn: (taskId: number) =>
      api.post<Tag>(`/v1/properties/${propertyId}/my-rooms/${taskId}/water`),
    onSuccess: fertigMit,
    onError: fehler
  })
  const setzen = useMutation({
    mutationFn: ({ taskId, outcome }: { taskId: number; outcome: Ausgang | null }) =>
      api.post<Tag>(`/v1/properties/${propertyId}/my-rooms/${taskId}`, { outcome }),
    onSuccess: fertigMit,
    onError: fehler
  })

  const fertig = (z: MeinZimmer): boolean => z.status !== 'open' && z.inspection !== 'rework'
  const geordnet = ordneZimmer(haus.rooms)
  const ersteErledigte = geordnet.findIndex(fertig)

  return <section className="space-y-2">
    {ueberschrift && <h2 className="text-base font-semibold pt-2">{haus.name}</h2>}
    {hinweis !== null && <Fehler text={hinweis} />}
    <ul className="space-y-2">
      {geordnet.map((z, i) => <li key={z.taskId}>
        {i === ersteErledigte && <h3 className="text-sm font-semibold text-neutral-500
                                                pt-3 pb-1">{t('today.done')}</h3>}
        <ZimmerKarte z={z} offen={offen === z.taskId}
                     laeuft={setzen.isPending || nachgearbeitet.isPending || wasser.isPending}
                     onNachgearbeitet={() => nachgearbeitet.mutate(z.taskId)}
                     onWasser={() => wasser.mutate(z.taskId)}
                     onToggle={() => setOffen(offen === z.taskId ? null : z.taskId)}
                     onSetzen={outcome => setzen.mutate({ taskId: z.taskId, outcome })}
                     propertyId={propertyId} locale={locale}
                     onGemeldet={uebernehmen} onFehler={fehler} />
      </li>)}
    </ul>
  </section>
}

function Marke({ farbe, children }: { farbe: string; children: React.ReactNode }): JSX.Element {
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${farbe}`}>
    {children}
  </span>
}

function ZimmerKarte({ z, offen, laeuft, onToggle, onSetzen, onNachgearbeitet, onWasser,
                       propertyId, locale, onGemeldet, onFehler }: {
  z: MeinZimmer; offen: boolean; laeuft: boolean; onToggle: () => void
  onNachgearbeitet: () => void; onWasser: () => void
  onSetzen: (o: Ausgang | null) => void; propertyId: number; locale: StaffLocale
  onGemeldet: (neu: Tag) => void; onFehler: (e: unknown) => void
}): JSX.Element {
  const t = usePT()
  const nacharbeit = z.inspection === 'rework'
  const fertig = z.status !== 'open' && !nacharbeit
  const [melden, setMelden] = useState(false)
  const wasserOffen = z.waiver?.water === true && !z.waiver.delivered

  return <div className={`rounded-lg border bg-white ${nacharbeit ? 'border-red-400 border-2'
                           : fertig ? 'border-neutral-200 opacity-80'
                           : !z.free ? 'border-amber-300' : 'border-neutral-300'}`}>
    <button type="button" onClick={onToggle} aria-expanded={offen}
            className="w-full text-left px-4 py-3 flex items-center gap-3">
      <span className={`text-2xl font-semibold tabular-nums min-w-[3.5rem]
                        ${fertig ? 'text-neutral-400 line-through' : ''}`}>{z.code}</span>
      <span className="flex flex-wrap gap-1.5 flex-1">
        <Marke farbe={z.areaId != null ? 'bg-neutral-100 text-neutral-800'
                      : z.kind === 'departure' ? 'bg-blue-100 text-blue-900'
                      : 'bg-neutral-100 text-neutral-800'}>
          {t(z.areaId != null ? 'room.area'
             : z.kind === 'departure' ? 'room.departure' : 'room.stayover')}
        </Marke>
        {!fertig && z.kind === 'departure' && z.areaId == null && (z.free
          ? <Marke farbe="bg-green-100 text-green-900">{t('room.free')}</Marke>
          : <Marke farbe="bg-amber-100 text-amber-900">{t('room.waiting')}</Marke>)}
        {!fertig && z.arrivalToday
          && <Marke farbe="bg-purple-100 text-purple-900">{t('room.arrival')}</Marke>}
        {z.waiver != null && !fertig
          && <Marke farbe="bg-amber-100 text-amber-900">{t('room.waived')}</Marke>}
        {wasserOffen && <Marke farbe="bg-sky-100 text-sky-900">{t('room.water')}</Marke>}
        {z.waiver?.delivered === true
          && <Marke farbe="bg-green-100 text-green-900">{t('room.waterDelivered')}</Marke>}
        {z.openProblems > 0
          && <Marke farbe="bg-red-100 text-red-900">{t('room.problems', { n: z.openProblems })}</Marke>}
        {fertig && z.outcome !== null
          && <Marke farbe="bg-green-100 text-green-900">{t(`outcome.${z.outcome}`)}</Marke>}
        {fertig && z.inspection === 'passed'
          && <Marke farbe="bg-green-600 text-white">{t('inspect.passed')}</Marke>}
        {nacharbeit && <Marke farbe="bg-red-600 text-white">{t('inspect.rework')}</Marke>}
      </span>
      {z.minutes !== null && <span className="text-sm text-neutral-500 whitespace-nowrap">
        {t('room.minutes', { minutes: z.minutes })}</span>}
    </button>
    {/* In der Sprache der Kraft, sobald uebersetzt; das Original darunter,
        damit sie es der Hausdame zeigen kann. */}
    {nacharbeit && z.inspectionNote !== null && <div className="px-4 pb-3 -mt-1">
      <p className="text-base text-red-900">„{z.inspectionNoteTranslated ?? z.inspectionNote}“</p>
      {z.inspectionNoteTranslated != null
        && <p className="text-sm text-neutral-500">{t('room.original')}: {z.inspectionNote}</p>}
    </div>}
    {offen && <div className="px-4 pb-4 space-y-2">
      {nacharbeit && <button type="button" disabled={laeuft} className={KNOPF}
                             onClick={onNachgearbeitet}>{t('inspect.reworked')}</button>}
      {/* Verzicht mit Wasser: die Flasche ist die Aufgabe, nicht die Reinigung. */}
      {wasserOffen && !nacharbeit && <button type="button" disabled={laeuft} className={KNOPF}
                                             onClick={onWasser}>{t('room.waterDone')}</button>}
      {!fertig && !nacharbeit && <>
        <button type="button" disabled={laeuft}
                className={wasserOffen ? KNOPF_LEISE : KNOPF}
                onClick={() => onSetzen('cleaned')}>{t('outcome.cleaned')}</button>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={laeuft} className={`${KNOPF_LEISE} text-sm`}
                  onClick={() => onSetzen('declined')}>{t('outcome.declined')}</button>
          <button type="button" disabled={laeuft} className={`${KNOPF_LEISE} text-sm`}
                  onClick={() => onSetzen('was_clean')}>{t('outcome.was_clean')}</button>
        </div>
      </>}
      {fertig && <button type="button" disabled={laeuft} className={KNOPF_LEISE}
                         onClick={() => onSetzen(null)}>{t('room.undo')}</button>}
      {melden
        ? <Melden taskId={z.taskId} propertyId={propertyId} locale={locale}
                  onFertig={neu => { setMelden(false); onGemeldet(neu) }}
                  onAbbrechen={() => setMelden(false)} onFehler={onFehler} />
        : <button type="button" className={`${KNOPF_LEISE} text-red-800`}
                  onClick={() => setMelden(true)}>{t('problem.report')}</button>}
    </div>}
  </div>
}

function Melden({ taskId, propertyId, onFertig, onAbbrechen, onFehler }: {
  taskId: number; propertyId: number; locale: StaffLocale
  onFertig: (neu: Tag) => void; onAbbrechen: () => void; onFehler: (e: unknown) => void
}): JSX.Element {
  const t = usePT()
  const [text, setText] = useState('')
  const [gesendet, setGesendet] = useState(false)
  const senden = useMutation({
    mutationFn: () => api.post<Tag>(
      `/v1/properties/${propertyId}/my-rooms/${taskId}/problem`, { text }),
    onSuccess: neu => { setGesendet(true); setTimeout(() => onFertig(neu), 1200) },
    onError: onFehler
  })
  if (gesendet) return <p role="status" className="text-base text-green-800">{t('problem.sent')}</p>
  return <form className="space-y-2" onSubmit={e => { e.preventDefault(); senden.mutate() }}>
    <label className="block">
      <span className="block text-sm text-neutral-600">{t('problem.hint')}</span>
      <textarea required maxLength={1000} rows={3} value={text}
                onChange={e => setText(e.target.value)} className={FELD} />
    </label>
    <div className="grid grid-cols-2 gap-2">
      <button type="button" className={KNOPF_LEISE} onClick={onAbbrechen}>
        {t('problem.cancel')}</button>
      <button type="submit" className={KNOPF}
              disabled={senden.isPending || text.trim() === ''}>{t('problem.send')}</button>
    </div>
  </form>
}
