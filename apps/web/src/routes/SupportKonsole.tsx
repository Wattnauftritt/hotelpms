import { useState } from 'react'
import type { JSX } from 'react'
import { usePlatformSupportSessions, useRequestSupportSession,
         useDeployments, useRequestDeployment,
         type SupportSession, type Deployment } from '../lib/queries/support.js'
import { useT, useLocale, type TextKey } from '../lib/i18n/index.js'
import { fehlerMeldung } from '../lib/meldungen.js'
import { Fehler, Laedt } from '../components/Shell.tsx'

/**
 * Die Konsole der Plattform.
 *
 * **Sie zeigt keine Kundendaten, und das ist kein Mangel.** Ohne
 * freigegebene Sitzung hat Plattformpersonal einen leeren Mandantenkontext;
 * die Zeilenrichtlinie liefert nichts, und keine Route gibt etwas heraus.
 * Was hier steht, sind die eigenen Anfragen und ihr Stand -- die Arbeit
 * selbst geschieht danach in der normalen Oberflaeche, im Haus des Kunden
 * und unter dessen Freigabe.
 *
 * Deshalb liegt sie auch dort, wo sonst „diesem Benutzer ist kein Haus
 * zugeordnet" stuende: fuer Plattformpersonal ohne laufende Sitzung ist das
 * der richtige Bildschirm, nicht eine Fehlermeldung.
 */

const ZUSTAND: Record<SupportSession['state'], TextKey> = {
  pending: 'support.state.pending',
  active: 'support.state.active',
  expired: 'support.state.expired',
  revoked: 'support.state.revoked'
}

const FELD = 'mt-0.5 w-full border border-neutral-300 rounded px-2 py-1 text-sm'

function Anfrage(): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const anfragen = useRequestSupportSession()
  const [accountId, setAccountId] = useState('')
  const [reason, setReason] = useState('')
  const [level, setLevel] = useState<'read' | 'write'>('read')
  const [hours, setHours] = useState('2')

  return (
    <form className="space-y-3 max-w-md border border-neutral-200 rounded p-4"
      onSubmit={e => {
        e.preventDefault()
        anfragen.mutate({
          accountId: Number(accountId), reason: reason.trim(),
          level, hours: Number(hours)
        }, { onSuccess: () => { setReason(''); setAccountId('') } })
      }}>
      <p className="text-sm text-neutral-600">{t('support.console.hint')}</p>

      <label className="block">
        <span className="block text-xs text-neutral-600">{t('support.accountId')}</span>
        <input required inputMode="numeric" value={accountId}
               onChange={e => setAccountId(e.target.value)} className={FELD} />
      </label>

      {/*
        * Der Anlass ist Pflicht und ein Freitext. Er steht in der Mail an den
        * Kunden und bleibt an der Sitzung stehen -- er ist das, woran der
        * Kunde seine Entscheidung festmacht, und spaeter der Nachweis, wofuer
        * der Zugriff erbeten war.
        */}
      <label className="block">
        <span className="block text-xs text-neutral-600">{t('support.reason')}</span>
        <input required value={reason} onChange={e => setReason(e.target.value)}
               className={FELD} />
      </label>

      <label className="block">
        <span className="block text-xs text-neutral-600">{t('support.level')}</span>
        <select value={level} className={FELD}
                onChange={e => setLevel(e.target.value === 'write' ? 'write' : 'read')}>
          <option value="read">{t('support.level.read')}</option>
          <option value="write">{t('support.level.write')}</option>
        </select>
      </label>

      <label className="block">
        <span className="block text-xs text-neutral-600">{t('support.hours')}</span>
        <input required inputMode="numeric" value={hours}
               onChange={e => setHours(e.target.value)} className={FELD} />
      </label>

      {anfragen.isError && (
        <p role="alert" className="text-sm text-red-800 bg-red-50 border
                                   border-red-200 rounded px-2 py-1">
          {fehlerMeldung(anfragen.error, locale).text}
        </p>
      )}
      {anfragen.isSuccess && (
        <p className="text-sm text-green-900 bg-green-50 border border-green-200
                      rounded px-2 py-1">
          {t('support.requested')}
        </p>
      )}

      <button type="submit" disabled={anfragen.isPending}
              className="w-full py-1.5 text-sm rounded bg-neutral-900 text-white
                         disabled:bg-neutral-300">
        {t(anfragen.isPending ? 'common.loading' : 'support.request')}
      </button>
    </form>
  )
}

function Liste(): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const q = usePlatformSupportSessions()

  if (q.isPending) return <Laedt />
  if (q.isError) return <Fehler error={q.error} />
  if (q.data.sessions.length === 0) {
    return <p className="text-sm text-neutral-500">{t('common.none')}</p>
  }

  const zeit = (iso: string) =>
    new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })

  return (
    <ul className="space-y-2 max-w-2xl">
      {q.data.sessions.map(s => (
        <li key={s.id} className="border border-neutral-200 rounded p-3 text-sm
                                  space-y-1">
          <div className="flex items-start justify-between gap-2">
            <span className="font-medium">{s.accountName}</span>
            <span className="text-xs text-neutral-600">{t(ZUSTAND[s.state])}</span>
          </div>
          <p>{s.reason}</p>
          <p className="text-xs text-neutral-600">
            {t(s.level === 'write' ? 'support.level.write' : 'support.level.read')}
            {' · '}{t('support.until')}: {zeit(s.expiresAt)}
          </p>
          {s.grantedByName !== null && (
            <p className="text-xs text-neutral-500">
              {t('support.grantedBy', { name: s.grantedByName })}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

const DEPLOY_ZUSTAND: Record<Deployment['status'], TextKey> = {
  pending: 'deploy.state.pending',
  running: 'deploy.state.running',
  done: 'deploy.state.done',
  failed: 'deploy.state.failed'
}

/**
 * Ausrollen.
 *
 * **Der Knopf bestimmt den Zeitpunkt, nicht den Inhalt.** Was auf die
 * Maschine kommt, haengt am Git-Tag `produktion`; wer ihn verschiebt, gibt
 * frei. Ohne diese Trennung waere jeder Merge nach main ein Kandidat fuer
 * die Produktion, und bei mehreren Bearbeitern ist das der Normalfall.
 *
 * **Die API rollt nicht aus, sie reiht ein.** Sie laeuft unter
 * NoNewPrivileges; der Neustart der Dienste braucht sudo, und das ist ihr
 * gesperrt. Ein eigener Dienst auf der Maschine sieht minuetlich nach --
 * daher die Wartezeit nach dem Klick, und daher der Hinweis darauf.
 */
function Ausrollen(): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const q = useDeployments()
  const anfordern = useRequestDeployment()
  const [offenesLog, setOffenesLog] = useState<number | null>(null)

  const zeit = (iso: string) =>
    new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })

  const laeuft = q.data?.deployments.some(
    d => d.status === 'pending' || d.status === 'running') === true

  return (
    <section className="space-y-3 border border-neutral-200 rounded p-4 bg-white">
      <h2 className="text-sm font-medium">{t('deploy.title')}</h2>
      <p className="text-sm text-neutral-600">{t('deploy.hint')}</p>

      <p className="text-sm">
        <span className="text-neutral-600">{t('deploy.current')}: </span>
        {q.data?.currentCommit != null
          ? <code className="font-mono">{q.data.currentCommit.slice(0, 12)}</code>
          : <span className="text-neutral-500">{t('deploy.currentUnknown')}</span>}
      </p>

      {anfordern.isError && <Fehler error={anfordern.error} />}
      {anfordern.isSuccess && (
        <p className="text-sm text-green-900 bg-green-50 border border-green-200
                      rounded px-2 py-1">{t('deploy.requested')}</p>
      )}

      <button type="button" disabled={anfordern.isPending || laeuft}
              onClick={() => anfordern.mutate()}
              className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                         disabled:bg-neutral-300">
        {t(anfordern.isPending ? 'common.loading' : 'deploy.request')}
      </button>

      {q.isError && <Fehler error={q.error} />}
      {q.data !== undefined && q.data.deployments.length > 0 && (
        <ul className="space-y-1 text-xs">
          {q.data.deployments.slice(0, 8).map(d => (
            <li key={d.id} className="border-t border-neutral-100 pt-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={d.status === 'failed'
                  ? 'text-red-800 font-medium' : 'font-medium'}>
                  {t(DEPLOY_ZUSTAND[d.status])}
                </span>
                <span className="text-neutral-600">{zeit(d.requestedAt)}</span>
                <span className="text-neutral-500">
                  {d.requestedBy ?? t('deploy.byHand')}
                </span>
                {d.commitAfter !== null && (
                  <code className="font-mono text-neutral-500">
                    {d.commitAfter.slice(0, 12)}
                  </code>
                )}
                {d.log !== null && d.log !== '' && (
                  <button type="button"
                          onClick={() => setOffenesLog(
                            offenesLog === d.id ? null : d.id)}
                          className="underline underline-offset-2 text-neutral-600">
                    {t('deploy.showLog')}
                  </button>
                )}
              </div>
              {offenesLog === d.id && d.log !== null && (
                // Vorformatiert und scrollbar: eine Bauausgabe hat lange
                // Zeilen, und umgebrochen ist sie nicht mehr zu lesen.
                <pre className="mt-1 p-2 bg-neutral-50 border border-neutral-200
                                rounded overflow-x-auto whitespace-pre">
                  {d.log}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function SupportKonsole(): JSX.Element {
  const t = useT()
  return (
    <div className="min-h-screen bg-neutral-50 p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-lg font-semibold">{t('support.console')}</h1>
        <Anfrage />
        <section className="space-y-2">
          <h2 className="text-sm font-medium">{t('support.mine')}</h2>
          <Liste />
        </section>
        <Ausrollen />
      </div>
    </div>
  )
}
