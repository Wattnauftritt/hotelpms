import { useState, type JSX } from 'react'
import { GUEST_REQUEST_DECLINE_REASONS, type GuestRequestDeclineReason,
         type GuestRequestRow } from '@hotelpms/contracts'
import { useT, useLocale, formatMoney, formatDate } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { useWunschBearbeiten } from '../lib/queries/gaestemappe.js'
import { Fehler } from './Shell.tsx'

/**
 * Wuensche aus der Gaestemappe (Migration 0149), wie die Rezeption sie sieht:
 * unter "Heute" die offenen des Hauses, im Seitenfenster alle der
 * Reservierung.
 *
 * Ein Extra mit Preis heisst beim Annehmen "Annehmen und buchen", nicht
 * "Erledigt": der Klick bucht aufs Folio, und das soll man vorher wissen.
 * Die Ablehnung ist ein Grund aus der festen Liste, damit der Gast die
 * Antwort in seiner Sprache liest.
 */
export function GastWunschListe({ wuensche, mitGast = false }: {
  wuensche: GuestRequestRow[]
  /** Unter "Heute" steht davor, wer es ist; im Seitenfenster weiss man das. */
  mitGast?: boolean
}): JSX.Element {
  const bearbeiten = useWunschBearbeiten()
  return (
    <div className="divide-y divide-neutral-100">
      {wuensche.map(w => (
        <Wunsch key={w.requestRef} w={w} mitGast={mitGast} busy={bearbeiten.isPending}
                onDone={() => bearbeiten.mutate({ requestRef: w.requestRef, reason: null })}
                onDecline={reason => bearbeiten.mutate({ requestRef: w.requestRef, reason })} />
      ))}
      {bearbeiten.isError && <div className="px-3 py-2"><Fehler error={bearbeiten.error} /></div>}
    </div>
  )
}

function Wunsch({ w, mitGast, busy, onDone, onDecline }: {
  w: GuestRequestRow; mitGast: boolean; busy: boolean
  onDone: () => void
  onDecline: (r: GuestRequestDeclineReason) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const [ablehnen, setAblehnen] = useState(false)
  const name = w.itemName === null ? null : w.itemName[locale] ?? w.itemName.de ?? ''
  const gast = w.lastName === null ? w.reservationRef
    : w.firstName === null ? w.lastName : `${w.lastName}, ${w.firstName}`
  const knopf = 'text-xs px-2 py-1 rounded-sm disabled:opacity-40'

  return (
    <div className="px-3 py-2 space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {mitGast && (
          <span className="w-14 shrink-0 font-medium tabular-nums">{w.roomCode ?? '–'}</span>
        )}
        <span className="grow">
          {mitGast && <span className="text-neutral-600">{gast} · </span>}
          {/* Eine Nachricht (0153) steht im Wortlaut des Gastes, in seiner
              Sprache -- uebersetzt wird sie nicht, die Rezeption fragt nach. */}
          {name === null
            ? <>
                <span className="text-[11px] px-1 me-1 rounded-sm bg-amber-100 text-amber-900">
                  {t('folder.req.message')}</span>
                {w.message === null
                  ? <span className="italic text-neutral-500">{t('folder.req.messageErased')}</span>
                  : <span className="whitespace-pre-wrap">{w.message}</span>}
              </>
            : <span className="font-medium">{w.qty} × {name}</span>}
          {w.wantedFor !== null && (
            <span className="text-neutral-600">
              {' · '}{t('folder.req.for', { date: formatDate(w.wantedFor, locale) })}
            </span>
          )}
        </span>
        {w.handler === 'housekeeping' && (
          <span className="text-[11px] px-1 rounded-sm bg-sky-100 text-sky-900">
            {t('folder.req.housekeeping')}
          </span>
        )}
        <span className="text-xs tabular-nums text-neutral-600">
          {w.unitPriceCent === null ? t('folder.req.free')
            : formatMoney(w.unitPriceCent * w.qty, locale)}
        </span>
      </div>
      {w.status === 'open' ? (
        <div className="flex flex-wrap justify-end gap-2">
          {ablehnen ? GUEST_REQUEST_DECLINE_REASONS.map(r => (
            <button key={r} disabled={!online || busy} onClick={() => onDecline(r)}
                    className={`${knopf} border border-neutral-300 hover:bg-neutral-50`}>
              {t(`folder.req.reason.${r}`)}
            </button>
          )) : (
            <>
              <button disabled={!online || busy} onClick={() => setAblehnen(true)}
                      className={`${knopf} border border-neutral-300 hover:bg-neutral-50`}>
                {t('folder.req.decline')}
              </button>
              <button disabled={!online || busy} onClick={onDone}
                      className={`${knopf} bg-neutral-900 text-white`}>
                {w.unitPriceCent === null ? t('folder.req.done') : t('folder.req.accept')}
              </button>
            </>
          )}
        </div>
      ) : (
        <p className={`text-xs text-end ${w.status === 'done' ? 'text-emerald-800' : 'text-red-800'}`}>
          {t(`folder.req.status.${w.status}`)}
          {w.declineReason !== null && <> · {t(`folder.req.reason.${w.declineReason}`)}</>}
        </p>
      )}
    </div>
  )
}
