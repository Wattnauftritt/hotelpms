import { useMemo, useRef, useState, type JSX } from 'react'
import { splitGuestBooking } from '@hotelpms/domain/cashbook'
import { useT, useLocale, formatMoney, formatDate, type TextKey } from '../lib/i18n/index.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { Dialog, Feld, KNOPF, KNOPF_LEISE } from '../components/Dialog.tsx'
import { centAusEingabe, eingabeAusCent } from '../lib/preisraster.js'
import { addMonths } from '../lib/dates.js'
import {
  useKasseneinstellung, useKassenmonat, useBuchen, useStornieren, useBelegNachreichen,
  useKasseneinstellungSpeichern, belegAdresse,
  type Kassenart, type Kassenzeile, type Kasseneinstellung, type NeuerBeleg, type Neubuchung
} from '../lib/queries/kassenbuch.js'
import { belegVorbereiten, BelegZuGross } from '../lib/kassenbeleg.js'

/**
 * Kassenbuch (Migration 0095, Dokument 09).
 *
 * Aufgebaut wie im Adminpanel, damit die Rezeption beim Umstieg nichts neu
 * lernt: oben erfassen, darunter der Monat mit laufendem Bestand. Anders
 * als dort laesst sich nichts loeschen; ein Fehler wird storniert, und
 * Buchung wie Storno bleiben stehen.
 *
 * Der Monat ist ein Aufruf. Die Fruehstuecksaufteilung einer Gastbuchung
 * rechnet die Vorschau mit derselben Funktion wie der Server, sonst stuende
 * hier ein Cent anders als nachher im Buch.
 */

const ART: Record<Kassenart, TextKey> = {
  lodging: 'cash.kind.lodging', breakfast_food: 'cash.kind.breakfastFood',
  breakfast_drinks: 'cash.kind.breakfastDrinks', city_tax: 'cash.kind.cityTax',
  cash_in: 'cash.kind.cashIn', bank_deposit: 'cash.kind.bankDeposit',
  expense: 'cash.kind.expense', other: 'cash.kind.other', legacy_guest: 'cash.kind.legacyGuest'
}

type Erfassung = 'guest' | 'city_tax' | 'cash_in' | 'bank_deposit' | 'expense' | 'other'
const ERFASSUNG: Array<[Erfassung, TextKey]> = [
  ['guest', 'cash.kind.guest'], ['city_tax', 'cash.kind.cityTax'],
  ['cash_in', 'cash.kind.cashIn'], ['bank_deposit', 'cash.kind.bankDeposit'],
  ['expense', 'cash.kind.expense'], ['other', 'cash.kind.other']
]

const FELD = 'border border-neutral-300 rounded-sm px-2 py-1 text-sm w-full'

function Kachel({ titel, cent, betont }: { titel: string; cent: number; betont?: boolean }): JSX.Element {
  const locale = useLocale()
  return (
    <div className={`rounded-sm border p-3 ${betont ? 'border-emerald-300 bg-emerald-50' : 'border-neutral-200 bg-white'}`}>
      <div className="text-xs text-neutral-600">{titel}</div>
      <div className={`text-lg font-semibold tabular-nums ${cent < 0 ? 'text-red-700' : ''}`}>
        {formatMoney(cent, locale)}
      </div>
    </div>
  )
}

/** Fotos oder Dateien sammeln, bevor die Buchung gespeichert wird. */
function Belegwahl({ belege, onBelege }: {
  belege: NeuerBeleg[]; onBelege: (b: NeuerBeleg[]) => void
}): JSX.Element {
  const t = useT()
  const kamera = useRef<HTMLInputElement>(null)
  const datei = useRef<HTMLInputElement>(null)
  const [fehler, setFehler] = useState<string | null>(null)
  const nehmen = async (liste: FileList | null) => {
    setFehler(null)
    const neu: NeuerBeleg[] = []
    for (const f of Array.from(liste ?? [])) {
      try { neu.push(await belegVorbereiten(f)) } catch (e) {
        setFehler(t(e instanceof BelegZuGross ? 'cash.receipt.tooLarge' : 'cash.receipt.type'))
      }
    }
    onBelege([...belege, ...neu].slice(0, 10))
  }
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={KNOPF_LEISE} onClick={() => kamera.current?.click()}>
          {t('cash.receipt.photo')}
        </button>
        <button type="button" className={KNOPF_LEISE} onClick={() => datei.current?.click()}>
          {t('cash.receipt.file')}
        </button>
        <input ref={kamera} type="file" accept="image/*" capture="environment" hidden
               onChange={e => { void nehmen(e.target.files); e.target.value = '' }} />
        <input ref={datei} type="file" accept="application/pdf,image/jpeg,image/png" multiple hidden
               onChange={e => { void nehmen(e.target.files); e.target.value = '' }} />
      </div>
      {belege.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-xs">
          {belege.map((b, i) => (
            <li key={i} className="flex items-center gap-1 rounded-sm border border-neutral-200 px-2 py-1">
              {b.data.startsWith('data:image/')
                ? <img src={b.data} alt="" className="h-10 w-10 object-cover" />
                : <span>PDF</span>}
              <span className="max-w-32 truncate">{b.name}</span>
              <button type="button" aria-label={t('cash.receipt.remove')}
                      onClick={() => onBelege(belege.filter((_, j) => j !== i))}>×</button>
            </li>
          ))}
        </ul>
      )}
      {fehler !== null && <div className="text-xs text-red-700">{fehler}</div>}
    </div>
  )
}

function Erfassen({ propertyId, heute, fruehstueckCent, speisenBp }: {
  propertyId: number; heute: string; fruehstueckCent: number; speisenBp: number
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const buchen = useBuchen(propertyId)
  const [art, setArt] = useState<Erfassung>('guest')
  const [datum, setDatum] = useState(heute)
  const [betrag, setBetrag] = useState('')
  const [anzahl, setAnzahl] = useState('0')
  const [kurtaxe, setKurtaxe] = useState('')
  const [satz, setSatz] = useState(1900)
  const [gast, setGast] = useState('')
  const [text, setText] = useState('')
  const [belege, setBelege] = useState<NeuerBeleg[]>([])

  const cent = centAusEingabe(betrag)
  const fruehstuecke = Number.parseInt(anzahl, 10)
  const vorschau = useMemo(() => art !== 'guest' ? [] : splitGuestBooking({
    totalCent: cent ?? 0, breakfasts: Number.isFinite(fruehstuecke) ? fruehstuecke : 0,
    cityTaxCent: centAusEingabe(kurtaxe) ?? 0, breakfastPriceCent: fruehstueckCent,
    breakfastFoodShareBp: speisenBp }), [art, cent, fruehstuecke, kurtaxe, fruehstueckCent, speisenBp])

  const leeren = () => {
    setBetrag(''); setAnzahl('0'); setKurtaxe(''); setGast(''); setText(''); setBelege([])
  }
  const speichern = () => {
    const gemeinsam = { businessDate: datum, guestName: gast.trim() || undefined,
                        text: text.trim() || undefined, receipts: belege }
    const b: Neubuchung = art === 'guest'
      ? { kind: 'guest', ...gemeinsam, totalCent: cent ?? 0,
          breakfasts: Number.isFinite(fruehstuecke) ? fruehstuecke : 0,
          cityTaxCent: centAusEingabe(kurtaxe) ?? 0 }
      : { kind: art, ...gemeinsam, amountCent: cent ?? 0,
          ...(art === 'expense' || art === 'other' ? { taxRateBp: satz } : {}) }
    buchen.mutate(b, { onSuccess: leeren })
  }

  return (
    <section className="rounded-sm border border-neutral-200 bg-white p-3 space-y-3">
      <h2 className="text-sm font-medium">{t('cash.new')}</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Feld label={t('cash.field.kind')}>
          <select value={art} onChange={e => setArt(e.target.value as Erfassung)} className={FELD}>
            {ERFASSUNG.map(([k, key]) => <option key={k} value={k}>{t(key)}</option>)}
          </select>
        </Feld>
        <Feld label={t('cash.field.date')}>
          <input type="date" value={datum} max={heute} onChange={e => setDatum(e.target.value)}
                 className={FELD} />
        </Feld>
        <Feld label={t(art === 'guest' ? 'cash.field.total' : 'cash.field.amount')}>
          <input inputMode="decimal" value={betrag} onChange={e => setBetrag(e.target.value)}
                 className={`${FELD} text-right tabular-nums`} placeholder="0,00" />
        </Feld>
        {art === 'guest' && <>
          <Feld label={t('cash.field.breakfasts')}>
            <input type="number" min={0} value={anzahl} onChange={e => setAnzahl(e.target.value)}
                   className={`${FELD} text-right`} />
          </Feld>
          <Feld label={t('cash.field.cityTax')}>
            <input inputMode="decimal" value={kurtaxe} onChange={e => setKurtaxe(e.target.value)}
                   className={`${FELD} text-right tabular-nums`} placeholder="0,00" />
          </Feld>
        </>}
        {(art === 'expense' || art === 'other') && (
          <Feld label={t('cash.field.taxRate')}>
            <select value={satz} onChange={e => setSatz(Number(e.target.value))} className={FELD}>
              {[0, 700, 1900].map(s => <option key={s} value={s}>{s / 100} %</option>)}
            </select>
          </Feld>
        )}
        <Feld label={t('cash.field.guest')}>
          <input value={gast} maxLength={100} onChange={e => setGast(e.target.value)} className={FELD} />
        </Feld>
        <Feld label={t('cash.field.text')} className="col-span-2">
          <input value={text} maxLength={255} onChange={e => setText(e.target.value)} className={FELD} />
        </Feld>
      </div>
      {art === 'guest' && vorschau.length > 0 && (
        <div className="text-xs text-neutral-600 flex flex-wrap gap-x-4">
          {vorschau.map(z => (
            <span key={z.kind}>
              {t(ART[z.kind])} {z.taxRateBp / 100} %: {formatMoney(z.amountCent, locale)}
            </span>
          ))}
        </div>
      )}
      {art === 'other' && <div className="text-xs text-neutral-500">{t('cash.otherHint')}</div>}
      <Belegwahl belege={belege} onBelege={setBelege} />
      {buchen.isError && <Fehler error={buchen.error} />}
      <button className={KNOPF} disabled={buchen.isPending || (art !== 'guest' && !cent)}
              onClick={speichern}>
        {t('cash.save')}
      </button>
    </section>
  )
}

function Zeile({ z, propertyId, darfStornieren, darfBuchen, onStorno }: {
  z: Kassenzeile; propertyId: number; darfStornieren: boolean; darfBuchen: boolean
  onStorno: (z: Kassenzeile) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const nachreichen = useBelegNachreichen(propertyId)
  const datei = useRef<HTMLInputElement>(null)
  const aufgehoben = z.voidedByNo !== null
  const storno = z.reversesNo !== null
  const mitglied = z.groupNo !== null
  return (
    <tr className={`border-t border-neutral-100 ${aufgehoben ? 'text-neutral-400 line-through' : ''}`}>
      <td className="px-2 py-1 tabular-nums text-neutral-500">{z.entryNo}</td>
      <td className="px-2 py-1 tabular-nums">{mitglied ? '' : formatDate(z.businessDate, locale)}</td>
      <td className={`px-2 py-1 ${mitglied ? 'pl-6' : ''}`}>
        {t(ART[z.kind])}
        {storno && <span className="ml-1 text-xs text-amber-800 no-underline">
          {t('cash.reverses', { n: z.reversesNo! })}</span>}
        {aufgehoben && <span className="ml-1 text-xs">{t('cash.voidedBy', { n: z.voidedByNo! })}</span>}
      </td>
      <td className="px-2 py-1">
        {[z.guestName, z.text].filter(Boolean).join(' · ')}
        {z.externalNumber !== null && (
          <span className="ml-1 text-xs text-neutral-500">{z.externalNumber}</span>
        )}
      </td>
      <td className="px-2 py-1 text-right tabular-nums">{z.taxRateBp / 100} %</td>
      <td className={`px-2 py-1 text-right tabular-nums ${z.amountCent < 0 ? 'text-red-700' : ''}`}>
        {formatMoney(z.amountCent, locale)}
      </td>
      <td className="px-2 py-1 text-right tabular-nums font-medium">
        {z.balanceAfterCent === null ? '' : formatMoney(z.balanceAfterCent, locale)}
      </td>
      <td className="px-2 py-1 whitespace-nowrap no-underline">
        {z.receipts.map((b, i) => (
          <a key={b.ref} href={belegAdresse(propertyId, b.ref)} target="_blank" rel="noreferrer"
             className="mr-1 text-xs underline">{t('cash.receipt.n', { n: i + 1 })}</a>
        ))}
        {darfBuchen && !mitglied && !storno && <>
          <button className="text-xs text-neutral-600 underline" disabled={nachreichen.isPending}
                  onClick={() => datei.current?.click()}>{t('cash.receipt.add')}</button>
          <input ref={datei} type="file" accept="application/pdf,image/*" hidden
                 onChange={async e => {
                   const f = e.target.files?.[0]
                   e.target.value = ''
                   if (f) nachreichen.mutate({ entryNo: z.entryNo, beleg: await belegVorbereiten(f) })
                 }} />
        </>}
        {nachreichen.isError && <Fehler error={nachreichen.error} />}
      </td>
      <td className="px-2 py-1 text-right">
        {darfStornieren && !aufgehoben && !storno && !mitglied && (
          <button className="text-xs text-red-700 underline" onClick={() => onStorno(z)}>
            {t('cash.void')}
          </button>
        )}
      </td>
    </tr>
  )
}

function Stornieren({ propertyId, z, onClose }: {
  propertyId: number; z: Kassenzeile; onClose: () => void
}): JSX.Element {
  const t = useT()
  const storno = useStornieren(propertyId)
  const [grund, setGrund] = useState('')
  return (
    <Dialog titel={t('cash.void.title', { n: z.entryNo })} breite="schmal" onClose={onClose}
            fuss={<>
              <button className={KNOPF_LEISE} onClick={onClose}>{t('common.cancel')}</button>
              <button className={KNOPF} disabled={storno.isPending}
                      onClick={() => storno.mutate({ entryNo: z.entryNo, reason: grund.trim() || undefined },
                        { onSuccess: onClose })}>
                {t('cash.void')}
              </button>
            </>}>
      <p className="text-sm text-neutral-700">{t('cash.void.hint')}</p>
      <Feld label={t('cash.void.reason')}>
        <input value={grund} maxLength={255} onChange={e => setGrund(e.target.value)} className={FELD} />
      </Feld>
      {storno.isError && <Fehler error={storno.error} />}
    </Dialog>
  )
}

function Einstellung({ propertyId, e, onClose }: {
  propertyId: number; e: Kasseneinstellung; onClose: () => void
}): JSX.Element {
  const t = useT()
  const speichern = useKasseneinstellungSpeichern(propertyId)
  const [w, setW] = useState(e)
  const [anfang, setAnfang] = useState(eingabeAusCent(e.openingBalanceCent))
  const [preis, setPreis] = useState(eingabeAusCent(e.breakfastPriceCent))
  const konto = (k: keyof Kasseneinstellung['accounts'], label: TextKey) => (
    <Feld label={t(label)}>
      <input value={w.accounts[k]} className={FELD}
             onChange={ev => setW({ ...w, accounts: { ...w.accounts, [k]: ev.target.value.trim() } })} />
    </Feld>
  )
  return (
    <Dialog titel={t('cash.settings')} onClose={onClose}
            fuss={<>
              <button className={KNOPF_LEISE} onClick={onClose}>{t('common.cancel')}</button>
              <button className={KNOPF} disabled={speichern.isPending}
                      onClick={() => speichern.mutate({ ...w,
                        openingBalanceCent: centAusEingabe(anfang) ?? 0,
                        breakfastPriceCent: centAusEingabe(preis) ?? 0 }, { onSuccess: onClose })}>
                {t('common.save')}
              </button>
            </>}>
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={w.enabled}
                 onChange={ev => setW({ ...w, enabled: ev.target.checked })} />
          {t('cash.settings.enabled')}
        </label>
        <Feld label={t('cash.settings.openingBalance')}>
          <input value={anfang} onChange={ev => setAnfang(ev.target.value)} className={`${FELD} text-right`} />
        </Feld>
        <Feld label={t('cash.settings.openingDate')}>
          <input type="date" value={w.openingDate ?? ''} className={FELD}
                 onChange={ev => setW({ ...w, openingDate: ev.target.value || null })} />
        </Feld>
        <Feld label={t('cash.settings.breakfastPrice')}>
          <input value={preis} onChange={ev => setPreis(ev.target.value)} className={`${FELD} text-right`} />
        </Feld>
        <Feld label={t('cash.settings.foodShare')}>
          <input type="number" min={0} max={100} value={w.breakfastFoodShareBp / 100} className={`${FELD} text-right`}
                 onChange={ev => setW({ ...w, breakfastFoodShareBp: Math.round(Number(ev.target.value) * 100) })} />
        </Feld>
        <Feld label={t('cash.settings.chart')}>
          <select value={w.chartOfAccounts} className={FELD}
                  onChange={ev => setW({ ...w, chartOfAccounts: ev.target.value as 'SKR03' | 'SKR04' })}>
            <option>SKR04</option><option>SKR03</option>
          </select>
        </Feld>
        <div />
        {konto('lodging', 'cash.kind.lodging')}
        {konto('breakfastFood', 'cash.kind.breakfastFood')}
        {konto('breakfastDrinks', 'cash.kind.breakfastDrinks')}
        {konto('cityTax', 'cash.kind.cityTax')}
        {konto('cashIn', 'cash.kind.cashIn')}
        {konto('bankDeposit', 'cash.kind.bankDeposit')}
        {konto('expense', 'cash.kind.expense')}
      </div>
      {speichern.isError && <Fehler error={speichern.error} />}
    </Dialog>
  )
}

export function Kassenbuch({ propertyId, permissions }: {
  propertyId: number; permissions: readonly string[]
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const darfEinstellen = permissions.includes('cashbook:export')
  const darfBuchen = permissions.includes('cashbook:write')
  const darfStornieren = permissions.includes('cashbook:void')
  const [monat, setMonat] = useState<string | null>(null)
  const [einstellen, setEinstellen] = useState(false)
  const [storno, setStorno] = useState<Kassenzeile | null>(null)

  const e = useKasseneinstellung(propertyId)
  const q = useKassenmonat(propertyId, monat, e.data?.enabled === true)
  const m = q.data
  const blaettern = (n: number) => {
    if (m) setMonat(addMonths(`${m.month}-01`, n).slice(0, 7))
  }

  if (e.isError) return <Fehler error={e.error} />
  if (e.data === undefined) return <Laedt />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t('cash.title')}</h1>
        <div className="grow" />
        {m && <div className="flex items-center gap-1">
          <button className={KNOPF_LEISE} onClick={() => blaettern(-1)} aria-label={t('common.back')}>←</button>
          <input type="month" value={m.month} max={m.today.slice(0, 7)}
                 onChange={ev => ev.target.value && setMonat(ev.target.value)}
                 className="border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
          <button className={KNOPF_LEISE} onClick={() => blaettern(1)} aria-label={t('common.forward')}>→</button>
        </div>}
        {darfEinstellen && (
          <button className={KNOPF_LEISE} onClick={() => setEinstellen(true)}>{t('cash.settings')}</button>
        )}
      </div>

      {!e.data.enabled
        ? <div className="text-sm text-neutral-600">
            {t(darfEinstellen ? 'cash.disabled.canEnable' : 'cash.disabled')}
          </div>
        : q.isError ? <Fehler error={q.error} />
        : m === undefined ? <Laedt />
        : <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Kachel titel={t('cash.balance.today')} cent={m.todayBalanceCent} betont />
              <Kachel titel={t('cash.balance.start')} cent={m.startBalanceCent} />
              <Kachel titel={t('cash.income')} cent={m.incomeCent} />
              <Kachel titel={t('cash.outgoing')} cent={m.outgoingCent} />
              <Kachel titel={t('cash.balance.end')} cent={m.closingBalanceCent} />
            </div>
            {m.openingDate !== null && (
              <div className="text-xs text-neutral-500">
                {t('cash.opening', { betrag: formatMoney(m.openingBalanceCent, locale),
                                     datum: formatDate(m.openingDate, locale) })}
              </div>
            )}
            {darfBuchen && <Erfassen propertyId={propertyId} heute={m.today}
                                     fruehstueckCent={m.breakfastPriceCent}
                                     speisenBp={m.breakfastFoodShareBp} />}
            {m.entries.length === 0
              ? <div className="text-sm text-neutral-500">{t('cash.none')}</div>
              : <div className="overflow-x-auto rounded-sm border border-neutral-200 bg-white">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-neutral-600">
                      <tr>
                        <th className="px-2 py-1 text-left">{t('cash.col.no')}</th>
                        <th className="px-2 py-1 text-left">{t('cash.field.date')}</th>
                        <th className="px-2 py-1 text-left">{t('cash.field.kind')}</th>
                        <th className="px-2 py-1 text-left">{t('cash.field.text')}</th>
                        <th className="px-2 py-1 text-right">{t('cash.col.tax')}</th>
                        <th className="px-2 py-1 text-right">{t('cash.field.amount')}</th>
                        <th className="px-2 py-1 text-right">{t('cash.col.balance')}</th>
                        <th className="px-2 py-1 text-left">{t('cash.col.receipts')}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {m.entries.map(z => (
                        <Zeile key={z.entryNo} z={z} propertyId={propertyId}
                               darfBuchen={darfBuchen} darfStornieren={darfStornieren}
                               onStorno={setStorno} />
                      ))}
                    </tbody>
                  </table>
                </div>}
            {(m.taxGroups.length > 0 || m.inputTaxGroups.length > 0) && (
              <div className="text-xs text-neutral-600 flex flex-col gap-1">
                {([['cash.outputTax', m.taxGroups], ['cash.inputTax', m.inputTaxGroups]] as const)
                  .filter(([, gruppen]) => gruppen.length > 0)
                  .map(([titel, gruppen]) => (
                    <div key={titel} className="flex flex-wrap gap-x-6">
                      <span className="font-medium">{t(titel)}</span>
                      {gruppen.map(g => (
                        <span key={g.rateBp}>{t('cash.taxGroup', {
                          satz: g.rateBp / 100, brutto: formatMoney(g.grossCent, locale),
                          netto: formatMoney(g.netCent, locale), steuer: formatMoney(g.taxCent, locale) })}</span>
                      ))}
                    </div>
                  ))}
              </div>
            )}
          </>}

      {einstellen && <Einstellung propertyId={propertyId} e={e.data} onClose={() => setEinstellen(false)} />}
      {storno !== null && <Stornieren propertyId={propertyId} z={storno} onClose={() => setStorno(null)} />}
    </div>
  )
}
