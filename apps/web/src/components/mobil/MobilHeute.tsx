import { useState } from 'react'
import type { DailySheet } from '@hotelpms/contracts'
import { useDailySheet, useReservationAction } from '../../lib/queries.js'
import { useT, useLocale, formatMoney, formatDate, weekdayShort } from '../../lib/i18n/index.js'
import { useOnline } from '../../lib/offline.js'
import { useSprung } from '../../lib/suche.js'
import { addDays, today } from '../../lib/dates.js'
import { naechte } from '../../lib/mobil.js'
import { Fehler, Laedt } from '../Shell.tsx'

type Liste = 'arrivals' | 'departures' | 'inHouse'
type Zeile = DailySheet['inHouse'][number]
  & { registered?: boolean; balanceCent?: number | null }

/**
 * Das Tagesgeschaeft am Telefon: Anreisen, Abreisen, Im Haus.
 *
 * Dieselbe eine Anfrage wie am Desktop (`daily-sheet`), nur anders gelegt:
 * statt drei Spalten nebeneinander eine Liste mit Umschalter, und je Karte
 * **eine** grosse Handlung. Was die Karte vorher wissen muss -- Meldeschein
 * fehlt, Saldo offen -- steht als Marke darauf, damit niemand erst
 * hineintippen muss, um es zu sehen.
 *
 * Antippen oeffnet das Seitenfenster der Reservierung ueber den Rahmen
 * (`useSprung`), dasselbe wie aus der Suche. Eine zweite Fassung davon fuer
 * das Telefon liefe mit der Zeit auseinander.
 */
export function MobilHeute({ propertyId, onFolio }: {
  propertyId: number; onFolio: (folioRef: string) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const { springen } = useSprung()
  const [datum, setDatum] = useState(today())
  const [liste, setListe] = useState<Liste>('arrivals')
  const q = useDailySheet(propertyId, datum)
  const aktion = useReservationAction(propertyId, datum)

  if (q.isError && q.data === undefined) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const d = q.data
  const zeilen: Zeile[] = d[liste]

  const listen: ReadonlyArray<{ key: Liste; text: string; n: number }> = [
    { key: 'arrivals', text: t('today.arrivals'), n: d.arrivals.length },
    { key: 'departures', text: t('today.departures'), n: d.departures.length },
    { key: 'inHouse', text: t('today.inhouse'), n: d.inHouse.length }
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="grow">
          <div className="text-xs text-neutral-500">{weekdayShort(datum, locale)}</div>
          <h1 className="text-lg font-semibold">
            {datum === today() ? t('mobil.tab.today') : formatDate(datum, locale)}
          </h1>
        </div>
        <Blaettern datum={datum} onDatum={setDatum} schritt={1} />
      </div>

      <div className="grid grid-cols-3 gap-2" role="tablist">
        {listen.map(l => (
          <button key={l.key} type="button" role="tab" aria-selected={liste === l.key}
                  onClick={() => setListe(l.key)}
                  className={`rounded-lg border px-2 py-2 text-center
                              ${liste === l.key
                                ? 'border-neutral-900 bg-neutral-900 text-white'
                                : 'border-neutral-200 bg-white'}`}>
            <div className="text-xl font-semibold tabular-nums">{l.n}</div>
            <div className="truncate text-[11px]">{l.text}</div>
          </button>
        ))}
      </div>

      {aktion.isError && <Fehler error={aktion.error} />}

      <ul className="space-y-2">
        {zeilen.map(r => (
          <li key={r.reservationRef}
              className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-3">
            <button type="button" onClick={() => springen({ art: 'reservierung', ref: r.reservationRef })}
                    className="flex min-w-0 grow items-center gap-3 text-left">
              <Zimmer code={r.roomCode} />
              <div className="min-w-0">
                <div className="truncate font-semibold">{name(r)}</div>
                <div className="truncate text-xs text-neutral-500">
                  {r.categoryCode} · {nachtText(naechte(r.arrival, r.departure), t)}
                  {/* Null heisst: nie angegeben. "0 Pers." laese sich wie ein leeres Zimmer. */}
                  {r.occupants > 0 && ` · ${t('mobil.persons', { n: r.occupants })}`}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {r.registered === false && (
                    <Marke farbe="bg-amber-100 text-amber-900">
                      ⚠ {t('today.registrationMissing')}
                    </Marke>
                  )}
                  {r.balanceCent !== undefined && r.balanceCent !== null && r.balanceCent !== 0 && (
                    <Marke farbe={r.balanceCent > 0
                      ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'}>
                      {t('today.balance')} {formatMoney(r.balanceCent, locale)}
                    </Marke>
                  )}
                </div>
              </div>
            </button>
            {liste === 'arrivals' && (
              <Handlung disabled={!online || r.roomCode === null || aktion.isPending
                                  || r.status === 'InHouse'}
                        onClick={() => aktion.mutate({ ref: r.reservationRef, action: 'check-in' })}>
                {r.status === 'InHouse' ? t('today.inhouse') : t('today.checkin')}
              </Handlung>
            )}
            {liste === 'departures' && (
              <Handlung disabled={!online || aktion.isPending || r.status === 'CheckedOut'}
                        onClick={() => aktion.mutate({ ref: r.reservationRef, action: 'check-out' })}>
                {t('today.checkout')}
              </Handlung>
            )}
            {liste === 'inHouse' && r.folioRef !== null && (
              <Handlung leise disabled={false} onClick={() => onFolio(r.folioRef!)}>
                {t('mobil.today.folio')}
              </Handlung>
            )}
          </li>
        ))}
      </ul>
      {zeilen.length === 0 && (
        <p className="py-6 text-center text-sm text-neutral-500">{t('common.none')}</p>
      )}
    </div>
  )
}

function name(r: { lastName: string | null; firstName: string | null
                   reservationRef: string }): string {
  if (r.lastName === null) return r.reservationRef
  return r.firstName === null ? r.lastName : `${r.firstName} ${r.lastName}`
}

export function nachtText(n: number, t: ReturnType<typeof useT>): string {
  return n === 1 ? t('mobil.night') : t('mobil.nights', { n })
}

/** Die Zimmernummer als Kasten; ohne Zimmer ein gelber Hinweis. */
function Zimmer({ code }: { code: string | null }): JSX.Element {
  const t = useT()
  if (code === null) {
    return (
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-amber-100
                       text-center text-[10px] leading-tight text-amber-900">
        {t('mobil.today.noRoom')}
      </span>
    )
  }
  return (
    <span className="grid h-11 min-w-11 shrink-0 place-items-center rounded-lg bg-violet-50
                     px-1 font-bold tabular-nums text-violet-800">
      {code}
    </span>
  )
}

function Marke({ farbe, children }: { farbe: string; children: React.ReactNode }): JSX.Element {
  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${farbe}`}>{children}</span>
}

function Handlung({ disabled, onClick, leise = false, children }: {
  disabled: boolean; onClick: () => void; leise?: boolean; children: React.ReactNode
}): JSX.Element {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
            className={`h-11 shrink-0 rounded-lg px-3 text-sm font-semibold
                        ${leise ? 'border border-neutral-300 bg-white text-neutral-900'
                                : 'bg-neutral-900 text-white'}
                        disabled:bg-neutral-200 disabled:text-neutral-500`}>
      {children}
    </button>
  )
}

/** Vor und zurueck, dazwischen der Weg nach heute. */
export function Blaettern({ datum, onDatum, schritt }: {
  datum: string; onDatum: (d: string) => void; schritt: number
}): JSX.Element {
  const t = useT()
  const knopf = 'h-10 min-w-10 rounded-lg border border-neutral-300 bg-white px-2 text-sm'
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button type="button" aria-label={t('common.back')} className={knopf}
              onClick={() => onDatum(addDays(datum, -schritt))}>‹</button>
      {datum !== today() && (
        <button type="button" className={knopf} onClick={() => onDatum(today())}>
          {t('common.today')}
        </button>
      )}
      <button type="button" aria-label={t('common.forward')} className={knopf}
              onClick={() => onDatum(addDays(datum, schritt))}>›</button>
    </div>
  )
}
