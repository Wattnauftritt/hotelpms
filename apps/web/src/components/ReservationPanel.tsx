import { useEffect, useState } from 'react'
import type { ReservationDetail } from '@hotelpms/contracts'
import { useReservation, usePatchReservationNotes } from '../lib/queries/booking.js'
import { useT, useLocale, formatMoney, formatDate, type Locale } from '../lib/i18n/index.js'
import { Fehler, Laedt } from './Shell.tsx'

const NOTES_MAX_LENGTH = 2000

/**
 * Das Seitenfenster einer Reservierung: alles, was zu einem angeklickten
 * Balken gehört, in einem Aufruf (A1).
 *
 * Warum ein eigenes Fenster und kein Dialog: der Belegungsplan bleibt
 * sichtbar dahinter. Wer im Plan arbeitet, will den Balken noch sehen,
 * während er die Reservierung liest — nicht ihn hinter einem Dialog
 * verlieren.
 */
export function ReservationPanel({ reservationRef, onClose, onOpenFolio }: {
  reservationRef: string; onClose: () => void; onOpenFolio: (folioRef: string) => void
}): JSX.Element {
  const t = useT()
  const q = useReservation(reservationRef)

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-md bg-white border-l
                    border-neutral-200 shadow-xl overflow-y-auto">
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-3">
          <button onClick={onClose}
                  className="text-sm px-2 py-1 border border-neutral-300 rounded">
            ← {t('common.back')}
          </button>
          <h2 className="text-sm font-medium">{t('plan.reservation')} {reservationRef}</h2>
        </div>

        {q.isError && <Fehler error={q.error} />}
        {q.data === undefined && !q.isError && <Laedt />}
        {q.data !== undefined && (
          <Inhalt reservation={q.data} onOpenFolio={onOpenFolio} />
        )}
      </div>
    </div>
  )
}

function Feld({ label, children }: { label: string; children: React.ReactNode }
): JSX.Element {
  return (
    <div>
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  )
}

function Inhalt({ reservation: r, onOpenFolio }: {
  reservation: ReservationDetail
  onOpenFolio: (folioRef: string) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={`text-xs px-2 py-0.5 rounded bg-neutral-100`}>
          {t(`status.${r.status}` as never)}
        </span>
        {r.blockRef !== null && (
          <span className="text-xs text-neutral-500">
            {t('plan.block')}: {r.blockName}
          </span>
        )}
      </div>

      <section className="grid grid-cols-2 gap-3 bg-neutral-50 rounded p-3">
        <Feld label={t('plan.guest')}>
          {r.guestName ?? <span className="text-neutral-400">{t('plan.noGuest')}</span>}
          {r.companyName !== null && (
            <div className="text-xs text-neutral-500">{r.companyName}</div>
          )}
        </Feld>
        <Feld label={t('plan.room')}>
          {r.roomCode ?? <span className="text-neutral-400">{t('plan.noRoom')}</span>}
          {r.floor !== null && <span className="text-neutral-400"> · {r.floor}</span>}
        </Feld>
        <Feld label={t('plan.category')}>{r.categoryName}</Feld>
        <Feld label={t('plan.ratePlan')}>{r.ratePlanCode ?? '—'}</Feld>
        <Feld label={t('plan.stay')}>
          {formatDate(r.arrival, locale)} – {formatDate(r.departure, locale)}
        </Feld>
        <Feld label={t('plan.total')}>{formatMoney(r.totalCent, locale)}</Feld>
        <Feld label={t('plan.source')}>{r.source}</Feld>
      </section>

      {(r.checkedInAt !== null || r.checkedOutAt !== null || r.canceledAt !== null) && (
        <section className="text-xs text-neutral-500 space-y-0.5">
          {r.checkedInAt !== null
            && <div>{t('plan.checkedInAt')} {zeitpunkt(r.checkedInAt, locale)}</div>}
          {r.checkedOutAt !== null
            && <div>{t('plan.checkedOutAt')} {zeitpunkt(r.checkedOutAt, locale)}</div>}
          {r.canceledAt !== null
            && <div>{t('plan.canceledAt')} {zeitpunkt(r.canceledAt, locale)}</div>}
        </section>
      )}

      <section className="bg-white border border-neutral-200 rounded overflow-hidden">
        <h3 className="px-3 py-2 text-sm font-medium border-b border-neutral-200">
          {t('plan.nights')}
        </h3>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-neutral-100">
            {r.nights.map(n => (
              <tr key={n.date}>
                <td className="px-3 py-1.5 text-neutral-500 tabular-nums">
                  {formatDate(n.date, locale)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {formatMoney(n.priceCent, locale)}
                </td>
              </tr>
            ))}
            {r.nights.length === 0 && (
              <tr><td className="px-3 py-3 text-neutral-400">{t('common.none')}</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="bg-white border border-neutral-200 rounded overflow-hidden">
        <h3 className="px-3 py-2 text-sm font-medium border-b border-neutral-200">
          {t('plan.occupants')}
        </h3>
        <ul className="divide-y divide-neutral-100 text-sm">
          {r.occupants.map((o, i) => (
            <li key={i} className="px-3 py-1.5 flex items-center justify-between">
              <span>{o.name ?? '—'}</span>
              <span className="text-xs text-neutral-500">
                {o.isPrimary && `${t('plan.primary')} · `}
                {o.ageAtArrival !== null && `${o.ageAtArrival}J`}
              </span>
            </li>
          ))}
          {r.occupants.length === 0 && (
            <li className="px-3 py-3 text-neutral-400">{t('plan.noOccupants')}</li>
          )}
        </ul>
      </section>

      <section className="bg-white border border-neutral-200 rounded p-3">
        <h3 className="text-sm font-medium mb-2">{t('plan.folio')}</h3>
        {r.folioRef !== null
          ? <button onClick={() => onOpenFolio(r.folioRef!)}
                    className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white">
              {t('plan.openFolio')}
            </button>
          : <span className="text-sm text-neutral-400">{t('plan.noFolio')}</span>}
      </section>

      <NotizFeld reservationRef={r.reservationRef} notes={r.notes} />
    </div>
  )
}

/**
 * Notiz am Balken (A5). Freitext, ohne Bestand oder Preis anzufassen -- und
 * ausdrücklich kein Ort für Gesundheitsdaten: das Feld wird weder
 * durchsucht noch anonymisiert.
 */
function NotizFeld({ reservationRef, notes }: {
  reservationRef: string; notes: string | null
}): JSX.Element {
  const t = useT()
  const [text, setText] = useState(notes ?? '')
  const speichern = usePatchReservationNotes(reservationRef)

  // Nach dem Laden einer anderen Reservierung den Text neu uebernehmen,
  // sonst zeigt das Feld die Notiz der vorigen Auswahl.
  useEffect(() => { setText(notes ?? '') }, [reservationRef, notes])

  const geaendert = text !== (notes ?? '')

  return (
    <section className="bg-white border border-neutral-200 rounded p-3">
      <h3 className="text-sm font-medium">{t('plan.notes')}</h3>
      <textarea value={text} onChange={e => setText(e.target.value)}
                maxLength={NOTES_MAX_LENGTH} rows={3}
                className="mt-2 w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
      <p className="mt-1 text-xs text-neutral-500">{t('plan.notesHint')}</p>
      <div className="mt-2 flex items-center gap-3">
        <button disabled={!geaendert || speichern.isPending}
                onClick={() => speichern.mutate(text === '' ? null : text)}
                className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t('plan.notesSave')}
        </button>
        {!geaendert && speichern.isSuccess && (
          <span className="text-xs text-emerald-700">✓ {t('plan.notesSaved')}</span>
        )}
      </div>
      {speichern.isError && <div className="mt-2"><Fehler error={speichern.error} /></div>}
    </section>
  )
}

function zeitpunkt(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB',
    { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso))
}
