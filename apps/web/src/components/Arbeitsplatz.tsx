import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.js'
import { useT } from '../lib/i18n/index.js'
import { Fehler } from './Shell.tsx'

/**
 * Der Arbeitsplatz: wer handelt hier gerade, und wie wechselt man das.
 *
 * **Warum das nicht "Abmelden und neu anmelden" ist.** An einer Rezeption
 * steht ein Rechner, an dem im Lauf eines Tages vier Menschen arbeiten. Sich
 * jedes Mal ab- und wieder anzumelden dauert zu lange, also tut es niemand
 * -- und dann steht im Protokoll an jeder Buchung der Name dessen, der
 * morgens aufgeschlossen hat. Der PIN ist der kurze Weg, der trotzdem
 * festhält, wer wirklich gehandelt hat.
 *
 * **Warum es diese Maske bisher nicht gab.** Die Route existiert seit
 * Anfang, den PIN prüft sie korrekt -- nur setzen konnte ihn niemand, und
 * benutzen erst recht nicht. Beides steht deshalb hier nebeneinander: ohne
 * den zweiten Teil wäre der erste wieder unbenutzbar.
 *
 * Nach einem Wechsel wird der Zwischenspeicher geleert, nicht nur neu
 * geladen. Sonst bliebe der Stand des Vorgängers stehen, und die neue
 * Person sähe für einen Wimpernschlag dessen Haus.
 */
export function Arbeitsplatz({ benutzer, pinGesetzt, gewechselt, onClose }: {
  benutzer: string
  pinGesetzt: boolean
  gewechselt: boolean
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const qc = useQueryClient()

  const [email, setEmail] = useState('')
  const [pin, setPin] = useState('')
  const [kennwort, setKennwort] = useState('')
  const [eigenerPin, setEigenerPin] = useState('')

  const wechseln = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/v1/auth/workstation-switch',
      { email, pin }),
    onSuccess: async () => {
      qc.clear()
      await qc.invalidateQueries({ queryKey: ['me'] })
      onClose()
    }
  })

  const pinSetzen = useMutation({
    mutationFn: (neu: string | null) =>
      api.post<{ pinSet: boolean }>('/v1/auth/workstation-pin',
        { password: kennwort, pin: neu }),
    onSuccess: async () => {
      setKennwort('')
      setEigenerPin('')
      await qc.invalidateQueries({ queryKey: ['me'] })
    }
  })

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
         onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded shadow-xl p-4 space-y-4
                      max-h-[90vh] overflow-auto"
           onClick={e => e.stopPropagation()}>
        <div>
          <h2 className="text-sm font-medium">{t('workstation.title')}</h2>
          <p className="text-sm text-neutral-600 mt-1">{benutzer}</p>
          {gewechselt && (
            <p role="status" className="text-xs text-amber-800 mt-1">
              {t('workstation.acting')}
            </p>
          )}
        </div>

        <section className="space-y-2 border-t border-neutral-200 pt-3">
          <h3 className="text-sm font-medium">{t('workstation.switch')}</h3>
          <p className="text-xs text-neutral-500">{t('workstation.switchHint')}</p>
          {!pinGesetzt && (
            <p className="text-xs text-amber-800">{t('workstation.needOwnPin')}</p>
          )}
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">{t('login.email')}</span>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                   autoComplete="off"
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">
              {t('workstation.pin')}
            </span>
            {/* `inputMode` statt `type="number"`: eine PIN ist eine Ziffernfolge
                und keine Zahl -- fuehrende Nullen muessen stehen bleiben. */}
            <input type="password" inputMode="numeric" value={pin}
                   onChange={e => setPin(e.target.value)} autoComplete="off"
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          {wechseln.isError && <Fehler error={wechseln.error} />}
          <button type="button"
                  disabled={wechseln.isPending || email === '' || pin === ''}
                  onClick={() => wechseln.mutate()}
                  className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                             disabled:bg-neutral-300">
            {t('workstation.switchSubmit')}
          </button>
        </section>

        <section className="space-y-2 border-t border-neutral-200 pt-3">
          <h3 className="text-sm font-medium">
            {t('workstation.ownPin')}
            {' — '}
            <span className={pinGesetzt ? 'text-emerald-700' : 'text-neutral-500'}>
              {pinGesetzt ? t('workstation.pinSet') : t('workstation.pinNotSet')}
            </span>
          </h3>
          <p className="text-xs text-neutral-500">{t('workstation.ownPinHint')}</p>
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">
              {t('login.password')}
            </span>
            {/* Das eigene Kennwort ist die Stelle, an der sich beweisen laesst,
                dass wirklich der Betroffene davorsitzt -- an einem Tresen
                steht die Sitzung offen, waehrend die Person Kaffee holt. */}
            <input type="password" value={kennwort}
                   onChange={e => setKennwort(e.target.value)} autoComplete="current-password"
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">
              {t('workstation.pin')}
            </span>
            <input type="password" inputMode="numeric" value={eigenerPin}
                   onChange={e => setEigenerPin(e.target.value)} autoComplete="off"
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          {pinSetzen.isError && <Fehler error={pinSetzen.error} />}
          {pinSetzen.isSuccess && (
            <p className="text-sm text-emerald-800">✓ {t('workstation.pinSaved')}</p>
          )}
          <div className="flex gap-2">
            <button type="button"
                    disabled={pinSetzen.isPending || kennwort === '' || eigenerPin === ''}
                    onClick={() => pinSetzen.mutate(eigenerPin)}
                    className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                               disabled:bg-neutral-300">
              {t('workstation.pinSave')}
            </button>
            {pinGesetzt && (
              <button type="button"
                      disabled={pinSetzen.isPending || kennwort === ''}
                      onClick={() => pinSetzen.mutate(null)}
                      className="px-3 py-1.5 text-sm rounded border border-neutral-300
                                 disabled:text-neutral-400">
                {t('workstation.pinRemove')}
              </button>
            )}
          </div>
        </section>

        <div className="border-t border-neutral-200 pt-3">
          <button type="button" onClick={onClose}
                  className="px-3 py-1.5 text-sm rounded border border-neutral-300">
            {t('common.back')}
          </button>
        </div>
      </div>
    </div>
  )
}
