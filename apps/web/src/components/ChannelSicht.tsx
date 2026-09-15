import { useMemo, useState } from 'react'
import type { ChannelAvailabilityDay, ChannelRateCell } from '@hotelpms/contracts'
import { useChannelView } from '../lib/queries/rates.js'
import { useT, useLocale, formatMoney, formatDate } from '../lib/i18n/index.js'
import { Fehler } from './Shell.tsx'

/**
 * Was der Channel Manager sieht.
 *
 * **Wofür das gut ist.** „Bei Booking.com steht ein anderer Preis" ist ohne
 * diese Ansicht nur aus Protokollen zu beantworten. Das Raster darüber
 * zeigt den **Pflegestand**; hier steht die **Auslieferung**, und die
 * beiden sind nicht dasselbe:
 *
 * - ein stillgelegter Ratenplan steht im Raster und geht nicht hinaus,
 * - ein Tag ohne Preis geht als „kein Preis" hinaus und wird drüben nicht
 *   verkauft,
 * - eine Sperre steht drüben neben dem Preis, nicht im Preis.
 *
 * **Die Zahlen sind nicht nachgebaut.** Sie kommen aus demselben SQL, das
 * der Channel Manager bekommt (`ariAvailability`, `ariRates`). Nachgebaut
 * wären sie beim nächsten Feld eine andere Antwort — und damit als Auskunft
 * wertlos.
 */
export function ChannelSicht({ propertyId, von, bis, belegung }: {
  propertyId: number; von: string; bis: string
  /** Hinaus geht der Preis je Belegung; gezeigt wird der gewählte. */
  belegung: number
}): JSX.Element {
  const t = useT()
  const [auf, setAuf] = useState(false)

  return (
    <section className="bg-white border border-neutral-200 rounded">
      <button onClick={() => setAuf(v => !v)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <span className="text-sm font-medium">{t('cv.title')}</span>
        <span className="text-xs text-neutral-500">{t('cv.open')}</span>
        <div className="grow" />
        <span className="text-neutral-400">{auf ? '▾' : '▸'}</span>
      </button>
      {/* Zugeklappt kostet die Ansicht keinen Aufruf: die Abfrage läuft
          erst, wenn jemand aufmacht. */}
      {auf && <Inhalt propertyId={propertyId} von={von} bis={bis} belegung={belegung} />}
    </section>
  )
}

/** Trennzeichen der Nachschlageschlüssel. In einem Code kommt es nicht vor. */
const TRENNER = ''

function Inhalt({ propertyId, von, bis, belegung }: {
  propertyId: number; von: string; bis: string; belegung: number
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [tag, setTag] = useState<string | null>(null)
  const q = useChannelView(propertyId, von, bis, true)

  const daten = q.data
  const tage = useMemo(
    () => daten === undefined ? [] : [...new Set(daten.days.map(d => d.date))].sort(),
    [daten])
  const kategorien = useMemo(
    () => daten === undefined ? [] : [...new Set(daten.days.map(d => d.categoryCode))].sort(),
    [daten])
  const plaene = useMemo(() => {
    if (daten === undefined) return []
    const gesehen = new Map<string, { categoryCode: string; ratePlanCode: string }>()
    for (const z of daten.cells) {
      gesehen.set(`${z.categoryCode}${TRENNER}${z.ratePlanCode}`,
        { categoryCode: z.categoryCode, ratePlanCode: z.ratePlanCode })
    }
    return [...gesehen.values()].sort(
      (a, b) => a.categoryCode.localeCompare(b.categoryCode)
             || a.ratePlanCode.localeCompare(b.ratePlanCode))
  }, [daten])

  // Nachschlagewerke statt einer Suche je Zelle: 400 Tage mal zehn Pläne
  // sind viertausend Zellen, und ein `find` in jeder ist quadratisch.
  const preise = useMemo(() => {
    const m = new Map<string, ChannelRateCell>()
    for (const z of daten?.cells ?? []) {
      m.set(`${z.categoryCode}${TRENNER}${z.ratePlanCode}${TRENNER}${z.date}`, z)
    }
    return m
  }, [daten])
  const frei = useMemo(() => {
    const m = new Map<string, ChannelAvailabilityDay>()
    for (const d of daten?.days ?? []) m.set(`${d.categoryCode}${TRENNER}${d.date}`, d)
    return m
  }, [daten])

  if (q.isError) return <div className="p-3"><Fehler error={q.error} /></div>
  if (daten === undefined) return <p className="px-3 pb-3 text-sm text-neutral-400">…</p>
  if (daten.cells.length === 0 && daten.days.length === 0) {
    return <p className="px-3 pb-3 text-sm text-neutral-500">{t('cv.empty')}</p>
  }

  const ohnePreis = daten.cells.filter(z => z.priceCent === null).length
  const gesperrt = daten.cells.filter(z => z.closed).length

  return (
    <div className="border-t border-neutral-200 px-3 py-2 space-y-3">
      <p className="text-xs text-neutral-500">{t('cv.intro')}</p>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600">
        <span>
          {t('cv.generatedAt')}: {new Date(daten.generatedAt)
            .toLocaleTimeString(locale === 'de' ? 'de-DE' : 'en-GB')}
        </span>
        <span className="tabular-nums">{tage.length} {t('cv.days')}</span>
        <span className="tabular-nums">{plaene.length} {t('rate.plans')}</span>
        {ohnePreis > 0 && (
          <span className="tabular-nums text-amber-700">
            {ohnePreis} × {t('cv.noPrice')}
          </span>
        )}
        {gesperrt > 0 && (
          <span className="tabular-nums text-amber-700">
            {gesperrt} × {t('cv.closedDays')}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="text-xs border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-white text-left font-medium px-2 py-1
                             border-b border-neutral-200 whitespace-nowrap">
                {t('cv.availability')}
              </th>
              {tage.map(d => (
                <th key={d} className="px-1 py-1 border-b border-neutral-200 font-normal
                                       text-neutral-500 whitespace-nowrap">
                  {/* Das Datum ist der Knopf zu den Rohdaten: derselbe Tag,
                      wie er über die Leitung geht. */}
                  <button onClick={() => setTag(vorher => vorher === d ? null : d)}
                          className={`px-1 rounded ${tag === d ? 'bg-neutral-900 text-white'
                                                               : 'hover:bg-neutral-100'}`}>
                    {formatDate(d, locale).slice(0, 5)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kategorien.map(k => (
              <tr key={k}>
                <td className="sticky left-0 z-10 bg-white px-2 py-1 font-medium
                               border-b border-neutral-100 whitespace-nowrap">{k}</td>
                {tage.map(d => {
                  const a = frei.get(`${k}${TRENNER}${d}`)
                  return (
                    <td key={d}
                        className={`px-1 py-1 text-center tabular-nums
                                    border-b border-neutral-100
                                    ${a !== undefined && a.available <= 0
                                      ? 'text-red-700' : ''}`}>
                      {a?.available ?? '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
            <tr>
              <td className="sticky left-0 z-10 bg-white px-2 pt-3 pb-1 text-left
                             font-medium whitespace-nowrap">{t('cv.rates')}</td>
              <td colSpan={tage.length} />
            </tr>
            {plaene.map(p => (
              <tr key={`${p.categoryCode}/${p.ratePlanCode}`}>
                <td className="sticky left-0 z-10 bg-white px-2 py-1 border-b
                               border-neutral-100 whitespace-nowrap">
                  <span className="text-neutral-500">{p.categoryCode}</span>{' '}
                  <span className="font-medium">{p.ratePlanCode}</span>
                </td>
                {tage.map(d => {
                  const z = preise.get(
                    `${p.categoryCode}${TRENNER}${p.ratePlanCode}${TRENNER}${d}`)
                  const preis = z === undefined || z.priceCent === null
                    ? null
                    : z.priceCent[belegung - 1] ?? z.priceCent[0] ?? null
                  return (
                    <td key={d}
                        className={`px-1 py-1 text-right tabular-nums whitespace-nowrap
                                    border-b border-neutral-100
                                    ${preis === null ? 'bg-amber-50 text-amber-700'
                                      : z?.closed === true
                                        ? 'text-neutral-400 line-through' : ''}`}>
                      {preis === null ? '—' : formatMoney(preis, locale)}
                      {z !== undefined && zeichen(z) !== '' && (
                        <span className="ml-0.5 text-[10px] text-neutral-500">
                          {zeichen(z)}
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {ohnePreis > 0 && <p className="text-xs text-neutral-500">{t('cv.noPriceHint')}</p>}
      <p className="text-xs text-neutral-500">{t('cv.inactiveHint')}</p>
      <p className="text-xs text-neutral-500">{t('cv.raw.hint')}</p>

      {tag !== null && (
        <div className="rounded border border-neutral-200 bg-neutral-50 p-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">
              {t('cv.raw')}: {formatDate(tag, locale)}
            </span>
            <div className="grow" />
            <button onClick={() => setTag(null)}
                    className="text-xs px-2 py-0.5 border border-neutral-300 rounded">
              {t('cv.raw.close')}
            </button>
          </div>
          <pre className="mt-1 overflow-x-auto text-[11px] leading-tight">
            {JSON.stringify({
              days: daten.days.filter(d => d.date === tag),
              cells: daten.cells.filter(z => z.date === tag)
            }, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

/** Restriktionen als Kurzzeichen, wie im Raster darüber. */
function zeichen(z: ChannelRateCell): string {
  const teile: string[] = []
  if (z.closed) teile.push('G')
  if (z.closedToArrival) teile.push('A')
  if (z.closedToDeparture) teile.push('B')
  if (z.minLos !== null && z.minLos > 1) teile.push(String(z.minLos))
  return teile.join('')
}
