import { useEffect, useState } from 'react'
import { useCheckinSettings, useSaveCheckinSettings } from '../lib/queries/checkin.js'
import { useT } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Einstellung je Haus: Link zum Online-Check-in vor Anreise (Dokument 30).
 *
 * Aus als Vorgabe. Ein Haus soll nicht durch eine Auslieferung ploetzlich
 * Gaeste anschreiben -- dieselbe Ueberlegung wie beim Gastversand selbst.
 * Die Bedingungen (bestaetigt, Adresse, Absenderdomain, kein Uebungshaus)
 * stehen im Hinweis, damit niemand auf eine Mail wartet, die nie kommen kann.
 */
export function OnlineCheckinEinstellung({ propertyId, isTraining }: {
  propertyId: number; isTraining: boolean
}): JSX.Element {
  const t = useT()
  const online = useOnline()
  const q = useCheckinSettings(propertyId)
  const speichern = useSaveCheckinSettings(propertyId)
  const [enabled, setEnabled] = useState(false)
  const [tage, setTage] = useState(3)

  useEffect(() => {
    if (q.data === undefined) return
    setEnabled(q.data.enabled)
    setTage(q.data.daysBefore)
  }, [q.data])

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />

  return (
    <form className="rounded border border-neutral-200 bg-white p-3 space-y-3 max-w-2xl"
          onSubmit={e => {
            e.preventDefault()
            speichern.mutate({ enabled, daysBefore: tage })
          }}>
      <h2 className="text-sm font-medium">{t('onlineCheckin.settings.title')}</h2>
      <label className="text-sm flex items-center gap-1.5 text-neutral-700">
        <input type="checkbox" checked={enabled} disabled={isTraining}
               onChange={e => setEnabled(e.target.checked)} />
        {t('onlineCheckin.settings.enabled')}
      </label>
      <label className="text-sm block">
        <span className="text-neutral-600">{t('onlineCheckin.settings.days')}</span>
        <input type="number" min={1} max={14} value={tage}
               onChange={e => setTage(Math.min(14, Math.max(1, Number(e.target.value) || 1)))}
               className="ml-2 border border-neutral-300 rounded px-2 py-1 w-20" />
      </label>
      <p className="text-xs text-neutral-500">
        {isTraining ? t('mail.training') : t('onlineCheckin.settings.hint')}
      </p>
      {speichern.isError && <Fehler error={speichern.error} />}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={!online || speichern.isPending}
                className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                           disabled:opacity-40">
          {t('common.save')}
        </button>
        {speichern.isSuccess && <span className="text-xs text-emerald-700">✓</span>}
      </div>
    </form>
  )
}
