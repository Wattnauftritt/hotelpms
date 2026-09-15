import { memo, useCallback, useMemo, useRef, type JSX } from 'react'
import type { RateGridCell, RatePlan } from '@hotelpms/contracts'
import { useT, useLocale, weekdayShort, geldFormatierer,
         type Locale } from '../lib/i18n/index.js'
import { isWeekend } from '../lib/dates.js'
import { restriktionsZeichen } from '../lib/preisraster.js'

/**
 * Das Preisraster: Tage waagerecht, Ratenpläne senkrecht.
 *
 * **Es ist die Arbeitsfläche, nicht das Bild.** Was man hier sieht, ändert
 * man hier: über die Tage einer Zeile ziehen wählt den Bereich, den die
 * Masken darunter bearbeiten. Eine Maske, die man nur über ein Menü
 * erreicht, wird im Betrieb nicht benutzt (Dokument 19, Abschnitt 3).
 *
 * **Die Auswahl bleibt in einer Zeile.** Ein Ratenplan ist die Einheit, die
 * die API schreibt (`PUT /v1/rates/bulk` nimmt genau einen), und eine
 * Auswahl über mehrere Zeilen würde vortäuschen, dass ein Klick alle
 * ändert. Wer mehrere Pläne pflegt, pflegt sie nacheinander -- und sieht
 * dabei jeden einzeln.
 *
 * **Warum die Zeilen gemerkt werden.** Gemessen an 400 Tagen mal vier
 * Plänen: ohne `memo` zeichnete jede Mausbewegung beim Ziehen alle 1 600
 * Zellen neu, und ein Zug über fünfzig Tage dauerte fünf Sekunden. Beim
 * Ziehen ändert sich aber nur **eine** Zeile. Gemerkt werden deshalb die
 * Zeilen, und die übrigen bleiben stehen -- das ist der Unterschied
 * zwischen einem Raster, in dem man arbeitet, und einem, das man ansieht.
 * Eine Bibliothek zur Virtualisierung braucht es dafür nicht; sie wäre die
 * nächste Stufe, wenn ein Haus dreißig Pläne hat (Dokument 19, Abschnitt 9).
 */

export interface Auswahl {
  ratePlanId: number
  from: string
  to: string
}

interface Props {
  plans: readonly RatePlan[]
  /** Muss stabil sein, sonst greift das Merken der Zeilen nicht. */
  tage: readonly string[]
  zellen: readonly RateGridCell[]
  /** Welche Belegungsstufe im Raster steht. 1 = eine Person. */
  belegung: number
  auswahl: Auswahl | null
  onAuswahl: (a: Auswahl) => void
}

interface ZeilenProps {
  plan: RatePlan
  tage: readonly string[]
  zellen: ReadonlyMap<string, RateGridCell> | undefined
  belegung: number
  /** Nur gesetzt, wenn die Auswahl in **dieser** Zeile liegt. */
  von: string | null
  bis: string | null
  /** Einmal gebaut und weitergereicht, nicht je Zelle erzeugt. */
  geld: Intl.NumberFormat
  abgeleitet: string
  onDown: (ratePlanId: number, datum: string) => void
  onEnter: (ratePlanId: number, datum: string) => void
}

const Zeile = memo(function Zeile(p: ZeilenProps): JSX.Element {
  return (
    <tr>
      <th scope="row"
          className="sticky left-0 z-10 bg-white border-b border-r
                     border-neutral-200 px-2 py-1 text-left font-normal">
        <div className="font-medium">{p.plan.name}</div>
        <div className="text-xs text-neutral-500">
          {p.plan.code} · {p.plan.categoryCode}
          {p.plan.baseRatePlanId !== null && <> · {p.abgeleitet}</>}
        </div>
      </th>
      {p.tage.map(d => {
        const z = p.zellen?.get(d)
        const preis = z?.priceCent?.[p.belegung - 1]
        const zeichen = z === undefined ? '' : restriktionsZeichen(z)
        const gewaehlt = p.von !== null && p.bis !== null && d >= p.von && d <= p.bis
        return (
          <td key={d}
              onMouseDown={() => p.onDown(p.plan.id, d)}
              onMouseEnter={() => p.onEnter(p.plan.id, d)}
              aria-selected={gewaehlt}
              className={`border-b border-neutral-200 px-1 py-1 text-center
                          tabular-nums cursor-pointer select-none
                          ${gewaehlt ? 'bg-neutral-900 text-white'
                                     : z?.closed === true ? 'bg-red-50'
                                     : isWeekend(d) ? 'bg-neutral-50' : ''}`}>
            <div className="text-xs">
              {preis === undefined
                ? <span className="text-neutral-300">—</span>
                : p.geld.format(preis / 100).replace(/\s?€/, '')}
            </div>
            {zeichen !== '' && (
              <div className={`text-[10px] ${
                gewaehlt ? 'text-neutral-300' : 'text-red-700'}`}>{zeichen}</div>
            )}
          </td>
        )
      })}
    </tr>
  )
})

const Kopfzeile = memo(function Kopfzeile(
  { tage, locale, planLabel }: { tage: readonly string[]; locale: Locale
                                 planLabel: string }
): JSX.Element {
  return (
    <tr>
      <th className="sticky left-0 z-20 bg-white border-b border-r border-neutral-200
                     px-2 py-1 text-left font-medium min-w-44">
        {planLabel}
      </th>
      {tage.map(d => (
        <th key={d}
            className={`border-b border-neutral-200 px-1 py-1 font-normal
                        text-xs text-center min-w-14
                        ${isWeekend(d) ? 'bg-neutral-100' : ''}`}>
          <div className="text-neutral-500">{weekdayShort(d, locale)}</div>
          <div className="tabular-nums">{d.slice(8, 10)}.{d.slice(5, 7)}.</div>
        </th>
      ))}
    </tr>
  )
})

export function RateGrid(props: Props): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const { onAuswahl } = props

  /*
   * Der Startpunkt des Ziehens steht in einer Referenz und nicht im
   * Zustand: er verändert nichts am Bild, und als Zustand zöge er bei
   * jeder Mausbewegung ein Neuzeichnen nach sich -- genau das, was hier
   * vermieden werden soll.
   */
  const ziehtAb = useRef<{ ratePlanId: number; von: string } | null>(null)

  const onDown = useCallback((ratePlanId: number, datum: string): void => {
    ziehtAb.current = { ratePlanId, von: datum }
    onAuswahl({ ratePlanId, from: datum, to: datum })
  }, [onAuswahl])

  // Beim Ziehen wächst die Auswahl in beide Richtungen; der Startpunkt
  // bleibt, wo die Maus gedrückt wurde.
  const onEnter = useCallback((ratePlanId: number, datum: string): void => {
    const start = ziehtAb.current
    if (start === null || start.ratePlanId !== ratePlanId) return
    onAuswahl({
      ratePlanId,
      from: datum < start.von ? datum : start.von,
      to: datum < start.von ? start.von : datum
    })
  }, [onAuswahl])

  const nachPlan = useMemo(() => {
    const m = new Map<number, Map<string, RateGridCell>>()
    for (const z of props.zellen) {
      let je = m.get(z.ratePlanId)
      if (je === undefined) { je = new Map(); m.set(z.ratePlanId, je) }
      je.set(z.date, z)
    }
    return m
  }, [props.zellen])

  const abgeleitet = t('rate.derived')
  const geld = useMemo(() => geldFormatierer(locale), [locale])

  return (
    <div className="overflow-x-auto border border-neutral-200 rounded bg-white"
         onMouseLeave={() => { ziehtAb.current = null }}
         onMouseUp={() => { ziehtAb.current = null }}>
      <table className="border-collapse text-sm">
        <thead>
          <Kopfzeile tage={props.tage} locale={locale} planLabel={t('rate.plan')} />
        </thead>
        <tbody>
          {props.plans.map(p => (
            <Zeile key={p.id} plan={p} tage={props.tage} zellen={nachPlan.get(p.id)}
                   belegung={props.belegung} geld={geld} abgeleitet={abgeleitet}
                   von={props.auswahl?.ratePlanId === p.id ? props.auswahl.from : null}
                   bis={props.auswahl?.ratePlanId === p.id ? props.auswahl.to : null}
                   onDown={onDown} onEnter={onEnter} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
