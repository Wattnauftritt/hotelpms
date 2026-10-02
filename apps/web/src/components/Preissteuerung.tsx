import { useMemo, useState, type JSX } from 'react'
import type { SteerPlan, SteerRuleRow, SteerPreviewCell, SteerMode, PriceSource,
              SteerRounding, SteerRuleKind, SteeringOverview } from '@hotelpms/contracts'
import { PRICE_SOURCES, STEER_ROUNDINGS, STEER_RULE_KINDS, STEER_MAX_HORIZON_DAYS }
  from '@hotelpms/contracts'
import { useCategories } from '../lib/queries.js'
import { useSteering, useSteerPreview, useSteerRun, useSetSteerMode, useSetSteerPlan,
         useSaveSteerRule, useDeleteSteerRule, useApplySteering }
  from '../lib/queries/rateSteering.js'
import { tageInklusive } from '../lib/queries/rates.js'
import { regelSatz, regelNutzlast, eingabeAusRegel, LEERE_REGEL, zellSchluessel,
         auswahlNutzlast, stufenpreis, prozentText, eingabeAusBp, bpAusEingabe,
         type RegelEingabe } from '../lib/preissteuerung.js'
import { centAusEingabe, eingabeAusCent, wochentagKuerzel } from '../lib/preisraster.js'
import { useT, useLocale, formatDate, formatMoney, geldFormatierer, weekdayShort,
         intlTag, type TextKey } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { useEscape } from '../lib/tasten.js'
import { today, addDays } from '../lib/dates.js'
import { Dialog, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Preissteuerung (Dokument 32): Modus, Leitplanken, Regeln, Vorschau, Verlauf.
 *
 * **Die Oberflaeche rechnet nichts nach.** Was eine Regel aus einem Preis
 * macht, sagt die Vorschau der API, die dieselbe Rechnung benutzt wie der
 * Worker. Eine zweite Rechnung hier zeigte beim ersten Rundungsfall einen
 * anderen Preis als den, der hinausgeht.
 *
 * **Regeln als Saetze, nicht als Formeln.** "Wenn die Belegung der Kategorie
 * mindestens 85 % betraegt: Preis +20 %" liest jeder an der Rezeption; eine
 * Tabelle mit Schwellen in Basispunkten liest niemand gegen.
 *
 * **Uebernehmen nur, was gezeigt wurde.** Der Fingerabdruck der Vorschau
 * geht mit; hat sich seither eine Belegung bewegt, lehnt die API ab, und die
 * Vorschau laedt neu.
 */

const ZEITRAEUME = [14, 30, 90] as const
const WOCHENTAGE = [0, 1, 2, 3, 4, 5, 6] as const

// ------------------------------------------------------------- Einstellung

function Einstellung({ propertyId, daten, darfSteuern }: {
  propertyId: number; daten: SteeringOverview; darfSteuern: boolean
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const setzen = useSetSteerMode(propertyId)
  const [modus, setModus] = useState<SteerMode | null>(null)
  const [horizont, setHorizont] = useState<string | null>(null)

  const m = modus ?? daten.mode
  const h = horizont ?? String(daten.horizonDays)
  const hZahl = Number(h)
  const gueltig = Number.isInteger(hZahl) && hZahl >= 1 && hZahl <= STEER_MAX_HORIZON_DAYS

  return (
    <section className="rounded border border-neutral-200 bg-white p-3 space-y-3">
      <div className="text-sm text-neutral-600">{t('steer.intro')}</div>
      <div className="flex flex-wrap items-end gap-4">
        <fieldset className="text-sm space-y-1">
          <legend className="text-neutral-600">{t('steer.mode')}</legend>
          {(['suggest', 'auto'] as const).map(v => (
            <label key={v} className="flex items-center gap-1.5">
              <input type="radio" name="steer-mode" value={v} checked={m === v}
                     disabled={!darfSteuern}
                     onChange={() => setModus(v)} />
              {t(v === 'suggest' ? 'steer.mode.suggest' : 'steer.mode.auto')}
            </label>
          ))}
        </fieldset>
        <label className="text-sm">
          <div className="text-neutral-600">{t('steer.horizon')}</div>
          <input type="number" min={1} max={STEER_MAX_HORIZON_DAYS} value={h}
                 disabled={!darfSteuern}
                 onChange={e => setHorizont(e.target.value)}
                 className="border border-neutral-300 rounded px-2 py-1 w-24 tabular-nums" />
        </label>
        {darfSteuern && (
          <button type="button"
                  disabled={!online || !gueltig || setzen.isPending}
                  onClick={() => setzen.mutate({ mode: m, horizonDays: hZahl },
                    { onSuccess: () => { setModus(null); setHorizont(null) } })}
                  className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                             disabled:opacity-40">
            {t('common.save')}
          </button>
        )}
        <div className="text-sm text-neutral-600">
          {daten.businessDate === null
            ? <span className="text-amber-800">{t('steer.noBusinessDay')}</span>
            : t('steer.businessDate', { datum: formatDate(daten.businessDate, locale) })}
        </div>
        {setzen.isSuccess && (
          <span role="status" className="text-sm text-emerald-800">{t('steer.saved')}</span>
        )}
      </div>
      {setzen.isError && <Fehler error={setzen.error} />}
    </section>
  )
}

// ------------------------------------------------------------ Ratenplaene

function PlanZeile({ propertyId, plan, darfSteuern }: {
  propertyId: number; plan: SteerPlan; darfSteuern: boolean
}): JSX.Element {
  const t = useT()
  const online = useOnline()
  const setzen = useSetSteerPlan(propertyId)
  const [source, setSource] = useState<PriceSource>(plan.source)
  const [min, setMin] = useState(plan.minCent === null ? '' : eingabeAusCent(plan.minCent))
  const [max, setMax] = useState(plan.maxCent === null ? '' : eingabeAusCent(plan.maxCent))
  const [rounding, setRounding] = useState<SteerRounding>(plan.rounding)
  const [schritt, setSchritt] = useState(eingabeAusBp(plan.maxStepBp))

  const minCent = min.trim() === '' ? null : centAusEingabe(min)
  const maxCent = max.trim() === '' ? null : centAusEingabe(max)
  const stepBp = schritt.trim() === '' ? null : bpAusEingabe(schritt)
  const gueltig = (min.trim() === '' || minCent !== null)
    && (max.trim() === '' || maxCent !== null)
    && (schritt.trim() === '' || (stepBp !== null && stepBp >= 100 && stepBp <= 10000))
    && (minCent === null || maxCent === null || minCent <= maxCent)
  const gesperrt = !darfSteuern || plan.derived

  const feld = 'border border-neutral-300 rounded px-2 py-1 w-24 text-right tabular-nums '
    + 'disabled:bg-neutral-100'

  return (
    <tr className="border-t border-neutral-100">
      <td className="py-1.5 pr-3">
        <div className="font-medium">{plan.name}</div>
        <div className="text-xs text-neutral-500">{plan.code} · {plan.categoryCode}</div>
      </td>
      {plan.derived
        ? <td colSpan={6} className="py-1.5 text-sm text-neutral-500">{t('steer.derived')}</td>
        : <>
            <td className="py-1.5 pr-2">
              <select value={source} disabled={gesperrt}
                      aria-label={t('steer.source')}
                      onChange={e => setSource(e.target.value as PriceSource)}
                      className="border border-neutral-300 rounded px-2 py-1 disabled:bg-neutral-100">
                {PRICE_SOURCES.map(s => (
                  <option key={s} value={s}>{t(`steer.source.${s}` as TextKey)}</option>
                ))}
              </select>
            </td>
            <td className="py-1.5 pr-2">
              <input value={min} onChange={e => setMin(e.target.value)} disabled={gesperrt}
                     inputMode="decimal" placeholder="—" aria-label={t('steer.min')}
                     className={feld} />
            </td>
            <td className="py-1.5 pr-2">
              <input value={max} onChange={e => setMax(e.target.value)} disabled={gesperrt}
                     inputMode="decimal" placeholder="—" aria-label={t('steer.max')}
                     className={feld} />
            </td>
            <td className="py-1.5 pr-2">
              <select value={rounding} disabled={gesperrt} aria-label={t('steer.rounding')}
                      onChange={e => setRounding(e.target.value as SteerRounding)}
                      className="border border-neutral-300 rounded px-2 py-1 disabled:bg-neutral-100">
                {STEER_ROUNDINGS.map(r => (
                  <option key={r} value={r}>{t(`steer.rounding.${r}` as TextKey)}</option>
                ))}
              </select>
            </td>
            <td className="py-1.5 pr-2">
              <input value={schritt} onChange={e => setSchritt(e.target.value)}
                     disabled={gesperrt} inputMode="decimal" placeholder="—"
                     aria-label={t('steer.maxStep')} className={feld} />
            </td>
            <td className="py-1.5">
              {darfSteuern && (
                <button type="button"
                        disabled={!online || !gueltig || setzen.isPending}
                        onClick={() => setzen.mutate({
                          ratePlanId: plan.ratePlanId, source, minCent, maxCent,
                          rounding, maxStepBp: stepBp })}
                        className="text-sm px-3 py-1 rounded border border-neutral-300
                                   hover:bg-neutral-50 disabled:opacity-40">
                  {t('common.save')}
                </button>
              )}
              {setzen.isSuccess && (
                <span role="status" className="ml-2 text-xs text-emerald-800">
                  {t('steer.saved')}
                </span>
              )}
              {setzen.isError && <Fehler error={setzen.error} />}
            </td>
          </>}
    </tr>
  )
}

function Plaene({ propertyId, plaene, darfSteuern }: {
  propertyId: number; plaene: readonly SteerPlan[]; darfSteuern: boolean
}): JSX.Element {
  const t = useT()
  return (
    <section className="rounded border border-neutral-200 bg-white p-3 space-y-2">
      <div className="font-medium">{t('steer.plans')}</div>
      <div className="text-xs text-neutral-500">{t('steer.plans.hint')}</div>
      <div className="overflow-x-auto">
        <table className="text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-500">
              <th className="font-normal pr-3">{t('rate.plan')}</th>
              <th className="font-normal pr-2">{t('steer.source')}</th>
              <th className="font-normal pr-2">{t('steer.min')}</th>
              <th className="font-normal pr-2">{t('steer.max')}</th>
              <th className="font-normal pr-2">{t('steer.rounding')}</th>
              <th className="font-normal pr-2">{t('steer.maxStep')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {plaene.map(p => (
              // Neu eingehaengt, wenn sich der gespeicherte Stand aendert: die
              // Felder zeigen sonst den Entwurf von vorhin statt der Antwort.
              <PlanZeile key={`${p.ratePlanId}:${p.source}:${p.minCent}:${p.maxCent}:`
                              + `${p.rounding}:${p.maxStepBp}`}
                         propertyId={propertyId} plan={p} darfSteuern={darfSteuern} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ----------------------------------------------------------------- Regeln

function zielText(r: SteerRuleRow, plaene: readonly SteerPlan[],
                  kategorien: ReadonlyArray<{ id: number; name: string }>,
                  t: ReturnType<typeof useT>): string {
  if (r.ratePlanId !== null) {
    return t('steer.target.plan',
      { plan: plaene.find(p => p.ratePlanId === r.ratePlanId)?.name ?? `#${r.ratePlanId}` })
  }
  if (r.categoryId !== null) {
    return t('steer.target.category',
      { kategorie: kategorien.find(k => k.id === r.categoryId)?.name ?? `#${r.categoryId}` })
  }
  return t('steer.target.all')
}

function RegelMaske({ propertyId, regel, plaene, kategorien, onClose }: {
  propertyId: number
  regel: SteerRuleRow | null
  plaene: readonly SteerPlan[]
  kategorien: ReadonlyArray<{ id: number; name: string }>
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const speichern = useSaveSteerRule(propertyId)
  const [e, setE] = useState<RegelEingabe>(regel === null ? LEERE_REGEL : eingabeAusRegel(regel))
  const nutzlast = regelNutzlast(e)
  const setze = <K extends keyof RegelEingabe>(k: K, v: RegelEingabe[K]): void =>
    setE(alt => ({ ...alt, [k]: v }))

  const absenden = (): void => {
    if (nutzlast === null) return
    speichern.mutate({ id: regel?.id ?? null, rule: nutzlast }, { onSuccess: onClose })
  }

  const gruppe = (k: SteerRuleKind): JSX.Element => {
    switch (k) {
      case 'occupancy': return (
        <div key={k} className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">
            <div className="text-neutral-600">{t('steer.rule.occMin')}</div>
            <input value={e.occMin} onChange={v => setze('occMin', v.target.value)}
                   inputMode="decimal" className={FELD} />
          </label>
          <label className="text-sm">
            <div className="text-neutral-600">{t('steer.rule.occBelow')}</div>
            <input value={e.occBelow} onChange={v => setze('occBelow', v.target.value)}
                   inputMode="decimal" className={FELD} />
          </label>
          <label className="text-sm">
            <div className="text-neutral-600">{t('steer.rule.scope')}</div>
            <select value={e.occupancyScope}
                    onChange={v => setze('occupancyScope', v.target.value as 'category')}
                    className={FELD}>
              <option value="category">{t('steer.scope.category')}</option>
              <option value="house">{t('steer.scope.house')}</option>
            </select>
          </label>
        </div>)
      case 'lead_time': return (
        <div key={k} className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <div className="text-neutral-600">{t('steer.rule.leadBelow')}</div>
            <input type="number" min={1} value={e.leadBelow}
                   onChange={v => setze('leadBelow', v.target.value)} className={FELD} />
          </label>
          <label className="text-sm">
            <div className="text-neutral-600">{t('steer.rule.leadMin')}</div>
            <input type="number" min={0} value={e.leadMin}
                   onChange={v => setze('leadMin', v.target.value)} className={FELD} />
          </label>
        </div>)
      case 'weekday': return (
        <div key={k} className="text-sm">
          <div className="text-neutral-600">{t('steer.rule.weekdays')}</div>
          <div className="flex flex-wrap gap-3 mt-1">
            {WOCHENTAGE.map(i => (
              <label key={i} className="flex items-center gap-1">
                <input type="checkbox" checked={e.weekdays.includes(i)}
                       onChange={v => setze('weekdays', v.target.checked
                         ? [...e.weekdays, i] : e.weekdays.filter(x => x !== i))} />
                {wochentagKuerzel(i, locale)}
              </label>
            ))}
          </div>
        </div>)
      case 'period': return (
        <div key={k} className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <div className="text-neutral-600">{t('steer.rule.period')} – {t('common.from')}</div>
            <input type="date" value={e.periodFrom}
                   onChange={v => setze('periodFrom', v.target.value)} className={FELD} />
          </label>
          <label className="text-sm">
            <div className="text-neutral-600">{t('steer.rule.period')} – {t('common.to')}</div>
            <input type="date" value={e.periodTo} min={e.periodFrom || undefined}
                   onChange={v => setze('periodTo', v.target.value)} className={FELD} />
          </label>
        </div>)
    }
  }

  return (
    <Dialog titel={regel === null ? t('steer.rule.new') : t('steer.rule.editTitle')}
            onClose={onClose} breite="mittel"
            fuss={<>
              <button type="button" className={KNOPF}
                      disabled={!online || nutzlast === null || speichern.isPending}
                      onClick={absenden}>
                {t('common.save')}
              </button>
              <button type="button" className={KNOPF_LEISE} onClick={onClose}>
                {t('common.cancel')}
              </button>
            </>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <div className="text-neutral-600">{t('steer.rule.kind')}</div>
            <select value={e.kind} onChange={v => setze('kind', v.target.value as SteerRuleKind)}
                    className={FELD}>
              {STEER_RULE_KINDS.map(k => (
                <option key={k} value={k}>{t(`steer.kind.${k}` as TextKey)}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <div className="text-neutral-600">{t('steer.rule.name')}</div>
            <input value={e.name} maxLength={80} onChange={v => setze('name', v.target.value)}
                   className={FELD} />
          </label>
        </div>

        {gruppe(e.kind)}

        <details className="rounded border border-neutral-200 p-3">
          <summary className="text-sm text-neutral-600 cursor-pointer">
            {t('steer.rule.moreConditions')}
          </summary>
          <div className="mt-3 space-y-3">
            {STEER_RULE_KINDS.filter(k => k !== e.kind).map(k => gruppe(k))}
          </div>
        </details>

        <div className="grid gap-3 sm:grid-cols-4 items-end">
          <label className="text-sm">
            <div className="text-neutral-600">{t('steer.rule.effect')}</div>
            <select value={e.richtung}
                    onChange={v => setze('richtung', v.target.value as 'hoch')} className={FELD}>
              <option value="hoch">{t('steer.effect.up')}</option>
              <option value="runter">{t('steer.effect.down')}</option>
            </select>
          </label>
          <label className="text-sm">
            <div className="text-neutral-600">&nbsp;</div>
            <select value={e.effectKind}
                    onChange={v => setze('effectKind', v.target.value as 'percent')}
                    className={FELD}>
              <option value="percent">{t('steer.effect.percent')}</option>
              <option value="amount">{t('steer.effect.amount')}</option>
            </select>
          </label>
          <label className="text-sm">
            <div className="text-neutral-600">{t('steer.effect.value')}</div>
            <input value={e.wert} onChange={v => setze('wert', v.target.value)}
                   inputMode="decimal" className={FELD} />
          </label>
          <label className="text-sm flex items-center gap-1.5 pb-2">
            <input type="checkbox" checked={e.active}
                   onChange={v => setze('active', v.target.checked)} />
            {t('steer.rule.active')}
          </label>
        </div>

        <label className="text-sm block">
          <div className="text-neutral-600">{t('steer.rule.target')}</div>
          <select value={e.ziel} onChange={v => setze('ziel', v.target.value as 'alle')}
                  className={FELD}>
            <option value="alle">{t('steer.target.all')}</option>
            {plaene.filter(p => !p.derived).map(p => (
              <option key={`p${p.ratePlanId}`} value={`plan:${p.ratePlanId}`}>
                {t('steer.target.plan', { plan: p.name })}
              </option>
            ))}
            {kategorien.map(k => (
              <option key={`k${k.id}`} value={`kategorie:${k.id}`}>
                {t('steer.target.category', { kategorie: k.name })}
              </option>
            ))}
          </select>
        </label>

        <div className="rounded bg-neutral-50 border border-neutral-200 p-3 text-sm">
          <div className="text-xs text-neutral-500">{t('steer.rule.reads')}</div>
          {nutzlast === null
            ? <div className="text-neutral-500">{t('steer.rule.incomplete')}</div>
            : <div className="font-medium" data-regelsatz>{regelSatz(nutzlast, t, locale)}</div>}
        </div>
        {speichern.isError && <Fehler error={speichern.error} />}
      </div>
    </Dialog>
  )
}

function Regeln({ propertyId, daten, kategorien, darfSteuern }: {
  propertyId: number; daten: SteeringOverview
  kategorien: ReadonlyArray<{ id: number; name: string }>; darfSteuern: boolean
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const entfernen = useDeleteSteerRule(propertyId)
  // undefined: keine Maske. null: neue Regel. Sonst die Regel in Bearbeitung.
  const [offen, setOffen] = useState<SteerRuleRow | null | undefined>(undefined)

  return (
    <section className="rounded border border-neutral-200 bg-white p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="font-medium">{t('steer.rules')}</div>
        <div className="grow" />
        {darfSteuern && (
          <button type="button" disabled={!online} onClick={() => setOffen(null)}
                  className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                             disabled:opacity-40">
            {t('steer.rule.new')}
          </button>
        )}
      </div>
      <div className="text-xs text-neutral-500">{t('steer.rules.hint')}</div>
      {daten.rules.length === 0
        ? <div className="text-sm text-neutral-500">{t('steer.rules.none')}</div>
        : <ul className="divide-y divide-neutral-100">
            {daten.rules.map(r => (
              <li key={r.id} className={`py-2 flex flex-wrap items-baseline gap-3
                                         ${r.active ? '' : 'opacity-60'}`}>
                <div className="grow min-w-0">
                  <div className="text-sm">{regelSatz(r, t, locale)}</div>
                  <div className="text-xs text-neutral-500">
                    {r.name !== null && <span className="font-medium">{r.name} · </span>}
                    {zielText(r, daten.plans, kategorien, t)}
                    {!r.active && <> · {t('steer.rule.inactive')}</>}
                  </div>
                </div>
                {darfSteuern && (
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setOffen(r)} disabled={!online}
                            className="text-sm px-2 py-1 rounded border border-neutral-300
                                       hover:bg-neutral-50 disabled:opacity-40">
                      {t('steer.rule.edit')}
                    </button>
                    <button type="button" onClick={() => entfernen.mutate(r.id)}
                            disabled={!online || entfernen.isPending}
                            className="text-sm px-2 py-1 rounded border border-neutral-300
                                       hover:bg-neutral-50 disabled:opacity-40">
                      {t('steer.rule.delete')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>}
      {entfernen.isError && <Fehler error={entfernen.error} />}
      {offen !== undefined && (
        <RegelMaske propertyId={propertyId} regel={offen} plaene={daten.plans}
                    kategorien={kategorien} onClose={() => setOffen(undefined)} />
      )}
    </section>
  )
}

// --------------------------------------------------------------- Vorschau

function Zellendetail({ zelle, regeln, belegung }: {
  zelle: SteerPreviewCell | undefined; regeln: readonly SteerRuleRow[]; belegung: number
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  if (zelle === undefined) {
    return <div className="text-sm text-neutral-500">{t('steer.detail.choose')}</div>
  }
  const geld = (p: readonly number[]): string => {
    const v = stufenpreis(p, belegung)
    return v === null ? '—' : formatMoney(v, locale)
  }
  const prozent = (bp: number | null): string => bp === null ? '—' : prozentText(bp, locale)
  return (
    <div className="text-sm space-y-1" data-zellendetail>
      <div className="font-medium">
        {weekdayShort(zelle.date, locale)} {formatDate(zelle.date, locale)}
        <span className="text-neutral-500 font-normal">
          {' · '}{zelle.leadDays === 1 ? t('steer.detail.lead.one')
            : t('steer.detail.lead', { n: zelle.leadDays })}
          {' · '}{t('steer.detail.occupancy',
            { kat: prozent(zelle.occupancyBp), haus: prozent(zelle.houseOccupancyBp) })}
        </span>
      </div>
      <div className="tabular-nums">
        {t('steer.detail.base')} {geld(zelle.baseCent)} · {t('steer.detail.current')}{' '}
        {geld(zelle.currentCent)} · {t('steer.detail.suggested')}{' '}
        <span className="font-semibold">{geld(zelle.suggestedCent)}</span>
      </div>
      {zelle.ruleIds.length === 0
        ? <div className="text-neutral-500">{t('steer.detail.noRule')}</div>
        : <ul className="list-disc pl-5">
            {zelle.ruleIds.map(id => {
              const r = regeln.find(x => x.id === id)
              return (
                <li key={id}>
                  {r === undefined ? t('steer.run.unknownRule', { id }) : regelSatz(r, t, locale)}
                </li>
              )
            })}
          </ul>}
    </div>
  )
}

function Vorschau({ propertyId, daten, darfUebernehmen }: {
  propertyId: number; daten: SteeringOverview; darfUebernehmen: boolean
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const online = useOnline()
  const [von, setVon] = useState(daten.businessDate ?? today())
  const [laenge, setLaenge] = useState<number>(14)
  const [belegung, setBelegung] = useState(2)
  const [gewaehlt, setGewaehlt] = useState<ReadonlySet<string>>(new Set())
  const [fokus, setFokus] = useState<string | null>(null)
  const bis = addDays(von, laenge - 1)
  const vorschau = useSteerPreview(propertyId, von, bis)
  const uebernehmen = useApplySteering(propertyId)
  const geldF = geldFormatierer(locale)

  // Escape hebt die Auswahl auf -- die oberste Lage, solange es eine gibt.
  useEscape(() => { setGewaehlt(new Set()); setFokus(null) }, gewaehlt.size > 0)

  const zellen = vorschau.data?.cells ?? []
  const nachPlan = useMemo(() => {
    const m = new Map<number, Map<string, SteerPreviewCell>>()
    for (const z of zellen) {
      let zeile = m.get(z.ratePlanId)
      if (zeile === undefined) { zeile = new Map(); m.set(z.ratePlanId, zeile) }
      zeile.set(z.date, z)
    }
    return m
  }, [zellen])
  const tage = useMemo(() => vorschau.data === undefined ? []
    : tageInklusive(vorschau.data.from, vorschau.data.to), [vorschau.data])
  const geaendert = zellen.filter(z => z.changed).length
  const auswahl = vorschau.data === undefined ? [] : auswahlNutzlast(zellen, gewaehlt)
  const fokusZelle = zellen.find(z => zellSchluessel(z.ratePlanId, z.date) === fokus)

  const anwenden = (nurAuswahl: boolean): void => {
    if (vorschau.data === undefined) return
    uebernehmen.mutate({
      from: vorschau.data.from, to: vorschau.data.to, token: vorschau.data.token,
      ...(nurAuswahl ? { cells: auswahl } : {})
    }, { onSuccess: () => setGewaehlt(new Set()) })
  }

  const umschalten = (z: SteerPreviewCell): void => {
    const k = zellSchluessel(z.ratePlanId, z.date)
    setFokus(k)
    if (!z.changed) return
    const n = new Set(gewaehlt)
    if (n.has(k)) n.delete(k)
    else n.add(k)
    setGewaehlt(n)
  }

  const gesteuert = daten.plans.filter(p => p.source === 'rules' && !p.derived)

  return (
    <section className="rounded border border-neutral-200 bg-white p-3 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="font-medium">{t('steer.preview')}</div>
        <div className="grow" />
        <label className="text-sm">
          <div className="text-neutral-600">{t('common.from')}</div>
          <input type="date" value={von} min={daten.businessDate ?? undefined}
                 onChange={e => { setVon(e.target.value); setGewaehlt(new Set()) }}
                 className="border border-neutral-300 rounded px-2 py-1" />
        </label>
        <label className="text-sm">
          <div className="text-neutral-600">{t('rate.days')}</div>
          <select value={laenge} onChange={e => { setLaenge(Number(e.target.value))
                                                  setGewaehlt(new Set()) }}
                  className="border border-neutral-300 rounded px-2 py-1">
            {ZEITRAEUME.map(n => <option key={n} value={n}>{t('steer.days', { n })}</option>)}
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

      {daten.mode === 'auto' && (
        <div className="text-sm text-neutral-600">{t('steer.preview.autoHint')}</div>
      )}

      {gesteuert.length === 0
        ? <div className="text-sm text-neutral-500">{t('steer.preview.empty')}</div>
        : vorschau.isError
          ? <Fehler error={vorschau.error} />
          : vorschau.data === undefined
            ? <Laedt />
            : <>
                <div className="overflow-x-auto border border-neutral-200 rounded">
                  <table className="text-xs border-collapse" data-vorschau>
                    <thead>
                      <tr>
                        <th className="sticky left-0 bg-white border-b border-r
                                       border-neutral-200 px-2 py-1 text-left font-medium
                                       min-w-40">
                          {t('rate.plan')}
                        </th>
                        {tage.map(d => (
                          <th key={d} className="border-b border-neutral-200 px-1 py-1
                                                 font-normal text-center min-w-16">
                            <div className="text-neutral-500">{weekdayShort(d, locale)}</div>
                            <div className="tabular-nums">{d.slice(8, 10)}.{d.slice(5, 7)}.</div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {gesteuert.map(p => (
                        <tr key={p.ratePlanId}>
                          <th className="sticky left-0 bg-white border-r border-neutral-200
                                         px-2 py-1 text-left font-normal">
                            <div className="text-sm">{p.name}</div>
                            <div className="text-neutral-500">{p.code}</div>
                          </th>
                          {tage.map(d => {
                            const z = nachPlan.get(p.ratePlanId)?.get(d)
                            if (z === undefined) {
                              return <td key={d} className="border-t border-neutral-100
                                                             text-center text-neutral-300">—</td>
                            }
                            const k = zellSchluessel(z.ratePlanId, z.date)
                            const neu = stufenpreis(z.suggestedCent, belegung)
                            const alt = stufenpreis(z.currentCent, belegung)
                            const richtung = !z.changed || neu === null || alt === null ? 0
                              : Math.sign(neu - alt)
                            const farbe = richtung > 0 ? 'bg-emerald-50 text-emerald-900'
                              : richtung < 0 ? 'bg-amber-50 text-amber-900'
                              : z.changed ? 'bg-sky-50' : 'text-neutral-500'
                            return (
                              <td key={d}
                                  onClick={() => umschalten(z)}
                                  aria-selected={gewaehlt.has(k)}
                                  data-geaendert={z.changed ? 'ja' : 'nein'}
                                  className={`border-t border-neutral-100 px-1 py-1 text-right
                                              tabular-nums cursor-pointer select-none ${farbe}
                                              ${gewaehlt.has(k) ? 'ring-2 ring-inset ring-neutral-900' : ''}
                                              ${fokus === k ? 'outline outline-1 outline-neutral-400' : ''}`}>
                                <div className="font-medium">
                                  {neu === null ? '—'
                                    : geldF.format(neu / 100).replace(/\s?€/, '')}
                                </div>
                                {z.changed && alt !== null && (
                                  <div className="text-[10px] text-neutral-500 line-through">
                                    {geldF.format(alt / 100).replace(/\s?€/, '')}
                                  </div>
                                )}
                                <div className="text-[10px] text-neutral-400">
                                  {z.occupancyBp === null ? '' : `${prozentText(z.occupancyBp, locale)} %`}
                                </div>
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="text-xs text-neutral-500">{t('steer.preview.legend')}</div>

                <Zellendetail zelle={fokusZelle} regeln={daten.rules} belegung={belegung} />

                {darfUebernehmen && (
                  <div className="flex flex-wrap items-center gap-3">
                    <button type="button" onClick={() => anwenden(false)}
                            disabled={!online || geaendert === 0 || uebernehmen.isPending}
                            className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white
                                       disabled:opacity-40">
                      {t('steer.apply.all', { n: geaendert })}
                    </button>
                    <button type="button" onClick={() => anwenden(true)}
                            disabled={!online || auswahl.length === 0 || uebernehmen.isPending}
                            className="text-sm px-3 py-1.5 rounded border border-neutral-300
                                       hover:bg-neutral-50 disabled:opacity-40">
                      {t('steer.apply.selected', { n: auswahl.length })}
                    </button>
                    {gewaehlt.size > 0 && (
                      <button type="button" onClick={() => setGewaehlt(new Set())}
                              className="text-sm text-neutral-600 underline">
                        {t('steer.selection.clear')}
                      </button>
                    )}
                    {uebernehmen.isSuccess && (
                      <span role="status" className="text-sm text-emerald-800">
                        {uebernehmen.data.changed === 1 ? t('steer.applied.one')
                          : t('steer.applied', { n: uebernehmen.data.changed })}
                      </span>
                    )}
                  </div>
                )}
                {uebernehmen.isError && <Fehler error={uebernehmen.error} />}
              </>}
    </section>
  )
}

// ---------------------------------------------------------------- Verlauf

function LaufDetail({ propertyId, runId, plaene }: {
  propertyId: number; runId: number; plaene: readonly SteerPlan[]
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const lauf = useSteerRun(propertyId, runId)
  if (lauf.isError) return <Fehler error={lauf.error} />
  if (lauf.data === undefined) return <Laedt />
  const geld = (p: readonly number[] | null): string =>
    p === null || p.length === 0 ? '—' : p.map(c => formatMoney(c, locale)).join(' / ')
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {lauf.data.changes.map(c => (
        <li key={`${c.ratePlanId}|${c.date}`} className="tabular-nums">
          <span className="font-medium">
            {plaene.find(p => p.ratePlanId === c.ratePlanId)?.code ?? `#${c.ratePlanId}`}
          </span>{' '}
          {formatDate(c.date, locale)}: {geld(c.oldCent)} → {geld(c.newCent)}
          <span className="text-neutral-500">
            {' '}({t('steer.detail.base')} {geld(c.baseCent)}
            {c.ruleIds.map(id => {
              const r = lauf.data.rules.find(x => x.id === id)
              return <span key={id}>; {r === undefined
                ? t('steer.run.unknownRule', { id }) : regelSatz(r, t, locale)}</span>
            })})
          </span>
        </li>
      ))}
    </ul>
  )
}

function Verlauf({ propertyId, daten }: {
  propertyId: number; daten: SteeringOverview
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [offen, setOffen] = useState<number | null>(null)
  useEscape(() => setOffen(null), offen !== null)
  const zeit = new Intl.DateTimeFormat(intlTag(locale),
    { dateStyle: 'short', timeStyle: 'short' })
  return (
    <section className="rounded border border-neutral-200 bg-white p-3 space-y-2">
      <div className="font-medium">{t('steer.runs')}</div>
      {daten.runs.length === 0
        ? <div className="text-sm text-neutral-500">{t('steer.runs.none')}</div>
        : <ul className="divide-y divide-neutral-100">
            {daten.runs.map(r => (
              <li key={r.runId} className="py-1.5 text-sm">
                <button type="button" className="text-left w-full hover:bg-neutral-50"
                        aria-expanded={offen === r.runId}
                        onClick={() => setOffen(offen === r.runId ? null : r.runId)}>
                  <span className="tabular-nums">{zeit.format(new Date(r.createdAt))}</span>
                  {' · '}
                  {r.kind === 'auto' ? t('steer.run.auto')
                    : t('steer.run.apply', { name: r.userName ?? '—' })}
                  {' · '}{t('steer.businessDate', { datum: formatDate(r.businessDate, locale) })}
                  {' · '}<span className="font-medium">
                    {r.changedDays === 1 ? t('steer.run.changed.one')
                      : t('steer.run.changed', { n: r.changedDays })}</span>
                </button>
                {offen === r.runId && r.changedDays > 0 && (
                  <LaufDetail propertyId={propertyId} runId={r.runId} plaene={daten.plans} />
                )}
              </li>
            ))}
          </ul>}
    </section>
  )
}

// ------------------------------------------------------------- Bildschirm

export function Preissteuerung({ propertyId, permissions }: {
  propertyId: number; permissions: readonly string[]
}): JSX.Element {
  const steuerung = useSteering(propertyId)
  const kategorien = useCategories(propertyId)
  const darfSteuern = permissions.includes('rate:steer')
  const darfUebernehmen = permissions.includes('rate:write')

  if (steuerung.isError) return <Fehler error={steuerung.error} />
  if (steuerung.data === undefined) return <Laedt />
  const daten = steuerung.data
  const kat = (kategorien.data?.categories ?? []).map(k => ({ id: k.id, name: k.name }))

  return (
    <div className="space-y-4">
      <Einstellung propertyId={propertyId} daten={daten} darfSteuern={darfSteuern} />
      <Vorschau propertyId={propertyId} daten={daten} darfUebernehmen={darfUebernehmen} />
      <Regeln propertyId={propertyId} daten={daten} kategorien={kat} darfSteuern={darfSteuern} />
      <Plaene propertyId={propertyId} plaene={daten.plans} darfSteuern={darfSteuern} />
      <Verlauf propertyId={propertyId} daten={daten} />
    </div>
  )
}
