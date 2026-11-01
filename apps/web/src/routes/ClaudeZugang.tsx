import { useState } from 'react'
import type { JSX } from 'react'
import { MCP_KLARTEXT_ZEILEN, type McpReleaseRow } from '@hotelpms/contracts'
import { useT, useLocale } from '../lib/i18n/index.js'
import { abgebrochen } from '../lib/passkey.js'
import { useMcpOverview, useMcpPending, useMcpLock, useMcpRevoke, useMcpGrant,
         useMcpClose } from '../lib/queries/mcp.js'
import { Fehler, Laedt } from '../components/Shell.tsx'

/**
 * Der Reiter "Claude-Zugang" im Adminpanel (0222, Dokument 38): der
 * Sperrschalter, die Verbindungen, die Klartext-Anfragen und das Protokoll
 * der letzten Aufrufe.
 *
 * Die Abgleichszahl steht gross an der Anfrage. Sie ist das, was den Passkey
 * an **diese** Anfrage bindet: Claude nennt sie im Gespraech, und wer hier
 * eine andere sieht, gibt nicht frei.
 */

function useZeit(): (iso: string | null) => string {
  const locale = useLocale()
  const f = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' })
  return iso => iso === null ? '' : f.format(new Date(iso))
}

/** Oben im Adminpanel, solange eine Anfrage offen ist -- in jedem Reiter. */
export function ClaudeHinweis(): JSX.Element | null {
  const t = useT()
  const q = useMcpPending(true)
  const n = q.data?.pending ?? 0
  if (n === 0) return null
  return (
    <p role="alert"
       className="text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded-sm p-3">
      {t('mcp.banner', { n })}
    </p>
  )
}

export function ClaudeZugang(): JSX.Element {
  const t = useT()
  const zeit = useZeit()
  const q = useMcpOverview()
  const sperren = useMcpLock()
  const trennen = useMcpRevoke()
  const schliessen = useMcpClose()

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const o = q.data
  const offen = o.releases.filter(r => r.state === 'pending')
  const rest = o.releases.filter(r => r.state !== 'pending')
  const verbunden = o.connections.filter(c => c.active)

  return (
    <div className="space-y-6">
      <p className="text-sm text-neutral-600 max-w-2xl">{t('mcp.intro')}</p>

      <section className={`flex flex-wrap items-center gap-3 rounded-sm border p-3 ${o.locked
        ? 'border-red-300 bg-red-50' : 'border-neutral-200 bg-white'}`}>
        <span className="text-sm">{t(o.locked ? 'mcp.isLocked' : 'mcp.isOpen')}</span>
        <button type="button" disabled={sperren.isPending}
                onClick={() => sperren.mutate(!o.locked)}
                className={`text-sm px-3 py-1.5 rounded-sm disabled:opacity-40 ${o.locked
                  ? 'border border-neutral-300 bg-white' : 'bg-red-700 text-white'}`}>
          {t(o.locked ? 'mcp.unlock' : 'mcp.lock')}
        </button>
        {sperren.isError && <Fehler error={sperren.error} />}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t('mcp.requests')}</h2>
        {offen.length > 0 && <p className="text-sm text-neutral-600">{t('mcp.matchHint')}</p>}
        {o.releases.length === 0 && (
          <p className="text-sm text-neutral-600">{t('mcp.noRequests')}</p>
        )}
        <ul className="space-y-2">
          {[...offen, ...rest].map(r => (
            <Freigabe key={r.ref} r={r} zeit={zeit}
                      onClose={() => schliessen.mutate(r.ref)}
                      schliesst={schliessen.isPending} />
          ))}
        </ul>
        {schliessen.isError && <Fehler error={schliessen.error} />}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t('mcp.connections')}</h2>
        {verbunden.length === 0 && (
          <p className="text-sm text-neutral-600">{t('mcp.noConnections')}</p>
        )}
        <ul className="space-y-1">
          {verbunden.map(c => (
            <li key={c.ref} className="flex flex-wrap items-center gap-3 text-sm">
              <span>{t('mcp.connection', { name: c.userName ?? '–',
                                           seit: zeit(c.createdAt), bis: zeit(c.expiresAt) })}</span>
              <button type="button" disabled={trennen.isPending}
                      onClick={() => trennen.mutate(c.ref)}
                      className="px-2 py-1 rounded-sm border border-neutral-300 bg-white
                                 disabled:opacity-40">
                {t('mcp.revoke')}
              </button>
            </li>
          ))}
        </ul>
        {trennen.isError && <Fehler error={trennen.error} />}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t('mcp.calls')}</h2>
        {o.calls.length === 0 && <p className="text-sm text-neutral-600">{t('mcp.noCalls')}</p>}
        {o.calls.length > 0 && (
          <div className="overflow-x-auto">
            <table className="text-xs w-full">
              <tbody>
                {o.calls.map(c => (
                  <tr key={c.id} className="border-t border-neutral-100 align-top">
                    <td className="py-1 pr-3 whitespace-nowrap">{zeit(c.at)}</td>
                    <td className="py-1 pr-3 font-mono">{c.tool}</td>
                    <td className="py-1 pr-3">{c.propertyId ?? ''}</td>
                    <td className="py-1 pr-3 text-right">{c.rows}</td>
                    <td className="py-1 pr-3 text-right">{c.durationMs} ms</td>
                    <td className="py-1 pr-3">
                      {c.plaintext && <span className="text-amber-800">{t('mcp.plaintext')}</span>}
                      {!c.ok && <span className="text-red-800"> ✗</span>}
                    </td>
                    <td className="py-1 font-mono text-neutral-600 break-all">{c.detail ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function Freigabe({ r, zeit, onClose, schliesst }: {
  r: McpReleaseRow; zeit: (iso: string | null) => string; onClose: () => void; schliesst: boolean
}): JSX.Element {
  const t = useT()
  const freigeben = useMcpGrant()
  const [fehler, setFehler] = useState<unknown>(null)

  const zustand = r.state === 'active'
    ? t('mcp.state.active', { zeit: zeit(r.expiresAt) })
    : t(`mcp.state.${r.state}`)

  return (
    <li className={`rounded-sm border p-3 space-y-2 ${r.state === 'pending'
      ? 'border-amber-300 bg-amber-50' : 'border-neutral-200 bg-white'}`}>
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-medium">{r.propertyName}</span>
        <span className="text-xs text-neutral-500">{r.accountName}</span>
        <span className="text-xs text-neutral-500">{zeit(r.requestedAt)}</span>
        <span className="text-xs rounded-sm bg-neutral-100 px-1.5 py-0.5">{zustand}</span>
      </div>
      <p className="text-sm whitespace-pre-wrap">{r.reason}</p>
      {r.state === 'pending' && (
        <p className="text-2xl font-mono tracking-widest">{t('mcp.match', { code: r.matchCode })}</p>
      )}
      {r.state === 'active' && (
        <p className="text-xs text-neutral-600">
          {t('mcp.rowsUsed', { n: r.rowsUsed, max: MCP_KLARTEXT_ZEILEN })}
        </p>
      )}
      {r.state === 'pending' && !r.allowed && (
        <p className="text-sm text-red-800">{t('mcp.notAllowed')}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {r.state === 'pending' && r.allowed && (
          <button type="button" disabled={freigeben.isPending}
                  onClick={() => {
                    setFehler(null)
                    freigeben.mutate(r.ref, {
                      onError: e => { if (!abgebrochen(e)) setFehler(e) } })
                  }}
                  className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
                             disabled:opacity-40">
            {t('mcp.grant')}
          </button>
        )}
        {(r.state === 'pending' || r.state === 'active') && (
          <button type="button" disabled={schliesst} onClick={onClose}
                  className="text-sm px-3 py-1.5 rounded-sm border border-neutral-300 bg-white
                             disabled:opacity-40">
            {t(r.state === 'pending' ? 'mcp.deny' : 'mcp.end')}
          </button>
        )}
      </div>
      {fehler !== null && <Fehler error={fehler} />}
    </li>
  )
}
