import { useState } from 'react'
import type { OnlineCheckinStatus } from '@hotelpms/contracts'
import { useCheckinLink, useSendCheckinLink, useRevokeCheckinLinks }
  from '../lib/queries/checkin.js'
import { useT, useLocale, formatDate, intlTag, type Locale } from '../lib/i18n/index.js'
import { Fehler } from './Shell.tsx'

/**
 * Online-Check-in im Seitenfenster einer Reservierung (Dokument 30).
 *
 * Was die Rezeption wissen muss, bevor der Gast am Tresen steht: ist der
 * Link hinaus, hat er ausgefuellt, und fehlt noch die Unterschrift. Der
 * Stand kommt mit der Reservierung (`onlineCheckin`), nicht als eigener
 * Aufruf -- ein Fenster, ein Aufruf.
 *
 * Die Knoepfe erscheinen nur, wo die Schnittstelle sie zulaesst
 * (`mayLink`, `maySend`). Der Link selbst bleibt nach dem Kopieren nur in
 * diesem Fenster stehen, solange es offen ist, und wird nie gespeichert.
 */
export function OnlineCheckinStand({ reservationRef, stand }: {
  reservationRef: string; stand: OnlineCheckinStatus
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const link = useCheckinLink(reservationRef)
  const senden = useSendCheckinLink(reservationRef)
  const zurueck = useRevokeCheckinLinks(reservationRef)
  const [kopiert, setKopiert] = useState<boolean | null>(null)

  const kopieren = async (): Promise<void> => {
    setKopiert(null)
    const r = await link.mutateAsync()
    try {
      await navigator.clipboard.writeText(r.link)
      setKopiert(true)
    } catch {
      // Ohne Zwischenablage (http, verweigertes Recht): der Link steht
      // markierbar darunter.
      setKopiert(false)
    }
  }

  const einladung = stand.invitedAt === null ? t('onlineCheckin.notInvited')
    : stand.invitationStatus === 'pending'
      ? t('onlineCheckin.invitationPending', { zeit: zeitpunkt(stand.invitedAt, locale) })
      : stand.invitationStatus === 'failed'
        ? t('onlineCheckin.invitationFailed', { zeit: zeitpunkt(stand.invitedAt, locale) })
        : t('onlineCheckin.invitedAt', { zeit: zeitpunkt(stand.invitedAt, locale) })

  const erledigt = stand.completedAt !== null || stand.source === 'desk'

  return (
    <section className="bg-white border border-neutral-200 rounded-sm p-3 space-y-2">
      <h3 className="text-sm font-medium">{t('onlineCheckin.title')}</h3>
      <ul className="text-sm space-y-0.5">
        <li className={stand.invitationStatus === 'failed' ? 'text-red-800' : 'text-neutral-700'}>
          {einladung}
        </li>
        {stand.completedAt !== null && (
          <li className="text-emerald-800">✓ {stand.source === 'import'
            ? t('onlineCheckin.completedImported', { zeit: zeitpunkt(stand.completedAt, locale),
                                                     system: stand.importedFrom ?? '' })
            : t(stand.source === 'terminal'
              ? 'onlineCheckin.completedTerminal' : 'onlineCheckin.completedOnline',
              { zeit: zeitpunkt(stand.completedAt, locale) })}</li>
        )}
        {stand.signaturePending && (
          <li className="text-amber-800">{t('onlineCheckin.signaturePending')}</li>
        )}
        {stand.activeLinks > 0 && !erledigt && (
          <li className="text-xs text-neutral-500">
            {t('onlineCheckin.activeLinks', { n: stand.activeLinks })}
          </li>
        )}
      </ul>

      {!erledigt && (stand.mayLink || stand.maySend) && (
        <div className="flex flex-wrap items-center gap-2">
          {stand.maySend && (
            <button onClick={() => senden.mutate()} disabled={senden.isPending}
                    className="text-xs px-2 py-1 rounded-sm border border-neutral-300
                               hover:bg-neutral-50 disabled:opacity-40">
              {t('onlineCheckin.send')}
            </button>
          )}
          {stand.mayLink && (
            <button onClick={() => { void kopieren() }} disabled={link.isPending}
                    className="text-xs px-2 py-1 rounded-sm border border-neutral-300
                               hover:bg-neutral-50 disabled:opacity-40">
              {t('onlineCheckin.copy')}
            </button>
          )}
          {stand.mayLink && stand.activeLinks > 0 && (
            <button onClick={() => zurueck.mutate()} disabled={zurueck.isPending}
                    className="text-xs px-2 py-1 rounded-sm border border-red-300 text-red-800
                               hover:bg-red-50 disabled:opacity-40">
              {t('onlineCheckin.revoke')}
            </button>
          )}
          {senden.isSuccess && (
            <span className="text-xs text-emerald-700">✓ {t('onlineCheckin.sent')}</span>
          )}
          {zurueck.isSuccess && (
            <span className="text-xs text-neutral-600">
              {t('onlineCheckin.revoked', { n: zurueck.data.revoked })}
            </span>
          )}
        </div>
      )}

      {link.data !== undefined && kopiert !== null && (
        <div className="space-y-1">
          <p className="text-xs text-neutral-600">
            {t(kopiert ? 'onlineCheckin.copied' : 'onlineCheckin.copyManual',
               { datum: formatDate(link.data.expiresOn, locale) })}
          </p>
          <input readOnly value={link.data.link} onFocus={e => e.currentTarget.select()}
                 className="w-full border border-neutral-300 rounded-sm px-2 py-1 text-xs font-mono" />
          <p className="text-xs text-amber-800">{t('onlineCheckin.copyWarning')}</p>
        </div>
      )}

      {senden.isError && <Fehler error={senden.error} />}
      {link.isError && <Fehler error={link.error} />}
      {zurueck.isError && <Fehler error={zurueck.error} />}
    </section>
  )
}

function zeitpunkt(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlTag(locale),
    { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso))
}
