import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { api } from '../lib/api.js'
import { today } from '../lib/dates.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { hm, type Monat as KraftMonat } from '../lib/arbeitszeit.js'
import { AltdatenPersonal } from './AltdatenPersonal.tsx'

/**
 * Arbeitszeit (Aufgabe 18, Baustein 6) -- fuer die Leitung.
 *
 * Eine Zeile je Kraft mit den Summen nach Art; ein Klick zeigt den Monat
 * der Kraft Tag fuer Tag und nimmt eine Korrektur mit Grund an. Oben der
 * Abschluss und die Ausgabe fuer die Zeitarbeitsfirma. Die Hausdame sieht
 * diesen Bildschirm nicht -- Arbeitszeit ist Personaldatum.
 */

interface Summen { rooms: number; extra: number; kitchen: number; correction: number
                   total: number }
interface Uebersicht {
  month: string
  closed: { closedAt: string; closedBy: string | null } | null
  staff: Array<{ userId: number; name: string; username: string | null
                 days: Record<string, number>; totals: Summen }>
}

export function Arbeitszeit({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const qc = useQueryClient()
  const [monat, setMonat] = useState(today().slice(0, 7))
  const [kraft, setKraft] = useState<number | null>(null)
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
    }
  })

  if (q.isError && q.data === undefined) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const u = q.data
  const zeilen = u.staff.filter(k => k.totals.total !== 0 || Object.keys(k.days).length > 0)

  return <div className="space-y-4">
    <p className="text-sm text-neutral-600 max-w-prose">{t('worktime.hint')}</p>
    <div className="flex flex-wrap items-end gap-4">
      <label className="text-sm">
        <span className="block text-neutral-600">{t('worktime.month')}</span>
        <input type="month" value={monat} max={today().slice(0, 7)}
               onChange={e => { if (e.target.value !== '') { setMonat(e.target.value); setKraft(null) } }}
               className="border border-neutral-300 rounded px-2 py-1" />
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

    {zeilen.length === 0
      ? <p className="text-sm text-neutral-500">{t('worktime.empty')}</p>
      : <table className="w-full text-sm border-collapse">
        <thead className="text-left text-neutral-500 border-b border-neutral-200">
          <tr>
            <th className="py-2 pr-3 font-medium">{t('worktime.name')}</th>
            {(['worktime.rooms', 'worktime.extra', 'worktime.kitchen', 'worktime.correction',
               'worktime.total'] as const).map(k =>
              <th key={k} className="py-2 pr-3 font-medium text-right">{t(k)}</th>)}
          </tr>
        </thead>
        <tbody>
          {zeilen.map(k => <Fragment key={k.userId}>
            <tr onClick={() => setKraft(kraft === k.userId ? null : k.userId)}
                className={`border-b border-neutral-100 cursor-pointer hover:bg-neutral-50
                            ${kraft === k.userId ? 'bg-neutral-50' : ''}`}>
              <td className="py-2 pr-3">{k.name}
                {k.username !== null && <span className="ml-2 text-neutral-400">{k.username}</span>}
              </td>
              {([k.totals.rooms, k.totals.extra, k.totals.kitchen, k.totals.correction] as const)
                .map((v, i) => <td key={i} className="py-2 pr-3 text-right tabular-nums">
                  {v === 0 ? '–' : hm(v)}</td>)}
              <td className="py-2 pr-3 text-right tabular-nums font-semibold">{hm(k.totals.total)}</td>
            </tr>
            {kraft === k.userId && <tr>
              <td colSpan={6} className="p-3 bg-neutral-50">
                <KraftDetail propertyId={propertyId} userId={k.userId} monat={monat}
                             offen={u.closed === null}
                             onKorrigiert={() => void qc.invalidateQueries({ queryKey: key })} />
              </td>
            </tr>}
          </Fragment>)}
        </tbody>
      </table>}

    <details className="border-t border-neutral-200 pt-3">
      <summary className="cursor-pointer text-sm font-medium">{t('worktime.legacy.title')}</summary>
      <div className="mt-3"><AltdatenPersonal propertyId={propertyId} /></div>
    </details>
  </div>
}

function KraftDetail({ propertyId, userId, monat, offen, onKorrigiert }: {
  propertyId: number; userId: number; monat: string; offen: boolean; onKorrigiert: () => void
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
  const tage = q.data.days.filter(d => d.rooms > 0 || d.entries.length > 0)

  return <div className="space-y-3">
    <table className="w-full text-sm">
      <tbody>
        {tage.map(d => <tr key={d.date} className="border-b border-neutral-200 align-top">
          <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(d.date, locale)}</td>
          <td className="py-1.5 pr-3">
            {d.rooms > 0 && <div>{t('worktime.roomsCount', { n: d.rooms })}
              <span className="ml-2 tabular-nums text-neutral-500">{hm(d.roomMinutes)}</span></div>}
            {d.entries.map(e => <div key={e.id}
                className={e.withdrawn ? 'line-through text-neutral-400' : ''}>
              {e.kind === 'kitchen' && `${t('worktime.kitchen')} ${e.start}–${e.end}`}
              {e.kind === 'extra' && `${t('worktime.extra')}: ${e.description ?? ''}`}
              {e.kind === 'correction' && <span className="text-amber-800">
                {t('worktime.correction')}: {e.description}</span>}
              <span className="ml-2 tabular-nums text-neutral-500">{hm(e.minutes)}</span>
              {e.withdrawn && <span className="ml-2">({t('worktime.withdrawn')})</span>}
              {e.kind !== 'correction' && e.description !== null
                && <Uebersetzung eintrag={e} propertyId={propertyId}
                                 onNeu={m => qc.setQueryData(key, m)} />}
            </div>)}
          </td>
          <td className="py-1.5 text-right tabular-nums font-medium">{hm(d.total)}</td>
        </tr>)}
      </tbody>
    </table>
    {offen && <form className="flex flex-wrap items-end gap-2 text-sm" onSubmit={e => {
      e.preventDefault(); korrigieren.mutate()
    }}>
      <label><span className="block text-neutral-600">{t('worktime.day')}</span>
        <input type="date" required value={tag} min={`${monat}-01`} max={q.data.days.at(-1)?.date}
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
function Uebersetzung({ eintrag, propertyId, onNeu }: {
  eintrag: KraftMonat['days'][number]['entries'][number]; propertyId: number
  onNeu: (m: Omit<KraftMonat, 'today'>) => void
}): JSX.Element | null {
  const t = useT()
  const [text, setText] = useState<string | null>(null)
  const speichern = useMutation({
    mutationFn: (neu: string | null) => api.put<Omit<KraftMonat, 'today'>>(
      `/v1/properties/${propertyId}/worktime/entries/${eintrag.id}/translation`, { text: neu }),
    onSuccess: m => { setText(null); onNeu(m) }
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
  return <div className="text-neutral-500">
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
