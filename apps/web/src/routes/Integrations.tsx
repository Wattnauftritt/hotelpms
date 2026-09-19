import { useState } from 'react'
import type { JSX } from 'react'
import type { WebhookSubscription, OAuthClient, ChannelConnection, PropertyUser,
              PropertyRole } from '@hotelpms/contracts'
import { useWebhookSubscriptions, useWebhookDeliveries, useCreateWebhook,
         useSetWebhookStatus, useOAuthClients, useCreateOAuthClient,
         useRevokeOAuthClient, useChannelConnections, useCreateChannelConnection,
         useDisableChannelConnection, usePropertyUsers, useRoles, useSetUserRoles,
         useInviteUser, useUserAction, useRenameUser, useRemoveUser,
         useAccountRoles, useSetAccountRoles }
  from '../lib/queries/integrations.js'
import { useHausrechte } from '../lib/rechte.js'
import { useReiter } from '../lib/reiter.js'
import { useT, useLocale, type TextKey } from '../lib/i18n/index.js'
import { apiText } from '../lib/meldungen.js'
import { useOnline } from '../lib/offline.js'
import { Fehler, Laedt } from '../components/Shell.tsx'

/**
 * Schnittstellen: Webhooks, Maschinenzugänge, Channel Manager, Benutzer.
 *
 * **Ein Geheimnis wird einmal gezeigt und nie wieder.** Ein angezeigtes
 * Geheimnis, das sich erneut abrufen lässt, liegt in jedem Bildschirmfoto.
 * Die API gibt es deshalb nur bei der Anlage heraus; die Maske hält es
 * sichtbar, bis der Benutzer ausdrücklich bestätigt, dass er es notiert hat.
 *
 * **Zugriffsbereiche sind Rechte, kein zweites System.** Ein Maschinenzugang
 * bekommt dieselben Schlüssel, die auch ein Mensch hat. Die Liste kommt von
 * der API, nicht aus einer Aufzählung hier — sonst fehlt nach dem nächsten
 * neuen Recht genau dieses.
 */

const REITER = ['webhooks', 'clients', 'channel', 'users'] as const
type Reiter = (typeof REITER)[number]

interface Bereich { key: Reiter; label: TextKey }

export function schnittstellenBereiche(darf: (p: string) => boolean): Bereich[] {
  const bereiche: Bereich[] = []
  if (darf('integration:manage')) {
    bereiche.push({ key: 'webhooks', label: 'int.tab.webhooks' })
    bereiche.push({ key: 'clients', label: 'int.tab.clients' })
    bereiche.push({ key: 'channel', label: 'int.tab.channel' })
  }
  if (darf('user:manage')) bereiche.push({ key: 'users', label: 'int.tab.users' })
  return bereiche
}

const knopf = 'text-sm px-3 py-1.5 rounded border border-neutral-300 ' +
              'hover:bg-neutral-50 disabled:opacity-40'
const knopfStark = 'text-sm px-3 py-1.5 rounded bg-neutral-900 text-white ' +
                   'disabled:opacity-40'
const feld = 'border border-neutral-300 rounded px-2 py-1'

/**
 * Ein Geheimnis, das genau jetzt zu sehen ist.
 *
 * Es bleibt stehen, bis jemand bestätigt, es notiert zu haben — nicht bis
 * zum nächsten Neuladen. Wer es wegklickt, weil er den Kasten für einen
 * Hinweis hielt, bekommt es nicht zurück.
 */
function Geheimnis(
  { wert, hinweis, onDone }: { wert: string; hinweis?: string; onDone: () => void }
): JSX.Element {
  const t = useT()
  return (
    <div className="rounded border border-amber-300 bg-amber-50 p-3 space-y-2"
         role="alert">
      <div className="font-medium text-amber-900">{t('secret.title')}</div>
      <code className="block break-all bg-white border border-amber-200 rounded
                       px-2 py-1 text-xs">{wert}</code>
      <div className="text-xs text-amber-900">{t('secret.hint')}</div>
      {hinweis !== undefined && (
        <div className="text-xs text-neutral-600">{hinweis}</div>
      )}
      <div className="flex gap-2">
        <button onClick={() => { void navigator.clipboard?.writeText(wert) }}
                className={knopf}>{t('secret.copy')}</button>
        <button onClick={onDone} className={knopfStark}>{t('secret.done')}</button>
      </div>
    </div>
  )
}

function Zeitpunkt({ wert, leer }: { wert: string | null; leer: TextKey }): JSX.Element {
  const t = useT()
  return <>{wert === null ? t(leer) : new Date(wert).toLocaleString()}</>
}

// ------------------------------------------------------------------ Webhooks

function Zustellungen({ subscriptionRef }: { subscriptionRef: string }): JSX.Element {
  const t = useT()
  const q = useWebhookDeliveries(subscriptionRef)

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  if (q.data.deliveries.length === 0) {
    return <div className="mt-1 text-sm text-neutral-500">{t('hook.noDeliveries')}</div>
  }

  return (
    <ul className="mt-1 space-y-1">
      {q.data.deliveries.map(d => (
        <li key={d.eventRef} className="text-sm flex flex-wrap gap-x-3 items-baseline">
          <span className="font-mono text-xs text-neutral-500">{d.eventType}</span>
          <span className={d.status === 'delivered' ? 'text-emerald-700'
                                                    : 'text-red-700'}>
            {d.status}
          </span>
          <span className="text-neutral-500">
            {t('hook.attempts')}: {d.attempts}
            {d.lastStatusCode !== null && ` · HTTP ${d.lastStatusCode}`}
          </span>
          <span className="text-neutral-500">
            <Zeitpunkt wert={d.deliveredAt ?? d.occurredAt} leer="client.never" />
          </span>
          {/* Der Grund gehört an die Zeile: wer nachsieht, warum nichts
              ankommt, soll nicht erst ein Protokoll aufschlagen müssen. */}
          {d.lastError !== null && (
            <span className="text-red-700 basis-full">
              {t('hook.lastError')}: {d.lastError}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function Abonnement({ hook }: { hook: WebhookSubscription }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const [offen, setOffen] = useState(false)
  const status = useSetWebhookStatus()
  const aktiv = hook.status === 'active'

  return (
    <li className={`rounded border border-neutral-200 bg-white p-3
                    ${aktiv ? '' : 'opacity-70'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <code className="text-sm break-all grow">{hook.url}</code>
        <span className={`text-xs px-1.5 py-0.5 rounded border ${
          aktiv ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : 'border-red-300 bg-red-50 text-red-900'}`}>
          {t(aktiv ? 'hook.status.active' : 'hook.status.disabled')}
        </span>
        <button onClick={() => setOffen(o => !o)} className={knopf}>
          {t('hook.deliveries')}
        </button>
        <button onClick={() => status.mutate({ ref: hook.subscriptionRef, aktiv: !aktiv })}
                disabled={!online || status.isPending} className={knopf}>
          {t(aktiv ? 'hook.disable' : 'hook.enable')}
        </button>
      </div>

      <div className="mt-1 text-xs text-neutral-500">
        {hook.allEventTypes ? t('hook.allEventTypes') : hook.eventTypes.join(', ')}
      </div>
      {/* Warum stillgelegt, steht an der Zeile. Sonst ist der einzige Weg
          zur Antwort das Protokoll des Workers. */}
      {hook.disabledReason !== null && (
        <div className="mt-1 text-xs text-red-800">
          {t('hook.disabledBecause')}: {hook.disabledReason}
        </div>
      )}
      {!aktiv && <div className="mt-1 text-xs text-neutral-500">{t('hook.enableHint')}</div>}

      {status.isError && <div className="mt-2"><Fehler error={status.error} /></div>}
      {offen && <Zustellungen subscriptionRef={hook.subscriptionRef} />}
    </li>
  )
}

function Webhooks(): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const q = useWebhookSubscriptions()
  const anlegen = useCreateWebhook()
  const [url, setUrl] = useState('https://')
  const [arten, setArten] = useState<string[]>([])
  const [geheimnis, setGeheimnis] = useState<{ wert: string; hinweis: string } | null>(null)

  const umschalten = (art: string): void => {
    setArten(a => a.includes(art) ? a.filter(x => x !== art) : [...a, art])
  }

  return (
    <div className="space-y-4">
      {geheimnis !== null && (
        <Geheimnis wert={geheimnis.wert} hinweis={geheimnis.hinweis}
                   onDone={() => setGeheimnis(null)} />
      )}

      <form className="rounded border border-neutral-200 bg-white p-3 space-y-3"
            onSubmit={e => {
              e.preventDefault()
              anlegen.mutate(
                { url: url.trim(), ...(arten.length === 0 ? {} : { eventTypes: arten }) },
                { onSuccess: r => {
                    setGeheimnis({ wert: r.signingSecret,
                                   hinweis: apiText(r.hinweisKey, r.hinweis, locale) })
                    setUrl('https://'); setArten([])
                  } })
            }}>
        <div className="font-medium">{t('hook.new')}</div>
        <label className="text-sm block">
          <div className="text-neutral-600">{t('hook.url')}</div>
          <input value={url} onChange={e => setUrl(e.target.value)} required
                 className={`${feld} w-full max-w-xl`} />
          <div className="text-xs text-neutral-500 mt-0.5">{t('hook.urlHint')}</div>
        </label>
        <div className="text-sm">
          <div className="text-neutral-600">{t('hook.eventTypes')}</div>
          <div className="flex flex-wrap gap-3 mt-1">
            {(q.data?.availableEventTypes ?? []).map(art => (
              <label key={art} className="flex items-center gap-1.5 text-neutral-700">
                <input type="checkbox" checked={arten.includes(art)}
                       onChange={() => umschalten(art)} />
                <code className="text-xs">{art}</code>
              </label>
            ))}
          </div>
          {/* Nichts angekreuzt heißt alle. Das ausdrücklich zu sagen ist
              nötig: eine leere Auswahl liest sich sonst als "keine". */}
          {arten.length === 0 && (
            <div className="text-xs text-neutral-500 mt-0.5">{t('hook.allEventTypes')}</div>
          )}
        </div>
        <div className="text-xs text-neutral-500">{t('hook.signature')}</div>
        {anlegen.isError && <Fehler error={anlegen.error} />}
        <button type="submit" disabled={!online || anlegen.isPending}
                className={knopfStark}>{t('common.save')}</button>
      </form>

      {q.isError
        ? <Fehler error={q.error} />
        : q.data === undefined
          ? <Laedt />
          : q.data.subscriptions.length === 0
            ? <div className="text-sm text-neutral-500">{t('common.none')}</div>
            : <ul className="space-y-2">
                {q.data.subscriptions.map(h => (
                  <Abonnement key={h.subscriptionRef} hook={h} />
                ))}
              </ul>}
    </div>
  )
}

// ------------------------------------------------------- Maschinenzugaenge

function Zugang({ client }: { client: OAuthClient }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const sperren = useRevokeOAuthClient()
  const aktiv = client.status === 'active'

  return (
    <li className={`rounded border border-neutral-200 bg-white p-3
                    ${aktiv ? '' : 'opacity-70'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium grow">{client.name}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded border ${
          aktiv ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : 'border-neutral-300 bg-neutral-100 text-neutral-600'}`}>
          {t(aktiv ? 'client.status.active' : 'client.status.disabled')}
        </span>
        {aktiv && (
          <button onClick={() => {
                    if (confirm(t('client.revokeConfirm'))) sperren.mutate(client.clientId)
                  }}
                  disabled={!online || sperren.isPending} className={knopf}>
            {t('client.revoke')}
          </button>
        )}
      </div>
      <div className="mt-0.5 text-xs text-neutral-500 flex flex-wrap gap-x-4">
        <code>{client.clientId}</code>
        <span>{t('client.activeTokens')}: {client.activeTokens}</span>
        <span>
          {t('client.lastUsed')}: <Zeitpunkt wert={client.lastUsedAt} leer="client.never" />
        </span>
        <span>
          {client.propertyIds.length === 0
            ? t('client.allProperties')
            : client.propertyIds.join(', ')}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {client.scopes.map(s => (
          <code key={s} className="text-xs px-1.5 py-0.5 rounded bg-neutral-100
                                   border border-neutral-200">{s}</code>
        ))}
      </div>
      {sperren.isError && <div className="mt-2"><Fehler error={sperren.error} /></div>}
    </li>
  )
}

function Maschinenzugaenge(): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const q = useOAuthClients()
  const anlegen = useCreateOAuthClient()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [geheimnis, setGeheimnis] = useState<{ wert: string; hinweis: string } | null>(null)

  const umschalten = (s: string): void => {
    setScopes(x => x.includes(s) ? x.filter(y => y !== s) : [...x, s])
  }

  return (
    <div className="space-y-4">
      {geheimnis !== null && (
        <Geheimnis wert={geheimnis.wert} hinweis={geheimnis.hinweis}
                   onDone={() => setGeheimnis(null)} />
      )}

      <form className="rounded border border-neutral-200 bg-white p-3 space-y-3"
            onSubmit={e => {
              e.preventDefault()
              if (name.trim() === '' || scopes.length === 0) return
              anlegen.mutate({ name: name.trim(), scopes },
                { onSuccess: r => {
                    setGeheimnis({
                      wert: `${r.clientId}:${r.clientSecret}`,
                      hinweis: apiText(r.hinweisKey, r.hinweis, locale) })
                    setName(''); setScopes([])
                  } })
            }}>
        <div className="font-medium">{t('client.new')}</div>
        <label className="text-sm block">
          <div className="text-neutral-600">{t('client.name')}</div>
          <input value={name} onChange={e => setName(e.target.value)} required
                 className={`${feld} w-64`} />
        </label>
        <div className="text-sm">
          <div className="text-neutral-600">{t('client.scopes')}</div>
          {/* Die Liste kommt von der API, nicht aus einer Aufzählung hier:
              sonst fehlt nach dem nächsten neuen Recht genau dieses. */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 max-h-48 overflow-y-auto">
            {(q.data?.availableScopes ?? []).map(s => (
              <label key={s} className="flex items-center gap-1.5 text-neutral-700">
                <input type="checkbox" checked={scopes.includes(s)}
                       onChange={() => umschalten(s)} />
                <code className="text-xs">{s}</code>
              </label>
            ))}
          </div>
          <div className="text-xs text-neutral-500 mt-1">{t('client.scopesHint')}</div>
        </div>
        {anlegen.isError && <Fehler error={anlegen.error} />}
        <button type="submit"
                disabled={!online || anlegen.isPending || name.trim() === ''
                          || scopes.length === 0}
                className={knopfStark}>{t('common.save')}</button>
      </form>

      {q.isError
        ? <Fehler error={q.error} />
        : q.data === undefined
          ? <Laedt />
          : q.data.clients.length === 0
            ? <div className="text-sm text-neutral-500">{t('common.none')}</div>
            : <ul className="space-y-2">
                {q.data.clients.map(c => <Zugang key={c.clientId} client={c} />)}
              </ul>}
    </div>
  )
}

// -------------------------------------------------------- Channel Manager

function Verbindung(
  { conn, propertyId }: { conn: ChannelConnection; propertyId: number }
): JSX.Element {
  const t = useT()
  const online = useOnline()
  const sperren = useDisableChannelConnection(propertyId)
  const aktiv = conn.status === 'active'

  return (
    <li className={`rounded border border-neutral-200 bg-white p-3
                    ${aktiv ? '' : 'opacity-70'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium grow">{conn.name}</span>
        <span className="text-xs text-neutral-500">{conn.provider}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded border ${
          aktiv ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : 'border-neutral-300 bg-neutral-100 text-neutral-600'}`}>
          {t(aktiv ? 'chan.status.active' : 'chan.status.disabled')}
        </span>
        {aktiv && (
          <button onClick={() => sperren.mutate(conn.connectionRef)}
                  disabled={!online || sperren.isPending} className={knopf}>
            {t('chan.disable')}
          </button>
        )}
      </div>
      <div className="mt-0.5 text-xs text-neutral-500">
        {t('chan.lastUsed')}: <Zeitpunkt wert={conn.lastUsedAt} leer="chan.never" />
      </div>
      {sperren.isError && <div className="mt-2"><Fehler error={sperren.error} /></div>}
    </li>
  )
}

function ChannelManager({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const q = useChannelConnections(propertyId)
  const anlegen = useCreateChannelConnection(propertyId)
  const [name, setName] = useState('')
  const [geheimnis, setGeheimnis] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      {geheimnis !== null && (
        <Geheimnis wert={geheimnis} onDone={() => setGeheimnis(null)} />
      )}

      <form className="rounded border border-neutral-200 bg-white p-3 space-y-3"
            onSubmit={e => {
              e.preventDefault()
              if (name.trim() === '') return
              anlegen.mutate({ provider: 'roomcloud', name: name.trim() },
                { onSuccess: r => { setGeheimnis(r.token); setName('') } })
            }}>
        <div className="font-medium">{t('chan.new')}</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <div className="text-neutral-600">{t('chan.provider')}</div>
            {/* Nur ein Anbieter ist angebunden. Eine Auswahl mit einem
                Eintrag ist ehrlicher als ein Freitextfeld, das 422 gibt. */}
            <select className={feld} value="roomcloud" disabled>
              <option value="roomcloud">roomcloud</option>
            </select>
          </label>
          <label className="text-sm">
            <div className="text-neutral-600">{t('chan.name')}</div>
            <input value={name} onChange={e => setName(e.target.value)} required
                   className={`${feld} w-64`} />
          </label>
          <button type="submit" disabled={!online || anlegen.isPending}
                  className={knopfStark}>{t('common.save')}</button>
        </div>
        {anlegen.isError && <Fehler error={anlegen.error} />}
      </form>

      <div className="text-xs text-neutral-500">{t('chan.pullHint')}</div>

      {q.isError
        ? <Fehler error={q.error} />
        : q.data === undefined
          ? <Laedt />
          : q.data.connections.length === 0
            ? <div className="text-sm text-neutral-500">{t('common.none')}</div>
            : <ul className="space-y-2">
                {q.data.connections.map(c => (
                  <Verbindung key={c.connectionRef} conn={c} propertyId={propertyId} />
                ))}
              </ul>}
    </div>
  )
}

// ---------------------------------------------------- Benutzer und Rollen
//
// Der Kunde verwaltet sein Personal selbst (0040): einladen, Rollen, Name,
// Link, entsperren, sperren, entfernen. Zwei Ebenen, zwei Rechte -- und die
// Grenze dazwischen zeigt die Oberflaeche so, wie die API sie zieht: wer den
// Betrieb nicht verwaltet, sieht an einem Inhaber keinen Knopf, der ihm
// ohnehin nur mit 403 antwortete.

function RollenWahl({ rollen, gewaehlt, onChange }: {
  rollen: PropertyRole[]; gewaehlt: string[]; onChange: (keys: string[]) => void
}): JSX.Element {
  const umschalten = (key: string): void => {
    onChange(gewaehlt.includes(key) ? gewaehlt.filter(x => x !== key) : [...gewaehlt, key])
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {rollen.map(r => (
        <label key={r.key} className="text-sm flex items-center gap-1.5">
          <input type="checkbox" checked={gewaehlt.includes(r.key)}
                 onChange={() => umschalten(r.key)} />
          {r.name}
          <span className="text-xs text-neutral-400">({r.permissions.length})</span>
        </label>
      ))}
    </div>
  )
}

function BenutzerZeile(
  { benutzer, rollen, betriebsrollen, propertyId, darfBetrieb, istSelbst }:
  { benutzer: PropertyUser; rollen: PropertyRole[]; betriebsrollen: PropertyRole[]
    propertyId: number; darfBetrieb: boolean; istSelbst: boolean }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const [offen, setOffen] = useState<'rollen' | 'betrieb' | 'name' | null>(null)
  const [gewaehlt, setGewaehlt] = useState(benutzer.roles.map(r => r.key))
  const [betrieb, setBetrieb] = useState(benutzer.accountRoles.map(r => r.key))
  const [name, setName] = useState(benutzer.displayName)
  const setzen = useSetUserRoles(propertyId)
  const betriebSetzen = useSetAccountRoles(propertyId)
  const aktion = useUserAction(propertyId)
  const umbenennen = useRenameUser(propertyId)
  const entfernen = useRemoveUser(propertyId)

  /*
   * Wer eine Rolle fuer den ganzen Betrieb traegt, wird nur von jemandem
   * mit settings:account angefasst -- sonst koennte die Direktion eines
   * Hauses den Inhaber sperren. Die API weist es ab; hier fehlt dann der
   * Knopf, statt dass er mit 403 antwortet.
   */
  const anfassbar = benutzer.accountRoles.length === 0 || darfBetrieb
  const zeit = (iso: string) =>
    new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })
  const fehler = [setzen, betriebSetzen, aktion, umbenennen, entfernen].find(m => m.isError)

  return (
    <li className={`rounded border bg-white p-3 ${benutzer.blocked
      ? 'border-red-200' : 'border-neutral-200'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{benutzer.displayName}</span>
        {istSelbst && <span className="text-xs text-neutral-400">{t('user.you')}</span>}
        <span className="text-sm text-neutral-500 grow">{benutzer.email}</span>
        {benutzer.blocked ? (
          <span className="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-900
                           border border-red-200">{t('user.blocked')}</span>
        ) : (
          <span className="text-xs text-neutral-500">
            {t(`user.status.${benutzer.status === 'active' ? 'active'
                : benutzer.status === 'invited' ? 'invited' : 'disabled'}`)}
          </span>
        )}
        <span className="text-xs text-neutral-500">
          {t('user.lastLogin')}: <Zeitpunkt wert={benutzer.lastLoginAt} leer="user.never" />
        </span>
      </div>

      <div className="mt-1 flex flex-wrap gap-1">
        {benutzer.accountRoles.map(r => (
          <span key={r.key} className="text-xs px-1.5 py-0.5 rounded
                                       bg-amber-50 border border-amber-200">
            {r.name}
          </span>
        ))}
        {benutzer.roles.length === 0 && benutzer.accountRoles.length === 0
          ? <span className="text-xs text-neutral-500">{t('user.noRoles')}</span>
          : benutzer.roles.map(r => (
              <span key={r.key} className="text-xs px-1.5 py-0.5 rounded
                                           bg-neutral-100 border border-neutral-200">
                {r.name}
              </span>
            ))}
      </div>
      {benutzer.lockedUntil !== null && (
        <p className="mt-1 text-xs text-red-800">
          {t('user.lockedUntil', { bis: zeit(benutzer.lockedUntil) })}
        </p>
      )}
      {/* Die Rechte stehen so da, wie die API sie liefert. Aus dem
          Rollennamen darauf zu schließen, geht bei der ersten eigenen Rolle
          eines Kunden schief -- und zwar lautlos. */}
      <details className="mt-1">
        <summary className="text-xs text-neutral-600 cursor-pointer">
          {t('user.permissions')} ({benutzer.permissions.length})
        </summary>
        <div className="mt-1 flex flex-wrap gap-1">
          {benutzer.permissions.map(p => (
            <code key={p} className="text-xs px-1.5 py-0.5 rounded bg-neutral-50
                                     border border-neutral-200">{p}</code>
          ))}
        </div>
      </details>

      {anfassbar && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button onClick={() => setOffen(o => o === 'rollen' ? null : 'rollen')}
                  className={knopf}>{t('user.edit')}</button>
          {darfBetrieb && (
            <button onClick={() => setOffen(o => o === 'betrieb' ? null : 'betrieb')}
                    className={knopf}>{t('user.accountRoles')}</button>
          )}
          <button onClick={() => setOffen(o => o === 'name' ? null : 'name')}
                  className={knopf}>{t('user.rename')}</button>
          {!benutzer.blocked && benutzer.status !== 'disabled' && (
            <button disabled={!online || aktion.isPending} className={knopf}
                    onClick={() => aktion.mutate({ userRef: benutzer.userRef,
                                                   action: 'access-link' })}>
              {t(benutzer.status === 'invited' ? 'user.sendInvite' : 'user.sendReset')}
            </button>
          )}
          {benutzer.lockedUntil !== null && (
            <button disabled={!online || aktion.isPending} className={knopf}
                    onClick={() => aktion.mutate({ userRef: benutzer.userRef,
                                                   action: 'unlock' })}>
              {t('user.unlock')}
            </button>
          )}
          {/* Der eigene Zugang traegt weder Sperre noch Entfernen. Die
              Route weist beides ab -- ein Knopf, der nur 409 sagt, ist eine
              Falle und keine Sicherung. */}
          {!istSelbst && (
            <>
              <button disabled={!online || aktion.isPending} className={knopf}
                      onClick={() => {
                        if (benutzer.blocked) {
                          aktion.mutate({ userRef: benutzer.userRef, action: 'unblock' })
                        } else if (window.confirm(
                            t('user.blockConfirm', { name: benutzer.displayName }))) {
                          aktion.mutate({ userRef: benutzer.userRef, action: 'block' })
                        }
                      }}>
                {t(benutzer.blocked ? 'user.unblock' : 'user.block')}
              </button>
              <button disabled={!online || entfernen.isPending}
                      className={`${knopf} text-red-800`}
                      onClick={() => {
                        if (window.confirm(
                            t('user.removeConfirm', { name: benutzer.displayName }))) {
                          entfernen.mutate(benutzer.userRef)
                        }
                      }}>
                {t('user.remove')}
              </button>
            </>
          )}
          {aktion.isSuccess && aktion.data.kind !== undefined && (
            <span className="text-xs text-green-800 self-center">{t('user.linkSent')}</span>
          )}
        </div>
      )}

      {fehler !== undefined && <div className="mt-2"><Fehler error={fehler.error} /></div>}

      {offen === 'rollen' && (
        <form className="mt-3 space-y-2"
              onSubmit={e => {
                e.preventDefault()
                setzen.mutate({ userRef: benutzer.userRef, roleKeys: gewaehlt },
                  { onSuccess: () => setOffen(null) })
              }}>
          <RollenWahl rollen={rollen} gewaehlt={gewaehlt} onChange={setGewaehlt} />
          <button type="submit" disabled={!online || setzen.isPending}
                  className={knopfStark}>{t('common.save')}</button>
        </form>
      )}

      {offen === 'betrieb' && (
        <form className="mt-3 space-y-2"
              onSubmit={e => {
                e.preventDefault()
                betriebSetzen.mutate({ userRef: benutzer.userRef, roleKeys: betrieb },
                  { onSuccess: () => setOffen(null) })
              }}>
          <p className="text-xs text-neutral-500">{t('user.accountRolesHint')}</p>
          <RollenWahl rollen={betriebsrollen} gewaehlt={betrieb} onChange={setBetrieb} />
          <button type="submit" disabled={!online || betriebSetzen.isPending}
                  className={knopfStark}>{t('common.save')}</button>
        </form>
      )}

      {offen === 'name' && (
        <form className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={e => {
                e.preventDefault()
                umbenennen.mutate({ userRef: benutzer.userRef, displayName: name.trim() },
                  { onSuccess: () => setOffen(null) })
              }}>
          <label className="block grow max-w-xs">
            <span className="block text-xs text-neutral-600">{t('user.name')}</span>
            <input required value={name} onChange={e => setName(e.target.value)}
                   className={feld} />
          </label>
          <button type="submit" disabled={!online || umbenennen.isPending}
                  className={knopfStark}>{t('common.save')}</button>
        </form>
      )}
    </li>
  )
}

/**
 * Einladen. Die Person bekommt eine E-Mail und setzt ihr Kennwort selbst --
 * ein Kennwort, das der Chef auf einen Zettel schreibt, bleibt auf dem
 * Zettel.
 */
function BenutzerEinladen({ propertyId, rollen }: {
  propertyId: number; rollen: PropertyRole[]
}): JSX.Element {
  const t = useT()
  const online = useOnline()
  const einladen = useInviteUser(propertyId)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [gewaehlt, setGewaehlt] = useState<string[]>(['reception'])

  return (
    <form className="rounded border border-neutral-200 bg-white p-3 space-y-2"
          onSubmit={e => {
            e.preventDefault()
            einladen.mutate({ email: email.trim(), displayName: name.trim(),
                              roleKeys: gewaehlt },
              { onSuccess: () => { setEmail(''); setName('') } })
          }}>
      <div className="font-medium text-sm">{t('user.invite')}</div>
      <p className="text-xs text-neutral-500">{t('user.inviteHint')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('user.name')}</span>
          <input required value={name} onChange={e => setName(e.target.value)}
                 className={feld} />
        </label>
        <label className="block">
          <span className="block text-xs text-neutral-600">{t('user.email')}</span>
          <input required type="email" value={email}
                 onChange={e => setEmail(e.target.value)} className={feld} />
        </label>
      </div>
      <RollenWahl rollen={rollen} gewaehlt={gewaehlt} onChange={setGewaehlt} />
      {einladen.isError && <Fehler error={einladen.error} />}
      {einladen.isSuccess && (
        <p className="text-sm text-green-900 bg-green-50 border border-green-200
                      rounded px-2 py-1">{t('user.invited')}</p>
      )}
      <button type="submit" disabled={!online || einladen.isPending || gewaehlt.length === 0}
              className={knopfStark}>{t('user.invite')}</button>
    </form>
  )
}

function Benutzer({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const { darfKonto } = useHausrechte(propertyId)
  const darfBetrieb = darfKonto('settings:account')
  const q = usePropertyUsers(propertyId)
  const rollen = useRoles()
  const betriebsrollen = useAccountRoles(propertyId, darfBetrieb)

  return (
    <div className="space-y-4">
      <div className="text-xs text-neutral-500">
        {t('user.rolesHint')} {t('user.noCreate')}
      </div>

      {q.isError
        ? <Fehler error={q.error} />
        : q.data === undefined || rollen.data === undefined
          ? <Laedt />
          : <>
              {q.data.users.length === 0
                ? <div className="text-sm text-neutral-500">{t('common.none')}</div>
                : <ul className="space-y-2">
                    {q.data.users.map(u => (
                      <BenutzerZeile key={u.userRef} benutzer={u}
                                     rollen={rollen.data.roles}
                                     betriebsrollen={betriebsrollen.data?.roles ?? []}
                                     propertyId={propertyId} darfBetrieb={darfBetrieb}
                                     istSelbst={u.isSelf} />
                    ))}
                  </ul>}
              <BenutzerEinladen propertyId={propertyId} rollen={rollen.data.roles} />
            </>}
    </div>
  )
}

export function Integrations({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const { darf, geladen } = useHausrechte(propertyId)
  const [reiter, setReiter] = useReiter<Reiter>('int', REITER, 'webhooks')

  const bereiche = schnittstellenBereiche(darf)
  if (!geladen) return <Laedt />
  if (bereiche.length === 0) {
    return <div className="text-sm text-neutral-500">{t('report.nothingAllowed')}</div>
  }
  const aktiv = bereiche.find(b => b.key === reiter) ?? bereiche[0]!

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">{t('int.title')}</h1>

      <div className="flex flex-wrap gap-1 border-b border-neutral-200">
        {bereiche.map(b => (
          <button key={b.key} onClick={() => setReiter(b.key)}
                  aria-current={b.key === aktiv.key ? 'page' : undefined}
                  className={`text-sm px-3 py-1.5 -mb-px border-b-2 ${
                    b.key === aktiv.key
                      ? 'border-neutral-900 font-medium'
                      : 'border-transparent text-neutral-600 hover:text-neutral-900'}`}>
            {t(b.label)}
          </button>
        ))}
      </div>

      {aktiv.key === 'webhooks' && <Webhooks />}
      {aktiv.key === 'clients' && <Maschinenzugaenge />}
      {aktiv.key === 'channel' && <ChannelManager propertyId={propertyId} />}
      {aktiv.key === 'users' && <Benutzer propertyId={propertyId} />}
    </div>
  )
}
