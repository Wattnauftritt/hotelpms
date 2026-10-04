import { useMemo, useRef, useState } from 'react'
import type { TapeChart } from '@hotelpms/contracts'
import { useTapeChart } from '../../lib/queries.js'
import { useT, useLocale, formatDate, weekdayShort } from '../../lib/i18n/index.js'
import { useSprung } from '../../lib/suche.js'
import { addDays, eachDay, today, isWeekend } from '../../lib/dates.js'
import { balkenSpanne, istFrei, mobilFenster, zimmerAmTag, zimmerGruppen, WOCHE_TAGE,
         type TagesLage, type ZimmerTag } from '../../lib/mobil.js'
import { Fehler, Laedt } from '../Shell.tsx'
import { Blaettern } from './MobilHeute.tsx'

type Ansicht = 'woche' | 'tag'
type Filter = { art: 'alle' } | { art: 'frei' } | { art: 'gruppe'; id: number }
type Einheit = TapeChart['units'][number]
type Reservierung = TapeChart['reservations'][number]

/**
 * Der Zimmerplan am Telefon, in zwei Ansichten.
 *
 * **Woche** ist der Plan, wie man ihn kennt, auf sieben Tage gekuerzt und
 * mit schmalen Zeilen, damit eine Etage mit zwoelf Zimmern auf einen
 * Bildschirm passt. Die Etagen klappen zu und nennen auch zugeklappt, wie
 * viel frei ist -- bei 35 Zimmern sucht man meist genau das.
 *
 * **Tag** zeigt jedes Zimmer als Kachel, alle auf einem Bildschirm: was ist
 * heute los, und wo ist noch etwas frei. Sven wollte beides (04.10.2026);
 * die Woche ist der Ausgangspunkt.
 *
 * **Gezogen wird hier nicht.** Ein Daumen trifft auf 32 Pixel hohen Zeilen
 * zu oft das Zimmer daneben, und ein verschobener Aufenthalt ist eine
 * Aenderung an einer echten Buchung. Antippen oeffnet das Seitenfenster der
 * Reservierung; was dort geht, geht auch am Telefon. Der Desktop-Plan
 * (`routes/Tape.tsx`) bleibt davon unberuehrt.
 *
 * Beide Ansichten teilen sich **eine** Anfrage (`mobilFenster`): ein Tag
 * vor dem ersten gezeigten, damit die Abreise am ersten Tag mitkommt.
 */
export function MobilPlan({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const { springen } = useSprung()
  const [ansicht, setAnsicht] = useState<Ansicht>('woche')
  const [start, setStart] = useState(today())
  const [filter, setFilter] = useState<Filter>({ art: 'alle' })
  const [zu, setZu] = useState<ReadonlySet<string>>(new Set())
  const fenster = mobilFenster(start)
  const q = useTapeChart(propertyId, fenster.von, fenster.bis)
  const wisch = useWischen(richtung =>
    setStart(s => addDays(s, richtung * (ansicht === 'woche' ? WOCHE_TAGE : 1))))

  const daten = q.data
  const lagen = useMemo(() => {
    const m = new Map<number, ZimmerTag>()
    if (daten === undefined) return m
    for (const u of daten.units) {
      m.set(u.id, zimmerAmTag(u.id, start, daten.reservations, daten.blocks))
    }
    return m
  }, [daten, start])

  if (q.isError && daten === undefined) return <Fehler error={q.error} />
  if (daten === undefined) return <Laedt />

  const kategorien = [...new Map(daten.units.map(u => [u.category_id, u.category_code]))]
  const passt = (u: Einheit): boolean =>
    filter.art === 'alle' ? true
      : filter.art === 'frei' ? istFrei(lagen.get(u.id)?.lage ?? 'frei')
        : u.category_id === filter.id
  const gruppen = zimmerGruppen(daten.units.filter(passt), t('mobil.plan.noFloor'),
                                n => t('mobil.plan.floor', { n }))
  const oeffnen = (ref: string): void => { springen({ art: 'reservierung', ref }) }

  const zaehle = (l: TagesLage): number => [...lagen.values()].filter(x => x.lage === l).length
  const frei = [...lagen.values()].filter(x => istFrei(x.lage)).length

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 grow">
          <div className="text-xs text-neutral-500">{t('nav.tape')}</div>
          <h1 className="truncate text-lg font-semibold">
            {ansicht === 'tag'
              ? `${weekdayShort(start, locale)} ${formatDate(start, locale)}`
              : `${formatDate(start, locale).slice(0, 6)}–${formatDate(addDays(start, WOCHE_TAGE - 1), locale)}`}
          </h1>
        </div>
        <div className="flex shrink-0 rounded-lg bg-neutral-200 p-0.5 text-sm" role="tablist">
          {(['woche', 'tag'] as const).map(a => (
            <button key={a} type="button" role="tab" aria-selected={ansicht === a}
                    onClick={() => setAnsicht(a)}
                    className={`h-9 rounded-md px-3 ${ansicht === a ? 'bg-white font-medium shadow-sm'
                                                                    : 'text-neutral-600'}`}>
              {t(a === 'woche' ? 'mobil.plan.week' : 'mobil.plan.day')}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex min-w-0 grow gap-1.5 overflow-x-auto pb-1">
          <Chip an={filter.art === 'alle'} onClick={() => setFilter({ art: 'alle' })}>
            {t('mobil.plan.all')}
          </Chip>
          <Chip an={filter.art === 'frei'} onClick={() => setFilter({ art: 'frei' })}>
            {t('mobil.plan.onlyFree')}
          </Chip>
          {kategorien.length > 1 && kategorien.map(([id, code]) => (
            <Chip key={id} an={filter.art === 'gruppe' && filter.id === id}
                  onClick={() => setFilter({ art: 'gruppe', id })}>
              {code}
            </Chip>
          ))}
        </div>
        <Blaettern datum={start} onDatum={setStart}
                   schritt={ansicht === 'woche' ? WOCHE_TAGE : 1} />
      </div>

      <div className="flex flex-wrap gap-x-3 text-xs text-neutral-600">
        <span><b className="text-emerald-700">{t('mobil.count.free', { n: frei })}</b></span>
        <span>{t('mobil.count.arrivals', { n: zaehle('anreise') + zaehle('wechsel') })}</span>
        <span>{t('mobil.count.departures', { n: zaehle('abreise') + zaehle('wechsel') })}</span>
        {zaehle('gesperrt') > 0 && <span>{t('mobil.count.blocked', { n: zaehle('gesperrt') })}</span>}
      </div>

      <div {...wisch}>
        {gruppen.length === 0 && (
          <p className="py-6 text-center text-sm text-neutral-500">{t('mobil.plan.empty')}</p>
        )}
        {ansicht === 'woche'
          ? <Woche start={start} daten={daten} gruppen={gruppen} lagen={lagen} zu={zu}
                   onZu={name => setZu(alt => {
                     const neu = new Set(alt)
                     if (neu.has(name)) neu.delete(name); else neu.add(name)
                     return neu
                   })}
                   onOeffnen={oeffnen} />
          : <Tag gruppen={gruppen} lagen={lagen} onOeffnen={oeffnen} />}
      </div>
    </div>
  )
}

function Chip({ an, onClick, children }: {
  an: boolean; onClick: () => void; children: React.ReactNode
}): JSX.Element {
  return (
    <button type="button" onClick={onClick} aria-pressed={an}
            className={`h-8 shrink-0 whitespace-nowrap rounded-full border px-3 text-xs
                        ${an ? 'border-neutral-900 bg-neutral-900 text-white'
                             : 'border-neutral-300 bg-white'}`}>
      {children}
    </button>
  )
}

/** Wie ein Balken aussieht, nach Zustand der Reservierung. */
function balkenFarbe(status: Reservierung['status']): string {
  switch (status) {
    case 'InHouse': return 'bg-violet-700 text-white'
    case 'Confirmed': return 'bg-violet-200 text-violet-950 ring-1 ring-inset ring-violet-500'
    case 'Optional': return 'bg-amber-100 text-amber-950 ring-1 ring-inset ring-amber-400'
    default: return 'bg-neutral-200 text-neutral-700'
  }
}

/** Zeilenhoehe der Woche. 32 Pixel: noch antippbar, zwoelf Zimmer passen auf einen Bildschirm. */
const ZEILE = 'h-8'

function Woche({ start, daten, gruppen, lagen, zu, onZu, onOeffnen }: {
  start: string; daten: TapeChart; gruppen: ReturnType<typeof zimmerGruppen>
  lagen: ReadonlyMap<number, ZimmerTag>; zu: ReadonlySet<string>
  onZu: (name: string) => void; onOeffnen: (ref: string) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const tage = eachDay(start, addDays(start, WOCHE_TAGE))
  const heute = today()
  const spalten = (
    <div aria-hidden className="pointer-events-none absolute inset-0 flex">
      {tage.map(d => (
        <div key={d} className={`flex-1 border-l border-neutral-100
                                 ${d === heute ? 'bg-violet-50' : isWeekend(d) ? 'bg-neutral-50' : ''}`} />
      ))}
    </div>
  )

  return (
    <div className="-mx-3 border-y border-neutral-200 bg-white">
      <div className="sticky top-[var(--kopf,0px)] z-10 flex border-b border-neutral-200 bg-neutral-50">
        <div className="w-12 shrink-0" />
        {tage.map(d => (
          <div key={d} className={`flex-1 py-1 text-center text-[10px] leading-tight
                                   ${d === heute ? 'text-violet-700' : 'text-neutral-500'}`}>
            {weekdayShort(d, locale)}
            <div className={`text-sm font-semibold ${d === heute ? '' : 'text-neutral-900'}`}>
              {d.slice(8, 10)}
            </div>
          </div>
        ))}
      </div>

      {gruppen.map(g => {
        const offen = !zu.has(g.name)
        const frei = g.zimmer.filter(u => istFrei(lagen.get(u.id)?.lage ?? 'frei')).length
        return (
          <section key={g.name}>
            <button type="button" onClick={() => onZu(g.name)} aria-expanded={offen}
                    className="flex h-9 w-full items-center gap-2 border-b border-neutral-200
                               bg-neutral-100 px-3 text-xs">
              <span aria-hidden className="w-3">{offen ? '▾' : '▸'}</span>
              <span className="grow truncate text-left font-semibold">{g.name}</span>
              <span className="text-neutral-500">{t('mobil.plan.rooms', { n: g.zimmer.length })}</span>
              <span className="font-semibold text-emerald-700">
                {t('mobil.count.free', { n: frei })}
              </span>
            </button>
            {offen && g.zimmer.map(u => (
              <div key={u.id} className={`flex ${ZEILE} border-b border-neutral-100`}>
                <div className="flex w-12 shrink-0 items-center gap-1 pl-2 text-xs font-semibold tabular-nums">
                  <span className="truncate">{u.code}</span>
                  {u.housekeeping === 'dirty' && (
                    <span title={t('hk.dirty')} className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                  )}
                </div>
                <div className="relative grow">
                  {spalten}
                  {daten.blocks.filter(b => b.resource_id === u.id).map((b, i) => {
                    const s = balkenSpanne(start, WOCHE_TAGE, b.from_date, b.to_date)
                    if (s === null) return null
                    return (
                      <div key={`s${i}`} title={b.reason}
                           style={{ left: `${s.start * 100}%`, width: `${(s.ende - s.start) * 100}%` }}
                           className="absolute inset-y-1 truncate rounded px-1 text-[10px] leading-6
                                      text-neutral-600 bg-[repeating-linear-gradient(45deg,#f5f5f5,#f5f5f5_4px,#d4d4d4_4px,#d4d4d4_8px)]">
                        {b.reason !== '' ? b.reason : t('mobil.lage.gesperrt')}
                      </div>
                    )
                  })}
                  {daten.reservations
                    .filter(r => r.resource_id === u.id && r.status !== 'Canceled' && r.status !== 'NoShow')
                    .map(r => {
                      const s = balkenSpanne(start, WOCHE_TAGE, r.arrival, r.departure)
                      if (s === null) return null
                      return (
                        <button key={r.public_ref} type="button" onClick={() => onOeffnen(r.public_ref)}
                                style={{ left: `calc(${s.start * 100}% + 1px)`,
                                         width: `calc(${(s.ende - s.start) * 100}% - 2px)` }}
                                className={`absolute inset-y-1 truncate px-1.5 text-left text-[11px]
                                            font-semibold leading-6 ${balkenFarbe(r.status)}
                                            rounded ${s.offenLinks ? 'rounded-l-none' : ''}
                                            ${s.offenRechts ? 'rounded-r-none' : ''}`}>
                          {r.status === 'Optional' ? `${t('mobil.plan.option')} ` : ''}
                          {r.last_name ?? r.public_ref}
                        </button>
                      )
                    })}
                </div>
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}

/** Wie eine Kachel der Tagesansicht aussieht. */
const KACHEL: Record<TagesLage, string> = {
  frei: 'bg-white text-emerald-800 ring-1 ring-inset ring-emerald-500',
  belegt: 'bg-violet-700 text-white',
  anreise: 'bg-violet-200 text-violet-950 ring-1 ring-inset ring-violet-500',
  abreise: 'bg-neutral-200 text-neutral-800',
  wechsel: 'bg-[linear-gradient(135deg,#e5e5e5_50%,#ddd6fe_50%)] text-neutral-900',
  gesperrt: 'text-neutral-600 bg-[repeating-linear-gradient(45deg,#f5f5f5,#f5f5f5_4px,#d4d4d4_4px,#d4d4d4_8px)]'
}

const ZEICHEN: Partial<Record<TagesLage, string>> = {
  anreise: '→', abreise: '←', wechsel: '⇄'
}

function Tag({ gruppen, lagen, onOeffnen }: {
  gruppen: ReturnType<typeof zimmerGruppen>
  lagen: ReadonlyMap<number, ZimmerTag>; onOeffnen: (ref: string) => void
}): JSX.Element {
  const t = useT()
  return (
    <div className="space-y-3">
      {gruppen.map(g => (
        <section key={g.name}>
          <h2 className="mb-1.5 text-xs font-semibold text-neutral-600">{g.name}</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(4rem,1fr))] gap-1.5">
            {g.zimmer.map(u => {
              const l = lagen.get(u.id) ?? { lage: 'frei' as const, reservierung: null }
              const r = l.reservierung
              const text = r !== null ? (r.last_name ?? r.public_ref) : t(`mobil.lage.${l.lage}`)
              return (
                <button key={u.id} type="button" disabled={r === null}
                        onClick={() => { if (r !== null) onOeffnen(r.public_ref) }}
                        aria-label={`${u.code}: ${t(`mobil.lage.${l.lage}`)}${r !== null ? `, ${text}` : ''}`}
                        className={`relative h-14 overflow-hidden rounded-lg p-1.5 text-left ${KACHEL[l.lage]}`}>
                  {u.housekeeping === 'dirty' && (
                    <span title={t('hk.dirty')}
                          className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white" />
                  )}
                  <div className="text-sm font-bold tabular-nums">{u.code}</div>
                  <div className="truncate text-[10px]">
                    {ZEICHEN[l.lage] !== undefined ? `${ZEICHEN[l.lage]} ` : ''}{text}
                  </div>
                </button>
              )
            })}
          </div>
        </section>
      ))}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-500">
        <span>→ {t('mobil.lage.anreise')}</span>
        <span>← {t('mobil.lage.abreise')}</span>
        <span>⇄ {t('mobil.lage.wechsel')}</span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-red-500" /> {t('hk.dirty')}
        </span>
      </div>
    </div>
  )
}

/**
 * Wischen blaettert: nach links in die Zukunft, nach rechts zurueck.
 *
 * Nur waagrecht und nur deutlich -- 60 Pixel und mehr zur Seite als nach
 * oben oder unten. Sonst blaetterte jedes schraege Scrollen durch die
 * Etagen eine Woche weiter.
 */
function useWischen(onWisch: (richtung: 1 | -1) => void): {
  onTouchStart: (e: React.TouchEvent) => void
  onTouchEnd: (e: React.TouchEvent) => void
} {
  const anfang = useRef<{ x: number; y: number } | null>(null)
  return {
    onTouchStart: e => {
      const p = e.touches[0]
      anfang.current = p === undefined ? null : { x: p.clientX, y: p.clientY }
    },
    onTouchEnd: e => {
      const a = anfang.current
      const p = e.changedTouches[0]
      anfang.current = null
      if (a === null || p === undefined) return
      const dx = p.clientX - a.x
      const dy = p.clientY - a.y
      if (Math.abs(dx) < 60 || Math.abs(dx) < 2 * Math.abs(dy)) return
      onWisch(dx < 0 ? 1 : -1)
    }
  }
}
