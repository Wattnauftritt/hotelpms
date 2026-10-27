import { useState, type JSX } from 'react'
import type { CheckinPortalSubmission } from '@hotelpms/contracts'
import { usePortalAbgaben, usePortalKandidaten, usePortalZuordnen,
         usePortalVerwerfen } from '../lib/queries/meldescheine.js'
import { useT, useLocale, formatDate, type TextKey } from '../lib/i18n/index.js'
import { Dialog, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Meldescheine vom festen Link je Haus, die noch keiner Reservierung
 * gehoeren (0216). Steht ueber der Liste der Meldescheine und nur, wenn
 * etwas wartet: die meisten ordnet StayGrid selbst zu, sobald das
 * Adminpanel die Buchungsnummer meldet.
 *
 * Nur Nachname, Nummer und Anreisetag; der Inhalt steht nach dem Zuordnen
 * am Meldeschein, hinter dessen eigenem Recht.
 */
const GRUND: Record<string, TextKey> = {
  waiting: 'reg.portal.waiting', registered: 'reg.portal.registered',
  rejected: 'reg.portal.rejected'
}

export function WartendeMeldescheine({ propertyId }: { propertyId: number }): JSX.Element | null {
  const t = useT()
  const locale = useLocale()
  const q = usePortalAbgaben(propertyId, true)
  const verwerfen = usePortalVerwerfen()
  const [zuordnen, setZuordnen] = useState<CheckinPortalSubmission | null>(null)

  if (q.isError) return <Fehler error={q.error} />
  const liste = q.data?.submissions ?? []
  if (liste.length === 0) return null

  return (
    <section className="rounded-sm border border-amber-200 bg-amber-50 p-3 space-y-2 text-sm">
      <h2 className="font-medium">{t('reg.portal.title')}</h2>
      <p className="text-xs text-neutral-600">{t('reg.portal.hint')}</p>
      {verwerfen.isError && <Fehler error={verwerfen.error} />}
      <ul className="space-y-1">
        {liste.map(s => (
          <li key={s.ref} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm
                                     border border-neutral-200 bg-white p-2">
            <span className="tabular-nums text-neutral-600">{formatDate(s.arrival, locale)}</span>
            <span className="font-medium">{s.lastName}</span>
            <span className="tabular-nums">{t('reg.portal.number', { nummer: s.bookingNumber })}</span>
            <span className="grow text-xs text-neutral-600">
              {t(GRUND[s.holdReason ?? 'waiting']!)}
            </span>
            <button onClick={() => setZuordnen(s)}
                    className="px-2 py-1 rounded-sm border border-neutral-300 hover:bg-neutral-50">
              {t('reg.portal.assign')}
            </button>
            <button disabled={verwerfen.isPending}
                    onClick={() => {
                      if (window.confirm(t('reg.portal.discardConfirm'))) verwerfen.mutate(s.ref)
                    }}
                    className="px-2 py-1 rounded-sm border border-neutral-300 hover:bg-neutral-50
                               text-red-800">
              {t('reg.portal.discard')}
            </button>
          </li>
        ))}
      </ul>
      {zuordnen !== null && <Zuordnen abgabe={zuordnen} onClose={() => setZuordnen(null)} />}
    </section>
  )
}

/**
 * Vorschlaege um den angegebenen Anreisetag, die mit derselben Nummer oder
 * demselben Nachnamen zuerst. Ein Aufruf beim Oeffnen, nicht je Zeile.
 */
function Zuordnen({ abgabe, onClose }: {
  abgabe: CheckinPortalSubmission; onClose: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const k = usePortalKandidaten(abgabe.ref)
  const z = usePortalZuordnen()
  return (
    <Dialog titel={t('reg.portal.assign')}
            unterzeile={`${abgabe.lastName} · ${t('reg.portal.number', { nummer: abgabe.bookingNumber })}`
              + ` · ${formatDate(abgabe.arrival, locale)}`}
            onClose={onClose}
            fuss={<button onClick={onClose} className={KNOPF_LEISE}>{t('common.cancel')}</button>}>
      <div className="space-y-2 text-sm">
        <div className="text-neutral-600">{t('reg.portal.candidates')}</div>
        {k.isError && <Fehler error={k.error} />}
        {z.isError && <Fehler error={z.error} />}
        {k.data === undefined ? (!k.isError && <Laedt />)
          : k.data.candidates.length === 0
            ? <div className="text-neutral-500">{t('reg.portal.noCandidates')}</div>
            : (
              <ul className="space-y-1">
                {k.data.candidates.map(c => (
                  <li key={c.reservationRef}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm border
                                 border-neutral-200 p-2">
                    <span className="tabular-nums text-neutral-600">
                      {formatDate(c.arrival, locale)} – {formatDate(c.departure, locale)}
                    </span>
                    <span className="font-medium grow">
                      {c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName}
                    </span>
                    {c.room !== null && <span>{c.room}</span>}
                    {c.bookingNumber !== null && (
                      <span className="tabular-nums text-xs text-neutral-600">
                        {t('reg.portal.number', { nummer: c.bookingNumber })}
                      </span>
                    )}
                    <button disabled={z.isPending}
                            onClick={() => z.mutate({ ref: abgabe.ref, reservationRef: c.reservationRef },
                              { onSuccess: onClose })}
                            className="px-2 py-1 rounded-sm bg-neutral-900 text-white
                                       disabled:opacity-40">
                      {t('reg.portal.assign')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
      </div>
    </Dialog>
  )
}
