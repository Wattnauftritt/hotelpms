import { useEffect, useState } from 'react'
import { useEscape } from '../lib/tasten.js'
import { useT, useLocale, intlTag, type Locale } from '../lib/i18n/index.js'
import { useTerminals, useCreateTerminal, useRepairTerminal, useRevokeTerminal,
         type Kopplungscode } from '../lib/queries/terminal.js'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Einstellungen → Gaesteterminals (Dokument 31).
 *
 * Koppeln, sehen, widerrufen. Der Code steht genau einmal da: die
 * Schnittstelle legt nur seinen Hash ab und kann ihn nicht noch einmal
 * zeigen. Wer ihn verpasst, koppelt neu -- das kostet einen Klick und
 * macht einen alten Code wertlos.
 */
export function Gaesteterminals({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [name, setName] = useState('')
  const [code, setCode] = useState<Kopplungscode | null>(null)
  const anlegen = useCreateTerminal(propertyId)
  const neu = useRepairTerminal(propertyId)
  const widerrufen = useRevokeTerminal(propertyId)
  const liste = useTerminals(propertyId, code !== null)

  // Escape schliesst den angezeigten Code -- er ist eine Lage ueber der
  // Liste, und danach braucht ihn niemand mehr.
  useEscape(() => setCode(null), code !== null)

  /*
   * Sobald der Code eingeloest ist, faellt er von selbst weg: das Terminal
   * steht dann als gekoppelt in der Liste, und ein stehengebliebener Code
   * saehe aus, als waere noch etwas zu tun.
   *
   * "Eingeloest" heisst: erst wartend gesehen, dann gekoppelt. Beim
   * Neukoppeln steht das Geraet im Zwischenspeicher noch als gekoppelt --
   * vom letzten Mal --, und der frische Code verschwaende, bevor ihn
   * jemand lesen kann.
   */
  const [wartendGesehen, setWartendGesehen] = useState(false)
  const stand = code === null ? undefined
    : liste.data?.terminals.find(d => d.deviceRef === code.deviceRef)?.state
  useEffect(() => {
    if (code === null) { setWartendGesehen(false); return }
    if (stand === 'pairing') setWartendGesehen(true)
    else if (stand === 'paired' && wartendGesehen) setCode(null)
  }, [code, stand, wartendGesehen])

  if (liste.isError) return <Fehler error={liste.error} />
  if (liste.data === undefined) return <Laedt />

  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-sm text-neutral-600">{t('terminal.settings.hint')}</p>

      {code !== null && (
        <div className="rounded border border-neutral-300 bg-white p-4 space-y-2" role="status">
          <div className="text-sm font-medium">
            {t('terminal.settings.codeTitle', { name: code.name })}
          </div>
          <div className="text-3xl font-mono tracking-widest select-all">{code.pairingCode}</div>
          <p className="text-xs text-neutral-600">
            {t('terminal.settings.codeHint', {
              adresse: `${location.origin}/terminal`,
              zeit: uhrzeit(code.pairingExpiresAt, locale) })}
          </p>
          <button type="button" onClick={() => setCode(null)}
                  className="text-xs text-neutral-600 underline">
            {t('common.close')}
          </button>
        </div>
      )}

      <form className="flex flex-wrap items-end gap-2"
            onSubmit={e => {
              e.preventDefault()
              if (name.trim() === '') return
              anlegen.mutate(name.trim(), { onSuccess: c => { setCode(c); setName('') } })
            }}>
        <label className="text-sm">
          <div className="text-neutral-600">{t('terminal.settings.name')}</div>
          <input value={name} onChange={e => setName(e.target.value)} maxLength={60}
                 placeholder={t('terminal.settings.namePlaceholder')}
                 className="border border-neutral-300 rounded px-2 py-1 w-72" />
        </label>
        <button type="submit" disabled={name.trim() === '' || anlegen.isPending}
                className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('terminal.settings.pair')}
        </button>
      </form>
      {anlegen.isError && <Fehler error={anlegen.error} />}
      {neu.isError && <Fehler error={neu.error} />}
      {widerrufen.isError && <Fehler error={widerrufen.error} />}

      {liste.data.terminals.length === 0
        ? <p className="text-sm text-neutral-500">{t('terminal.settings.none')}</p>
        : <ul className="divide-y divide-neutral-100 border border-neutral-200 rounded bg-white">
            {liste.data.terminals.map(d => (
              <li key={d.deviceRef} className="px-3 py-2 flex flex-wrap items-center gap-3">
                <span className="font-medium text-sm grow">{d.name}</span>
                <span className="text-xs text-neutral-600">
                  {d.state === 'pairing' && d.pairingExpiresAt !== null
                    ? t('terminal.settings.state.pairing',
                        { zeit: uhrzeit(d.pairingExpiresAt, locale) })
                    : t(`terminal.settings.state.${d.state}`)}
                </span>
                {d.state === 'paired' && (
                  <span className={`text-xs ${d.online ? 'text-emerald-700' : 'text-amber-700'}`}>
                    {t(d.online ? 'terminal.settings.online' : 'terminal.settings.offline')}
                  </span>
                )}
                <button type="button" disabled={neu.isPending}
                        onClick={() => neu.mutate(d.deviceRef, { onSuccess: setCode })}
                        className="text-xs px-2 py-1 rounded border border-neutral-300
                                   hover:bg-neutral-50">
                  {t('terminal.settings.repair')}
                </button>
                <button type="button" disabled={widerrufen.isPending}
                        onClick={() => {
                          if (confirm(t('terminal.settings.revokeConfirm', { name: d.name }))) {
                            widerrufen.mutate(d.deviceRef)
                          }
                        }}
                        className="text-xs px-2 py-1 rounded border border-red-300 text-red-800
                                   hover:bg-red-50">
                  {t('terminal.settings.revoke')}
                </button>
              </li>
            ))}
          </ul>}
    </div>
  )
}

/** Ein Zeitpunkt als Uhrzeit des Betrachters. Ein Zeitpunkt, kein Kalendertag. */
function uhrzeit(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlTag(locale), { timeStyle: 'short' }).format(new Date(iso))
}
