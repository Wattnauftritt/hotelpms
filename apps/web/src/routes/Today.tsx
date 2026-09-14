import { useState } from 'react'
import { useDailySheet, useReservationAction } from '../lib/queries.js'
import { useT, useLocale, formatMoney, formatDate } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { today } from '../lib/dates.js'
import { Fehler, Laedt, DatumsWahl } from '../components/Shell.tsx'

/**
 * Das Tagesgeschäft: Anreisen, Abreisen, Hausliste.
 *
 * Alle drei kommen aus **einer** Anfrage. Sie werden am Morgen gemeinsam
 * gebraucht und nie einzeln; sie getrennt zu holen kostet drei Runden für
 * denselben Bildschirm.
 */
export function Today({ propertyId, onFolio }: {
  propertyId: number; onFolio: (folioRef: string) => void
}): JSX.Element {
  const [datum, setDatum] = useState(today())
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const q = useDailySheet(propertyId, datum)
  const aktion = useReservationAction(propertyId, datum)

  if (q.isError && q.data === undefined) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const d = q.data

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <DatumsWahl value={datum} onChange={setDatum} />
        <button onClick={() => setDatum(today())}
                className="text-sm px-2 py-1 border border-neutral-300 rounded">
          {t('common.today')}
        </button>
        {aktion.isError && <Fehler error={aktion.error} />}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Spalte titel={`${t('today.arrivals')} (${d.arrivals.length})`}>
          {d.arrivals.map(r => (
            <Zeile key={r.reservationRef} name={namen(r)} raum={r.roomCode}
                   kategorie={r.categoryCode}>
              <div className="flex items-center gap-2">
                {!r.registered && (
                  <span title={t('today.registered')}
                        className="text-[11px] px-1 rounded bg-amber-100 text-amber-800">
                    ⚠ {t('today.registered')}
                  </span>
                )}
                <button
                  disabled={!online || r.roomCode === null || aktion.isPending
                            || r.status === 'InHouse'}
                  onClick={() => aktion.mutate({ ref: r.reservationRef, action: 'check-in' })}
                  title={r.roomCode === null ? t('today.needsRoom') : undefined}
                  className="text-xs px-2 py-1 rounded bg-neutral-900 text-white
                             disabled:bg-neutral-300">
                  {t('today.checkin')}
                </button>
              </div>
            </Zeile>
          ))}
        </Spalte>

        <Spalte titel={`${t('today.departures')} (${d.departures.length})`}>
          {d.departures.map(r => (
            <Zeile key={r.reservationRef} name={namen(r)} raum={r.roomCode}
                   kategorie={r.categoryCode}
                   onFolio={r.folioRef === null ? undefined : () => onFolio(r.folioRef!)}>
              <div className="flex items-center gap-2">
                {r.balanceCent !== null && r.balanceCent !== 0 && (
                  <span className={`text-[11px] px-1 rounded tabular-nums
                                    ${r.balanceCent > 0
                                      ? 'bg-red-100 text-red-800'
                                      : 'bg-emerald-100 text-emerald-800'}`}
                        title={t('today.balance')}>
                    {formatMoney(r.balanceCent, locale)}
                  </span>
                )}
                <button
                  disabled={!online || aktion.isPending || r.status === 'CheckedOut'}
                  onClick={() => aktion.mutate({ ref: r.reservationRef, action: 'check-out' })}
                  className="text-xs px-2 py-1 rounded bg-neutral-900 text-white
                             disabled:bg-neutral-300">
                  {t('today.checkout')}
                </button>
              </div>
            </Zeile>
          ))}
        </Spalte>

        <Spalte titel={`${t('today.inhouse')} (${d.inHouse.length})`}>
          {d.inHouse.map(r => (
            <Zeile key={r.reservationRef} name={namen(r)} raum={r.roomCode}
                   kategorie={r.categoryCode}
                   onFolio={r.folioRef === null ? undefined : () => onFolio(r.folioRef!)}>
              <span className="text-[11px] text-neutral-500 tabular-nums">
                → {formatDate(r.departure, locale)}
              </span>
            </Zeile>
          ))}
        </Spalte>
      </div>
    </div>
  )
}

function namen(r: { lastName: string | null; firstName: string | null
                    reservationRef: string }): string {
  if (r.lastName === null) return r.reservationRef
  return r.firstName === null ? r.lastName : `${r.lastName}, ${r.firstName}`
}

function Spalte({ titel, children }: { titel: string; children: React.ReactNode }) {
  const t = useT()
  const leer = Array.isArray(children) && children.length === 0
  return (
    <section className="bg-white border border-neutral-200 rounded">
      <h2 className="px-3 py-2 text-sm font-medium border-b border-neutral-200">{titel}</h2>
      <div className="divide-y divide-neutral-100">
        {leer ? <p className="px-3 py-4 text-sm text-neutral-400">{t('common.none')}</p>
              : children}
      </div>
    </section>
  )
}

function Zeile({ name, raum, kategorie, onFolio, children }: {
  name: string; raum: string | null; kategorie: string
  onFolio?: () => void; children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="w-14 shrink-0 text-sm font-medium tabular-nums">
        {raum ?? <span className="text-neutral-400">{kategorie}</span>}
      </span>
      {onFolio === undefined
        ? <span className="grow truncate text-sm">{name}</span>
        : <button onClick={onFolio}
                  className="grow truncate text-sm text-left hover:underline">
            {name}
          </button>}
      {children}
    </div>
  )
}
