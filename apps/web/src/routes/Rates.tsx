import { useMemo, useState, type JSX } from 'react'
import type { RatePlan } from '@hotelpms/contracts'
import { useCategories } from '../lib/queries.js'
import { useRatePlans, useRateGrid, useSetRates, useSetRestrictions,
         useCreateRatePlan, useRebuildDerived,
         tageInklusive, MAX_RASTER_TAGE } from '../lib/queries/rates.js'
import { useRechte } from '../lib/queries/rechte.js'
import { RateGrid, type Auswahl } from '../components/RateGrid.tsx'
import { betroffeneTage, centAusEingabe, eingabeAusCent, preisVorschau,
         preisNutzlast, restriktionsNutzlast, wochentagKuerzel,
         type Vorschau } from '../lib/preisraster.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { today, addDays } from '../lib/dates.js'
import { Fehler, Laedt } from '../components/Shell.tsx'

/**
 * Preise und Restriktionen (B1 bis B3 aus Dokument 20).
 *
 * Das ist die Ansicht, aus der die Preise an den Channel Manager gehen.
 * Deshalb trägt sie ein Jahr am Stück: `rate-grid` liefert bis zu 400 Tage
 * in **einer** Anfrage, und wer sie tageweise nachlüde, machte aus einer
 * Runde vierhundert.
 *
 * **Die Vorschau ist keine Bequemlichkeit.** Wer 365 Tage auf einmal ändert
 * und sich vertippt, merkt es sonst, wenn die ersten Buchungen zum falschen
 * Preis hereinkommen -- und rückwirkend ändern geht nicht, weil eine
 * bestätigte Buchung ihren Preis behält. Deshalb: ohne Vorschau kein
 * Übernehmen, und die Vorschau verfällt, sobald sich die Eingabe ändert.
 */

const ZEITRAEUME = [30, 90, 180, MAX_RASTER_TAGE] as const
const WOCHENTAGE = [0, 1, 2, 3, 4, 5, 6] as const

/** Ein Vorschaustand gilt für genau eine Eingabe. Ändert sie sich, verfällt er. */
interface Geprueft { signatur: string; vorschau: Vorschau }

function Wochentagswahl(
  { gewaehlt, onChange }: { gewaehlt: number[]; onChange: (w: number[]) => void }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-neutral-600">{t('rate.weekdays')}</span>
      {WOCHENTAGE.map(i => (
        <label key={i} className="text-sm flex items-center gap-1">
          <input type="checkbox" checked={gewaehlt.includes(i)}
                 onChange={e => onChange(e.target.checked
                   ? [...gewaehlt, i].sort((a, b) => a - b)
                   : gewaehlt.filter(x => x !== i))} />
          {wochentagKuerzel(i, locale)}
        </label>
      ))}
      {gewaehlt.length === 7 && (
        <span className="text-xs text-neutral-500">({t('rate.weekdays.all')})</span>
      )}
    </div>
  )
}

function VorschauZeile(
  { gezeigt, aktuell, mitVergleich }: {
    gezeigt: Geprueft | null; aktuell: string; mitVergleich: boolean }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  if (gezeigt === null) {
    return <div className="text-sm text-neutral-500">{t('rate.preview.required')}</div>
  }
  if (gezeigt.signatur !== aktuell) {
    return <div className="text-sm text-amber-800">{t('rate.preview.stale')}</div>
  }
  const v = gezeigt.vorschau
  return (
    <div className="text-sm">
      <span className="font-semibold tabular-nums">{v.tage}</span>{' '}
      {t('rate.preview.affected')}
      {v.erster !== null && v.letzter !== null && (
        <span className="text-neutral-500">
          {' '}({formatDate(v.erster, locale)} – {formatDate(v.letzter, locale)})
        </span>
      )}
      {mitVergleich && (
        <span className="text-neutral-600">
          {' · '}<span className="tabular-nums">{v.geaendert}</span>{' '}
          {t('rate.preview.changed')}
          {v.unveraendert > 0 && <>{', '}
            <span className="tabular-nums">{v.unveraendert}</span>{' '}
            {t('rate.preview.unchanged')}</>}
        </span>
      )}
    </div>
  )
}

interface MaskenProps {
  propertyId: number
  plan: RatePlan
  auswahl: Auswahl
  tage: readonly string[]
  zellen: Parameters<typeof preisVorschau>[1]
  maxBelegung: number
  darfSchreiben: boolean
}

function Preismaske(p: MaskenProps): JSX.Element {
  const t = useT()
  const online = useOnline()
  const setzen = useSetRates(p.propertyId)
  const [wochentage, setWochentage] = useState<number[]>([...WOCHENTAGE])
  const [eingaben, setEingaben] = useState<string[]>([])
  const [geprueft, setGeprueft] = useState<Geprueft | null>(null)

  const stufen = Math.max(1, p.maxBelegung)

  /*
   * Vorbelegt wird mit dem Preis, der am ersten gewaehlten Tag schon steht:
   * eine Preispflege ist fast immer eine Aenderung und selten ein leeres
   * Blatt. Getippte Werte gewinnen, und ein absichtlich geleertes Feld
   * bleibt leer -- sonst kaeme der alte Preis zurueck, sobald man ihn
   * loescht.
   */
  const vorhanden = p.zellen.find(
    z => z.ratePlanId === p.plan.id && z.date === p.auswahl.from)?.priceCent ?? null
  const feld = (i: number): string =>
    eingaben[i] ?? (vorhanden?.[i] === undefined ? '' : eingabeAusCent(vorhanden[i]))

  const werte = Array.from({ length: stufen }, (_, i) => centAusEingabe(feld(i)))
  const vollstaendig = werte.every(v => v !== null)
  const betroffen = betroffeneTage(
    p.tage.filter(d => d >= p.auswahl.from && d <= p.auswahl.to), wochentage)

  // Die Unterschrift der Eingabe. Ändert sich irgendetwas daran, passt die
  // gezeigte Vorschau nicht mehr zu dem, was das Übernehmen täte.
  const signatur = JSON.stringify([
    p.plan.id, p.auswahl.from, p.auswahl.to, wochentage, werte])

  const ansehen = (): void => {
    if (!vollstaendig) return
    setGeprueft({ signatur,
      vorschau: preisVorschau(betroffen, p.zellen, p.plan.id, werte as number[]) })
  }

  const uebernehmen = (): void => {
    if (!vollstaendig || geprueft === null || geprueft.signatur !== signatur) return
    setzen.mutate(preisNutzlast({
      propertyId: p.propertyId, ratePlanId: p.plan.id,
      from: p.auswahl.from, to: p.auswahl.to,
      weekdays: wochentage, priceCent: werte as number[]
    }), { onSuccess: () => setGeprueft(null) })
  }

  return (
    <section className="rounded border border-neutral-200 bg-white p-3 space-y-3">
      <div className="font-medium">{t('rate.setPrice')}</div>

      <Wochentagswahl gewaehlt={wochentage} onChange={w => { setWochentage(w) }} />

      <div>
        <div className="text-sm text-neutral-600">{t('rate.price.perOccupancy')}</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {Array.from({ length: stufen }, (_, i) => (
            <label key={i} className="text-sm">
              <div className="text-xs text-neutral-500">
                {i + 1} {i === 0 ? t('rate.price.person') : t('rate.price.persons')}
              </div>
              <input inputMode="decimal" value={feld(i)}
                     onChange={e => {
                       const naechste = [...eingaben]
                       naechste[i] = e.target.value
                       setEingaben(naechste)
                     }}
                     placeholder="0,00"
                     aria-label={`${t('rate.price.perOccupancy')} ${i + 1}`}
                     className="border border-neutral-300 rounded px-2 py-1 w-24
                                text-right tabular-nums" />
            </label>
          ))}
        </div>
      </div>

      <div className="text-xs text-neutral-500">{t('rate.hint.bulk')}</div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={ansehen} disabled={!vollstaendig}
                className="text-sm px-3 py-1.5 rounded border border-neutral-300
                           hover:bg-neutral-50 disabled:opacity-40">
          {geprueft === null ? t('rate.preview') : t('rate.preview.again')}
        </button>
        <button type="button" onClick={uebernehmen}
                disabled={!online || !p.darfSchreiben || !vollstaendig
                          || geprueft === null || geprueft.signatur !== signatur
                          || setzen.isPending}
                className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                           disabled:opacity-40">
          {t('rate.apply')}
        </button>
        <VorschauZeile gezeigt={geprueft} aktuell={signatur} mitVergleich />
      </div>

      {setzen.isError && <Fehler error={setzen.error} />}
      {setzen.isSuccess && (
        <div role="status" className="text-sm text-emerald-800">
          <span className="tabular-nums">{setzen.data.days}</span> {t('rate.applied')}
        </div>
      )}
    </section>
  )
}

function Restriktionsmaske(p: MaskenProps): JSX.Element {
  const t = useT()
  const online = useOnline()
  const setzen = useSetRestrictions(p.propertyId)
  const [wochentage, setWochentage] = useState<number[]>([...WOCHENTAGE])
  const [minLos, setMinLos] = useState('')
  const [maxLos, setMaxLos] = useState('')
  const [closed, setClosed] = useState(false)
  const [cta, setCta] = useState(false)
  const [ctd, setCtd] = useState(false)
  const [geprueft, setGeprueft] = useState<Geprueft | null>(null)

  const zahl = (s: string): number | null => {
    const n = Number(s.trim())
    return s.trim() === '' || !Number.isInteger(n) || n < 1 ? null : n
  }
  const betroffen = betroffeneTage(
    p.tage.filter(d => d >= p.auswahl.from && d <= p.auswahl.to), wochentage)
  const signatur = JSON.stringify([
    p.plan.id, p.auswahl.from, p.auswahl.to, wochentage,
    zahl(minLos), zahl(maxLos), closed, cta, ctd])

  const ansehen = (): void => {
    setGeprueft({ signatur, vorschau: {
      tage: betroffen.length, geaendert: betroffen.length, unveraendert: 0,
      erster: betroffen[0] ?? null, letzter: betroffen[betroffen.length - 1] ?? null } })
  }

  const uebernehmen = (): void => {
    if (geprueft === null || geprueft.signatur !== signatur) return
    setzen.mutate(restriktionsNutzlast({
      propertyId: p.propertyId, ratePlanId: p.plan.id,
      from: p.auswahl.from, to: p.auswahl.to, weekdays: wochentage,
      minLos: zahl(minLos), maxLos: zahl(maxLos),
      closed, closedToArrival: cta, closedToDeparture: ctd
    }), { onSuccess: () => setGeprueft(null) })
  }

  return (
    <section className="rounded border border-neutral-200 bg-white p-3 space-y-3">
      <div className="font-medium">{t('rate.restrictions')}</div>

      <Wochentagswahl gewaehlt={wochentage} onChange={w => { setWochentage(w) }} />

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <div className="text-neutral-600">{t('rate.minLos')}</div>
          <input type="number" min={1} value={minLos}
                 onChange={e => setMinLos(e.target.value)}
                 placeholder={t('rate.unchangedField')}
                 className="border border-neutral-300 rounded px-2 py-1 w-28" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('rate.maxLos')}</div>
          <input type="number" min={1} value={maxLos}
                 onChange={e => setMaxLos(e.target.value)}
                 placeholder={t('rate.unchangedField')}
                 className="border border-neutral-300 rounded px-2 py-1 w-28" />
        </label>
        <label className="text-sm flex items-center gap-1.5">
          <input type="checkbox" checked={closed}
                 onChange={e => setClosed(e.target.checked)} />
          {t('rate.closed')}
        </label>
        <label className="text-sm flex items-center gap-1.5">
          <input type="checkbox" checked={cta} onChange={e => setCta(e.target.checked)} />
          {t('rate.cta')}
        </label>
        <label className="text-sm flex items-center gap-1.5">
          <input type="checkbox" checked={ctd} onChange={e => setCtd(e.target.checked)} />
          {t('rate.ctd')}
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={ansehen}
                className="text-sm px-3 py-1.5 rounded border border-neutral-300
                           hover:bg-neutral-50">
          {geprueft === null ? t('rate.preview') : t('rate.preview.again')}
        </button>
        <button type="button" onClick={uebernehmen}
                disabled={!online || !p.darfSchreiben || geprueft === null
                          || geprueft.signatur !== signatur || setzen.isPending}
                className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                           disabled:opacity-40">
          {t('rate.apply')}
        </button>
        <VorschauZeile gezeigt={geprueft} aktuell={signatur} mitVergleich={false} />
      </div>

      {setzen.isError && <Fehler error={setzen.error} />}
      {setzen.isSuccess && (
        <div role="status" className="text-sm text-emerald-800">
          <span className="tabular-nums">{setzen.data.days}</span> {t('rate.applied')}
        </div>
      )}
    </section>
  )
}

/**
 * Ratenpläne anlegen und abgeleitete Raten neu rechnen (B4).
 *
 * Steht unter dem Raster und nicht in der Einrichtung: wer Preise pflegt,
 * legt den Plan an, für den er sie pflegt, und sieht ihn gleich in der
 * Zeile darüber.
 */
function Ratenplaene(
  { propertyId, plaene, kategorien, von, bis, darfSchreiben }: {
    propertyId: number
    plaene: readonly RatePlan[]
    kategorien: ReadonlyArray<{ id: number; name: string }>
    von: string; bis: string; darfSchreiben: boolean }
): JSX.Element {
  const t = useT()
  const online = useOnline()
  const anlegen = useCreateRatePlan(propertyId)
  const neuRechnen = useRebuildDerived(propertyId)

  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [categoryId, setCategoryId] = useState(0)
  const [baseId, setBaseId] = useState(0)
  const [deriveKind, setDeriveKind] = useState<'amount' | 'percent'>('percent')
  const [deriveValue, setDeriveValue] = useState('-15')

  const gewaehlteKategorie = categoryId !== 0 ? categoryId : kategorien[0]?.id ?? 0
  const wert = Number(deriveValue)
  const abgeleitet = baseId !== 0
  const bereit = code.trim() !== '' && name.trim() !== '' && gewaehlteKategorie !== 0
    && (!abgeleitet || Number.isInteger(wert))

  const absenden = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!bereit) return
    anlegen.mutate({
      code: code.trim(), name: name.trim(), categoryId: gewaehlteKategorie,
      ...(abgeleitet
        ? { baseRatePlanId: baseId, deriveKind, deriveValue: wert }
        : {})
    }, { onSuccess: () => { setCode(''); setName('') } })
  }

  return (
    <section className="rounded border border-neutral-200 bg-white p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="font-medium">{t('rate.plans')}</div>
        <div className="grow" />
        <button type="button"
                onClick={() => neuRechnen.mutate({ from: von, to: bis })}
                disabled={!online || !darfSchreiben || neuRechnen.isPending}
                className="text-sm px-3 py-1.5 rounded border border-neutral-300
                           hover:bg-neutral-50 disabled:opacity-40">
          {t('rate.rebuild')}
        </button>
        {neuRechnen.isSuccess && (
          <span role="status" className="text-sm text-emerald-800">
            <span className="tabular-nums">{neuRechnen.data.days}</span>{' '}
            {t('rate.rebuild.done')}{' '}
            <span className="tabular-nums">{neuRechnen.data.plans}</span>{' '}
            {/* Eine abgeleitete Rate, nicht "1 abgeleitete Raten". */}
            {t(neuRechnen.data.plans === 1 ? 'rate.rebuild.plan' : 'rate.rebuild.plans')}
          </span>
        )}
      </div>
      {neuRechnen.isError && <Fehler error={neuRechnen.error} />}

      {darfSchreiben && (
        <form onSubmit={absenden} className="space-y-2 border-t border-neutral-200 pt-3">
          <div className="text-sm text-neutral-600">{t('rate.plan.new')}</div>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">
              <div className="text-neutral-600">{t('rate.plan.code')}</div>
              <input value={code} onChange={e => setCode(e.target.value)} required
                     className="border border-neutral-300 rounded px-2 py-1 w-28" />
            </label>
            <label className="text-sm">
              <div className="text-neutral-600">{t('rate.plan.name')}</div>
              <input value={name} onChange={e => setName(e.target.value)} required
                     className="border border-neutral-300 rounded px-2 py-1 w-56" />
            </label>
            <label className="text-sm">
              <div className="text-neutral-600">{t('common.category')}</div>
              <select value={gewaehlteKategorie}
                      onChange={e => setCategoryId(Number(e.target.value))}
                      className="border border-neutral-300 rounded px-2 py-1">
                {kategorien.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <div className="text-neutral-600">{t('rate.plan.base')}</div>
              <select value={baseId} onChange={e => setBaseId(Number(e.target.value))}
                      className="border border-neutral-300 rounded px-2 py-1">
                <option value={0}>{t('rate.plan.base.none')}</option>
                {plaene.filter(p => p.baseRatePlanId === null)
                  .map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {abgeleitet && (
              <>
                <label className="text-sm">
                  <div className="text-neutral-600">{t('rate.plan.deriveKind')}</div>
                  <select value={deriveKind}
                          onChange={e => setDeriveKind(e.target.value as 'percent')}
                          className="border border-neutral-300 rounded px-2 py-1">
                    <option value="percent">{t('rate.plan.derive.percent')}</option>
                    <option value="amount">{t('rate.plan.derive.amount')}</option>
                  </select>
                </label>
                <label className="text-sm">
                  <div className="text-neutral-600">{t('rate.plan.deriveValue')}</div>
                  <input type="number" value={deriveValue}
                         onChange={e => setDeriveValue(e.target.value)}
                         className="border border-neutral-300 rounded px-2 py-1 w-24
                                    text-right tabular-nums" />
                </label>
              </>
            )}
          </div>

          {abgeleitet && (
            <div className="text-xs text-neutral-500">
              {t('rate.plan.deriveHint')} {t('rate.plan.emptyHint')}
            </div>
          )}
          {anlegen.isError && <Fehler error={anlegen.error} />}

          <button type="submit" disabled={!online || !bereit || anlegen.isPending}
                  className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                             disabled:opacity-40">
            {t('common.save')}
          </button>
        </form>
      )}
    </section>
  )
}

export function Rates({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [von, setVon] = useState(today())
  const [laenge, setLaenge] = useState<number>(30)
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [belegung, setBelegung] = useState(2)
  const [auswahl, setAuswahl] = useState<Auswahl | null>(null)

  const bis = addDays(von, laenge - 1)
  // Die Tage werden gemerkt: als neue Liste bei jedem Neuzeichnen faenden
  // die Zeilen des Rasters ihre Eingaben jedes Mal veraendert und
  // zeichneten sich alle neu -- damit waere das Merken dort wirkungslos.
  const tage = useMemo(() => tageInklusive(von, bis), [von, bis])
  const rechte = useRechte(propertyId)
  const darfSchreiben = rechte.includes('rate:write')

  const plaene = useRatePlans(propertyId)
  const kategorien = useCategories(propertyId)
  const raster = useRateGrid(propertyId, von, bis, categoryId)

  const aktivePlaene = (plaene.data?.ratePlans ?? [])
    .filter(p => p.active && (categoryId === null || p.categoryId === categoryId))
  const gewaehlterPlan = aktivePlaene.find(p => p.id === auswahl?.ratePlanId)
  const maxBelegung = kategorien.data?.categories
    .find(k => k.id === gewaehlterPlan?.categoryId)?.maxOccupancy ?? 2

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-lg font-semibold">{t('rate.title')}</h1>
        <div className="grow" />

        <label className="text-sm">
          <div className="text-neutral-600">{t('common.from')}</div>
          <input type="date" value={von} onChange={e => setVon(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('rate.days')}</div>
          <select value={laenge} onChange={e => setLaenge(Number(e.target.value))}
                  className="border border-neutral-300 rounded px-2 py-1">
            {ZEITRAEUME.map(n => (
              <option key={n} value={n}>{t(`rate.days.${n}` as 'rate.days.30')}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('common.category')}</div>
          <select value={categoryId ?? ''}
                  onChange={e => {
                    setCategoryId(e.target.value === '' ? null : Number(e.target.value))
                    setAuswahl(null)
                  }}
                  className="border border-neutral-300 rounded px-2 py-1">
            <option value="">—</option>
            {(kategorien.data?.categories ?? []).map(k => (
              <option key={k.id} value={k.id}>{k.name}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('rate.occupancy')}</div>
          <select value={belegung} onChange={e => setBelegung(Number(e.target.value))}
                  className="border border-neutral-300 rounded px-2 py-1">
            {[1, 2, 3, 4].map(n => (
              <option key={n} value={n}>{n} {t('rate.occupancy.n')}</option>
            ))}
          </select>
        </label>
      </div>

      {raster.isError
        ? <Fehler error={raster.error} />
        : raster.data === undefined || plaene.data === undefined
          ? <Laedt />
          : aktivePlaene.length === 0
            ? <div className="text-sm text-neutral-500">{t('rate.noPlans')}</div>
            : <>
                <RateGrid plans={aktivePlaene} tage={tage} zellen={raster.data.cells}
                          belegung={belegung} auswahl={auswahl}
                          onAuswahl={setAuswahl} />
                <div className="text-xs text-neutral-500">{t('rate.legend')}</div>

                <Ratenplaene propertyId={propertyId}
                             plaene={plaene.data?.ratePlans ?? []}
                             kategorien={kategorien.data?.categories ?? []}
                             von={von} bis={bis} darfSchreiben={darfSchreiben} />

                {auswahl === null || gewaehlterPlan === undefined
                  ? <div className="text-sm text-neutral-500">
                      {t('rate.selection.none')}
                    </div>
                  : <>
                      <div className="flex flex-wrap items-end gap-3 rounded border
                                      border-neutral-200 bg-white p-3">
                        <div>
                          <div className="text-sm text-neutral-600">
                            {t('rate.selection')}
                          </div>
                          <div className="font-medium">{gewaehlterPlan.name}</div>
                        </div>
                        {/* Die Auswahl ist auch tippbar. An einer Rezeption steht
                            jemand daneben und redet, während er eingibt; Ziehen
                            ist die schnelle Bedienung, nicht die einzige. */}
                        <label className="text-sm">
                          <div className="text-neutral-600">{t('common.from')}</div>
                          <input type="date" value={auswahl.from}
                                 max={auswahl.to}
                                 onChange={e => setAuswahl(
                                   { ...auswahl, from: e.target.value })}
                                 className="border border-neutral-300 rounded px-2 py-1" />
                        </label>
                        <label className="text-sm">
                          <div className="text-neutral-600">{t('common.to')}</div>
                          <input type="date" value={auswahl.to}
                                 min={auswahl.from}
                                 onChange={e => setAuswahl(
                                   { ...auswahl, to: e.target.value })}
                                 className="border border-neutral-300 rounded px-2 py-1" />
                        </label>
                        <div className="text-sm text-neutral-600">
                          {formatDate(auswahl.from, locale)} –{' '}
                          {formatDate(auswahl.to, locale)}
                        </div>
                      </div>

                      <div className="grid gap-3 lg:grid-cols-2">
                        <Preismaske propertyId={propertyId} plan={gewaehlterPlan}
                                    auswahl={auswahl} tage={tage}
                                    zellen={raster.data.cells}
                                    maxBelegung={maxBelegung}
                                    darfSchreiben={darfSchreiben} />
                        <Restriktionsmaske propertyId={propertyId} plan={gewaehlterPlan}
                                           auswahl={auswahl} tage={tage}
                                           zellen={raster.data.cells}
                                           maxBelegung={maxBelegung}
                                           darfSchreiben={darfSchreiben} />
                      </div>
                    </>}
              </>}
    </div>
  )
}
