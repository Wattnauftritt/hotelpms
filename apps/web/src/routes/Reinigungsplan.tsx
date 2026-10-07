import { Fragment, useEffect, useMemo, useState } from 'react'
import { useT, useLocale, intlTag } from '../lib/i18n/index.js'
import { useOnline } from '../lib/offline.js'
import { today } from '../lib/dates.js'
import { Fehler, Laedt, DatumsWahl } from '../components/Shell.tsx'
import {
  useReinigungsplan, usePlanSpeichern, usePlanVorschlag, useSollminutenSpeichern,
  useBereicheSpeichern, usePersonalGemeinsam, usePersonalGemeinsamSpeichern, zielVon,
  type Reinigungsplan as Plan, type PlanZimmer, type ReinigungsArt, type Sollminute,
  type Zuteilung, type Bereich
} from '../lib/queries/reinigungsplan.js'
import { useHausrechte } from '../lib/rechte.js'
import { useCleaningWaiverSettings, useSaveCleaningWaiverSettings } from '../lib/queries/checkin.js'

/**
 * Reinigungsplan (Aufgabe 18, Baustein 2).
 *
 * Die Hausdame hakt an, wer heute arbeitet, laesst sich einen Vorschlag
 * machen und schiebt einzelne Zimmer um. Erst „Speichern“ schreibt; bis
 * dahin ist alles ein Entwurf in diesem Bildschirm. So kann sie zwei
 * Vorschlaege vergleichen, ohne dass auf einem Handy schon Zimmer
 * erscheinen, die gleich wieder verschwinden.
 *
 * Die Last je Kraft steht neben dem Namen und rechnet beim Umschieben mit:
 * nach Minuten, weil danach abgerechnet wird, und weil zwei Abreisen mehr
 * Arbeit sind als sechs Bleiber.
 *
 * Bereiche wie das Gemeinschaftsbad stehen als Zeile mit `areaId` in
 * derselben Liste (0116). Arbeitet der Betrieb mit gemeinsamem Personal,
 * stehen die Zimmer aller Haeuser hier, nach Haus getrennt; sonst steht
 * neben einer Kraft, was sie heute im anderen Haus schon hat.
 */

/** Je Zimmer oder Bereich (`zielVon`) die Kraft. */
type Entwurf = Map<string, number | null>

const artVon = (z: PlanZimmer): ReinigungsArt | null => z.kind ?? z.due

function entwurfAus(plan: Plan): Entwurf {
  return new Map(plan.rooms.filter(z => artVon(z) !== null)
    .map(z => [zielVon(z), z.assignedTo]))
}

export function Reinigungsplan({ propertyId }: { propertyId: number }): JSX.Element {
  const [datum, setDatum] = useState(today())
  const q = useReinigungsplan(propertyId, datum)
  if (q.isError && q.data === undefined) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  // Am Datum und am Stand geschluesselt: ein anderer Tag oder ein frisch
  // gespeicherter Plan beginnt mit einem frischen Entwurf.
  return <div className="space-y-4">
    <DatumsWahl value={datum} onChange={setDatum} />
    <Tagesplan key={`${datum}-${q.dataUpdatedAt}`} propertyId={propertyId} plan={q.data} />
    <Sollminuten key={`n-${q.dataUpdatedAt}`} propertyId={propertyId} plan={q.data} />
    <Bereiche key={`b-${q.dataUpdatedAt}`} propertyId={propertyId} bereiche={q.data.areas} />
    <VerzichtEinstellung propertyId={propertyId} />
    <Gemeinsam propertyId={propertyId} />
    <Verlauf plan={q.data} />
  </div>
}

function Tagesplan({ propertyId, plan }: { propertyId: number; plan: Plan }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const speichern = usePlanSpeichern(propertyId, plan.date)
  const vorschlag = usePlanVorschlag(propertyId, plan.date)
  const [entwurf, setEntwurf] = useState<Entwurf>(() => entwurfAus(plan))
  const faellig = plan.rooms.filter(z => artVon(z) !== null)

  // Wer heute arbeitet: wer schon Zimmer hat, sonst alle mit der Rolle.
  const [heute, setHeute] = useState<Set<number>>(() => {
    const geplant = new Set(faellig.flatMap(z => z.assignedTo ?? []))
    return geplant.size > 0 ? geplant
      : new Set(plan.staff.filter(k => k.active).map(k => k.userId))
  })

  const geaendert = faellig.some(z => entwurf.get(zielVon(z)) !== z.assignedTo)
  const last = useMemo(() => {
    const m = new Map<number, { rooms: number; minutes: number }>()
    for (const z of faellig) {
      const k = entwurf.get(zielVon(z))
      if (k === null || k === undefined) continue
      const l = m.get(k) ?? { rooms: 0, minutes: 0 }
      m.set(k, { rooms: l.rooms + 1, minutes: l.minutes + z.minutes })
    }
    return m
  }, [entwurf, faellig])
  const offen = faellig.filter(z => (entwurf.get(zielVon(z)) ?? null) === null).length

  const zuteilen = (ziel: string, kraft: number | null): void =>
    setEntwurf(alt => new Map(alt).set(ziel, kraft))
  const mehrereHaeuser = plan.houses.length > 1
  const hausName = (id: number): string => plan.houses.find(h => h.id === id)?.name ?? ''

  const vorschlagen = (): void => {
    vorschlag.mutate([...heute], {
      onSuccess: r => setEntwurf(alt => {
        const neu = new Map(alt)
        for (const a of r.assignments) neu.set(zielVon(a), a.assignedTo)
        return neu
      })
    })
  }

  const sichern = (): void => {
    const liste: Zuteilung[] = faellig.map(z => ({
      ...(z.areaId !== null ? { areaId: z.areaId } : { resourceId: z.resourceId! }),
      kind: artVon(z)!, assignedTo: entwurf.get(zielVon(z)) ?? null
    }))
    speichern.mutate(liste)
  }

  const kraefte = plan.staff
  const name = (id: number | null): string =>
    kraefte.find(k => k.userId === id)?.displayName ?? '–'

  return <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
    <aside className="space-y-2">
      <h2 className="text-sm font-semibold">{t('cleaningPlan.staff')}</h2>
      {kraefte.length === 0 && (
        <p className="text-sm text-neutral-600">{t('cleaningPlan.noStaff')}</p>
      )}
      <ul className="space-y-1">
        {kraefte.map(k => {
          const l = last.get(k.userId) ?? { rooms: 0, minutes: 0 }
          return <li key={k.userId}>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" disabled={!k.active}
                     checked={heute.has(k.userId)}
                     onChange={e => setHeute(alt => {
                       const neu = new Set(alt)
                       if (e.target.checked) neu.add(k.userId); else neu.delete(k.userId)
                       return neu
                     })} />
              <span>
                <span className="block">{k.displayName}</span>
                <span className="block text-xs text-neutral-500">
                  {k.active ? t('cleaningPlan.load', { rooms: l.rooms, minutes: l.minutes })
                            : t('cleaningPlan.inactive')}
                </span>
                {k.elsewhere.map(a => (
                  <span key={a.propertyId} className="block text-xs text-neutral-500">
                    {t('cleaningPlan.elsewhere', { house: a.propertyName, rooms: a.rooms,
                                                   minutes: a.minutes })}
                  </span>
                ))}
              </span>
            </label>
          </li>
        })}
      </ul>
      <button type="button" onClick={vorschlagen}
              disabled={!online || heute.size === 0 || faellig.length === 0
                        || vorschlag.isPending}
              className="w-full text-sm px-3 py-1.5 rounded-sm border border-neutral-300
                         bg-white hover:bg-neutral-50 disabled:opacity-40">
        {t(vorschlag.isPending ? 'common.loading' : 'cleaningPlan.suggest')}
      </button>
      <p className="text-xs text-neutral-500">{t('cleaningPlan.suggestHint')}</p>
      {vorschlag.isError && <Fehler error={vorschlag.error} />}
    </aside>

    <section className="space-y-2 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        {offen > 0 && (
          <span className="text-sm text-amber-800">
            {t('cleaningPlan.unassigned', { rooms: offen })}
          </span>
        )}
        <div className="grow" />
        {geaendert && <span className="text-sm text-neutral-500">{t('cleaningPlan.unsaved')}</span>}
        <button type="button" onClick={() => setEntwurf(entwurfAus(plan))}
                disabled={!geaendert}
                className="text-sm px-3 py-1 rounded-sm border border-neutral-300
                           disabled:opacity-40">
          {t('cleaningPlan.discard')}
        </button>
        <button type="button" onClick={sichern}
                disabled={!online || !geaendert || speichern.isPending}
                className="text-sm px-3 py-1 rounded-sm bg-neutral-900 text-white
                           disabled:bg-neutral-300">
          {t(speichern.isPending ? 'common.loading' : 'cleaningPlan.save')}
        </button>
      </div>
      {speichern.isError && <Fehler error={speichern.error} />}

      {faellig.length === 0
        ? <p className="text-sm text-neutral-600">{t('cleaningPlan.nothingDue')}</p>
        : <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-xs text-neutral-500 border-b border-neutral-200">
                <th className="py-1 pr-2 font-normal">{t('cleaningPlan.room')}</th>
                <th className="py-1 pr-2 font-normal">{t('cleaningPlan.due')}</th>
                <th className="py-1 pr-2 font-normal text-right">{t('cleaningPlan.minutes')}</th>
                <th className="py-1 font-normal">{t('cleaningPlan.assignee')}</th>
              </tr>
            </thead>
            <tbody>
              {faellig.map((z, i) => {
                const ziel = zielVon(z)
                const kraft = entwurf.get(ziel) ?? null
                const erledigt = z.taskStatus === 'done'
                const neuesHaus = mehrereHaeuser && faellig[i - 1]?.propertyId !== z.propertyId
                return <Fragment key={ziel}>
                  {neuesHaus && <tr>
                    <th colSpan={4} className="pt-3 pb-1 text-left text-sm font-semibold">
                      {hausName(z.propertyId)}
                    </th>
                  </tr>}
                  <tr className={`border-b border-neutral-100
                                  ${kraft === null ? 'bg-amber-50' : ''}`}>
                  <td className="py-1 pr-2 font-medium">
                    {z.code}
                    {z.building !== null && (
                      <span className="ml-1 text-xs text-neutral-400">{z.building}</span>
                    )}
                  </td>
                  <td className="py-1 pr-2">
                    {t(z.areaId !== null ? 'cleaningPlan.area'
                       : artVon(z) === 'departure' ? 'cleaningPlan.departure'
                       : 'cleaningPlan.stayover')}
                    {z.departureCheckedOut && (
                      <span className="ml-1 text-xs text-emerald-700">
                        {t('cleaningPlan.checkedOut')}
                      </span>
                    )}
                    {z.arrivalToday && (
                      <span className="ml-1 text-xs text-blue-700">{t('cleaningPlan.arrival')}</span>
                    )}
                    {z.waived && (
                      <span className="ml-1 text-xs text-amber-700">{t('cleaningPlan.waived')}</span>
                    )}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {z.minutes}
                    {z.source === 'legacy' && (
                      <span className="ml-1 text-xs text-neutral-400">{t('cleaningPlan.legacy')}</span>
                    )}
                  </td>
                  <td className="py-1">
                    {erledigt
                      ? <span>{name(kraft)} · <span className="text-emerald-700">
                          {t('cleaningPlan.done')}</span></span>
                      : <select value={kraft ?? ''}
                                onChange={e => zuteilen(ziel,
                                  e.target.value === '' ? null : Number(e.target.value))}
                                className="border border-neutral-300 rounded-sm px-1 py-0.5
                                           bg-white max-w-full">
                          <option value="">{t('cleaningPlan.nobody')}</option>
                          {kraefte.filter(k => k.active || k.userId === kraft).map(k => (
                            <option key={k.userId} value={k.userId}>{k.displayName}</option>
                          ))}
                        </select>}
                  </td>
                </tr>
                </Fragment>
              })}
            </tbody>
          </table>}
    </section>
  </div>
}

/**
 * Die Sollminuten: Haus, je Kategorie, einzelne Zimmer. Ein leeres Feld ist
 * "nicht eingetragen" und faellt auf die naechste Stufe -- nicht 0, denn
 * 0 Minuten ist ein gueltiger Wert (ein Zimmer, das nur gelueftet wird).
 */
function Sollminuten({ propertyId, plan }: { propertyId: number; plan: Plan }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const sichern = useSollminutenSpeichern(propertyId)
  const [offen, setOffen] = useState(false)
  const [werte, setWerte] = useState<Map<string, string>>(() => new Map(
    plan.norms.map(n => [`${n.kind}/${n.categoryId ?? ''}/${n.resourceId ?? ''}`,
                         String(n.minutes)])))
  const [neuesZimmer, setNeuesZimmer] = useState('')
  useEffect(() => { if (sichern.isSuccess) setOffen(false) }, [sichern.isSuccess])

  // Sollminuten sind eine Einstellung je Haus: nur die eigenen Zimmer, ohne
  // Bereiche (die tragen ihre Minuten selbst).
  const eigene = plan.rooms.filter(z => z.propertyId === propertyId && z.resourceId !== null)
  const kategorien = [...new Map(eigene.map(z => [z.categoryId!, z.categoryCode!]))]
  const zimmerMitWert = [...new Set([...werte.keys()]
    .map(k => k.split('/')[2]!).filter(r => r !== ''))].map(Number)
  const feld = (kind: ReinigungsArt, cat: number | null, room: number | null): JSX.Element => {
    const k = `${kind}/${cat ?? ''}/${room ?? ''}`
    return <input type="number" min={0} max={480} inputMode="numeric"
                  value={werte.get(k) ?? ''}
                  placeholder={cat === null && room === null
                    ? t('cleaningPlan.normDefault', { minutes: plan.defaults[kind] }) : ''}
                  onChange={e => setWerte(alt => new Map(alt).set(k, e.target.value))}
                  className="w-32 border border-neutral-300 rounded-sm px-1 py-0.5 text-right" />
  }

  const speichern = (): void => {
    const norms: Sollminute[] = []
    for (const [k, v] of werte) {
      if (v.trim() === '') continue
      const [kind, cat, room] = k.split('/')
      norms.push({ kind: kind as ReinigungsArt, categoryId: cat === '' ? null : Number(cat),
                   resourceId: room === '' ? null : Number(room), minutes: Number(v) })
    }
    sichern.mutate(norms)
  }

  return <details open={offen} onToggle={e => setOffen((e.target as HTMLDetailsElement).open)}
                  className="border border-neutral-200 rounded-sm bg-white">
    <summary className="px-3 py-2 text-sm font-semibold cursor-pointer">
      {t('cleaningPlan.norms')}
    </summary>
    <div className="px-3 pb-3 space-y-3">
      <p className="text-xs text-neutral-600">{t('cleaningPlan.normsHint')}</p>
      <table className="text-sm">
        <thead>
          <tr className="text-left text-xs text-neutral-500">
            <th className="pr-3 font-normal" />
            <th className="pr-3 font-normal">{t('cleaningPlan.departure')}</th>
            <th className="font-normal">{t('cleaningPlan.stayover')}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="pr-3 py-0.5">{t('cleaningPlan.normProperty')}</td>
            <td className="pr-3">{feld('departure', null, null)}</td>
            <td>{feld('stayover', null, null)}</td>
          </tr>
          {kategorien.map(([id, code]) => (
            <tr key={id}>
              <td className="pr-3 py-0.5">{code}</td>
              <td className="pr-3">{feld('departure', id, null)}</td>
              <td>{feld('stayover', id, null)}</td>
            </tr>
          ))}
          {zimmerMitWert.map(id => (
            <tr key={`z${id}`}>
              <td className="pr-3 py-0.5">
                {t('cleaningPlan.room')} {eigene.find(z => z.resourceId === id)?.code ?? id}
              </td>
              <td className="pr-3">{feld('departure', null, id)}</td>
              <td>{feld('stayover', null, id)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-neutral-600">{t('cleaningPlan.normRooms')}</span>
        <select value={neuesZimmer} onChange={e => setNeuesZimmer(e.target.value)}
                className="border border-neutral-300 rounded-sm px-1 py-0.5 bg-white">
          <option value="" />
          {eigene.filter(z => !zimmerMitWert.includes(z.resourceId!)).map(z => (
            <option key={z.resourceId} value={z.resourceId!}>{z.code}</option>
          ))}
        </select>
        <button type="button" disabled={neuesZimmer === ''}
                onClick={() => {
                  setWerte(alt => new Map(alt).set(`departure//${neuesZimmer}`, ''))
                  setNeuesZimmer('')
                }}
                className="px-2 py-0.5 rounded-sm border border-neutral-300 disabled:opacity-40">
          {t('cleaningPlan.normAddRoom')}
        </button>
      </div>
      {sichern.isError && <Fehler error={sichern.error} />}
      <button type="button" onClick={speichern} disabled={!online || sichern.isPending}
              className="text-sm px-3 py-1 rounded-sm bg-neutral-900 text-white
                         disabled:bg-neutral-300">
        {t(sichern.isPending ? 'common.loading' : 'cleaningPlan.normSave')}
      </button>
    </div>
  </details>
}

/**
 * Reinigungsbereiche (0116): was gereinigt wird, aber kein Zimmer ist. Die
 * Liste ist der ganze Stand; ein Bereich wird abgeschaltet, nicht
 * geloescht -- an alten Aufgaben haengen abgerechnete Minuten.
 */
type BereichEntwurf = { id: number | null; code: string; building: string; minutes: string
                        active: boolean }

function Bereiche({ propertyId, bereiche }: {
  propertyId: number; bereiche: Bereich[]
}): JSX.Element {
  const t = useT()
  const online = useOnline()
  const sichern = useBereicheSpeichern(propertyId)
  const [zeilen, setZeilen] = useState<BereichEntwurf[]>(() => bereiche.map(b => ({
    id: b.id, code: b.code, building: b.building ?? '', minutes: String(b.minutes),
    active: b.active })))
  const aendern = (i: number, teil: Partial<BereichEntwurf>): void =>
    setZeilen(alt => alt.map((z, j) => j === i ? { ...z, ...teil } : z))
  const speichern = (): void => {
    sichern.mutate(zeilen.filter(z => z.code.trim() !== '').map(z => ({
      id: z.id, code: z.code.trim(), building: z.building.trim() === '' ? null : z.building.trim(),
      minutes: Number(z.minutes), active: z.active })))
  }
  const feld = 'border border-neutral-300 rounded-sm px-1 py-0.5'
  return <details className="border border-neutral-200 rounded-sm bg-white">
    <summary className="px-3 py-2 text-sm font-semibold cursor-pointer">
      {t('cleaningPlan.areas')}
    </summary>
    <div className="px-3 pb-3 space-y-2 text-sm">
      <p className="text-xs text-neutral-600">{t('cleaningPlan.areasHint')}</p>
      {zeilen.length > 0 && <table className="text-sm">
        <thead>
          <tr className="text-left text-xs text-neutral-500">
            <th className="pr-2 font-normal">{t('cleaningPlan.areaCode')}</th>
            <th className="pr-2 font-normal">{t('cleaningPlan.areaBuilding')}</th>
            <th className="pr-2 font-normal">{t('cleaningPlan.minutes')}</th>
            <th className="font-normal" />
          </tr>
        </thead>
        <tbody>
          {zeilen.map((z, i) => <tr key={z.id ?? `neu${i}`}>
            <td className="pr-2 py-0.5">
              <input value={z.code} maxLength={20} onChange={e => aendern(i, { code: e.target.value })}
                     className={`w-28 ${feld}`} />
            </td>
            <td className="pr-2">
              <input value={z.building} maxLength={40}
                     onChange={e => aendern(i, { building: e.target.value })}
                     className={`w-28 ${feld}`} />
            </td>
            <td className="pr-2">
              <input type="number" min={0} max={480} inputMode="numeric" value={z.minutes}
                     onChange={e => aendern(i, { minutes: e.target.value })}
                     className={`w-20 text-right ${feld}`} />
            </td>
            <td>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={z.active}
                       onChange={e => aendern(i, { active: e.target.checked })} />
                {t('cleaningPlan.areaActive')}
              </label>
            </td>
          </tr>)}
        </tbody>
      </table>}
      <div className="flex flex-wrap gap-2">
        <button type="button"
                onClick={() => setZeilen(alt => [...alt,
                  { id: null, code: '', building: '', minutes: '20', active: true }])}
                className="px-2 py-0.5 rounded-sm border border-neutral-300">
          {t('cleaningPlan.areaAdd')}
        </button>
        <button type="button" onClick={speichern} disabled={!online || sichern.isPending}
                className="px-3 py-0.5 rounded-sm bg-neutral-900 text-white disabled:bg-neutral-300">
          {t(sichern.isPending ? 'common.loading' : 'cleaningPlan.areaSave')}
        </button>
      </div>
      {sichern.isError && <Fehler error={sichern.error} />}
    </div>
  </details>
}

/**
 * Gemeinsam oder je Haus (0116). Eine Einstellung des Betriebs; nur wer
 * den Betrieb verwaltet, sieht sie. Hier und nicht in den Einstellungen:
 * sie aendert, was dieser Bildschirm zeigt.
 */
function Gemeinsam({ propertyId }: { propertyId: number }): JSX.Element | null {
  const t = useT()
  const { darf } = useHausrechte(propertyId)
  const verwalten = darf('settings:account')
  const q = usePersonalGemeinsam(propertyId, verwalten)
  const sichern = usePersonalGemeinsamSpeichern(propertyId)
  if (!verwalten) return null
  return <details className="border border-neutral-200 rounded-sm bg-white">
    <summary className="px-3 py-2 text-sm font-semibold cursor-pointer">
      {t('cleaningPlan.shared')}
    </summary>
    <div className="px-3 pb-3 space-y-2 text-sm">
      {q.data === undefined ? (q.isError ? <Fehler error={q.error} /> : <Laedt />) : <>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={q.data.shared} disabled={sichern.isPending}
                 onChange={e => sichern.mutate(e.currentTarget.checked)} />
          {t('cleaningPlan.sharedToggle')}
        </label>
        <p className="text-xs text-neutral-600">
          {t(q.data.shared ? 'cleaningPlan.sharedOn' : 'cleaningPlan.sharedOff')}
        </p>
      </>}
      {sichern.isError && <Fehler error={sichern.error} />}
    </div>
  </details>
}

/**
 * Reinigungsverzicht (0115): ob Gaeste auf die Zwischenreinigung verzichten
 * koennen, und ob es dafuer Wasser gibt. Hier und nicht in den
 * Einstellungen des Hauses: die Hausdame entscheidet es, und sie sieht im
 * Plan darueber, was der Schalter bewirkt.
 */
function VerzichtEinstellung({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const q = useCleaningWaiverSettings(propertyId)
  const sichern = useSaveCleaningWaiverSettings(propertyId)
  const e = q.data
  return <details className="border border-neutral-200 rounded-sm bg-white">
    <summary className="px-3 py-2 text-sm font-semibold cursor-pointer">
      {t('cleaningPlan.waiver')}
    </summary>
    <div className="px-3 pb-3 space-y-2 text-sm">
      <p className="text-xs text-neutral-600">{t('cleaningPlan.waiverHint')}</p>
      {e === undefined ? (q.isError ? <Fehler error={q.error} /> : <Laedt />) : <>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={e.enabled} disabled={sichern.isPending}
                 onChange={x => sichern.mutate({ ...e, enabled: x.currentTarget.checked })} />
          {t('cleaningPlan.waiverEnabled')}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={e.waterGift} disabled={sichern.isPending || !e.enabled}
                 onChange={x => sichern.mutate({ ...e, waterGift: x.currentTarget.checked })} />
          {t('cleaningPlan.waiverWater')}
        </label>
      </>}
      {sichern.isError && <Fehler error={sichern.error} />}
    </div>
  </details>
}

function Verlauf({ plan }: { plan: Plan }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const name = (id: number | null): string =>
    id === null ? t('cleaningPlan.nobody')
      : plan.staff.find(k => k.userId === id)?.displayName ?? `#${id}`
  const uhr = new Intl.DateTimeFormat(intlTag(locale), { hour: '2-digit', minute: '2-digit' })

  const satz = (e: Plan['log'][number]): string => {
    const room = e.roomCode ?? '?'
    if (e.action === 'created') return t('cleaningPlan.logCreated', { room, to: name(e.assignedTo) })
    if (e.action === 'deleted') return t('cleaningPlan.logDeleted', { room })
    if (e.assignedFrom !== e.assignedTo) {
      return t('cleaningPlan.logMoved', { room, from: name(e.assignedFrom), to: name(e.assignedTo) })
    }
    if (e.minutesFrom !== e.minutesTo) {
      return t('cleaningPlan.logMinutes', { room, from: e.minutesFrom ?? 0, to: e.minutesTo ?? 0 })
    }
    return t('cleaningPlan.logStatus', { room, from: e.statusFrom ?? '', to: e.statusTo ?? '' })
  }

  return <details className="border border-neutral-200 rounded-sm bg-white">
    <summary className="px-3 py-2 text-sm font-semibold cursor-pointer">
      {t('cleaningPlan.log')}
    </summary>
    <div className="px-3 pb-3">
      {plan.log.length === 0
        ? <p className="text-sm text-neutral-600">{t('cleaningPlan.logEmpty')}</p>
        : <ul className="text-sm space-y-0.5">
            {plan.log.map(e => (
              <li key={e.id} className="flex gap-3">
                <span className="text-neutral-500 tabular-nums shrink-0">
                  {t('cleaningPlan.logBy', { zeit: uhr.format(new Date(e.changedAt)),
                                             wer: e.changedBy ?? '–' })}
                </span>
                <span>{satz(e)}</span>
              </li>
            ))}
          </ul>}
    </div>
  </details>
}
