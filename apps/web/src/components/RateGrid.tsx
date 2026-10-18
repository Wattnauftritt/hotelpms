import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { RateGridAvailability, RateGridCell, RatePlan } from '@hotelpms/contracts'
import { useT, useLocale, weekdayShort, geldFormatierer,
         type Locale } from '../lib/i18n/index.js'
import { isWeekend, today } from '../lib/dates.js'
import { sperrZeichen, preisFuerBelegung, centAusEingabe,
         eingabeAusCent } from '../lib/preisraster.js'

/**
 * Das Preisraster: Tage waagerecht, je Kategorie ein Block.
 *
 * **Aufgebaut wie der Channel Manager.** Die Rezeption pflegt Preise seit
 * Jahren in RoomCloud: je Zimmertyp oben, wie viele Zimmer frei sind,
 * darunter jede Rate mit ihrem Preis und darunter ihrem Mindestaufenthalt
 * (Sven, 18.10.2026: "so sind wir es gewohnt und so ist es praktisch").
 * Standard- und Mehrtagesrate stehen damit untereinander, und wer einen Tag
 * ansieht, sieht beide Preise und beide Mindestaufenthalte auf einen Blick.
 *
 * **Es ist die Arbeitsfläche, nicht das Bild.** Über die Tage einer Zeile
 * ziehen wählt den Bereich, den die Masken darunter bearbeiten; ein
 * einfacher Klick öffnet das Feld dieses Tages, und Tab springt zum selben
 * Feld am nächsten Tag -- so tippt die Rezeption in RoomCloud eine Woche
 * Preise in einem Zug (Sven, 18.10.2026). Eine Maske, die man nur über ein
 * Menü erreicht, wird im Betrieb nicht benutzt (Dokument 19, Abschnitt 3).
 *
 * **Reihenfolge der Raten:** die Standardrate oben, darunter die übrigen in
 * der Reihenfolge, in der sie angelegt wurden. So steht es in RoomCloud, und
 * nach dem Kürzel sortiert stünde die Mehrtagesrate vorn.
 *
 * **Die Auswahl bleibt bei einem Plan.** Ein Ratenplan ist die Einheit, die
 * die API schreibt (`PUT /v1/rates/bulk` nimmt genau einen); Preis- und
 * Mindestaufenthaltszeile desselben Plans wählen dieselbe Auswahl.
 *
 * **Warum die Zeilen gemerkt werden.** Gemessen an 400 Tagen mal vier
 * Plänen: ohne `memo` zeichnete jede Mausbewegung beim Ziehen alle 1 600
 * Zellen neu, und ein Zug über fünfzig Tage dauerte fünf Sekunden. Beim
 * Ziehen ändert sich aber nur **ein** Plan. Gemerkt werden deshalb die
 * Zeilen, und die übrigen bleiben stehen.
 */

export interface Auswahl {
  ratePlanId: number
  from: string
  to: string
}

/** Die Kategorie, wie das Raster sie braucht. */
export interface RasterKategorie {
  id: number
  name: string
  code: string
  maxOccupancy: number
}

interface Props {
  plans: readonly RatePlan[]
  kategorien: readonly RasterKategorie[]
  /** Muss stabil sein, sonst greift das Merken der Zeilen nicht. */
  tage: readonly string[]
  zellen: readonly RateGridCell[]
  frei: readonly RateGridAvailability[]
  /** Welche Belegungsstufe im Raster steht. 0 = volle Belegung der Kategorie. */
  belegung: number
  auswahl: Auswahl | null
  onAuswahl: (a: Auswahl) => void
  /** Ohne Schreibrecht `undefined`: dann gibt es kein Tippen in der Zelle. */
  onPreis?: (plan: RatePlan, datum: string, priceCent: number[]) => void
  onMindest?: (plan: RatePlan, datum: string, zelle: RateGridCell | undefined,
               minLos: number | null) => void
}

/** Welche Zelle gerade getippt wird. Höchstens eine im ganzen Raster. */
interface Bearbeitung { ratePlanId: number; datum: string; feld: 'preis' | 'mindest' }

interface ZeilenProps {
  plan: RatePlan
  tage: readonly string[]
  zellen: ReadonlyMap<string, RateGridCell> | undefined
  /** Index im Preisfeld, 1 = eine Person. */
  stufe: number
  /** Nur gesetzt, wenn die Auswahl in **diesem** Plan liegt. */
  von: string | null
  bis: string | null
  /** Nur gesetzt, wenn die getippte Zelle in **diesem** Plan liegt. */
  bearbeitung: Bearbeitung | null
  /** Einmal gebaut und weitergereicht, nicht je Zelle erzeugt. */
  geld: Intl.NumberFormat
  abgeleitet: string
  mindestLabel: string
  darfTippen: boolean
  /** Getippt, aber noch nicht vom Server zurück: steht bis dahin blass da. */
  entwurf: ReadonlyMap<string, string> | undefined
  onDown: (ratePlanId: number, datum: string) => void
  onEnter: (ratePlanId: number, datum: string) => void
  /** Maus losgelassen: auf demselben Tag wie gedrückt heißt das Tippen. */
  onUp: (b: Bearbeitung) => void
  onTippen: (b: Bearbeitung | null) => void
  onSpeichern: (plan: RatePlan, b: Bearbeitung, text: string) => void
}

/**
 * Das Feld in der Zelle. Enter und Verlassen speichern, Tab speichert und
 * geht einen Tag weiter (Umschalt+Tab zurück), Escape verwirft. Ein
 * unveränderter Wert wird nicht geschickt.
 */
function Eingabe(
  { anfang, onFertig }: {
    anfang: string; onFertig: (text: string | null, weiter: -1 | 0 | 1) => void }
): JSX.Element {
  const [text, setText] = useState(anfang)
  // Verlassen nach Enter oder Tab feuert noch einmal; einmal reicht.
  const fertig = useRef(false)
  const ende = (t: string | null, weiter: -1 | 0 | 1): void => {
    if (fertig.current) return
    fertig.current = true
    onFertig(t === anfang ? null : t, weiter)
  }
  return (
    <input autoFocus value={text} onChange={e => setText(e.target.value)}
           onFocus={e => e.target.select()}
           onKeyDown={e => {
             if (e.key === 'Enter') { e.preventDefault(); ende(text, 0) }
             if (e.key === 'Tab') { e.preventDefault(); ende(text, e.shiftKey ? -1 : 1) }
             if (e.key === 'Escape') ende(null, 0)
           }}
           onBlur={() => ende(text, 0)}
           onMouseDown={e => e.stopPropagation()}
           onMouseUp={e => e.stopPropagation()}
           inputMode="decimal"
           className="w-full min-w-12 bg-white border border-sky-600 rounded-sm px-1
                      text-end text-xs text-neutral-900 tabular-nums outline-none" />
  )
}

const PlanZeilen = memo(function PlanZeilen(p: ZeilenProps): JSX.Element {
  const darfPreis = p.darfTippen && p.plan.baseRatePlanId === null
  const zelle = (d: string, feld: 'preis' | 'mindest'): JSX.Element => {
    const z = p.zellen?.get(d)
    const gewaehlt = p.von !== null && p.bis !== null && d >= p.von && d <= p.bis
    const tippt = p.bearbeitung !== null && p.bearbeitung.datum === d
      && p.bearbeitung.feld === feld
    const preis = z === undefined ? undefined : preisFuerBelegung(z.priceCent, p.stufe)
    const darf = feld === 'preis' ? darfPreis : p.darfTippen
    const b: Bearbeitung = { ratePlanId: p.plan.id, datum: d, feld }
    const getippt = p.entwurf?.get(`${d}|${feld}`)
    return (
      <td key={d}
          onMouseDown={() => { if (!tippt) p.onDown(p.plan.id, d) }}
          onMouseEnter={() => p.onEnter(p.plan.id, d)}
          onMouseUp={() => { if (darf && !tippt) p.onUp(b) }}
          aria-selected={gewaehlt}
          className={`border-b border-neutral-200 px-1 text-center tabular-nums
                      select-none ${darf ? 'cursor-text' : 'cursor-pointer'}
                      ${feld === 'preis' ? 'py-1' : 'py-0'}
                      ${tippt ? 'bg-white'
                        : gewaehlt ? 'bg-sky-100'
                        : z?.closed === true ? 'bg-red-50'
                        : isWeekend(d) ? 'bg-neutral-50' : ''}`}>
        {tippt
          ? <Eingabe anfang={feld === 'preis'
                       ? (preis === undefined ? '' : eingabeAusCent(preis))
                       : String(z?.minLos ?? '')}
                     onFertig={(text, weiter) => {
                       if (text !== null) p.onSpeichern(p.plan, b, text)
                       const i = p.tage.indexOf(d) + weiter
                       p.onTippen(weiter !== 0 && i >= 0 && i < p.tage.length
                         ? { ...b, datum: p.tage[i]! } : null)
                     }} />
          : getippt !== undefined
            ? <div className="text-xs italic text-neutral-500">{getippt}</div>
          : feld === 'preis'
            ? <>
                <div className="text-xs font-medium">
                  {preis === undefined
                    ? <span className="text-neutral-300">—</span>
                    : p.geld.format(preis / 100).replace(/\s?€/, '')}
                </div>
                {z !== undefined && sperrZeichen(z) !== '' && (
                  <div className="text-[10px] text-red-700">{sperrZeichen(z)}</div>
                )}
              </>
            : <div className={`text-[11px] ${z?.minLos != null && z.minLos > 1
                               ? 'font-semibold text-neutral-800' : 'text-neutral-400'}`}>
                {z?.minLos ?? 1}
              </div>}
      </td>
    )
  }
  return (
    <>
      <tr>
        <th scope="row" title={p.plan.code}
            className="sticky start-0 z-10 bg-white border-b border-e
                       border-neutral-200 px-2 py-1 text-start font-normal">
          <div className="font-medium leading-tight">{p.plan.name}</div>
          {p.plan.baseRatePlanId !== null && (
            <div className="text-[11px] text-neutral-500">{p.abgeleitet}</div>
          )}
        </th>
        {p.tage.map(d => zelle(d, 'preis'))}
      </tr>
      <tr className="bg-neutral-50/60">
        <th scope="row"
            className="sticky start-0 z-10 bg-neutral-50 border-b border-e border-neutral-200
                       px-2 py-0 text-end text-[11px] font-normal text-neutral-400">
          ☾ {p.mindestLabel}
        </th>
        {p.tage.map(d => zelle(d, 'mindest'))}
      </tr>
    </>
  )
})

const KategorieZeile = memo(function KategorieZeile(
  { kategorie, tage, frei, freiLabel }: {
    kategorie: RasterKategorie; tage: readonly string[]
    frei: ReadonlyMap<string, RateGridAvailability> | undefined; freiLabel: string }
): JSX.Element {
  return (
    <tr className="bg-slate-700 text-white">
      <th scope="rowgroup"
          className="sticky start-0 z-10 bg-slate-700 border-e border-slate-600
                     px-2 py-1.5 text-start">
        <div className="font-semibold leading-tight">{kategorie.name}</div>
        <div className="text-[11px] font-normal text-slate-300">{freiLabel}</div>
      </th>
      {tage.map(d => {
        const f = frei?.get(d)
        return (
          <td key={d}
              className={`border-s border-slate-600 px-1 py-1.5 text-center text-xs
                          tabular-nums ${f !== undefined && f.available <= 0
                            ? 'bg-red-600 font-semibold' : 'text-slate-100'}`}>
            {f === undefined ? '' : `${f.available} / ${f.capacity}`}
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
  const heute = today()
  return (
    <tr>
      <th className="sticky start-0 top-0 z-30 bg-white border-b border-e border-neutral-200
                     px-2 py-1 text-start font-medium min-w-40">
        {planLabel}
      </th>
      {tage.map(d => (
        <th key={d}
            className={`sticky top-0 z-20 border-b-2 px-1 py-1 font-normal
                        text-xs text-center min-w-14
                        ${d === heute ? 'border-sky-600 bg-sky-50 font-semibold'
                          : `border-neutral-200 ${isWeekend(d) ? 'bg-neutral-100' : 'bg-white'}`}`}>
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
  const { onAuswahl, onPreis, onMindest } = props
  const [bearbeitung, setBearbeitung] = useState<Bearbeitung | null>(null)
  // Je Plan, Schlüssel "Tag|Feld". Kommen neue Zellen vom Server, ist der
  // getippte Stand dort angekommen oder abgewiesen; beides löst ihn ab.
  const [entwurf, setEntwurf] = useState<ReadonlyMap<number, ReadonlyMap<string, string>>>(
    () => new Map())
  useEffect(() => { setEntwurf(new Map()) }, [props.zellen])

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

  // Ein Klick ohne Ziehen öffnet das Feld; über mehrere Tage gezogen
  // bleibt es eine Auswahl für die Masken darunter.
  const onUp = useCallback((b: Bearbeitung): void => {
    const start = ziehtAb.current
    if (start !== null && start.ratePlanId === b.ratePlanId && start.von === b.datum) {
      setBearbeitung(b)
    }
  }, [])

  const nachPlan = useMemo(() => {
    const m = new Map<number, Map<string, RateGridCell>>()
    for (const z of props.zellen) {
      let je = m.get(z.ratePlanId)
      if (je === undefined) { je = new Map(); m.set(z.ratePlanId, je) }
      je.set(z.date, z)
    }
    return m
  }, [props.zellen])

  const freiJeKategorie = useMemo(() => {
    const m = new Map<number, Map<string, RateGridAvailability>>()
    for (const f of props.frei) {
      let je = m.get(f.categoryId)
      if (je === undefined) { je = new Map(); m.set(f.categoryId, je) }
      je.set(f.date, f)
    }
    return m
  }, [props.frei])

  const stufeJeKategorie = useMemo(
    () => new Map(props.kategorien.map(k => [k.id, props.belegung === 0
      ? Math.max(1, k.maxOccupancy) : props.belegung])),
    [props.kategorien, props.belegung])

  /*
   * Ein getippter Preis ersetzt nur die gezeigte Belegungsstufe. Die übrigen
   * bleiben, wie sie stehen; fehlen Stufen bis zur gezeigten, werden sie mit
   * dem letzten vorhandenen Preis gefüllt -- denselben, den eine Buchung
   * dort bisher bekam (`preisFuerBelegung`).
   */
  const onSpeichern = useCallback((plan: RatePlan, b: Bearbeitung, text: string): void => {
    const z = nachPlan.get(plan.id)?.get(b.datum)
    setEntwurf(alt => {
      const m = new Map(alt)
      m.set(plan.id, new Map(alt.get(plan.id)).set(`${b.datum}|${b.feld}`, text.trim()))
      return m
    })
    if (b.feld === 'preis') {
      const cent = centAusEingabe(text)
      if (cent === null || onPreis === undefined) return
      const stufe = stufeJeKategorie.get(plan.categoryId) ?? 1
      const alt = z?.priceCent ?? []
      const neu = alt.length === 0 ? [cent]
        : Array.from({ length: Math.max(alt.length, stufe) },
                     (_, i) => i === stufe - 1 ? cent : alt[Math.min(i, alt.length - 1)]!)
      onPreis(plan, b.datum, neu)
    } else {
      if (onMindest === undefined) return
      const s = text.trim()
      const n = s === '' ? null : Number(s)
      if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 365)) return
      onMindest(plan, b.datum, z, n === 1 ? null : n)
    }
  }, [nachPlan, stufeJeKategorie, onPreis, onMindest])

  const abgeleitet = t('rate.derived')
  const mindestLabel = t('rate.minLos')
  const freiLabel = t('rate.grid.free')
  const geld = useMemo(() => geldFormatierer(locale), [locale])
  const darfTippen = onPreis !== undefined && onMindest !== undefined

  const bloecke = props.kategorien
    .map(k => ({ k, plaene: props.plans.filter(p => p.categoryId === k.id)
                              .sort((a, b) => rang(a) - rang(b) || a.id - b.id) }))
    .filter(b => b.plaene.length > 0)

  return (
    <div className="overflow-auto max-h-[75vh] border border-neutral-200 rounded-sm bg-white"
         onMouseLeave={() => { ziehtAb.current = null }}
         onMouseUp={() => { ziehtAb.current = null }}>
      <table className="border-collapse text-sm">
        <thead>
          <Kopfzeile tage={props.tage} locale={locale} planLabel={t('rate.plan')} />
        </thead>
        {bloecke.map(({ k, plaene }, i) => (
          <tbody key={k.id}>
            {/* Luft zwischen den Zimmergruppen: ohne sie lesen sich die
                Raten der einen als Fortsetzung der anderen. */}
            {i > 0 && (
              <tr aria-hidden="true"><td colSpan={props.tage.length + 1} className="h-3" /></tr>
            )}
            <KategorieZeile kategorie={k} tage={props.tage}
                            frei={freiJeKategorie.get(k.id)} freiLabel={freiLabel} />
            {plaene.map(p => (
              <PlanZeilen key={p.id} plan={p} tage={props.tage} zellen={nachPlan.get(p.id)}
                          stufe={stufeJeKategorie.get(k.id) ?? 1}
                          geld={geld} abgeleitet={abgeleitet} mindestLabel={mindestLabel}
                          darfTippen={darfTippen} entwurf={entwurf.get(p.id)}
                          von={props.auswahl?.ratePlanId === p.id ? props.auswahl.from : null}
                          bis={props.auswahl?.ratePlanId === p.id ? props.auswahl.to : null}
                          bearbeitung={bearbeitung?.ratePlanId === p.id ? bearbeitung : null}
                          onDown={onDown} onEnter={onEnter} onUp={onUp}
                          onTippen={setBearbeitung} onSpeichern={onSpeichern} />
            ))}
          </tbody>
        ))}
      </table>
      {darfTippen && (
        <div className="px-2 py-1 text-xs text-neutral-500">{t('rate.grid.hint')}</div>
      )}
    </div>
  )
}

/** Die Standardrate vorn, wie in RoomCloud; sonst gilt die Reihenfolge des Anlegens. */
function rang(p: RatePlan): number {
  return /standard/i.test(p.code) || /standard/i.test(p.name) ? 0 : 1
}
