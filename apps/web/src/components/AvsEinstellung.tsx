import { useEffect, useState, type JSX } from 'react'
import { useAvsEinstellung, useAvsEinstellungSpeichern } from '../lib/queries/avs.js'
import { useT } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Meldeschein als Datei fuer AVS: die Kennungen des Hauses (Migration 0091).
 *
 * **Ohne Objektnummer keine Datei.** Sie vergibt die Kurverwaltung, und
 * ohne sie ordnet AVS den Schein keinem Haus zu. Ist hier nichts
 * eingetragen, zeigt der Check-in keinen AVS-Knopf -- ein Haus ohne
 * Kurbeitrag soll davon nichts sehen.
 *
 * **Die Kategorie je Befreiung steht beim Befreiungsgrund**, nicht hier:
 * hier nur die Vorgabe fuer alle anderen.
 */
export function AvsEinstellung({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const q = useAvsEinstellung(propertyId)
  const speichern = useAvsEinstellungSpeichern(propertyId)
  const [hotelId, setHotelId] = useState('')
  const [origin, setOrigin] = useState('StayGrid')
  const [userName, setUserName] = useState('StayGrid')
  const [minAge, setMinAge] = useState('16')
  const [kategorie, setKategorie] = useState('1')
  // In Euro mit Komma, wie die Rezeption es auf dem Preisblatt liest.
  const [fruehstueck, setFruehstueck] = useState('0')

  useEffect(() => {
    if (q.data?.configured !== true) return
    setHotelId(q.data.hotelId ?? '')
    setOrigin(q.data.origin ?? 'StayGrid')
    setUserName(q.data.userName ?? 'StayGrid')
    setMinAge(String(q.data.minAge ?? 16))
    setKategorie(String(q.data.defaultCategory ?? 1))
    setFruehstueck(((q.data.breakfastCent ?? 0) / 100).toFixed(2).replace('.', ','))
  }, [q.data])

  const alter = Number(minAge)
  const kat = Number(kategorie)
  const fruehstueckCent = /^\d{1,4}([.,]\d{1,2})?$/.test(fruehstueck.trim())
    ? Math.round(Number(fruehstueck.trim().replace(',', '.')) * 100) : NaN
  const gueltig = /^[0-9]{1,10}$/.test(hotelId.trim())
    && /^[A-Za-z0-9_-]{1,10}$/.test(userName.trim())
    && origin.trim() !== '' && origin.trim().length <= 40
    && Number.isInteger(alter) && alter >= 0 && alter <= 30
    && Number.isInteger(kat) && kat >= 1 && kat <= 99
    && Number.isInteger(fruehstueckCent) && fruehstueckCent <= 100_000
  const eingabe = 'w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm'

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />

  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-sm text-neutral-600">{t('avsSettings.hint')}</p>
      {!q.data.configured && (
        <p className="text-sm text-amber-800">{t('avsSettings.notConfigured')}</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">{t('avsSettings.hotelId')}</span>
          <input value={hotelId} inputMode="numeric"
                 onChange={e => setHotelId(e.target.value)} className={eingabe} />
        </label>
        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">
            {t('avsSettings.defaultCategory')}
          </span>
          <input value={kategorie} inputMode="numeric"
                 onChange={e => setKategorie(e.target.value)} className={eingabe} />
        </label>
        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">{t('avsSettings.minAge')}</span>
          <input value={minAge} inputMode="numeric"
                 onChange={e => setMinAge(e.target.value)} className={eingabe} />
        </label>
        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">
            {t('avsSettings.breakfast')}
          </span>
          <input value={fruehstueck} inputMode="decimal"
                 onChange={e => setFruehstueck(e.target.value)} className={eingabe} />
        </label>
        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">{t('avsSettings.origin')}</span>
          <input value={origin} onChange={e => setOrigin(e.target.value)} className={eingabe} />
        </label>
        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">{t('avsSettings.userName')}</span>
          <input value={userName} onChange={e => setUserName(e.target.value)}
                 className={eingabe} />
        </label>
      </div>
      <p className="text-xs text-neutral-500">{t('avsSettings.categoryHint')}</p>
      {speichern.isError && <Fehler error={speichern.error} />}
      <div className="flex items-center gap-3">
        <button type="button" disabled={!online || !gueltig || speichern.isPending}
                onClick={() => speichern.mutate({
                  hotelId: hotelId.trim(), origin: origin.trim(), userName: userName.trim(),
                  minAge: alter, defaultCategory: kat, breakfastCent: fruehstueckCent })}
                className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                           disabled:opacity-40">
          {t('common.save')}
        </button>
        {speichern.isSuccess && (
          <span className="text-sm text-emerald-800">✓ {t('avsSettings.saved')}</span>
        )}
      </div>
    </div>
  )
}
