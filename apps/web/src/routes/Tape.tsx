import { useMemo, useState } from 'react'
import type { TapeChart as TapeChartData } from '@hotelpms/contracts'
import { useTapeChart, useCategories } from '../lib/queries.js'
import { useAssignUnit, useChangeStay } from '../lib/queries/booking.js'
import { useT } from '../lib/i18n/index.js'
import { today, addDays, eachDay } from '../lib/dates.js'
import { TapeChart } from '../components/TapeChart.tsx'
import { ReservationPanel } from '../components/ReservationPanel.tsx'
import { BookingDialog } from '../components/BookingDialog.tsx'
import { GroupBookingDialog, type GroupSelection }
  from '../components/GroupBookingDialog.tsx'
import { Fehler, Laedt, DatumsWahl } from '../components/Shell.tsx'

const SPANNEN = [14, 30, 60] as const
/** Zustaende, die ein Zimmer wirklich belegen. Storniert und No-Show nicht. */
const BINDEND = new Set(['Optional', 'Confirmed', 'InHouse'])

interface Auswahl {
  resourceId: number; categoryId: number; categoryName: string; roomCode: string
  arrival: string; departure: string
}

export function Tape({ propertyId, onFolio, onCheckIn }: {
  propertyId: number; onFolio: (folioRef: string) => void
  onCheckIn: (reservationRef: string) => void
}): JSX.Element {
  const [von, setVon] = useState(today())
  const [tage, setTage] = useState<number>(30)
  // Balken anklicken zeigt die Reservierung im Seitenfenster (A1); der Plan
  // bleibt dahinter sichtbar.
  const [ausgewaehlt, setAusgewaehlt] = useState<string | null>(null)
  const [auswahl, setAuswahl] = useState<Auswahl | null>(null)
  // Mehrere Zimmerzeilen zugleich markiert: daraus wird **eine** Buchung
  // mit mehreren Zimmern, nicht eine Buchung je Zimmer.
  const [gruppe, setGruppe] = useState<GroupSelection | null>(null)
  const t = useT()
  const bis = addDays(von, tage)
  const q = useTapeChart(propertyId, von, bis)
  const kategorien = useCategories(propertyId)
  const zuweisen = useAssignUnit()
  const umbuchen = useChangeStay()

  const warnungen = useWarnungen(q.data, kategorien.data?.categories ?? [])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <DatumsWahl value={von} onChange={setVon} step={7} />
        <button onClick={() => setVon(today())}
                className="text-sm px-2 py-1 border border-neutral-300 rounded">
          {t('common.today')}
        </button>
        <div className="flex gap-1">
          {SPANNEN.map(n => (
            <button key={n} onClick={() => setTage(n)}
                    className={`text-sm px-2 py-1 rounded border
                                ${tage === n
                                  ? 'bg-neutral-900 text-white border-neutral-900'
                                  : 'border-neutral-300'}`}>
              {n}
            </button>
          ))}
        </div>
        <div className="grow" />
        <Legende />
      </div>

      {warnungen.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs
                        text-amber-900 space-y-0.5">
          <div className="font-medium">{t('warnings.title')}</div>
          {warnungen.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}

      {(zuweisen.isError || umbuchen.isError) && (
        <Fehler error={zuweisen.error ?? umbuchen.error} />
      )}

      {q.isError && q.data === undefined ? <Fehler error={q.error} />
        : q.data === undefined ? <Laedt />
        : <TapeChart data={q.data}
                      onSelect={setAusgewaehlt}
                      onCreate={sel => {
                        const u = q.data!.units.find(x => x.id === sel.resourceId)
                        setAuswahl({ ...sel, roomCode: u?.code ?? '',
                                      categoryName: u?.category_name ?? '' })
                      }}
                      onCreateGroup={sel => {
                        const zimmer = new Map(q.data!.units.map(u => [u.id, u]))
                        setGruppe({
                          arrival: sel.arrival, departure: sel.departure,
                          rooms: sel.rooms.map(r => ({
                            ...r,
                            roomCode: zimmer.get(r.resourceId)?.code ?? '',
                            categoryName: zimmer.get(r.resourceId)?.category_name ?? ''
                          }))
                        })
                      }}
                      onMove={(reservationRef, resourceId) =>
                        zuweisen.mutate({ reservationRef, resourceId })}
                      onChangeStay={(reservationRef, arrival, departure) =>
                        umbuchen.mutate({ reservationRef, arrival, departure })} />}

      {/* Die Gesten stehen unter dem Plan, nicht in einer Hilfe: Ziehen und
          Mehrfachauswahl gab es zum Teil schon, und niemand hat sie gefunden. */}
      <p className="text-xs text-neutral-500">{t('plan.dragHint')}</p>

      {ausgewaehlt !== null && (
        <ReservationPanel reservationRef={ausgewaehlt}
                          onClose={() => setAusgewaehlt(null)}
                          onOpenFolio={onFolio}
                          onOpenCheckIn={onCheckIn} />
      )}

      {gruppe !== null && (
        <GroupBookingDialog propertyId={propertyId} selection={gruppe}
                            onClose={() => setGruppe(null)} />
      )}

      {auswahl !== null && (
        <BookingDialog propertyId={propertyId}
                        categoryId={auswahl.categoryId} categoryName={auswahl.categoryName}
                        resourceId={auswahl.resourceId} roomCode={auswahl.roomCode}
                        arrival={auswahl.arrival} departure={auswahl.departure}
                        onClose={() => setAuswahl(null)} />
      )}
    </div>
  )
}

/**
 * Überbuchung sichtbar machen (A7). Gerechnet wird aus dem, was ohnehin
 * schon geladen ist -- Balken und Zimmergruppen -- kein zweiter Aufruf je
 * Zeile, nur eine zusätzliche, feste Anfrage für die Gruppendaten.
 */
function useWarnungen(
  data: TapeChartData | undefined,
  kategorien: Array<{ id: number; name: string }>
): string[] {
  const t = useT()
  return useMemo(() => {
    if (data === undefined) return []
    const out: string[] = []

    const ohneZimmer = data.reservations.filter(
      r => r.resource_id === null && BINDEND.has(r.status)).length
    if (ohneZimmer > 0) out.push(`${ohneZimmer} ${t('warnings.unassigned')}`)

    const kapazitaet = new Map<number, number>()
    for (const u of data.units) {
      kapazitaet.set(u.category_id, (kapazitaet.get(u.category_id) ?? 0) + 1)
    }
    const namen = new Map(kategorien.map(k => [k.id, k.name]))
    const tageListe = eachDay(data.from, data.to)

    for (const [categoryId, kapa] of kapazitaet) {
      let betroffeneTage = 0
      for (const tag of tageListe) {
        const belegt = data.reservations.filter(r =>
          r.category_id === categoryId && BINDEND.has(r.status)
          && r.arrival <= tag && r.departure > tag).length
        if (belegt > kapa) betroffeneTage++
      }
      if (betroffeneTage > 0) {
        out.push(`${t('warnings.overbooked')}: ${namen.get(categoryId) ?? categoryId} `
          + `(${betroffeneTage})`)
      }
    }
    return out
  }, [data, kategorien, t])
}

function Legende(): JSX.Element {
  const t = useT()
  const punkte: Array<[string, 'status.Optional' | 'status.Confirmed' | 'status.InHouse']> = [
    ['bg-status-optional', 'status.Optional'],
    ['bg-status-confirmed', 'status.Confirmed'],
    ['bg-status-inhouse', 'status.InHouse']
  ]
  return (
    <div className="flex items-center gap-3 text-xs text-neutral-600">
      {punkte.map(([farbe, key]) => (
        <span key={key} className="flex items-center gap-1">
          <span className={`inline-block w-3 h-3 rounded ${farbe}`} />
          {t(key)}
        </span>
      ))}
    </div>
  )
}
