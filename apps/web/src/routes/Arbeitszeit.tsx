import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useT, useLocale, formatDate, weekdayShort } from '../lib/i18n/index.js'
import { api } from '../lib/api.js'
import { addDays, today } from '../lib/dates.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { haelften, hm, type Eintrag, type Monat as KraftMonat } from '../lib/arbeitszeit.js'
import { AltdatenPersonal } from './AltdatenPersonal.tsx'

/**
 * Arbeitszeit (Aufgabe 18, Baustein 6) -- fuer die Leitung.
 *
 * Zwei Ansichten wie in der alten App (Sven, 10.10.2026):
 *
 * - **Tag**: je Kraft die Abreise- und Bleiberzimmer und die Zusatzarbeiten
 *   eines Tages. Hier passt die Leitung eine falsch eingetragene Zeit an
 *   oder nimmt eine Zusatzarbeit heraus.
 * - **Monat**: alle Kraefte mit Summen, oder eine Kraft Tag fuer Tag. Je
 *   mit den Summen 1.–15. und 16.–Monatsende, weil die Zeitarbeitsfirma
 *   halbmonatlich bezahlt wird. Dort auch Abschluss, Ausgabe und Korrektur
 *   mit Grund.
 *
 * Die Hausdame sieht diesen Bildschirm nicht -- Arbeitszeit ist
 * Personaldatum.
 */

interface Summen { rooms: number; extra: number; kitchen: number; correction: number
                   total: number }
interface Uebersicht {
  month: string
  closed: { closedAt: string; closedBy: string | null } | null
  staff: Array<{ userId: number; name: string; username: string | null
                 days: Record<string, number>; totals: Summen
                 /** Monatssumme in anderen Haeusern, die die Leitung fuehrt (0116). */
                 elsewhere?: Array<{ propertyId: number; name: string; total: number }> }>
}

interface ZimmerDesTags {
  taskId: number; code: string; kind: 'departure' | 'stayover' | 'deep_clean' | 'inspection'
  minutes: number; status: 'open' | 'done' | 'skipped'
  outcome: 'cleaned' | 'declined' | 'was_clean' | null
}
interface TagAllerKraefte {
  date: string; closed: boolean
  staff: Array<{ userId: number; name: string; username: string | null
                 rooms: ZimmerDesTags[]; entries: Eintrag[]
                 totals: { departure: number; stayover: number; otherRooms: number; extra: number
                           kitchen: number; correction: number; total: number } }>
}

const REITER = 'px-3 py-1.5 text-sm border border-neutral-300 first:rounded-l last:rounded-r -ml-px'

export function Arbeitszeit({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const [ansicht, setAnsicht] = useState<'tag' | 'monat'>('tag')
  const [datum, setDatum] = useState(today())
  const [monat, setMonat] = useState(today().slice(0, 7))
  const [kraft, setKraft] = useState<number | null>(null)

  return <div className="space-y-4">
    <div className="flex" role="tablist">
      {(['tag', 'monat'] as const).map(a =>
        <button key={a} type="button" role="tab" aria-selected={ansicht === a}
                onClick={() => setAnsicht(a)}
                className={`${REITER} ${ansicht === a ? 'bg-neutral-900 text-white border-neutral-900'
                                                     : 'bg-white'}`}>
          {t(a === 'tag' ? 'worktime.viewDay' : 'worktime.viewMonth')}</button>)}
    </div>
    {ansicht === 'tag'
      ? <TagesAnsicht propertyId={propertyId} datum={datum} setDatum={setDatum} />
      : <MonatsAnsicht propertyId={propertyId} monat={monat} kraft={kraft}
                       setMonat={m => { setMonat(m); setKraft(null) }} setKraft={setKraft}
                       zumTag={d => { setDatum(d); setAnsicht('tag') }} />}
  </div>
}

// ---------------------------------------------------------------- Tag

function TagesAnsicht({ propertyId, datum, setDatum }: {
  propertyId: number; datum: string; setDatum: (d: string) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const qc = useQueryClient()
  const key = ['worktime-day', propertyId, datum]
  const q = useQuery<TagAllerKraefte>({
    queryKey: key,
    queryFn: () => api.get(`/v1/properties/${propertyId}/worktime/day?date=${datum}`)
  })
  // Eine Aenderung am Tag aendert auch die Monatssummen.
  const neu = (d: TagAllerKraefte): void => {
    qc.setQueryData(key, d)
    void qc.invalidateQueries({ queryKey: ['worktime', propertyId] })
    void qc.invalidateQueries({ queryKey: ['worktime-person', propertyId] })
  }
  const heute = today()

  return <div className="space-y-4">
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-sm">
        <span className="block text-neutral-600">{t('worktime.date')}</span>
        <input type="date" value={datum} max={heute}
               onChange={e => { if (e.target.value !== '') setDatum(e.target.value) }}
               className="border border-neutral-300 rounded px-2 py-1" />
      </label>
      <button type="button" aria-label={t('worktime.prevDay')} onClick={() => setDatum(addDays(datum, -1))}
              className="px-3 py-1 rounded border border-neutral-300">‹</button>
      <button type="button" aria-label={t('worktime.nextDay')} disabled={datum >= heute}
              onClick={() => setDatum(addDays(datum, 1))}
              className="px-3 py-1 rounded border border-neutral-300 disabled:text-neutral-300">›</button>
      {datum !== heute && <button type="button" onClick={() => setDatum(heute)}
              className="px-3 py-1 rounded border border-neutral-300">{t('worktime.today')}</button>}
      <span className="text-sm text-neutral-500 pb-1">
        {weekdayShort(datum, locale)} {formatDate(datum, locale)}</span>
    </div>
    {q.isError && q.data === undefined ? <Fehler error={q.error} />
      : q.data === undefined ? <Laedt />
      : <>
        {q.data.closed && <p className="text-sm text-amber-800">{t('worktime.dayClosed')}</p>}
        {q.data.staff.length === 0
          ? <p className="text-sm text-neutral-500">{t('worktime.dayEmpty')}</p>
          : q.data.staff.map(k => <KraftTag key={k.userId} propertyId={propertyId} kraft={k}
                                            offen={!q.data.closed} onNeu={neu} />)}
      </>}
  </div>
}

function KraftTag({ propertyId, kraft: k, offen, onNeu }: {
  propertyId: number; kraft: TagAllerKraefte['staff'][number]; offen: boolean
  onNeu: (d: TagAllerKraefte) => void
}): JSX.Element {
  const t = useT()
  const abreise = k.rooms.filter(z => z.kind === 'departure')
  const bleiber = k.rooms.filter(z => z.kind === 'stayover')
  const weitere = k.rooms.filter(z => z.kind !== 'departure' && z.kind !== 'stayover')
  const arbeiten = k.entries
  const zusatz = k.totals.extra + k.totals.kitchen + k.totals.correction

  return <section className="border border-neutral-200 rounded-lg p-4 space-y-4 bg-white">
    <header className="flex items-center justify-between border-b border-neutral-100 pb-2">
      <h3 className="font-semibold">{k.name}
        {k.username !== null && <span className="ml-2 text-sm font-normal text-neutral-400">
          {k.username}</span>}</h3>
      <span className="rounded-full bg-neutral-900 text-white text-sm px-3 py-0.5 tabular-nums">
        {hm(k.totals.total)}</span>
    </header>
    <div className="grid gap-3 md:grid-cols-2">
      <ZimmerFeld titel={t('worktime.departures')} farbe="border-red-400" zimmer={abreise} />
      <ZimmerFeld titel={t('worktime.stayovers')} farbe="border-sky-400" zimmer={bleiber} />
      {weitere.length > 0
        && <ZimmerFeld titel={t('worktime.otherRooms')} farbe="border-neutral-400" zimmer={weitere} />}
    </div>
    {arbeiten.length > 0 && <div className="border border-neutral-200 rounded">
      <div className="flex justify-between bg-neutral-50 px-3 py-2 text-sm font-medium">
        <span>{t('worktime.extraWork')}</span>
        <span className="tabular-nums">{arbeiten.filter(e => !e.withdrawn).length}</span>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-neutral-500">
          <tr className="border-b border-neutral-100">
            <th className="px-3 py-1.5 font-medium">{t('worktime.description')}</th>
            <th className="px-3 py-1.5 font-medium text-right">{t('worktime.time')}</th>
            <th className="px-3 py-1.5"><span className="sr-only">{t('worktime.editTime')}</span></th>
          </tr>
        </thead>
        <tbody>
          {arbeiten.map(e => <ArbeitZeile key={e.id} propertyId={propertyId} eintrag={e}
                                          offen={offen} onNeu={onNeu} />)}
        </tbody>
      </table>
    </div>}
    <footer className="flex flex-wrap justify-between gap-x-6 gap-y-1 rounded bg-emerald-50
                       px-3 py-2 text-sm tabular-nums">
      <span>{t('worktime.sumDepartures')}: {hm(k.totals.departure)}</span>
      <span>{t('worktime.sumStayovers')}: {hm(k.totals.stayover)}</span>
      {k.totals.otherRooms > 0 && <span>{t('worktime.sumOther')}: {hm(k.totals.otherRooms)}</span>}
      <span>{t('worktime.sumExtra')}: {hm(zusatz)}</span>
      <span className="font-semibold">{t('worktime.total')}: {hm(k.totals.total)}</span>
    </footer>
  </section>
}

function ZimmerFeld({ titel, farbe, zimmer }: {
  titel: string; farbe: string; zimmer: ZimmerDesTags[]
}): JSX.Element {
  const t = useT()
  return <div className={`rounded bg-neutral-50 border-l-4 ${farbe} p-3`}>
    <h4 className="text-sm font-medium mb-2">{titel}</h4>
    {zimmer.length === 0
      ? <p className="text-sm text-neutral-400">{t('worktime.noRooms')}</p>
      : <ul className="flex flex-wrap gap-2">
        {zimmer.map(z => {
          const gereinigt = z.outcome === 'cleaned'
          const zustand = z.outcome ?? 'open'
          return <li key={z.taskId} title={t(`worktime.room.${zustand}`)}
                     className={`rounded border px-2 py-1 text-sm tabular-nums ${gereinigt
                       ? 'border-emerald-300 bg-emerald-100'
                       : 'border-neutral-300 bg-white text-neutral-500'}`}>
            <span className="font-medium">{z.code}</span>
            <span className="mx-1" aria-hidden="true">
              {gereinigt ? '✓' : z.outcome === null ? '○' : '⊘'}</span>
            <span className="sr-only">{t(`worktime.room.${zustand}`)}</span>
            <span className="text-xs">({gereinigt ? z.minutes : 0} min)</span>
          </li>
        })}
      </ul>}
  </div>
}

/**
 * Eine Zusatzarbeit, ein Kuechendienst oder eine Korrektur. Anpassen geht
 * nur bei Zusatzarbeiten (Kueche hat Beginn und Ende), herausnehmen bei
 * beiden; Korrekturen stehen nur da.
 */
function ArbeitZeile({ propertyId, eintrag: e, offen, onNeu }: {
  propertyId: number; eintrag: Eintrag; offen: boolean; onNeu: (d: TagAllerKraefte) => void
}): JSX.Element {
  const t = useT()
  const [minuten, setMinuten] = useState<string | null>(null)
  const [sicher, setSicher] = useState(false)
  const pfad = `/v1/properties/${propertyId}/worktime/entries/${e.id}`
  const anpassen = useMutation({
    mutationFn: (m: number) => api.put<TagAllerKraefte>(pfad, { minutes: m }),
    onSuccess: d => { setMinuten(null); onNeu(d) }
  })
  const herausnehmen = useMutation({
    mutationFn: () => api.post<TagAllerKraefte>(`${pfad}/withdraw`),
    onSuccess: d => { setSicher(false); onNeu(d) }
  })
  const aktiv = offen && !e.withdrawn && e.kind !== 'correction'

  return <tr className="border-b border-neutral-100 last:border-0 align-top">
    <td className={`px-3 py-1.5 ${e.withdrawn ? 'text-neutral-400' : ''}`}>
      <span className={e.withdrawn ? 'line-through' : ''}>
        {e.kind === 'kitchen' && `${t('worktime.kitchen')} ${e.start}–${e.end}`}
        {e.kind === 'extra' && e.description}
        {e.kind === 'correction' && <span className="text-amber-800">
          {t('worktime.correction')}: {e.description}</span>}
      </span>
      {e.kind !== 'correction' && e.description !== null && !e.withdrawn
        && <Uebersetzung eintrag={e} propertyId={propertyId} />}
      {e.originalMinutes !== null && <span className="block text-xs text-amber-800">
        {t('worktime.adjusted', { name: e.adjustedBy ?? '–', time: hm(e.originalMinutes) })}</span>}
      {e.withdrawn && <span className="block text-xs">
        {e.withdrawnBy !== null ? t('worktime.withdrawnBy', { name: e.withdrawnBy })
                                : t('worktime.withdrawn')}</span>}
      {(anpassen.isError || herausnehmen.isError)
        && <Fehler error={anpassen.error ?? herausnehmen.error} />}
    </td>
    <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">
      {minuten === null
        ? <span className={e.withdrawn ? 'line-through text-neutral-400' : ''}>{hm(e.minutes)}</span>
        : <form className="inline-flex gap-1" onSubmit={ev => {
            ev.preventDefault(); anpassen.mutate(Number(minuten))
          }}>
            <input type="number" autoFocus required min={1} max={1440} value={minuten}
                   aria-label={t('worktime.minutes')} onChange={ev => setMinuten(ev.target.value)}
                   className="border border-neutral-300 rounded px-1 py-0.5 w-20 text-right" />
            <span className="self-center text-neutral-500">min</span>
            <button type="submit" disabled={anpassen.isPending || minuten === ''
                                            || Number(minuten) < 1}
                    className="px-2 py-0.5 rounded bg-neutral-900 text-white disabled:bg-neutral-300">
              {t('worktime.saveTime')}</button>
            <button type="button" onClick={() => setMinuten(null)}
                    className="px-2 py-0.5 text-neutral-500">{t('worktime.cancel')}</button>
          </form>}
    </td>
    <td className="px-3 py-1.5 text-right whitespace-nowrap">
      {aktiv && minuten === null && <span className="inline-flex gap-2">
        {e.kind === 'extra' && <button type="button" onClick={() => setMinuten(String(e.minutes))}
                className="px-2 py-0.5 rounded border border-neutral-300">{t('worktime.editTime')}</button>}
        {sicher
          ? <>
            <button type="button" disabled={herausnehmen.isPending}
                    onClick={() => herausnehmen.mutate()}
                    className="px-2 py-0.5 rounded bg-red-700 text-white">
              {t('worktime.removeConfirm')}</button>
            <button type="button" onClick={() => setSicher(false)}
                    className="px-2 py-0.5 text-neutral-500">{t('worktime.cancel')}</button>
          </>
          : <button type="button" aria-label={t('worktime.remove')} title={t('worktime.remove')}
                    onClick={() => setSicher(true)}
                    className="px-2 py-0.5 text-red-700">×</button>}
      </span>}
    </td>
  </tr>
}

// ---------------------------------------------------------------- Monat

function MonatsAnsicht({ propertyId, monat, kraft, setMonat, setKraft, zumTag }: {
  propertyId: number; monat: string; kraft: number | null
  setMonat: (m: string) => void; setKraft: (k: number | null) => void
  zumTag: (d: string) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const qc = useQueryClient()
  const [grund, setGrund] = useState<string | null>(null)
  const key = ['worktime', propertyId, monat]
  const q = useQuery<Uebersicht>({
    queryKey: key,
    queryFn: () => api.get(`/v1/properties/${propertyId}/worktime?month=${monat}`)
  })
  const abschluss = useMutation({
    mutationFn: (a: { zu: boolean; reason?: string }) => api.post<Uebersicht>(
      `/v1/properties/${propertyId}/worktime/${a.zu ? 'close' : 'reopen'}`,
      { month: monat, reason: a.reason }),
    onSuccess: u => {
      qc.setQueryData(key, u)
      setGrund(null)
      void qc.invalidateQueries({ queryKey: ['worktime-person', propertyId] })
      void qc.invalidateQueries({ queryKey: ['worktime-day', propertyId] })
    }
  })

  if (q.isError && q.data === undefined) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const u = q.data
  const zeilen = u.staff.filter(k => k.totals.total !== 0 || Object.keys(k.days).length > 0)
  const letzter = letzterTag(monat)
  const gewaehlt = u.staff.find(k => k.userId === kraft)

  return <div className="space-y-4">
    <p className="text-sm text-neutral-600 max-w-prose">{t('worktime.hint')}</p>
    <div className="flex flex-wrap items-end gap-4">
      <label className="text-sm">
        <span className="block text-neutral-600">{t('worktime.month')}</span>
        <input type="month" value={monat} max={today().slice(0, 7)}
               onChange={e => { if (e.target.value !== '') setMonat(e.target.value) }}
               className="border border-neutral-300 rounded px-2 py-1" />
      </label>
      <label className="text-sm">
        <span className="block text-neutral-600">{t('worktime.employee')}</span>
        <select value={kraft ?? ''} onChange={e => setKraft(e.target.value === '' ? null
                                                                          : Number(e.target.value))}
                className="border border-neutral-300 rounded px-2 py-1 min-w-48">
          <option value="">{t('worktime.allStaff')}</option>
          {u.staff.map(k => <option key={k.userId} value={k.userId}>{k.name}</option>)}
        </select>
      </label>
      {u.closed === null
        ? <div className="text-sm">
            <button type="button" disabled={abschluss.isPending}
                    onClick={() => abschluss.mutate({ zu: true })}
                    className="px-3 py-1.5 rounded bg-neutral-900 text-white disabled:bg-neutral-300">
              {t('worktime.close')}</button>
            <span className="ml-3 text-neutral-500">{t('worktime.closeHint')}</span>
          </div>
        : <div className="text-sm flex flex-wrap items-center gap-3">
            <span>{t('worktime.closedBy', { date: formatDate(u.closed.closedAt.slice(0, 10), locale),
                                            name: u.closed.closedBy ?? '–' })}</span>
            <a href={`/v1/properties/${propertyId}/worktime/export?month=${monat}`}
               className="px-3 py-1.5 rounded bg-neutral-900 text-white">{t('worktime.export')}</a>
            {grund === null
              ? <button type="button" onClick={() => setGrund('')}
                        className="px-3 py-1.5 rounded border border-neutral-300">
                  {t('worktime.reopen')}</button>
              : <form className="inline-flex gap-2" onSubmit={e => {
                  e.preventDefault(); abschluss.mutate({ zu: false, reason: grund.trim() })
                }}>
                  <input autoFocus required maxLength={500} value={grund}
                         placeholder={t('worktime.reopenReason')}
                         onChange={e => setGrund(e.target.value)}
                         className="border border-neutral-300 rounded px-2 py-1 w-64" />
                  <button type="submit" disabled={abschluss.isPending || grund.trim() === ''}
                          className="px-3 py-1.5 rounded border border-neutral-300">
                    {t('worktime.reopen')}</button>
                </form>}
          </div>}
    </div>
    {u.closed === null && <p className="text-xs text-neutral-500">{t('worktime.exportHint')}</p>}
    {abschluss.isError && <Fehler error={abschluss.error} />}

    {gewaehlt !== undefined
      ? <KraftMonatAnsicht propertyId={propertyId} userId={gewaehlt.userId} name={gewaehlt.name}
                           monat={monat} offen={u.closed === null} zumTag={zumTag}
                           onKorrigiert={() => {
                             void qc.invalidateQueries({ queryKey: key })
                             void qc.invalidateQueries({ queryKey: ['worktime-day', propertyId] })
                           }} />
      : zeilen.length === 0
      ? <p className="text-sm text-neutral-500">{t('worktime.empty')}</p>
      : <div className="overflow-x-auto"><table className="w-full text-sm border-collapse">
        <thead className="text-left text-neutral-500 border-b border-neutral-200">
          <tr>
            <th className="py-2 pr-3 font-medium">{t('worktime.name')}</th>
            <th className="py-2 pr-3 font-medium text-right">{t('worktime.firstHalf')}</th>
            <th className="py-2 pr-3 font-medium text-right">
              {t('worktime.secondHalf', { last: letzter })}</th>
            {(['worktime.rooms', 'worktime.extra', 'worktime.kitchen', 'worktime.correction',
               'worktime.total'] as const).map(k =>
              <th key={k} className="py-2 pr-3 font-medium text-right">{t(k)}</th>)}
          </tr>
        </thead>
        <tbody>
          {zeilen.map(k => {
            const [erste, zweite] = haelften(monat, k.days)
            return <tr key={k.userId} onClick={() => setKraft(k.userId)}
                       className="border-b border-neutral-100 cursor-pointer hover:bg-neutral-50">
              <td className="py-2 pr-3">
                <button type="button" className="text-left hover:underline">{k.name}</button>
                {k.username !== null && <span className="ml-2 text-neutral-400">{k.username}</span>}
                {(k.elsewhere ?? []).length > 0 && <span className="block text-xs text-neutral-500">
                  {k.elsewhere!.map(h => t('worktime.elsewhere', { house: h.name, time: hm(h.total) }))
                    .join(' · ')}
                  {' · '}
                  {t('worktime.allHouses', { time: hm(k.totals.total
                    + k.elsewhere!.reduce((s, h) => s + h.total, 0)) })}
                </span>}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{hm(erste)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{hm(zweite)}</td>
              {([k.totals.rooms, k.totals.extra, k.totals.kitchen, k.totals.correction] as const)
                .map((v, i) => <td key={i} className="py-2 pr-3 text-right tabular-nums text-neutral-600">
                  {v === 0 ? '–' : hm(v)}</td>)}
              <td className="py-2 pr-3 text-right tabular-nums font-semibold">{hm(k.totals.total)}</td>
            </tr>
          })}
        </tbody>
      </table></div>}
    {gewaehlt === undefined && zeilen.length > 0
      && <p className="text-xs text-neutral-500">{t('worktime.halvesHint')}</p>}

    <details className="border-t border-neutral-200 pt-3">
      <summary className="cursor-pointer text-sm font-medium">{t('worktime.legacy.title')}</summary>
      <div className="mt-3"><AltdatenPersonal propertyId={propertyId} /></div>
    </details>
  </div>
}

/** Der letzte Tag eines Monats als Zahl, ohne `Date` in Ortszeit. */
function letzterTag(month: string): number {
  const [j, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(j, m, 0)).getUTCDate()
}

/** Was an einem Tag nicht Zimmer ist, nach Art -- zurueckgezogene zaehlen nicht. */
function nachArt(entries: Eintrag[]): { extra: number; kitchen: number; correction: number } {
  const s = { extra: 0, kitchen: 0, correction: 0 }
  for (const e of entries) if (!e.withdrawn) s[e.kind] += e.minutes
  return s
}

function KraftMonatAnsicht({ propertyId, userId, name, monat, offen, zumTag, onKorrigiert }: {
  propertyId: number; userId: number; name: string; monat: string; offen: boolean
  zumTag: (d: string) => void; onKorrigiert: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const qc = useQueryClient()
  const key = ['worktime-person', propertyId, userId, monat]
  const q = useQuery<Omit<KraftMonat, 'today'>>({
    queryKey: key,
    queryFn: () => api.get(`/v1/properties/${propertyId}/worktime/${userId}?month=${monat}`)
  })
  const [tag, setTag] = useState(`${monat}-01`)
  const [minuten, setMinuten] = useState('')
  const [grund, setGrund] = useState('')
  const korrigieren = useMutation({
    mutationFn: () => api.post<Omit<KraftMonat, 'today'>>(
      `/v1/properties/${propertyId}/worktime/corrections`,
      { userId, date: tag, minutes: Number(minuten), reason: grund.trim() }),
    onSuccess: m => {
      qc.setQueryData(key, m); setMinuten(''); setGrund(''); onKorrigiert()
    }
  })
  if (q.isError && q.data === undefined) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const m = q.data
  const mitKueche = m.totals.kitchen !== 0
  const mitKorrektur = m.totals.correction !== 0
  const letzter = letzterTag(monat)

  return <div className="space-y-4">
    <p className="text-sm text-neutral-500"><span className="font-medium text-neutral-800">{name}</span>
      {' · '}{formatDate(m.days[0]!.date, locale)} – {formatDate(m.days.at(-1)!.date, locale)}</p>
    <div className="grid gap-4 lg:grid-cols-[1fr_16rem] items-start">
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead className="text-left text-neutral-500 bg-neutral-50">
          <tr>
            <th className="px-2 py-1.5 font-medium">{t('worktime.date')}</th>
            <th className="px-2 py-1.5 font-medium text-right">{t('worktime.rooms')}</th>
            <th className="px-2 py-1.5 font-medium text-right">{t('worktime.extra')}</th>
            {mitKueche && <th className="px-2 py-1.5 font-medium text-right">{t('worktime.kitchen')}</th>}
            {mitKorrektur
              && <th className="px-2 py-1.5 font-medium text-right">{t('worktime.correction')}</th>}
            <th className="px-2 py-1.5 font-medium text-right">{t('worktime.total')}</th>
          </tr>
        </thead>
        <tbody>
          {m.days.map(d => {
            const a = nachArt(d.entries)
            const leer = d.total === 0 && d.entries.length === 0 && d.rooms === 0
            return <tr key={d.date} onClick={() => zumTag(d.date)} title={t('worktime.openDay')}
                       className={`border-b border-neutral-100 cursor-pointer hover:bg-neutral-50
                                   tabular-nums ${leer ? 'text-neutral-400' : ''}
                                   ${d.date.endsWith('-15') ? 'border-b-2 border-b-neutral-300' : ''}`}>
              <td className="px-2 py-1">
                <span className="inline-block w-8 text-neutral-400">{weekdayShort(d.date, locale)}</span>
                {formatDate(d.date, locale)}</td>
              <td className="px-2 py-1 text-right">{hm(d.roomMinutes)}</td>
              <td className="px-2 py-1 text-right">{hm(a.extra)}</td>
              {mitKueche && <td className="px-2 py-1 text-right">{hm(a.kitchen)}</td>}
              {mitKorrektur && <td className="px-2 py-1 text-right">{hm(a.correction)}</td>}
              <td className="px-2 py-1 text-right font-medium">{hm(d.total)}</td>
            </tr>
          })}
        </tbody>
      </table></div>
      <aside className="border border-neutral-200 rounded-lg p-3 space-y-2 bg-neutral-50">
        <h3 className="text-sm font-medium">{t('worktime.summary')}</h3>
        {([[t('worktime.monthTotal'), m.totals.total],
           [t('worktime.firstHalf'), m.halves[0].total],
           [t('worktime.secondHalf', { last: letzter }), m.halves[1].total]] as const)
          .map(([titel, wert]) => <div key={titel} className="bg-white border border-neutral-200 rounded px-3 py-2">
            <div className="text-xs text-neutral-500">{titel}</div>
            <div className="text-xl font-semibold tabular-nums">{hm(wert)}</div>
          </div>)}
        <p className="text-xs text-neutral-500">{t('worktime.halvesHint')}</p>
      </aside>
    </div>
    {offen && <form className="flex flex-wrap items-end gap-2 text-sm" onSubmit={e => {
      e.preventDefault(); korrigieren.mutate()
    }}>
      <span className="w-full font-medium">{t('worktime.correctionTitle')}</span>
      <label><span className="block text-neutral-600">{t('worktime.day')}</span>
        <input type="date" required value={tag} min={`${monat}-01`} max={m.days.at(-1)?.date}
               onChange={e => setTag(e.target.value)}
               className="border border-neutral-300 rounded px-2 py-1" /></label>
      <label><span className="block text-neutral-600">{t('worktime.minutesSigned')}</span>
        <input type="number" required min={-1440} max={1440} value={minuten}
               onChange={e => setMinuten(e.target.value)}
               className="border border-neutral-300 rounded px-2 py-1 w-28" /></label>
      <label className="flex-1 min-w-48"><span className="block text-neutral-600">
        {t('worktime.reason')}</span>
        <input type="text" required maxLength={500} value={grund}
               onChange={e => setGrund(e.target.value)}
               className="border border-neutral-300 rounded px-2 py-1 w-full" /></label>
      <button type="submit" disabled={korrigieren.isPending || minuten === '' || Number(minuten) === 0}
              className="px-3 py-1.5 rounded bg-neutral-900 text-white disabled:bg-neutral-300">
        {t('worktime.save')}</button>
    </form>}
    {korrigieren.isError && <Fehler error={korrigieren.error} />}
  </div>
}

/**
 * Deutsch neben dem Text der Kraft (0112), mit Berichtigung von Hand. DeepL
 * kennt die Woerter des Hauses nicht; wer abrechnet, soll lesen, was gemeint
 * war. Zurueck an DeepL geht es mit "automatisch".
 */
function Uebersetzung({ eintrag, propertyId }: {
  eintrag: Eintrag; propertyId: number
}): JSX.Element | null {
  const t = useT()
  const qc = useQueryClient()
  const [text, setText] = useState<string | null>(null)
  const speichern = useMutation({
    mutationFn: (neu: string | null) => api.put(
      `/v1/properties/${propertyId}/worktime/entries/${eintrag.id}/translation`, { text: neu }),
    onSuccess: () => {
      setText(null)
      void qc.invalidateQueries({ queryKey: ['worktime-day', propertyId] })
    }
  })
  if (text !== null) {
    return <form className="flex gap-2 mt-1 no-underline" onSubmit={e => {
      e.preventDefault(); speichern.mutate(text.trim())
    }}>
      <input autoFocus required maxLength={500} value={text} onChange={e => setText(e.target.value)}
             className="border border-neutral-300 rounded px-2 py-0.5 flex-1" />
      <button type="submit" disabled={speichern.isPending || text.trim() === ''}
              className="px-2 py-0.5 rounded border border-neutral-300">{t('worktime.save')}</button>
      <button type="button" onClick={() => setText(null)}
              className="px-2 py-0.5 text-neutral-500">{t('worktime.cancel')}</button>
      {speichern.isError && <Fehler error={speichern.error} />}
    </form>
  }
  return <div className="text-xs text-neutral-500">
    {eintrag.translationDe !== null && <span>
      {t('worktime.translationDe')}: {eintrag.translationDe}
      {eintrag.translationManual && <span className="ml-1">({t('worktime.translationManual')})</span>}
    </span>}
    <button type="button" className="ml-2 underline"
            onClick={() => setText(eintrag.translationDe ?? eintrag.description ?? '')}>
      {t('worktime.editTranslation')}</button>
    {eintrag.translationManual
      && <button type="button" className="ml-2 underline" disabled={speichern.isPending}
                 onClick={() => speichern.mutate(null)}>{t('worktime.autoTranslation')}</button>}
  </div>
}
