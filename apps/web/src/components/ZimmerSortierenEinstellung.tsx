import { useEffect, useState, type JSX } from 'react'
import {
  useSortierEinstellung, useSortierEinstellungSpeichern,
  type SortierGewichte, type SortierModus, type SortierWunsch
} from '../lib/queries/zimmerSortieren.js'
import { useT, type TextKey } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Zimmer sortieren: ob und womit das Haus sortiert (Migration 0103).
 *
 * Die Gewichte sind eingeklappt. Wer nur den Modus waehlt, soll nicht
 * zwoelf Zahlen vor sich sehen und meinen, er muesse sie verstehen: die
 * Vorgaben sind am Hotel des Adminpanels ueber Monate eingestellt worden.
 */

const ZAHLEN = [
  'pricePercent', 'topRoomQuality', 'cheapGuestMarginCent', 'topRoomPenalty', 'wishPenalty',
  'smallRoomFromNights', 'smallRoomPenalty', 'groupBuildingPenalty', 'groupQualityPenalty',
  'groupFloorPenalty', 'groupNumberPenaltyMax', 'movePenalty'
] as const

const MODI: SortierModus[] = ['manual', 'auto', 'off']

function wuenscheLesen(text: string): SortierWunsch[] | null {
  const zeilen = text.split('\n').map(z => z.trim()).filter(z => z !== '')
  const out: SortierWunsch[] = []
  for (const z of zeilen) {
    const [k, a, ...rest] = z.split('=').map(x => x.trim())
    if (rest.length > 0 || k === undefined || a === undefined || k === '' || a === '') return null
    out.push({ keyword: k.toLowerCase(), attribute: a })
  }
  return out
}

const wuenscheText = (w: SortierWunsch[]): string =>
  w.map(x => `${x.keyword} = ${x.attribute}`).join('\n')

export function ZimmerSortierenEinstellung({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const q = useSortierEinstellung(propertyId)
  const speichern = useSortierEinstellungSpeichern(propertyId)
  const [modus, setModus] = useState<SortierModus>('manual')
  const [heuteFest, setHeuteFest] = useState(true)
  const [zahlen, setZahlen] = useState<Record<string, string>>({})
  const [klein, setKlein] = useState('')
  const [wuensche, setWuensche] = useState('')

  useEffect(() => {
    if (q.data === undefined) return
    const w = q.data.weights
    setModus(q.data.mode)
    setHeuteFest(q.data.keepToday)
    setZahlen(Object.fromEntries(ZAHLEN.map(k => [k, typeof w[k] === 'number' ? String(w[k]) : ''])))
    setKlein(typeof w.smallRoomAttribute === 'string' ? w.smallRoomAttribute : '')
    setWuensche(Array.isArray(w.wishes) ? wuenscheText(w.wishes) : '')
  }, [q.data])

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const vorgabe = q.data.effective

  const gelesen = wuensche.trim() === '' ? undefined : wuenscheLesen(wuensche)
  const zahlenGueltig = ZAHLEN.every(k => {
    const v = (zahlen[k] ?? '').trim()
    return v === '' || /^\d{1,7}$/.test(v)
  })
  const gueltig = zahlenGueltig && gelesen !== null

  function gewichte(): SortierGewichte {
    const w: SortierGewichte = {}
    for (const k of ZAHLEN) {
      const v = (zahlen[k] ?? '').trim()
      if (v !== '') w[k] = Number(v)
    }
    if (klein.trim() !== '') w.smallRoomAttribute = klein.trim()
    if (gelesen !== undefined && gelesen !== null) w.wishes = gelesen
    return w
  }

  const eingabe = 'w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm'
  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-sm text-neutral-600">{t('roomSort.hint')}</p>
      <fieldset className="space-y-1">
        <legend className="text-xs text-neutral-600 mb-1">{t('roomSort.mode')}</legend>
        {MODI.map(m => (
          <label key={m} className="flex items-center gap-2 text-sm">
            <input type="radio" name="room-sort-mode" checked={modus === m}
                   onChange={() => setModus(m)} />
            {t(`roomSort.mode.${m}` as TextKey)}
          </label>
        ))}
      </fieldset>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={heuteFest}
               onChange={e => setHeuteFest(e.target.checked)} />
        <span>
          {t('roomSort.keepToday')}
          <span className="block text-xs text-neutral-500">{t('roomSort.keepTodayHint')}</span>
        </span>
      </label>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-neutral-600">
          {t('roomSort.weights')}
        </summary>
        <p className="text-xs text-neutral-500 mt-2">{t('roomSort.weightsHint')}</p>
        <div className="grid sm:grid-cols-2 gap-3 mt-2">
          {ZAHLEN.map(k => (
            <label key={k} className="block text-sm">
              <span className="block text-xs text-neutral-600 mb-1">
                {t(`roomSort.w.${k}` as TextKey)}
              </span>
              <input value={zahlen[k] ?? ''} inputMode="numeric"
                     placeholder={String(vorgabe[k])}
                     onChange={e => setZahlen(z => ({ ...z, [k]: e.target.value }))}
                     className={eingabe} />
            </label>
          ))}
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">
              {t('roomSort.w.smallRoomAttribute')}
            </span>
            <input value={klein} placeholder={String(vorgabe.smallRoomAttribute)}
                   onChange={e => setKlein(e.target.value)} className={eingabe} />
          </label>
        </div>
        <label className="block text-sm mt-3">
          <span className="block text-xs text-neutral-600 mb-1">{t('roomSort.wishes')}</span>
          <textarea value={wuensche} rows={5} placeholder={wuenscheText(vorgabe.wishes)}
                    onChange={e => setWuensche(e.target.value)} className={eingabe} />
          <span className="block text-xs text-neutral-500 mt-1">{t('roomSort.wishesHint')}</span>
        </label>
        {gelesen === null && (
          <p className="text-xs text-red-700 mt-1">{t('roomSort.wishesInvalid')}</p>
        )}
      </details>
      {speichern.isError && <Fehler error={speichern.error} />}
      <div className="flex items-center gap-3">
        <button type="button" disabled={!online || !gueltig || speichern.isPending}
                onClick={() => speichern.mutate({
                  mode: modus, keepToday: heuteFest, weights: gewichte() })}
                className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                           disabled:opacity-40">
          {t('common.save')}
        </button>
        {speichern.isSuccess && (
          <span className="text-sm text-emerald-800">✓ {t('roomSort.saved')}</span>
        )}
      </div>
    </div>
  )
}
