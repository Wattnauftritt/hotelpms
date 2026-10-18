import { useMemo, useState, type JSX, type ReactNode } from 'react'
import type { RateGridCell, RateInclusion, RatePlan } from '@hotelpms/contracts'
import { useCategories } from '../lib/queries.js'
import { useRatePlans, useRateGrid, useSetRates, useSetRestrictions, useDeleteRatePlan,
         useCreateRatePlan, useRebuildDerived, useSetBreakfast, useSetInclusions,
         useSetHouseBreakfast, type Fruehstueckswerte,
         tageInklusive, type VatRule, MAX_RASTER_TAGE } from '../lib/queries/rates.js'
import { RateGrid, type Auswahl } from '../components/RateGrid.tsx'
import { ChannelSicht } from '../components/ChannelSicht.tsx'
import { betroffeneTage, centAusEingabe, eingabeAusCent, preisVorschau,
         preisNutzlast, restriktionsNutzlast, wochentagKuerzel,
         type Vorschau } from '../lib/preisraster.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { today, addDays } from '../lib/dates.js'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { Preissteuerung } from '../components/Preissteuerung.tsx'
import { KalenderAbruf } from '../components/KalenderAbruf.tsx'
import { KalenderSenden } from '../components/KalenderSenden.tsx'
import { useReiter } from '../lib/reiter.js'

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
    <section className="rounded-sm border border-neutral-200 bg-white p-3 space-y-3">
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
                     className="border border-neutral-300 rounded-sm px-2 py-1 w-24
                                text-end tabular-nums" />
            </label>
          ))}
        </div>
      </div>

      <div className="text-xs text-neutral-500">{t('rate.hint.bulk')}</div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={ansehen} disabled={!vollstaendig}
                className="text-sm px-3 py-1.5 rounded-sm border border-neutral-300
                           hover:bg-neutral-50 disabled:opacity-40">
          {geprueft === null ? t('rate.preview') : t('rate.preview.again')}
        </button>
        <button type="button" onClick={uebernehmen}
                disabled={!online || !p.darfSchreiben || !vollstaendig
                          || geprueft === null || geprueft.signatur !== signatur
                          || setzen.isPending}
                className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
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
    <section className="rounded-sm border border-neutral-200 bg-white p-3 space-y-3">
      <div className="font-medium">{t('rate.restrictions')}</div>

      <Wochentagswahl gewaehlt={wochentage} onChange={w => { setWochentage(w) }} />

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <div className="text-neutral-600">{t('rate.minLos')}</div>
          <input type="number" min={1} value={minLos}
                 onChange={e => setMinLos(e.target.value)}
                 placeholder={t('rate.unchangedField')}
                 className="border border-neutral-300 rounded-sm px-2 py-1 w-28" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('rate.maxLos')}</div>
          <input type="number" min={1} value={maxLos}
                 onChange={e => setMaxLos(e.target.value)}
                 placeholder={t('rate.unchangedField')}
                 className="border border-neutral-300 rounded-sm px-2 py-1 w-28" />
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
                className="text-sm px-3 py-1.5 rounded-sm border border-neutral-300
                           hover:bg-neutral-50">
          {geprueft === null ? t('rate.preview') : t('rate.preview.again')}
        </button>
        <button type="button" onClick={uebernehmen}
                disabled={!online || !p.darfSchreiben || geprueft === null
                          || geprueft.signatur !== signatur || setzen.isPending}
                className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
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
 * Frühstück je Rate (Migration 0158): enthalten ja oder nein, der Preis
 * je Person und Nacht und wahlweise ein eigener für Kinder (0 = frei). Mehr fragt die Maske nicht ab: den Getränkeanteil
 * gibt das BMF pauschal vor, er steht in der Domain und nicht hier.
 */
function FruehstueckRate(
  { propertyId, plan, darfSchreiben }: {
    propertyId: number; plan: RatePlan; darfSchreiben: boolean }
): JSX.Element {
  const setzen = useSetBreakfast(propertyId)
  return (
    <FruehstueckZeile
      titel={<>{plan.name}<span className="text-neutral-500"> ({plan.code})</span></>}
      werte={plan} darfSchreiben={darfSchreiben}
      onSave={w => setzen.mutate({ ratePlanId: plan.id, ...w })}
      pending={setzen.isPending} gespeichert={setzen.isSuccess}
      fehler={setzen.isError ? setzen.error : null} />
  )
}

/**
 * Dieselbe Frage als Regel des Hauses (Migration 0169). Sie gilt für jede
 * Rate ohne eigenen Preis und für Buchungen ganz ohne Rate -- die aus dem
 * Altsystem und dem Adminpanel, an denen sonst nichts das Frühstück kennt.
 */
function FruehstueckHaus(
  { propertyId, werte, darfSchreiben }: {
    propertyId: number; werte: Fruehstueckswerte; darfSchreiben: boolean }
): JSX.Element {
  const t = useT()
  const setzen = useSetHouseBreakfast(propertyId)
  return (
    <FruehstueckZeile
      titel={<span className="font-medium">{t('rate.breakfast.house')}</span>}
      werte={werte} darfSchreiben={darfSchreiben}
      onSave={w => setzen.mutate(w)}
      pending={setzen.isPending} gespeichert={setzen.isSuccess}
      fehler={setzen.isError ? setzen.error : null} />
  )
}

function FruehstueckZeile(
  { titel, werte, darfSchreiben, onSave, pending, gespeichert, fehler }: {
    titel: ReactNode; werte: Fruehstueckswerte; darfSchreiben: boolean
    onSave: (w: Fruehstueckswerte) => void
    pending: boolean; gespeichert: boolean; fehler: unknown }
): JSX.Element {
  const t = useT()
  const online = useOnline()
  const plan = werte
  const [enthalten, setEnthalten] = useState(plan.breakfastCent !== null)
  const [preis, setPreis] = useState(
    plan.breakfastCent === null ? '' : eingabeAusCent(plan.breakfastCent))
  const [kinderEigen, setKinderEigen] = useState(plan.childBreakfastCent !== null)
  const [kinderPreis, setKinderPreis] = useState(
    plan.childBreakfastCent === null ? '' : eingabeAusCent(plan.childBreakfastCent))

  const cent = centAusEingabe(preis)
  const kinderCent = centAusEingabe(kinderPreis)
  // Ein Kinderpreis von 0 ist gueltig: Kinder fruehstuecken frei.
  const gueltig = !enthalten
    || (cent !== null && cent > 0 && (!kinderEigen || kinderCent !== null))
  const neu = enthalten ? cent : null
  const neuKinder = enthalten && kinderEigen ? kinderCent : null
  const geaendert = neu !== plan.breakfastCent || neuKinder !== plan.childBreakfastCent

  return (
    <form className="flex flex-wrap items-center gap-3 text-sm"
          onSubmit={e => {
            e.preventDefault()
            if (!gueltig || !geaendert) return
            onSave({ breakfastCent: neu, childBreakfastCent: neuKinder })
          }}>
      <span className="w-56 truncate">{titel}</span>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={enthalten} disabled={!darfSchreiben}
               onChange={e => setEnthalten(e.target.checked)} />
        {t('rate.breakfast')}
      </label>
      {enthalten && (
        <label className="flex items-center gap-1.5">
          <span className="text-neutral-600">{t('rate.breakfast.price')}</span>
          <input value={preis} onChange={e => setPreis(e.target.value)}
                 disabled={!darfSchreiben} inputMode="decimal"
                 aria-invalid={!gueltig}
                 className="border border-neutral-300 rounded-sm px-2 py-1 w-24
                            text-end tabular-nums" />
          <span>€</span>
        </label>
      )}
      {enthalten && (
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={kinderEigen} disabled={!darfSchreiben}
                 onChange={e => setKinderEigen(e.target.checked)} />
          {t('rate.breakfast.children')}
        </label>
      )}
      {enthalten && kinderEigen && (
        <label className="flex items-center gap-1.5">
          <span className="text-neutral-600">{t('rate.breakfast.childPrice')}</span>
          <input value={kinderPreis} onChange={e => setKinderPreis(e.target.value)}
                 disabled={!darfSchreiben} inputMode="decimal" placeholder="0,00"
                 aria-invalid={kinderCent === null}
                 className="border border-neutral-300 rounded-sm px-2 py-1 w-24
                            text-end tabular-nums" />
          <span>€</span>
        </label>
      )}
      {darfSchreiben && (
        <button type="submit"
                disabled={!online || !gueltig || !geaendert || pending}
                className="px-3 py-1 rounded-sm border border-neutral-300
                           hover:bg-neutral-50 disabled:opacity-40">
          {t('common.save')}
        </button>
      )}
      {gespeichert && !geaendert && (
        <span role="status" className="text-emerald-800">{t('rate.breakfast.saved')}</span>
      )}
      {fehler !== null && <Fehler error={fehler} />}
    </form>
  )
}

interface InklusivEntwurf {
  name: string; preis: string; chargeMode: RateInclusion['chargeMode']; taxRuleId: number | null
}

/**
 * Weitere Inklusivleistungen einer Rate (Migration 0165): Parken, Sauna,
 * Sekt zur Anreise. Der Nachtlauf rechnet sie wie das Frühstück aus dem
 * Nachtpreis heraus, jede zu ihrem Satz. Gespeichert wird die ganze Liste;
 * der Schlüssel der Zeile hängt am gespeicherten Stand, damit der Entwurf
 * nach dem Speichern neu beginnt.
 */
function InklusivZeile(
  { propertyId, plan, vatRules, darfSchreiben }: {
    propertyId: number; plan: RatePlan; vatRules: readonly VatRule[]; darfSchreiben: boolean }
): JSX.Element {
  const t = useT()
  const online = useOnline()
  const setzen = useSetInclusions(propertyId)
  const [liste, setListe] = useState<InklusivEntwurf[]>(() => plan.inclusions.map(i => ({
    name: i.name, preis: eingabeAusCent(i.grossCent), chargeMode: i.chargeMode,
    taxRuleId: i.taxRuleId })))
  // Ohne Vorgabe der volle Satz: Parken, Wellness und Getraenke tragen ihn.
  const vorgabeSatz = vatRules.find(v => v.rateBp === 1900)?.id ?? vatRules[0]?.id ?? null

  const fertig = liste.map(e => {
    const cent = centAusEingabe(e.preis)
    return e.name.trim() !== '' && cent !== null && cent > 0 && e.taxRuleId !== null
      ? { name: e.name.trim(), grossCent: cent, chargeMode: e.chargeMode, taxRuleId: e.taxRuleId }
      : null
  })
  const gueltig = fertig.every(f => f !== null)
  const geaendert = JSON.stringify(fertig) !== JSON.stringify(plan.inclusions)
  const aendern = (i: number, teil: Partial<InklusivEntwurf>): void =>
    setListe(l => l.map((e, j) => j === i ? { ...e, ...teil } : e))

  return (
    <form className="space-y-1.5 text-sm"
          onSubmit={e => {
            e.preventDefault()
            if (!gueltig || !geaendert) return
            setzen.mutate({ ratePlanId: plan.id,
                            inclusions: fertig.filter((f): f is RateInclusion => f !== null) })
          }}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="w-56 truncate">{plan.name}
          <span className="text-neutral-500"> ({plan.code})</span></span>
        {liste.length === 0 && (
          <span className="text-neutral-500">{t('rate.inclusion.none')}</span>
        )}
        {darfSchreiben && liste.length < 10 && (
          <button type="button" disabled={vorgabeSatz === null}
                  onClick={() => setListe(l => [...l, { name: '', preis: '',
                    chargeMode: 'per_night', taxRuleId: vorgabeSatz }])}
                  className="px-2 py-0.5 rounded-sm border border-neutral-300
                             hover:bg-neutral-50 disabled:opacity-40">
            {t('rate.inclusion.add')}
          </button>
        )}
        {darfSchreiben && (
          <button type="submit"
                  disabled={!online || !gueltig || !geaendert || setzen.isPending}
                  className="px-3 py-1 rounded-sm border border-neutral-300
                             hover:bg-neutral-50 disabled:opacity-40">
            {t('common.save')}
          </button>
        )}
        {setzen.isSuccess && !geaendert && (
          <span role="status" className="text-emerald-800">{t('rate.breakfast.saved')}</span>
        )}
      </div>
      {liste.map((e, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 ps-4">
          <input value={e.name} onChange={x => aendern(i, { name: x.target.value })}
                 disabled={!darfSchreiben} maxLength={60}
                 aria-label={t('rate.inclusion.name')} placeholder={t('rate.inclusion.name')}
                 aria-invalid={e.name.trim() === ''}
                 className="border border-neutral-300 rounded-sm px-2 py-1 w-44" />
          <input value={e.preis} onChange={x => aendern(i, { preis: x.target.value })}
                 disabled={!darfSchreiben} inputMode="decimal"
                 aria-label={t('rate.inclusion.price')}
                 aria-invalid={fertig[i] === null && e.name.trim() !== ''}
                 className="border border-neutral-300 rounded-sm px-2 py-1 w-24
                            text-end tabular-nums" />
          <span>€</span>
          <select value={e.chargeMode} disabled={!darfSchreiben}
                  aria-label={t('rate.inclusion.mode')}
                  onChange={x => aendern(i, {
                    chargeMode: x.target.value as RateInclusion['chargeMode'] })}
                  className="border border-neutral-300 rounded-sm px-2 py-1">
            <option value="per_night">{t('rate.inclusion.perNight')}</option>
            <option value="per_person_night">{t('rate.inclusion.perPersonNight')}</option>
            <option value="once">{t('rate.inclusion.once')}</option>
          </select>
          <select value={e.taxRuleId ?? ''} disabled={!darfSchreiben}
                  aria-label={t('rate.inclusion.tax')}
                  onChange={x => aendern(i, { taxRuleId: Number(x.target.value) })}
                  className="border border-neutral-300 rounded-sm px-2 py-1">
            {vatRules.map(v => (
              <option key={v.id} value={v.id}>{v.name} ({v.rateBp / 100} %)</option>
            ))}
          </select>
          {darfSchreiben && (
            <button type="button" onClick={() => setListe(l => l.filter((_, j) => j !== i))}
                    className="text-neutral-500 hover:text-neutral-900">
              {t('rate.inclusion.remove')}
            </button>
          )}
        </div>
      ))}
      {setzen.isError && <Fehler error={setzen.error} />}
    </form>
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
  { propertyId, plaene, vatRules, hausFruehstueck, kategorien, von, bis, darfSchreiben }: {
    propertyId: number
    plaene: readonly RatePlan[]
    vatRules: readonly VatRule[]
    hausFruehstueck: Fruehstueckswerte
    kategorien: ReadonlyArray<{ id: number; name: string; code: string }>
    von: string; bis: string; darfSchreiben: boolean }
): JSX.Element {
  const t = useT()
  const online = useOnline()
  const anlegen = useCreateRatePlan(propertyId)
  const neuRechnen = useRebuildDerived(propertyId)

  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  // Wie in RoomCloud eine Rate fuer mehrere Zimmergruppen; leer heisst:
  // die erste Gruppe, damit das Formular ohne Klick sofort benutzbar ist.
  const [gruppen, setGruppen] = useState<number[]>([])
  const [baseId, setBaseId] = useState(0)
  const loeschen = useDeleteRatePlan(propertyId)
  const [deriveKind, setDeriveKind] = useState<'amount' | 'percent'>('percent')
  const [deriveValue, setDeriveValue] = useState('-15')

  const gewaehlt = gruppen.length > 0 ? gruppen
    : kategorien[0] === undefined ? [] : [kategorien[0].id]
  const wert = Number(deriveValue)
  const abgeleitet = baseId !== 0
  // Eine abgeleitete Rate hat eine Basis in einer Gruppe; fuer mehrere
  // gaebe es keine, die API weist es ebenso ab.
  const bereit = code.trim() !== '' && name.trim() !== '' && gewaehlt.length > 0
    && (!abgeleitet || (Number.isInteger(wert) && gewaehlt.length === 1))
  const beispielGruppe = kategorien.find(k => k.id === gewaehlt[0])?.code ?? 'DZ'

  const absenden = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!bereit) return
    anlegen.mutate({
      code: code.trim(), name: name.trim(), categoryIds: gewaehlt,
      ...(abgeleitet
        ? { baseRatePlanId: baseId, deriveKind, deriveValue: wert }
        : {})
    }, { onSuccess: () => { setCode(''); setName('') } })
  }

  return (
    <section className="rounded-sm border border-neutral-200 bg-white p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="font-medium">{t('rate.plans')}</div>
        <div className="grow" />
        <button type="button"
                onClick={() => neuRechnen.mutate({ from: von, to: bis })}
                disabled={!online || !darfSchreiben || neuRechnen.isPending}
                className="text-sm px-3 py-1.5 rounded-sm border border-neutral-300
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

      {/* Auch ohne Raten: die Regel des Hauses ist genau fuer Buchungen
          da, die keine haben. Der Schluessel haengt am gespeicherten Stand,
          damit die Zeile nach dem Laden neu beginnt. */}
      <div className="space-y-2 border-t border-neutral-200 pt-3">
        <div className="text-sm text-neutral-600">{t('rate.breakfast.title')}</div>
        <FruehstueckHaus key={JSON.stringify(hausFruehstueck)}
                         propertyId={propertyId} werte={hausFruehstueck}
                         darfSchreiben={darfSchreiben} />
        <div className="text-xs text-neutral-500">{t('rate.breakfast.houseHint')}</div>
        {plaene.map(p => (
          <FruehstueckRate key={p.id}
                           propertyId={propertyId} plan={p}
                           darfSchreiben={darfSchreiben} />
        ))}
        <div className="text-xs text-neutral-500">
          {t('rate.breakfast.hint')} {t('rate.breakfast.childHint')}
        </div>
      </div>

      {plaene.length > 0 && (
        <div className="space-y-3 border-t border-neutral-200 pt-3">
          <div className="text-sm text-neutral-600">{t('rate.inclusion.title')}</div>
          {plaene.map(p => (
            <InklusivZeile key={`${p.id}-${JSON.stringify(p.inclusions)}`}
                           propertyId={propertyId} plan={p} vatRules={vatRules}
                           darfSchreiben={darfSchreiben} />
          ))}
          <div className="text-xs text-neutral-500">{t('rate.inclusion.hint')}</div>
        </div>
      )}

      {darfSchreiben && plaene.length > 0 && (
        <div className="space-y-1 border-t border-neutral-200 pt-3">
          {plaene.map(p => (
            <div key={p.id} className="flex flex-wrap items-center gap-3 text-sm">
              <span>{p.name} <span className="text-neutral-500">({p.code} · {p.categoryCode})</span></span>
              <button type="button" disabled={!online || loeschen.isPending}
                      onClick={() => {
                        if (window.confirm(t('rate.plan.deleteConfirm',
                                             { name: p.name, code: p.code }))) {
                          loeschen.mutate(p.id)
                        }
                      }}
                      className="text-xs text-red-800 underline disabled:opacity-40">
                {t('rate.plan.delete')}
              </button>
            </div>
          ))}
          {loeschen.isError && <Fehler error={loeschen.error} />}
        </div>
      )}

      {darfSchreiben && (
        <form onSubmit={absenden} className="space-y-2 border-t border-neutral-200 pt-3">
          <div className="text-sm text-neutral-600">{t('rate.plan.new')}</div>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">
              <div className="text-neutral-600">{t('rate.plan.code')}</div>
              <input value={code} onChange={e => setCode(e.target.value)} required
                     className="border border-neutral-300 rounded-sm px-2 py-1 w-28" />
            </label>
            <label className="text-sm">
              <div className="text-neutral-600">{t('rate.plan.name')}</div>
              <input value={name} onChange={e => setName(e.target.value)} required
                     className="border border-neutral-300 rounded-sm px-2 py-1 w-56" />
            </label>
            <fieldset className="text-sm">
              <legend className="text-neutral-600">{t('rate.plan.categories')}</legend>
              <div className="flex flex-wrap gap-x-3 gap-y-1 py-1">
                {kategorien.map(k => (
                  <label key={k.id} className="inline-flex items-center gap-1">
                    <input type="checkbox" checked={gewaehlt.includes(k.id)}
                           onChange={e => setGruppen(e.target.checked
                             ? [...gewaehlt, k.id]
                             : gewaehlt.filter(g => g !== k.id))} />
                    {k.name}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="text-sm">
              <div className="text-neutral-600">{t('rate.plan.base')}</div>
              <select value={baseId} onChange={e => setBaseId(Number(e.target.value))}
                      className="border border-neutral-300 rounded-sm px-2 py-1">
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
                          className="border border-neutral-300 rounded-sm px-2 py-1">
                    <option value="percent">{t('rate.plan.derive.percent')}</option>
                    <option value="amount">{t('rate.plan.derive.amount')}</option>
                  </select>
                </label>
                <label className="text-sm">
                  <div className="text-neutral-600">{t('rate.plan.deriveValue')}</div>
                  <input type="number" value={deriveValue}
                         onChange={e => setDeriveValue(e.target.value)}
                         className="border border-neutral-300 rounded-sm px-2 py-1 w-24
                                    text-end tabular-nums" />
                </label>
              </>
            )}
          </div>

          {gewaehlt.length > 1 && (
            <div className="text-xs text-neutral-500">
              {t('rate.plan.multiHint', { example: `${code.trim() || 'standard'}-${beispielGruppe}` })}
            </div>
          )}
          {abgeleitet && (
            <div className="text-xs text-neutral-500">
              {t('rate.plan.deriveHint')} {t('rate.plan.emptyHint')}
            </div>
          )}
          {anlegen.isError && <Fehler error={anlegen.error} />}

          <button type="submit" disabled={!online || !bereit || anlegen.isPending}
                  className="text-sm px-3 py-1.5 rounded-sm bg-neutral-900 text-white
                             disabled:opacity-40">
            {t('common.save')}
          </button>
        </form>
      )}
    </section>
  )
}

/*
 * Zwei Reiter unter "Preise": das Raster, in dem Preise gepflegt werden, und
 * die Steuerung, die sie aus Regeln setzt (Dokument 32). Beides beantwortet
 * dieselbe Frage -- was kostet dieser Tag -- und gehoert deshalb unter
 * denselben Eintrag, nicht in einen eigenen Bildschirm daneben.
 */
const REITER = ['raster', 'steuerung'] as const
type Reiter = (typeof REITER)[number]

export function Rates(
  { propertyId, permissions }: { propertyId: number; permissions: readonly string[] }
): JSX.Element {
  const t = useT()
  const [reiter, setReiter] = useReiter<Reiter>('preise', REITER, 'raster')
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 border-b border-neutral-200">
        {REITER.map(r => (
          <button key={r} type="button" onClick={() => setReiter(r)}
                  aria-current={r === reiter ? 'page' : undefined}
                  className={`text-sm px-3 py-1.5 -mb-px border-b-2 ${
                    r === reiter
                      ? 'border-neutral-900 font-medium'
                      : 'border-transparent text-neutral-600 hover:text-neutral-900'}`}>
            {t(r === 'raster' ? 'steer.tab.grid' : 'steer.tab.steering')}
          </button>
        ))}
      </div>
      {reiter === 'raster'
        ? <Preisraster propertyId={propertyId} permissions={permissions} />
        : <Preissteuerung propertyId={propertyId} permissions={permissions} />}
    </div>
  )
}

function Preisraster(
  { propertyId, permissions }: { propertyId: number; permissions: readonly string[] }
): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [von, setVon] = useState(today())
  const [laenge, setLaenge] = useState<number>(30)
  const [categoryId, setCategoryId] = useState<number | null>(null)
  // 0 = volle Belegung je Kategorie: so zeigt RoomCloud seine Preise (x1
  // beim Einzel-, x2 beim Doppelzimmer), und so kennt die Rezeption sie.
  const [belegung, setBelegung] = useState(0)
  const [auswahl, setAuswahl] = useState<Auswahl | null>(null)

  const bis = addDays(von, laenge - 1)
  // Die Tage werden gemerkt: als neue Liste bei jedem Neuzeichnen faenden
  // die Zeilen des Rasters ihre Eingaben jedes Mal veraendert und
  // zeichneten sich alle neu -- damit waere das Merken dort wirkungslos.
  const tage = useMemo(() => tageInklusive(von, bis), [von, bis])
  const darfSchreiben = permissions.includes('rate:write')
  const online = useOnline()
  const preisSetzen = useSetRates(propertyId)
  const restriktionSetzen = useSetRestrictions(propertyId)

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
                 className="border border-neutral-300 rounded-sm px-2 py-1" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('rate.days')}</div>
          <select value={laenge} onChange={e => setLaenge(Number(e.target.value))}
                  className="border border-neutral-300 rounded-sm px-2 py-1">
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
                  className="border border-neutral-300 rounded-sm px-2 py-1">
            <option value="">—</option>
            {(kategorien.data?.categories ?? []).map(k => (
              <option key={k.id} value={k.id}>{k.name}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('rate.occupancy')}</div>
          <select value={belegung} onChange={e => setBelegung(Number(e.target.value))}
                  className="border border-neutral-300 rounded-sm px-2 py-1">
            <option value={0}>{t('rate.occupancy.standard')}</option>
            {[1, 2, 3, 4].map(n => (
              <option key={n} value={n}>{n} {t('rate.occupancy.n')}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Wer schreiben darf, darf holen: uebernommen wird ueber denselben
          Weg wie die Preispflege, und erst nach der Vorschau. */}
      {darfSchreiben && <KalenderAbruf propertyId={propertyId} />}
      {/* Senden nur per Knopf; der Zeitraum ist der des Rasters, damit
          "gewaehlter Zeitraum" genau das meint, was gerade zu sehen ist. */}
      {darfSchreiben && <KalenderSenden propertyId={propertyId} von={von} bis={bis} />}

      {raster.isError
        ? <Fehler error={raster.error} />
        : raster.data === undefined || plaene.data === undefined
          ? <Laedt />
          : aktivePlaene.length === 0
            // Ohne Ratenplan muss der Abschnitt trotzdem stehen: dort wird
            // der erste angelegt und die Fruehstuecksregel des Hauses
            // gesetzt, die gerade fuer Buchungen ohne Rate gilt.
            ? <>
                <div className="text-sm text-neutral-500">{t('rate.noPlans')}</div>
                <Ratenplaene propertyId={propertyId}
                             plaene={plaene.data.ratePlans}
                             vatRules={plaene.data.vatRules}
                             hausFruehstueck={plaene.data.houseBreakfast
                                              ?? { breakfastCent: null, childBreakfastCent: null }}
                             kategorien={kategorien.data?.categories ?? []}
                             von={von} bis={bis} darfSchreiben={darfSchreiben} />
              </>
            : <>
                <RateGrid plans={aktivePlaene} tage={tage} zellen={raster.data.cells}
                          kategorien={kategorien.data?.categories ?? []}
                          frei={raster.data.availability}
                          belegung={belegung} auswahl={auswahl}
                          onAuswahl={setAuswahl}
                          {...(darfSchreiben && online ? {
                            onPreis: (plan: RatePlan, datum: string, priceCent: number[]) =>
                              preisSetzen.mutate({ propertyId, ratePlanId: plan.id,
                                                   from: datum, to: datum, priceCent }),
                            onMindest: (plan: RatePlan, datum: string,
                                        z: RateGridCell | undefined, minLos: number | null) =>
                              // Die Route setzt alle Restriktionen des Tages; was
                              // nicht getippt wurde, geht so mit, wie es steht.
                              restriktionSetzen.mutate({ propertyId, ratePlanId: plan.id,
                                from: datum, to: datum, minLos,
                                maxLos: z?.maxLos ?? null, closed: z?.closed ?? false,
                                closedToArrival: z?.closedToArrival ?? false,
                                closedToDeparture: z?.closedToDeparture ?? false })
                          } : {})} />
                {(preisSetzen.isError || restriktionSetzen.isError) && (
                  <Fehler error={preisSetzen.error ?? restriktionSetzen.error} />
                )}
                <div className="text-xs text-neutral-500">{t('rate.legend')}</div>

                {/* Unter dem Raster, weil die Frage dort entsteht: wer
                    gerade Preise gesetzt hat, will sehen, was davon
                    hinausgeht. Derselbe Zeitraum wie oben. */}
                <ChannelSicht propertyId={propertyId} von={von} bis={bis}
                              belegung={belegung === 0 ? 2 : belegung} />

                <Ratenplaene propertyId={propertyId}
                             plaene={plaene.data?.ratePlans ?? []}
                             vatRules={plaene.data?.vatRules ?? []}
                             hausFruehstueck={plaene.data?.houseBreakfast
                                              ?? { breakfastCent: null, childBreakfastCent: null }}
                             kategorien={kategorien.data?.categories ?? []}
                             von={von} bis={bis} darfSchreiben={darfSchreiben} />

                {auswahl === null || gewaehlterPlan === undefined
                  ? <div className="text-sm text-neutral-500">
                      {t('rate.selection.none')}
                    </div>
                  : <>
                      <div className="flex flex-wrap items-end gap-3 rounded-sm border
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
                                 className="border border-neutral-300 rounded-sm px-2 py-1" />
                        </label>
                        <label className="text-sm">
                          <div className="text-neutral-600">{t('common.to')}</div>
                          <input type="date" value={auswahl.to}
                                 min={auswahl.from}
                                 onChange={e => setAuswahl(
                                   { ...auswahl, to: e.target.value })}
                                 className="border border-neutral-300 rounded-sm px-2 py-1" />
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
