import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useT, useLocale, formatMoney, formatDate, weekdayShort } from '../../lib/i18n/index.js'
import { useEscape } from '../../lib/tasten.js'
import { addMonths } from '../../lib/dates.js'
import { Fehler, Laedt } from '../Shell.tsx'
import { Feld, KNOPF_LEISE } from '../Dialog.tsx'
import {
  useKasseneinstellung, useKassenmonat, useBelegNachreichen, belegAdresse,
  type Kassenmonat, type Kassenzeile
} from '../../lib/queries/kassenbuch.js'
import { belegVorbereiten } from '../../lib/kassenbeleg.js'
import { kassenbloecke, type Kassenblock } from '../../lib/kassengruppen.js'
import {
  ART, ERFASSUNG, Belegwahl, useErfassung, Stornieren, Loeschen, DatevExport, Einstellung
} from '../../routes/Kassenbuch.tsx'

/**
 * Das Kassenbuch am Telefon (Sven, 07.10.2026).
 *
 * **Warum eine eigene Fassung.** Die Tabelle des Desktops hat neun Spalten;
 * auf 390 Pixeln rollt sie seitwaerts, und Betrag und Bestand stehen
 * ausserhalb des Bildes. Am Telefon steht deshalb je Buchung eine Zeile mit
 * dem, was man sucht -- wer oder was, und wie viel --, nach Tagen
 * gegliedert. Alles Weitere (Zeilen einer Gastbuchung, Steuersatz, Belege,
 * Stornieren) steht hinter einem Antippen.
 *
 * **Warum die neue Buchung eine eigene Seite ist.** Am Telefon wird vor
 * allem eine Ausgabe mit ihrem Bon erfasst, und der Bon will fotografiert
 * werden. Ueber der Liste bliebe dafuer ein Streifen; als ganze Seite steht
 * das Foto so gross da, dass man vor dem Buchen sieht, ob es lesbar ist,
 * und "Buchen" klebt unten am Daumen. Die Seite rechnet und bucht mit
 * demselben Haken wie der Desktop (`useErfassung`).
 *
 * Die Kamera bleibt das Dateifeld mit `capture` (`lib/kassenbeleg.ts`): das
 * Telefon oeffnet dafuer seine eigene Kamera ueber den ganzen Bildschirm,
 * mit Fokus, Blitz und Wiederholen, und das kann keine Webseite besser.
 */
export function MobilKasse({ propertyId, permissions }: {
  propertyId: number; permissions: readonly string[]
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const darfEinstellen = permissions.includes('cashbook:export')
  const darfBuchen = permissions.includes('cashbook:write')
  const darfStornieren = permissions.includes('cashbook:void')
  const [monat, setMonat] = useState<string | null>(null)
  const [neu, setNeu] = useState(false)
  // Nach Nummer und nicht als Block: nach einem Storno oder Beleg kommt der
  // Monat neu, und das Blatt soll den neuen Stand zeigen, nicht den alten.
  const [gewaehlt, setGewaehlt] = useState<number | null>(null)
  const [storno, setStorno] = useState<Kassenzeile | null>(null)
  const [loeschen, setLoeschen] = useState<Kassenzeile | null>(null)
  const [datev, setDatev] = useState(false)
  const [einstellen, setEinstellen] = useState(false)

  const e = useKasseneinstellung(propertyId)
  const q = useKassenmonat(propertyId, monat, e.data?.enabled === true)
  const m = q.data
  const bloecke = useMemo(() => kassenbloecke(m?.entries ?? []), [m])
  const block = bloecke.find(b => b.kopf.entryNo === gewaehlt)

  if (e.isError) return <Fehler error={e.error} />
  if (e.data === undefined) return <Laedt />

  const einstellung = e.data
  const dialoge = <>
    {einstellen && <Einstellung propertyId={propertyId} e={einstellung} onClose={() => setEinstellen(false)} />}
    {datev && m && <DatevExport propertyId={propertyId} heute={m.today} onClose={() => setDatev(false)} />}
  </>
  const schreibtisch = darfEinstellen && (
    <div className="flex flex-wrap gap-2">
      {m && <button className={KNOPF_LEISE} onClick={() => setDatev(true)}>{t('cash.datev.title')}</button>}
      <button className={KNOPF_LEISE} onClick={() => setEinstellen(true)}>{t('cash.settings')}</button>
    </div>
  )

  if (!einstellung.enabled) {
    return (
      <div className="space-y-3">
        <h1 className="text-lg font-semibold">{t('cash.title')}</h1>
        <p className="text-sm text-neutral-600">
          {t(darfEinstellen ? 'cash.disabled.canEnable' : 'cash.disabled')}
        </p>
        {schreibtisch}
        {dialoge}
      </div>
    )
  }
  if (q.isError) return <Fehler error={q.error} />
  if (m === undefined) return <Laedt />

  return (
    // Unten Platz fuer den schwebenden Knopf, sonst deckt er die letzte Buchung zu.
    <div className={`space-y-3 ${darfBuchen ? 'pb-24' : ''}`}>
      <Monatswahl m={m} onMonat={setMonat} />

      <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3">
        <div className="text-xs text-neutral-600">{t('cash.balance.today')}</div>
        <div className={`text-2xl font-semibold tabular-nums ${m.todayBalanceCent < 0 ? 'text-red-700' : ''}`}>
          {formatMoney(m.todayBalanceCent, locale)}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Kennzahl titel={t('cash.income')} cent={m.incomeCent} />
        <Kennzahl titel={t('cash.outgoing')} cent={m.outgoingCent} />
        <Kennzahl titel={t('cash.balance.end')} cent={m.closingBalanceCent} />
      </div>

      {bloecke.length === 0
        ? <p className="text-sm text-neutral-500">{t('cash.none')}</p>
        : <Liste bloecke={bloecke} onWahl={setGewaehlt} />}

      {schreibtisch}

      {darfBuchen && (
        <button type="button" onClick={() => setNeu(true)}
                className="fixed right-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20
                           h-14 rounded-full bg-neutral-900 px-5 text-base font-medium text-white shadow-lg">
          + {t('cash.new')}
        </button>
      )}

      {neu && <NeueBuchung propertyId={propertyId} m={m} onClose={() => setNeu(false)} />}
      {block !== undefined && (
        <Buchungsblatt propertyId={propertyId} b={block} darfBuchen={darfBuchen}
                       darfStornieren={darfStornieren} onStorno={setStorno} onLoeschen={setLoeschen}
                       onClose={() => setGewaehlt(null)} />
      )}
      {storno !== null && <Stornieren propertyId={propertyId} z={storno} onClose={() => setStorno(null)} />}
      {loeschen !== null && (
        <Loeschen propertyId={propertyId} z={loeschen} onClose={() => setLoeschen(null)} />
      )}
      {dialoge}
    </div>
  )
}

function Monatswahl({ m, onMonat }: { m: Kassenmonat; onMonat: (monat: string) => void }): JSX.Element {
  const t = useT()
  const blaettern = (n: number): void => onMonat(addMonths(`${m.month}-01`, n).slice(0, 7))
  const letzter = m.month >= m.today.slice(0, 7)
  const knopf = 'h-11 w-11 shrink-0 rounded-md border border-neutral-300 bg-white text-lg disabled:text-neutral-300'
  return (
    <div className="flex items-center gap-2">
      <h1 className="grow text-lg font-semibold">{t('cash.title')}</h1>
      <button className={knopf} onClick={() => blaettern(-1)} aria-label={t('common.back')}>‹</button>
      <input type="month" value={m.month} max={m.today.slice(0, 7)}
             onChange={ev => ev.target.value && onMonat(ev.target.value)}
             className="h-11 w-36 rounded-md border border-neutral-300 bg-white px-2 text-base" />
      <button className={knopf} disabled={letzter} onClick={() => blaettern(1)}
              aria-label={t('common.forward')}>›</button>
    </div>
  )
}

function Kennzahl({ titel, cent }: { titel: string; cent: number }): JSX.Element {
  const locale = useLocale()
  return (
    <div className="min-w-0 rounded-lg border border-neutral-200 bg-white p-2">
      <div className="truncate text-[11px] text-neutral-600">{titel}</div>
      <div className={`truncate text-sm font-semibold tabular-nums ${cent < 0 ? 'text-red-700' : ''}`}>
        {formatMoney(cent, locale)}
      </div>
    </div>
  )
}

/** Was eine Buchung in der Liste heisst: der Gast, sonst der Text, sonst die Art. */
function benennen(z: Kassenzeile, art: string): string {
  return z.guestName ?? z.text ?? art
}

/**
 * Die Buchungen des Monats, nach Tag gegliedert. Der Tag steht einmal
 * darueber statt in jeder Zeile: am Telefon ist jede Zeile, die nicht
 * gelesen werden muss, eine Zeile weniger Liste im Bild.
 */
function Liste({ bloecke, onWahl }: {
  bloecke: Kassenblock[]; onWahl: (entryNo: number) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const tage: Array<{ tag: string; bloecke: Kassenblock[] }> = []
  for (const b of bloecke) {
    const letzter = tage.at(-1)
    if (letzter?.tag === b.kopf.businessDate) letzter.bloecke.push(b)
    else tage.push({ tag: b.kopf.businessDate, bloecke: [b] })
  }
  return (
    <div className="space-y-3">
      {tage.map(({ tag, bloecke }) => (
        <section key={tag} className="space-y-1">
          <h2 className="px-1 text-xs font-medium text-neutral-500">
            {weekdayShort(tag, locale)}, {formatDate(tag, locale)}
          </h2>
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 bg-white">
            {bloecke.map(b => {
              const z = b.kopf
              const aufgehoben = z.voidedByNo !== null
              const art = t(ART[z.kind])
              const name = benennen(z, art)
              return (
                <li key={z.entryNo}>
                  <button type="button" onClick={() => onWahl(z.entryNo)}
                          className={`flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left
                                      ${aufgehoben ? 'text-neutral-400' : ''}`}>
                    <div className="min-w-0 grow">
                      <div className={`truncate text-sm font-medium ${aufgehoben ? 'line-through' : ''}`}>
                        {name}
                      </div>
                      <div className="truncate text-xs text-neutral-500">
                        {z.entryNo}
                        {name !== art && ` · ${art}`}
                        {b.mitglieder.length > 0 && ` · ${t('cash.group.lines', { n: b.mitglieder.length })}`}
                        {z.reversesNo !== null && ` · ${t('cash.reverses', { n: z.reversesNo })}`}
                        {aufgehoben && ` · ${t('cash.voidedBy', { n: z.voidedByNo! })}`}
                        {b.belege.length > 0 && <Bueroklammer />}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className={`text-sm font-semibold tabular-nums
                                       ${b.summeCent < 0 && !aufgehoben ? 'text-red-700' : ''}
                                       ${aufgehoben ? 'line-through' : ''}`}>
                        {formatMoney(b.summeCent, locale)}
                      </div>
                      {b.bestandCent !== null && (
                        <div className="text-xs tabular-nums text-neutral-500">
                          {formatMoney(b.bestandCent, locale)}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** Zeigt, dass ein Beleg dranhaengt; als Zeichen, weil daneben kein Platz fuer ein Wort ist. */
function Bueroklammer(): JSX.Element {
  const t = useT()
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
         role="img" aria-label={t('cash.col.receipts')} className="ml-1 inline h-3.5 w-3.5 align-[-2px]">
      <path d="m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 8" />
    </svg>
  )
}

/**
 * Der Zurueck-Knopf des Telefons schliesst die Seite, statt den Bildschirm
 * zu verlassen. Auf Android ist das der Griff, mit dem man eine Seite
 * verlaesst; ohne eigenen Eintrag im Verlauf fuehrte er zum vorigen
 * Bildschirm, und die halb erfasste Buchung samt Foto waere weg.
 *
 * Gibt die Funktion zurueck, mit der die Seite selbst schliesst: ueber den
 * Verlauf, damit der eigene Eintrag nicht liegen bleibt -- sonst taete der
 * naechste Druck auf Zurueck scheinbar nichts. Verschwindet die Seite von
 * selbst (die Buchung ist geloescht), nimmt sie ihren Eintrag mit.
 */
function useZurueckSchliesst(onClose: () => void): () => void {
  const halter = useRef(onClose)
  halter.current = onClose
  const lebt = useRef(false)
  useEffect(() => {
    lebt.current = true
    // Nur einmal: im StrictMode laeuft der Effekt doppelt.
    if (!eigenerEintrag()) history.pushState({ kassenseite: true }, '', location.href)
    const zurueck = (): void => halter.current()
    window.addEventListener('popstate', zurueck)
    return () => {
      lebt.current = false
      window.removeEventListener('popstate', zurueck)
      // Spaeter pruefen: der StrictMode baut gleich wieder auf, und dann bleibt der Eintrag.
      setTimeout(() => { if (!lebt.current && eigenerEintrag()) history.back() }, 0)
    }
  }, [])
  return () => { if (eigenerEintrag()) history.back(); else halter.current() }
}

function eigenerEintrag(): boolean {
  return (history.state as { kassenseite?: boolean } | null)?.kassenseite === true
}

/**
 * Eine Seite ueber dem ganzen Bildschirm, auch ueber der Leiste: Kopf, Rumpf,
 * Fuss. `onClose` kommt aus `useZurueckSchliesst` beim Aufrufer, damit auch
 * der Fuss (etwa "Buchen") ueber den Verlauf schliessen kann.
 */
function Vollbild({ titel, onClose, fuss, children }: {
  titel: ReactNode; onClose: () => void; fuss?: ReactNode; children: ReactNode
}): JSX.Element {
  const t = useT()
  useEscape(onClose)
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-40 flex flex-col bg-white">
      <header className="flex items-center gap-2 border-b border-neutral-200 px-2
                         pt-[env(safe-area-inset-top)]">
        <button type="button" onClick={onClose}
                className="h-12 shrink-0 px-2 text-base text-violet-700">
          ‹ {t('common.back')}
        </button>
        <h2 className="min-w-0 grow truncate pr-2 text-right text-base font-semibold">{titel}</h2>
      </header>
      <div className="grow overflow-y-auto overscroll-contain p-4">{children}</div>
      {fuss !== undefined && (
        <footer className="border-t border-neutral-200 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          {fuss}
        </footer>
      )}
    </div>
  )
}

/*
 * 16 Pixel Schrift in jedem Feld: darunter zoomt Safari beim Antippen in
 * die Seite hinein und nicht wieder heraus.
 */
const FELD_GROSS = 'h-12 w-full rounded-md border border-neutral-300 bg-white px-3 text-base'

/**
 * Wie `Feld`, aber als Gruppe und nicht als `label`: ein `label` um mehrere
 * Knoepfe leitet jedes Antippen daneben an den ersten weiter, und die Art
 * sprang dann auf "Uebernachtung" zurueck.
 */
function Gruppe({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div role="group" aria-label={label} className="text-sm">
      <div className="mb-1 text-xs text-neutral-600">{label}</div>
      {children}
    </div>
  )
}

function Wahl<T extends string | number>({ werte, wert, onWert, spalten }: {
  werte: ReadonlyArray<readonly [T, string]>; wert: T; onWert: (w: T) => void; spalten: string
}): JSX.Element {
  return (
    <div className={`grid gap-2 ${spalten}`}>
      {werte.map(([w, text]) => (
        <button key={String(w)} type="button" onClick={() => onWert(w)} aria-pressed={wert === w}
                className={`min-h-12 rounded-md border px-2 text-sm
                            ${wert === w
                              ? 'border-violet-700 bg-violet-50 font-semibold text-violet-800'
                              : 'border-neutral-300 bg-white'}`}>
          {text}
        </button>
      ))}
    </div>
  )
}

/**
 * Neue Buchung als ganze Seite. Reihenfolge nach dem, was man in der Hand
 * hat: erst die Art, dann den Betrag, dann den Beleg; Datum und Text sind
 * meist schon richtig oder leer und stehen darunter.
 */
function NeueBuchung({ propertyId, m, onClose }: {
  propertyId: number; m: Kassenmonat; onClose: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const f = useErfassung({ propertyId, heute: m.today, fruehstueckCent: m.breakfastPriceCent,
                           speisenBp: m.breakfastFoodShareBp })
  const schliessen = useZurueckSchliesst(onClose)
  return (
    <Vollbild titel={t('cash.new')} onClose={schliessen}
              fuss={<>
                {f.buchen.isError && <div className="mb-2"><Fehler error={f.buchen.error} /></div>}
                <button type="button" disabled={!f.bereit} onClick={() => f.speichern(schliessen)}
                        className="h-12 w-full rounded-md bg-neutral-900 text-base font-medium text-white
                                   disabled:bg-neutral-300">
                  {t('cash.save')}
                </button>
              </>}>
      <div className="space-y-5">
        <Gruppe label={t('cash.field.kind')}>
          <Wahl werte={ERFASSUNG.map(([k, key]) => [k, t(key)] as const)} wert={f.art}
                onWert={f.setArt} spalten="grid-cols-2" />
        </Gruppe>

        <Feld label={t(f.art === 'guest' ? 'cash.field.total' : 'cash.field.amount')}>
          <div className="relative">
            <input inputMode="decimal" value={f.betrag} onChange={ev => f.setBetrag(ev.target.value)}
                   placeholder="0,00"
                   className="h-16 w-full rounded-md border border-neutral-300 bg-white pl-3 pr-10
                              text-right text-3xl font-semibold tabular-nums" />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xl text-neutral-500">
              €
            </span>
          </div>
        </Feld>
        {f.art === 'other' && <p className="text-sm text-neutral-500">{t('cash.otherHint')}</p>}

        {f.art === 'guest' && (
          <div className="grid grid-cols-2 gap-3">
            <Feld label={t('cash.field.breakfasts')}>
              <input inputMode="numeric" value={f.anzahl} onChange={ev => f.setAnzahl(ev.target.value)}
                     className={`${FELD_GROSS} text-right`} />
            </Feld>
            <Feld label={t('cash.field.cityTax')}>
              <input inputMode="decimal" value={f.kurtaxe} onChange={ev => f.setKurtaxe(ev.target.value)}
                     placeholder="0,00" className={`${FELD_GROSS} text-right tabular-nums`} />
            </Feld>
          </div>
        )}
        {f.art === 'guest' && f.vorschau.length > 0 && (
          <ul className="space-y-0.5 text-sm text-neutral-600">
            {f.vorschau.map(z => (
              <li key={z.kind} className="flex justify-between gap-2">
                <span>{t(ART[z.kind])} {z.taxRateBp / 100} %</span>
                <span className="tabular-nums">{formatMoney(z.amountCent, locale)}</span>
              </li>
            ))}
          </ul>
        )}
        {(f.art === 'expense' || f.art === 'other') && (
          <Gruppe label={t('cash.field.taxRate')}>
            <Wahl werte={[0, 700, 1900].map(s => [s, `${s / 100} %`] as const)} wert={f.satz}
                  onWert={f.setSatz} spalten="grid-cols-3" />
          </Gruppe>
        )}

        <Gruppe label={t('cash.col.receipts')}>
          <Belegwahl belege={f.belege} onBelege={f.setBelege} gross />
        </Gruppe>

        <Feld label={t('cash.field.date')}>
          <input type="date" value={f.datum} max={m.today} onChange={ev => f.setDatum(ev.target.value)}
                 className={FELD_GROSS} />
        </Feld>
        <Feld label={t('cash.field.guest')}>
          <input value={f.gast} maxLength={100} onChange={ev => f.setGast(ev.target.value)}
                 className={FELD_GROSS} />
        </Feld>
        <Feld label={t('cash.field.text')}>
          <input value={f.text} maxLength={255} onChange={ev => f.setText(ev.target.value)}
                 className={FELD_GROSS} />
        </Feld>
      </div>
    </Vollbild>
  )
}

/**
 * Eine Buchung mit allem, was die Liste weglaesst: die Zeilen einer
 * Gastbuchung, Steuersaetze, die Belege als Bild und die Handlungen.
 */
function Buchungsblatt({ propertyId, b, darfBuchen, darfStornieren, onStorno, onLoeschen, onClose }: {
  propertyId: number; b: Kassenblock; darfBuchen: boolean; darfStornieren: boolean
  onStorno: (z: Kassenzeile) => void; onLoeschen: (z: Kassenzeile) => void; onClose: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const z = b.kopf
  const nachreichen = useBelegNachreichen(propertyId)
  const kamera = useRef<HTMLInputElement>(null)
  const datei = useRef<HTMLInputElement>(null)
  const aufgehoben = z.voidedByNo !== null
  const storno = z.reversesNo !== null
  const zeilen = [z, ...b.mitglieder]
  const reichen = async (liste: FileList | null): Promise<void> => {
    for (const f of Array.from(liste ?? [])) {
      nachreichen.mutate({ entryNo: z.entryNo, beleg: await belegVorbereiten(f) })
    }
  }
  const schliessen = useZurueckSchliesst(onClose)
  return (
    <Vollbild titel={t('cash.entry.title', { n: z.entryNo })} onClose={schliessen}>
      <div className="space-y-5">
        <div>
          <div className="text-sm text-neutral-500">
            {weekdayShort(z.businessDate, locale)}, {formatDate(z.businessDate, locale)}
          </div>
          <div className={`text-3xl font-semibold tabular-nums ${aufgehoben ? 'text-neutral-400 line-through' : ''}
                           ${b.summeCent < 0 && !aufgehoben ? 'text-red-700' : ''}`}>
            {formatMoney(b.summeCent, locale)}
          </div>
          {[z.guestName, z.text].filter(Boolean).map(s => <div key={s} className="text-base">{s}</div>)}
          {z.externalNumber !== null && <div className="text-xs text-neutral-500">{z.externalNumber}</div>}
          {storno && <div className="text-sm text-amber-800">{t('cash.reverses', { n: z.reversesNo! })}</div>}
          {aufgehoben && <div className="text-sm text-neutral-600">{t('cash.voidedBy', { n: z.voidedByNo! })}</div>}
        </div>

        <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
          {zeilen.map(r => (
            <li key={r.entryNo} className={`flex items-baseline gap-2 px-3 py-2 text-sm
                                             ${r.voidedByNo !== null ? 'text-neutral-400 line-through' : ''}`}>
              <span className="w-10 shrink-0 tabular-nums text-neutral-500">{r.entryNo}</span>
              <span className="min-w-0 grow truncate">{t(ART[r.kind])}</span>
              <span className="shrink-0 tabular-nums text-neutral-500">{r.taxRateBp / 100} %</span>
              <span className="w-24 shrink-0 text-right tabular-nums">{formatMoney(r.amountCent, locale)}</span>
            </li>
          ))}
          {b.bestandCent !== null && (
            <li className="flex justify-between px-3 py-2 text-sm text-neutral-600">
              <span>{t('cash.col.balance')}</span>
              <span className="tabular-nums font-medium">{formatMoney(b.bestandCent, locale)}</span>
            </li>
          )}
        </ul>

        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            {t('cash.col.receipts')}
          </h3>
          {b.belege.length === 0 && <p className="text-sm text-neutral-500">{t('cash.receipt.none')}</p>}
          <div className="grid grid-cols-2 gap-2">
            {b.belege.map((beleg, i) => (
              <a key={beleg.ref} href={belegAdresse(propertyId, beleg.ref)} target="_blank" rel="noreferrer"
                 className="flex h-32 items-center justify-center overflow-hidden rounded-md border
                            border-neutral-200 bg-neutral-50 text-sm underline">
                {beleg.mime.startsWith('image/')
                  ? <img src={belegAdresse(propertyId, beleg.ref)} alt={t('cash.receipt.n', { n: i + 1 })}
                         loading="lazy" className="h-full w-full object-cover object-top" />
                  : t('cash.receipt.n', { n: i + 1 })}
              </a>
            ))}
          </div>
          {darfBuchen && !storno && (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" disabled={nachreichen.isPending} onClick={() => kamera.current?.click()}
                      className="h-12 rounded-md border border-neutral-300 bg-white text-base">
                {t('cash.receipt.photo')}
              </button>
              <button type="button" disabled={nachreichen.isPending} onClick={() => datei.current?.click()}
                      className="h-12 rounded-md border border-neutral-300 bg-white text-base">
                {t('cash.receipt.file')}
              </button>
              <input ref={kamera} type="file" accept="image/*" capture="environment" hidden
                     onChange={ev => { void reichen(ev.target.files); ev.target.value = '' }} />
              <input ref={datei} type="file" accept="application/pdf,image/jpeg,image/png" hidden
                     onChange={ev => { void reichen(ev.target.files); ev.target.value = '' }} />
            </div>
          )}
          {nachreichen.isPending && <Laedt />}
          {nachreichen.isError && <Fehler error={nachreichen.error} />}
        </section>

        {darfStornieren && !storno && (
          <div className="grid grid-cols-2 gap-2 pt-2">
            {!aufgehoben && (
              <button type="button" onClick={() => onStorno(z)}
                      className="h-12 rounded-md border border-red-300 bg-white text-base text-red-700">
                {t('cash.void')}
              </button>
            )}
            {/* Uebernommenes loescht das Adminpanel, sonst kaeme es wieder. */}
            {!z.datevExported && z.externalNumber === null && (
              <button type="button" onClick={() => onLoeschen(z)}
                      className="h-12 rounded-md border border-neutral-300 bg-white text-base text-neutral-700">
                {t('cash.erase')}
              </button>
            )}
          </div>
        )}
      </div>
    </Vollbild>
  )
}
