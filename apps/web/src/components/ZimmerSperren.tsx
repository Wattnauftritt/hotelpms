import { useState, type JSX } from 'react'
import { useCreateMaintenanceTicket } from '../lib/queries/settings.js'
import { useT } from '../lib/i18n/index.js'
import { addDays } from '../lib/dates.js'
import { Fehler } from './Shell.tsx'

/**
 * Ein Zimmer sperren -- aus dem Plan heraus, wo die Entscheidung faellt.
 *
 * **Warum hier und nicht nur im Wartungsbildschirm.** "Der Handwerker kommt
 * Dienstag an die Dusche in 204" faellt jemandem ein, waehrend er auf den
 * Plan sieht. Bisher hiess das: Bildschirm wechseln, Zimmer suchen, Datum
 * eintippen, zurueck. Der Weg ist so lang, dass die Sperrung haeufig gar
 * nicht entsteht -- und dann verkauft das Haus ein Zimmer ohne Dusche.
 *
 * **Es entsteht immer eine Wartungsmeldung, nicht nur ein Riegel.** Eine
 * Sperrung ohne Grund und ohne Zustaendigen bleibt stehen, bis jemand
 * darueber stolpert; die Meldung hat einen Zustand und taucht in der Liste
 * auf, die jemand abarbeitet. Deshalb ist der Titel Pflicht: "Sperrung" als
 * Grund ist keiner.
 *
 * **Out of Order senkt die Kapazitaet, Out of Service nicht.** Das ist der
 * ganze Unterschied und der Grund, warum hier gewaehlt werden muss: ein
 * Zimmer ohne Fernseher ist verkaeuflich, eines ohne Wasser nicht. Wer
 * beides gleich behandelt, verkauft entweder zu wenig oder das Falsche.
 */
export function ZimmerSperren({ propertyId, resourceId, roomCode, ab, onClose }: {
  propertyId: number
  resourceId: number
  roomCode: string
  /** Der angeklickte Tag. Vorbelegung, kein Zwang. */
  ab: string
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const [von, setVon] = useState(ab)
  const [bis, setBis] = useState(() => addDays(ab, 1))
  const [art, setArt] = useState<'out_of_order' | 'out_of_service'>('out_of_order')
  const [titel, setTitel] = useState('')
  const anlegen = useCreateMaintenanceTicket(propertyId)

  const gueltig = bis > von && titel.trim() !== ''

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
         onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded shadow-xl p-4 space-y-3"
           onClick={e => e.stopPropagation()}>
        <h2 className="text-sm font-medium">
          {t('sperre.title')} — {roomCode}
        </h2>

        <div className="flex gap-2">
          <label className="block text-sm grow">
            <span className="block text-xs text-neutral-600 mb-1">{t('common.from')}</span>
            <input type="date" value={von} onChange={e => setVon(e.target.value)}
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          <label className="block text-sm grow">
            <span className="block text-xs text-neutral-600 mb-1">{t('common.to')}</span>
            <input type="date" value={bis} onChange={e => setBis(e.target.value)}
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
        </div>

        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">{t('sperre.kind')}</span>
          <select value={art}
                  onChange={e => setArt(e.target.value as 'out_of_order' | 'out_of_service')}
                  className="w-full border border-neutral-300 rounded px-2 py-1 text-sm">
            <option value="out_of_order">{t('sperre.outOfOrder')}</option>
            <option value="out_of_service">{t('sperre.outOfService')}</option>
          </select>
          <span className="block text-xs text-neutral-500 mt-1">
            {art === 'out_of_order' ? t('sperre.outOfOrderHint') : t('sperre.outOfServiceHint')}
          </span>
        </label>

        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">{t('sperre.reason')}</span>
          <input value={titel} onChange={e => setTitel(e.target.value)}
                 placeholder={t('sperre.reasonPlaceholder')}
                 className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          {/* Der Grund steht am Riegel im Plan und ist der Titel der
              Wartungsmeldung. Eine Sperrung, deren Grund niemand kennt,
              bleibt stehen, bis jemand darueber stolpert. */}
          <span className="block text-xs text-neutral-500 mt-1">{t('sperre.reasonHint')}</span>
        </label>

        {anlegen.isError && <Fehler error={anlegen.error} />}
        {anlegen.isSuccess ? (
          <>
            <p className="text-sm text-emerald-800">✓ {t('sperre.created')}</p>
            <button type="button" onClick={onClose}
                    className="px-3 py-1.5 text-sm rounded border border-neutral-300">
              {t('common.back')}
            </button>
          </>
        ) : (
          <div className="flex gap-2">
            <button type="button" disabled={!gueltig || anlegen.isPending}
                    onClick={() => anlegen.mutate({
                      propertyId, resourceId, title: titel.trim(),
                      block: { from: von, to: bis, kind: art }
                    })}
                    className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                               disabled:bg-neutral-300">
              {t('sperre.submit')}
            </button>
            <button type="button" onClick={onClose}
                    className="px-3 py-1.5 text-sm rounded border border-neutral-300">
              {t('booking.close')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
