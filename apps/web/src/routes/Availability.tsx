import { useState } from 'react'
import { useCategories } from '../lib/queries.js'
import { useAvailability } from '../lib/queries/booking.js'
import { useT } from '../lib/i18n/index.js'
import { today, addDays } from '../lib/dates.js'
import { AvailabilityGrid } from '../components/AvailabilityGrid.tsx'
import { BookingDialog } from '../components/BookingDialog.tsx'
import { Fehler, Laedt, DatumsWahl } from '../components/Shell.tsx'

const SPANNEN = [30, 90, 180, 365] as const

interface Auswahl { categoryId: number; categoryName: string; arrival: string; departure: string }

/**
 * Verfügbarkeitsraster (A8): was ist noch frei, ohne auf einzelne Zimmer
 * zu sehen. `GET .../availability` liefert bis 731 Tage in einem Aufruf --
 * ein Jahr Vorschau ist deshalb keine Backend-Frage mehr.
 */
export function Availability({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const [von, setVon] = useState(today())
  const [tage, setTage] = useState<number>(90)
  const [auswahl, setAuswahl] = useState<Auswahl | null>(null)
  const bis = addDays(von, tage)
  const kategorien = useCategories(propertyId)
  const q = useAvailability(propertyId, von, bis)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t('availability.title')}</h1>
        <div className="grow" />
        <DatumsWahl value={von} onChange={setVon} step={30} />
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
      </div>

      {q.isError && q.data === undefined ? <Fehler error={q.error} />
        : q.data === undefined || kategorien.data === undefined ? <Laedt />
        : <AvailabilityGrid from={von} to={bis} days={q.data.days}
                            categories={kategorien.data.categories}
                            onSelect={sel => setAuswahl({
                              categoryId: sel.categoryId, categoryName: sel.categoryName,
                              arrival: sel.date, departure: addDays(sel.date, 1)
                            })} />}

      {auswahl !== null && (
        <BookingDialog propertyId={propertyId}
                        categoryId={auswahl.categoryId} categoryName={auswahl.categoryName}
                        arrival={auswahl.arrival} departure={auswahl.departure}
                        onClose={() => setAuswahl(null)} />
      )}
    </div>
  )
}
