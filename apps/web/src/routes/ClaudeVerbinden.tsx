import { MCP_CLIENT_ID, MCP_REDIRECT_URIS } from '@hotelpms/contracts'
import type { JSX } from 'react'
import { useT } from '../lib/i18n/index.js'
import { useMcpConsent } from '../lib/queries/mcp.js'
import { Fehler } from '../components/Fehler.tsx'

/**
 * `/mcp-verbinden`: hierher leitet claude.ai beim Verbinden des
 * Claude-Zugangs weiter (Dokument 38).
 *
 * Erst nach der Anmeldung erreichbar, und die Plattformrechte gelten nur mit
 * Passkey-Sitzung (0211) -- die Anmeldung hier ist also die mit Passkey. Der
 * Knopf verlangt dazu eine frische Bestaetigung: an einem Rechner, an dem
 * jemand kurz aufsteht, soll niemand nebenbei Claude anschliessen.
 *
 * Geprueft wird in der Schnittstelle; hier nur so viel, dass eine
 * offensichtlich falsche Anfrage keinen Knopf bekommt.
 */

export function istClaudeVerbinden(pathname: string = location.pathname): boolean {
  return pathname.replace(/\/+$/, '') === '/mcp-verbinden'
}

export function ClaudeVerbinden({ darf }: { darf: boolean }): JSX.Element {
  const t = useT()
  const zustimmen = useMcpConsent()
  const p = new URLSearchParams(location.search)
  const redirectUri = p.get('redirect_uri') ?? ''
  const gueltig = p.get('response_type') === 'code'
    && p.get('client_id') === MCP_CLIENT_ID
    && MCP_REDIRECT_URIS.includes(redirectUri)
    && (p.get('code_challenge') ?? '') !== ''
    && p.get('code_challenge_method') === 'S256'

  const erlauben = () => zustimmen.mutate({
    clientId: p.get('client_id') ?? '',
    redirectUri,
    codeChallenge: p.get('code_challenge') ?? '',
    codeChallengeMethod: 'S256',
    state: p.get('state') ?? ''
  }, { onSuccess: r => location.assign(r.redirectTo) })

  // Abbrechen sagt claude.ai, dass abgelehnt wurde -- aber nur an eine
  // Adresse aus der festen Liste, nie an eine aus der Anfrage allein.
  const abbrechen = () => {
    if (!gueltig) { location.replace('/'); return }
    const ziel = new URL(redirectUri)
    ziel.searchParams.set('error', 'access_denied')
    const state = p.get('state')
    if (state !== null) ziel.searchParams.set('state', state)
    location.assign(ziel.toString())
  }

  return (
    <div className="min-h-screen grid place-items-center p-8">
      <div className="grid gap-4 max-w-md text-sm">
        <h1 className="text-lg font-medium">{t('mcp.connect.title')}</h1>
        {!gueltig && <p className="text-red-800">{t('mcp.connect.invalid')}</p>}
        {gueltig && !darf && <p className="text-red-800">{t('mcp.connect.noPermission')}</p>}
        {gueltig && darf && <p className="text-neutral-700">{t('mcp.connect.text')}</p>}
        {zustimmen.isError && <Fehler error={zustimmen.error} />}
        <div className="flex gap-2">
          {gueltig && darf && (
            <button type="button" onClick={erlauben} disabled={zustimmen.isPending}
                    className="px-3 py-1.5 rounded-sm bg-neutral-900 text-white
                               disabled:opacity-40">
              {t('mcp.connect.allow')}
            </button>
          )}
          <button type="button" onClick={abbrechen}
                  className="px-3 py-1.5 rounded-sm border border-neutral-300 bg-white">
            {t('mcp.connect.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
