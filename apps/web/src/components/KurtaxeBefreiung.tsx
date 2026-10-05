import { useState, type JSX } from 'react'
import { useBefreiungsgruende, useCreateBefreiungsgrund, useUpdateBefreiungsgrund }
  from '../lib/queries/settings.js'
import { useT } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Befreiungsgruende fuer die Kurtaxe, die das Meldeformular anbietet
 * (Migration 0089).
 *
 * **Je Haus, weil je Gemeinde.** Was befreit, regelt die Kurbeitragssatzung,
 * und die AVS-Kategorie dazu steht in der Konfiguration genau dieser
 * Gemeinde. Eine feste Liste im Code waere fuer jedes zweite Haus falsch.
 *
 * **Abschalten statt loeschen.** Ein Meldeschein zeigt auf den Grund, den
 * der Gast gewaehlt hat; das Kuerzel bleibt, weil ein Umsystem den Grund
 * darunter schickt.
 */
export function KurtaxeBefreiung({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const q = useBefreiungsgruende(propertyId)
  const anlegen = useCreateBefreiungsgrund(propertyId)
  const aendern = useUpdateBefreiungsgrund(propertyId)
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [nachweis, setNachweis] = useState(false)
  const [avs, setAvs] = useState('')

  const avsZahl = avs.trim() === '' ? null : Number(avs)
  const gueltig = /^[a-z0-9_]{1,40}$/.test(code.trim()) && label.trim() !== ''
    && (avsZahl === null || (Number.isInteger(avsZahl) && avsZahl >= 1 && avsZahl <= 99))
  const gruende = q.data?.reasons ?? []
  const eingabe = 'w-full border border-neutral-300 rounded-sm px-2 py-1 text-sm'

  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-sm text-neutral-600">{t('exemption.hint')}</p>

      {q.isError && <Fehler error={q.error} />}
      {aendern.isError && <Fehler error={aendern.error} />}
      {q.data === undefined && !q.isError ? <Laedt /> : (
        <ul className="space-y-2">
          {gruende.map(g => (
            <li key={g.reasonRef}
                className={`border rounded-sm p-2 text-sm flex flex-wrap items-center gap-2
                            ${g.active ? 'border-neutral-300'
                                       : 'border-neutral-200 bg-neutral-50 text-neutral-500'}`}>
              <span className="font-medium">{g.label}</span>
              <span className="text-xs text-neutral-500">{g.code}</span>
              {g.needsProof && (
                <span className="text-xs text-neutral-500">· {t('exemption.withProof')}</span>
              )}
              {g.avsCategory !== null && (
                <span className="text-xs text-neutral-500">
                  · {t('exemption.avsCategory')} {g.avsCategory}
                </span>
              )}
              <div className="grow" />
              <button type="button" disabled={!online || aendern.isPending}
                      onClick={() => aendern.mutate({ reasonRef: g.reasonRef, active: !g.active })}
                      className="px-2 py-0.5 text-xs rounded-sm border border-neutral-300
                                 disabled:opacity-50">
                {g.active ? t('exemption.deactivate') : t('exemption.activate')}
              </button>
            </li>
          ))}
          {gruende.length === 0 && (
            <li className="text-sm text-neutral-500">{t('exemption.none')}</li>
          )}
        </ul>
      )}

      <div className="border-t border-neutral-200 pt-3 space-y-2">
        <h2 className="text-sm font-medium">{t('exemption.new')}</h2>
        <div className="flex flex-wrap gap-2">
          <label className="block text-sm w-40">
            <span className="block text-xs text-neutral-600 mb-1">{t('exemption.code')}</span>
            <input value={code} onChange={e => setCode(e.target.value)}
                   placeholder="behinderung" className={eingabe} />
          </label>
          <label className="block text-sm grow">
            <span className="block text-xs text-neutral-600 mb-1">{t('exemption.label')}</span>
            <input value={label} onChange={e => setLabel(e.target.value)} maxLength={120}
                   placeholder="100 % Behinderung" className={eingabe} />
          </label>
          <label className="block text-sm w-28">
            <span className="block text-xs text-neutral-600 mb-1">{t('exemption.avsCategory')}</span>
            <input value={avs} onChange={e => setAvs(e.target.value)} inputMode="numeric"
                   className={eingabe} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={nachweis} onChange={e => setNachweis(e.target.checked)} />
          {t('exemption.needsProof')}
        </label>
        {anlegen.isError && <Fehler error={anlegen.error} />}
        {!online && <div className="text-sm text-amber-800">{t('error.offlineWrite')}</div>}
        <button type="button" disabled={!gueltig || anlegen.isPending || !online}
                onClick={() => anlegen.mutate(
                  { code: code.trim(), label: label.trim(), needsProof: nachweis,
                    avsCategory: avsZahl, sort: (gruende.length + 1) * 10 },
                  { onSuccess: () => { setCode(''); setLabel(''); setNachweis(false); setAvs('') } })}
                className="px-3 py-1.5 text-sm rounded-sm bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('common.save')}
        </button>
      </div>
    </div>
  )
}
