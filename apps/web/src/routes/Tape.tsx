import { useState } from 'react'
import { useTapeChart } from '../lib/queries.js'
import { useT } from '../lib/i18n/index.js'
import { today, addDays } from '../lib/dates.js'
import { TapeChart } from '../components/TapeChart.tsx'
import { Fehler, Laedt, DatumsWahl } from '../components/Shell.tsx'

const SPANNEN = [14, 30, 60] as const

export function Tape({ propertyId }: { propertyId: number }): JSX.Element {
  const [von, setVon] = useState(today())
  const [tage, setTage] = useState<number>(30)
  const t = useT()
  const q = useTapeChart(propertyId, von, addDays(von, tage))

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

      {q.isError && q.data === undefined ? <Fehler error={q.error} />
        : q.data === undefined ? <Laedt />
        : <TapeChart data={q.data} />}
    </div>
  )
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
