import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { StaffLocale } from '@hotelpms/contracts'
import { api } from '../lib/api.js'
import { fehlerText, usePT } from './texte.js'
import { FELD, Fehler, KNOPF, KNOPF_LEISE, Karte } from './teile.js'
import { tagName } from './Kueche.js'
import { hm, monatPlus, type Monat } from '../lib/arbeitszeit.js'

/**
 * Meine Arbeitszeit (Baustein 6, Aufgabe 18 in Dokument 16).
 *
 * Keine Stempeluhr: was zaehlt, sind die Minuten der gereinigten Zimmer,
 * dazu Zusatzarbeiten und Kuechendienste, die die Kraft selbst eintraegt,
 * und Korrekturen der Leitung mit Grund. Die Kraft sieht ihren Monat so,
 * wie ihn die Leitung sieht -- dieselbe Zahl, dieselben Zeilen.
 */

export type { Eintrag, Tag, Monat } from '../lib/arbeitszeit.js'

function monatName(month: string, locale: StaffLocale): string {
  const [j, m] = month.split('-').map(Number) as [number, number]
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(j, m - 1, 1)))
}

function gestern(heute: string): string {
  const [j, m, t] = heute.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(j, m - 1, t - 1)).toISOString().slice(0, 10)
}

export function Zeit({ propertyId, locale, kueche }: {
  propertyId: number; locale: StaffLocale; kueche: boolean
}): JSX.Element {
  const t = usePT()
  const qc = useQueryClient()
  const [monat, setMonat] = useState<string | null>(null)
  const key = ['my-time', propertyId, monat]
  const q = useQuery<Monat>({
    queryKey: key,
    queryFn: () => api.get<Monat>(`/v1/properties/${propertyId}/my-time`
      + (monat === null ? '' : `?month=${monat}`)),
    refetchOnWindowFocus: true
  })
  const [fehler, setFehler] = useState<string | null>(null)
  const uebernehmen = (neu: Monat): void => {
    qc.setQueryData(['my-time', propertyId, monat], neu)
    setFehler(null)
  }
  const zurueck = useMutation({
    mutationFn: (id: number) =>
      api.post<Monat>(`/v1/properties/${propertyId}/my-time/${id}/withdraw`),
    onSuccess: uebernehmen,
    onError: e => setFehler(fehlerText(e, locale))
  })

  if (q.isPending) return <Karte><p>{t('app.loading')}</p></Karte>
  if (q.isError) {
    return <Karte>
      <Fehler text={fehlerText(q.error, locale)} />
      <button type="button" className={KNOPF_LEISE} onClick={() => { void q.refetch() }}>
        {t('app.retry')}
      </button>
    </Karte>
  }
  const m = q.data
  const aktuell = m.today.slice(0, 7)
  const eigeneTage = [m.today, gestern(m.today)]
  const tage = m.days.filter(d => d.rooms > 0 || d.entries.length > 0).reverse()

  return <div className="space-y-3">
    <div className="flex items-center justify-between">
      <button type="button" aria-label={t('time.prev')} className="px-4 py-2 text-xl"
              disabled={m.month <= monatPlus(aktuell, -12)}
              onClick={() => setMonat(monatPlus(m.month, -1))}>‹</button>
      <h2 className="text-lg font-semibold">{monatName(m.month, locale)}</h2>
      <button type="button" aria-label={t('time.next')} className="px-4 py-2 text-xl
                                                                     disabled:text-neutral-300"
              disabled={m.month >= aktuell}
              onClick={() => setMonat(monatPlus(m.month, 1))}>›</button>
    </div>
    <section className="bg-white border border-neutral-200 rounded-lg p-4 text-center">
      <p className="text-4xl font-semibold tabular-nums">{hm(m.totals.total)}</p>
      <p className="text-sm text-neutral-600">{t('time.total', { minutes: m.totals.total })}</p>
      {m.closed && <p className="text-sm text-neutral-600 mt-1">{t('time.closed')}</p>}
    </section>
    {m.month === aktuell && !m.closed
      && <Eintragen propertyId={propertyId} locale={locale} kueche={kueche}
                    heute={m.today} onFertig={neu => {
                      // Ein Eintrag von gestern kann im Vormonat liegen.
                      void qc.invalidateQueries({ queryKey: ['my-time', propertyId] })
                      uebernehmen(neu)
                    }} />}
    {fehler !== null && <Fehler text={fehler} />}
    {tage.length === 0
      ? <Karte><p className="text-base text-neutral-700">{t('time.empty')}</p></Karte>
      : <ul className="space-y-2">
        {tage.map(d => <li key={d.date}
                           className="bg-white border border-neutral-200 rounded-lg p-3">
          <div className="flex justify-between font-medium">
            <span>{tagName(d.date, locale)}</span>
            <span className="tabular-nums">{hm(d.total)}</span>
          </div>
          {d.rooms > 0 && <p className="text-sm text-neutral-700 flex justify-between">
            <span>{t('time.rooms', { n: d.rooms })}</span>
            <span className="tabular-nums">{t('room.minutes', { minutes: d.roomMinutes })}</span>
          </p>}
          {d.entries.map(e => <div key={e.id} className={`text-sm mt-1 ${e.withdrawn
            ? 'text-neutral-400 line-through' : 'text-neutral-700'}`}>
            <div className="flex justify-between gap-2">
              <span>
                {e.kind === 'kitchen' && `${t('time.kitchen')} ${e.start}–${e.end}`}
                {e.kind === 'extra' && e.description}
                {e.kind === 'correction' && <span className="text-amber-800">
                  {t('time.correction')}: {e.description}</span>}
              </span>
              <span className="tabular-nums whitespace-nowrap">
                {t('room.minutes', { minutes: e.minutes })}</span>
            </div>
            {e.kind !== 'correction' && !e.withdrawn && !m.closed
              && eigeneTage.includes(e.date)
              && <button type="button" disabled={zurueck.isPending}
                         className="text-sm text-red-800 underline mt-1"
                         onClick={() => zurueck.mutate(e.id)}>{t('time.withdraw')}</button>}
          </div>)}
        </li>)}
      </ul>}
  </div>
}

function Eintragen({ propertyId, locale, kueche, heute, onFertig }: {
  propertyId: number; locale: StaffLocale; kueche: boolean; heute: string
  onFertig: (neu: Monat) => void
}): JSX.Element {
  const t = usePT()
  const [offen, setOffen] = useState(false)
  const [tag, setTag] = useState<'heute' | 'gestern'>('heute')
  const [art, setArt] = useState<'extra' | 'kitchen'>(kueche ? 'kitchen' : 'extra')
  const [text, setText] = useState('')
  const [minuten, setMinuten] = useState('')
  const [beginn, setBeginn] = useState('')
  const [ende, setEnde] = useState('')
  const [fehler, setFehler] = useState<string | null>(null)
  const senden = useMutation({
    mutationFn: () => api.post<Monat>(`/v1/properties/${propertyId}/my-time`, {
      date: tag === 'heute' ? heute : gestern(heute), kind: art,
      description: text.trim() === '' ? undefined : text.trim(),
      ...(art === 'extra' ? { minutes: Number(minuten) } : { start: beginn, end: ende })
    }),
    onSuccess: neu => {
      setText(''); setMinuten(''); setBeginn(''); setEnde(''); setFehler(null); setOffen(false)
      onFertig(neu)
    },
    onError: e => setFehler(fehlerText(e, locale))
  })
  if (!offen) {
    return <button type="button" className={KNOPF} onClick={() => setOffen(true)}>
      {t('time.add')}</button>
  }
  const wahl = (an: boolean): string => `py-2.5 rounded-md border text-base ${an
    ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300 bg-white'}`
  return <Karte titel={t('time.add')}>
    <form className="space-y-3" onSubmit={e => { e.preventDefault(); senden.mutate() }}>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={wahl(tag === 'heute')} aria-pressed={tag === 'heute'}
                onClick={() => setTag('heute')}>{t('kitchen.today')}</button>
        <button type="button" className={wahl(tag === 'gestern')}
                aria-pressed={tag === 'gestern'}
                onClick={() => setTag('gestern')}>{t('time.yesterday')}</button>
      </div>
      {kueche && <div className="grid grid-cols-2 gap-2">
        <button type="button" className={wahl(art === 'kitchen')}
                aria-pressed={art === 'kitchen'}
                onClick={() => setArt('kitchen')}>{t('time.kitchen')}</button>
        <button type="button" className={wahl(art === 'extra')} aria-pressed={art === 'extra'}
                onClick={() => setArt('extra')}>{t('time.extra')}</button>
      </div>}
      {art === 'kitchen'
        ? <div className="grid grid-cols-2 gap-2">
          <label className="block"><span className="block text-sm text-neutral-600">
            {t('time.start')}</span>
            <input type="time" required value={beginn} onChange={e => setBeginn(e.target.value)}
                   className={FELD} /></label>
          <label className="block"><span className="block text-sm text-neutral-600">
            {t('time.end')}</span>
            <input type="time" required value={ende} onChange={e => setEnde(e.target.value)}
                   className={FELD} /></label>
        </div>
        : <>
          <label className="block"><span className="block text-sm text-neutral-600">
            {t('time.what')}</span>
            <input type="text" required maxLength={500} value={text}
                   onChange={e => setText(e.target.value)} className={FELD} /></label>
          <label className="block"><span className="block text-sm text-neutral-600">
            {t('time.minutes')}</span>
            <input type="number" inputMode="numeric" required min={1} max={1440}
                   value={minuten} onChange={e => setMinuten(e.target.value)}
                   className={FELD} /></label>
        </>}
      <p className="text-sm text-neutral-500">{t('time.hint')}</p>
      {fehler !== null && <Fehler text={fehler} />}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={KNOPF_LEISE}
                onClick={() => setOffen(false)}>{t('problem.cancel')}</button>
        <button type="submit" className={KNOPF} disabled={senden.isPending}>
          {t('time.save')}</button>
      </div>
    </form>
  </Karte>
}
