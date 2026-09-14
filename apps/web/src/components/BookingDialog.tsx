import { useState } from 'react'
import type { Guest } from '@hotelpms/contracts'
import { useCreateBooking } from '../lib/queries/booking.js'
import { useT } from '../lib/i18n/index.js'
import { GuestPicker } from './GuestPicker.tsx'
import { Fehler } from './Shell.tsx'

/**
 * Buchungsdialog: im Plan aufgezogen (A2) oder aus einer Zelle des
 * Verfügbarkeitsrasters heraus (A8).
 *
 * Zimmer, falls eines mitkommt, und Zeitraum stehen als Vorschlag fest --
 * aufgezogen oder angeklickt wurde genau das. Die Buchung entsteht mit
 * `resourceId` in einem Aufruf und landet deshalb im vorgeschlagenen
 * Zimmer, nicht in irgendeinem der Gruppe; ohne Zimmer bindet sie nur die
 * Gruppe, wie jede andere freie Buchung auch.
 */
export function BookingDialog({ propertyId, categoryId, categoryName, resourceId, roomCode,
                                arrival: anfangsAnreise, departure: anfangsAbreise, onClose }: {
  propertyId: number; categoryId: number; categoryName: string
  resourceId?: number; roomCode?: string
  arrival: string; departure: string
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const [guest, setGuest] = useState<Guest | null>(null)
  const [notes, setNotes] = useState('')
  const [arrival, setArrival] = useState(anfangsAnreise)
  const [departure, setDeparture] = useState(anfangsAbreise)
  const buchen = useCreateBooking(propertyId)

  const gueltig = departure > arrival

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
         onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded shadow-xl p-4 space-y-3"
           onClick={e => e.stopPropagation()}>
        <h2 className="text-sm font-medium">{t('booking.title')}</h2>

        <div className="text-sm bg-neutral-50 rounded p-2">
          <div className="text-xs text-neutral-500">{t('booking.category')}</div>
          <div>{roomCode !== undefined ? `${roomCode} · ` : ''}{categoryName}</div>
        </div>

        <div className="flex gap-2">
          <label className="block text-sm grow">
            <span className="block text-xs text-neutral-600 mb-1">{t('booking.arrival')}</span>
            <input type="date" value={arrival} onChange={e => setArrival(e.target.value)}
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
          <label className="block text-sm grow">
            <span className="block text-xs text-neutral-600 mb-1">{t('booking.departure')}</span>
            <input type="date" value={departure} onChange={e => setDeparture(e.target.value)}
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          </label>
        </div>

        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">{t('booking.guest')}</span>
          <GuestPicker value={guest} onChange={setGuest} />
        </label>

        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">{t('booking.notes')}</span>
          <input value={notes} onChange={e => setNotes(e.target.value)}
                 className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
        </label>

        {buchen.isError && <Fehler error={buchen.error} />}
        {buchen.isSuccess ? (
          <>
            <p className="text-sm text-emerald-800">
              ✓ {t('booking.created')} — {buchen.data.reservationRef}
            </p>
            <button type="button" onClick={onClose}
                    className="px-3 py-1.5 text-sm rounded border border-neutral-300">
              {t('common.back')}
            </button>
          </>
        ) : (
          <div className="flex gap-2">
            <button type="button" disabled={buchen.isPending || !gueltig}
                    onClick={() => buchen.mutate({
                      propertyId, categoryId, arrival, departure, resourceId,
                      guestRef: guest?.guestRef,
                      notes: notes.trim() === '' ? undefined : notes.trim()
                    })}
                    className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                               disabled:bg-neutral-300">
              {t('booking.submit')}
            </button>
            <button type="button" onClick={onClose}
                    className="px-3 py-1.5 text-sm rounded border border-neutral-300">
              {t('booking.close')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
