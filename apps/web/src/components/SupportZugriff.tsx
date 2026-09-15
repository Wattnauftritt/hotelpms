import { useState } from 'react'
import type { JSX } from 'react'
import { useSupportSessions, useGrantSupportSession, useRevokeSupportSession,
         type SupportSession } from '../lib/queries/support.js'
import { useT, useLocale, type TextKey } from '../lib/i18n/index.js'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Support-Zugriff, Kundenseite.
 *
 * **Die Einwilligung ist die Sache, nicht die Verwaltung.** Der Bildschirm
 * ist deshalb so gebaut, dass vor der Entscheidung alles dasteht, was sie
 * traegt: wer fragt, warum, wie lange, und was damit erlaubt wird -- und
 * ausdruecklich auch, was auch dann nicht geht. Eine Einwilligung, bei der
 * man nachschlagen muesste, was man erlaubt, ist informiert nur dem Namen
 * nach (Art. 4 Nr. 11 DSGVO).
 *
 * Ablehnen steht gleichwertig neben Freigeben. Ein Bildschirm mit einem
 * grossen Ja und einem verschaemten Nein ist eine Suggestivfrage.
 */

const ZUSTAND: Record<SupportSession['state'], TextKey> = {
  pending: 'support.state.pending',
  active: 'support.state.active',
  expired: 'support.state.expired',
  revoked: 'support.state.revoked'
}

function Marke({ state }: { state: SupportSession['state'] }): JSX.Element {
  const t = useT()
  const farbe = state === 'active'
    ? 'bg-amber-100 text-amber-900 border-amber-300'
    : state === 'pending'
      ? 'bg-blue-50 text-blue-900 border-blue-300'
      : 'bg-neutral-100 text-neutral-600 border-neutral-300'
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border ${farbe}`}>
      {t(ZUSTAND[state])}
    </span>
  )
}

function Rechte({ s }: { s: SupportSession }): JSX.Element {
  const t = useT()
  const [offen, setOffen] = useState(false)
  return (
    <div className="text-xs text-neutral-600">
      <button type="button" onClick={() => setOffen(o => !o)}
              aria-expanded={offen}
              className="underline underline-offset-2">
        {t('support.showPermissions')}
      </button>
      {offen && (
        <div className="mt-1 space-y-1">
          <ul className="flex flex-wrap gap-1">
            {s.permissions.map(p => (
              <li key={p} className="px-1.5 py-0.5 bg-neutral-100 rounded font-mono">
                {p}
              </li>
            ))}
          </ul>
          <p className="text-neutral-500">{t('support.never')}</p>
        </div>
      )}
    </div>
  )
}

function Karte({ s }: { s: SupportSession }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const freigeben = useGrantSupportSession()
  const beenden = useRevokeSupportSession()
  const laeuft = freigeben.isPending || beenden.isPending

  const zeit = (iso: string) =>
    new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })

  return (
    <li className="border border-neutral-200 rounded p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm">
          <span className="text-neutral-600">{t('support.who')}: </span>
          <span className="font-medium">{s.staffName}</span>
        </div>
        <Marke state={s.state} />
      </div>

      {/* Der Anlass ist Kundentext, keine Beschriftung: er kommt vom Support
          und wird unveraendert gezeigt. */}
      <p className="text-sm">
        <span className="text-neutral-600">{t('support.reason')}: </span>{s.reason}
      </p>

      <p className="text-sm text-neutral-600">
        {t('support.level')}: {t(s.level === 'write'
          ? 'support.level.write' : 'support.level.read')}
        {' · '}{t('support.until')}: {zeit(s.expiresAt)}
      </p>

      {s.grantedByName !== null && (
        <p className="text-xs text-neutral-500">
          {t('support.grantedBy', { name: s.grantedByName })}
        </p>
      )}

      <Rechte s={s} />

      {s.state === 'pending' && (
        <div className="flex gap-2 pt-1">
          <button type="button" disabled={laeuft}
                  onClick={() => freigeben.mutate(s.id)}
                  className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                             disabled:bg-neutral-300">
            {t('support.grant')}
          </button>
          {/* Gleichwertig daneben, nicht kleiner: sonst ist die Frage keine. */}
          <button type="button" disabled={laeuft}
                  onClick={() => beenden.mutate(s.id)}
                  className="px-3 py-1.5 text-sm rounded border border-neutral-300
                             disabled:text-neutral-400">
            {t('support.deny')}
          </button>
        </div>
      )}

      {s.state === 'active' && (
        <div className="pt-1">
          {/* Der Widerruf muss so einfach sein wie die Erteilung
              (Art. 7 Abs. 3 DSGVO) -- also ein Knopf an derselben Stelle. */}
          <button type="button" disabled={laeuft}
                  onClick={() => beenden.mutate(s.id)}
                  className="px-3 py-1.5 text-sm rounded border border-neutral-300
                             disabled:text-neutral-400">
            {t('support.revoke')}
          </button>
        </div>
      )}
    </li>
  )
}

export function SupportZugriff(): JSX.Element {
  const t = useT()
  const q = useSupportSessions()

  if (q.isPending) return <Laedt />
  if (q.isError) return <Fehler error={q.error} />

  /*
   * Offene Anfragen und laufende Sitzungen zuerst: was eine Entscheidung
   * verlangt oder gerade wirkt, gehoert nach oben. Abgelaufenes ist Nachweis
   * und steht darunter.
   */
  const rang = (s: SupportSession) =>
    s.state === 'pending' ? 0 : s.state === 'active' ? 1 : 2
  const liste = [...q.data.sessions].sort((a, b) => rang(a) - rang(b))

  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600">{t('support.hint')}</p>
      {liste.length === 0
        ? <p className="text-sm text-neutral-500">{t('support.none')}</p>
        : <ul className="space-y-2 max-w-2xl">
            {liste.map(s => <Karte key={s.id} s={s} />)}
          </ul>}
    </div>
  )
}
