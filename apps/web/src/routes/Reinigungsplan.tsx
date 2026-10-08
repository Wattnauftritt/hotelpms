import { useEffect, useMemo, useState, type DragEvent } from 'react'
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

/** Minuten als Stunden, wie die Hausdame sie liest: 330 → "5:30". */
export const stunden = (minuten: number): string =>
  `${Math.floor(minuten / 60)}:${String(minuten % 60).padStart(2, '0')}`

/**
 * Was ein Zimmer einer Kraft einbringt. Ein nicht gereinigtes (Gast hat
 * abgelehnt, war sauber) zaehlt nicht: abgerechnet wird nur, was gereinigt
 * ist (`outcome = 'cleaned'`), und die Karte soll dieselbe Zahl zeigen.
 * Ebenso ein offenes Zimmer, dessen Gast heute verzichtet: es ist gesperrt,
 * auch wenn es schon zugeteilt war (Sven, 08.10.2026).
 */
const gesperrt = (z: PlanZimmer): boolean => z.waived && z.taskStatus !== 'done'
const zaehlt = (z: PlanZimmer): number =>
  z.taskStatus === 'skipped' || gesperrt(z) ? 0 : z.minutes

export interface KraftSumme {
  abreisen: number; abreiseMinuten: number; bleiber: number; bleiberMinuten: number
}

/** Je Kraft Abreisen und Bleiber, nach Zahl und Minuten. */
export function summen(
  faellig: readonly PlanZimmer[], entwurf: ReadonlyMap<string, number | null>
): Map<number, KraftSumme> {
  const m = new Map<number, KraftSumme>()
  for (const z of faellig) {
    const k = entwurf.get(zielVon(z))
    if (k === null || k === undefined || gesperrt(z)) continue
    const s = m.get(k) ?? { abreisen: 0, abreiseMinuten: 0, bleiber: 0, bleiberMinuten: 0 }
    if (artVon(z) === 'departure') { s.abreisen++; s.abreiseMinuten += zaehlt(z) }
    else { s.bleiber++; s.bleiberMinuten += zaehlt(z) }
    m.set(k, s)
  }
  return m
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

/**
 * Der Tagesplan als Brett, wie der Putzplan der alten App (Sven,
 * 08.10.2026: "die Planung ist sehr unuebersichtlich"). Oben liegen die
 * offenen Zimmer als Chips, Abreisen rot, Bleiber blau -- die Farbe sagt,
 * welche Reinigung ein Zimmer bekommt. Darunter steht je Kraft eine Karte
 * mit ihren Abreisen und Bleibern und den Summen; dieselbe Karte ist nach
 * dem Speichern der fertige Plan, mit Haken an dem, was erledigt ist.
 *
 * Zwei Wege, ein Zimmer zu verteilen: eine Kraft antippen und dann Zimmer
 * antippen (am Tablet, wo Ziehen nicht geht), oder ein Zimmer auf eine
 * Karte ziehen. Ein Zimmer in einer Karte antippen legt es zurueck, oder
 * zur ausgewaehlten Kraft, wenn eine andere ausgewaehlt ist.
 */
function Tagesplan({ propertyId, plan }: { propertyId: number; plan: Plan }): JSX.Element {
  const t = useT()
  const online = useOnline()
  const speichern = usePlanSpeichern(propertyId, plan.date)
  const vorschlag = usePlanVorschlag(propertyId, plan.date)
  const [entwurf, setEntwurf] = useState<Entwurf>(() => entwurfAus(plan))
  const [gewaehlt, setGewaehlt] = useState<number | null>(null)
  const faellig = plan.rooms.filter(z => artVon(z) !== null)

  // Wer heute arbeitet: wer schon Zimmer hat, sonst alle mit der Rolle.
  const [heute, setHeute] = useState<Set<number>>(() => {
    const geplant = new Set(faellig.flatMap(z => z.assignedTo ?? []))
    return geplant.size > 0 ? geplant
      : new Set(plan.staff.filter(k => k.active).map(k => k.userId))
  })

  // Auch ohne Umteilung ungespeichert: eine Art, die der Kalender seit dem
  // Speichern geaendert hat, steht noch nicht an der Aufgabe.
  const geaendert = faellig.some(z => entwurf.get(zielVon(z)) !== z.assignedTo || z.kindChanged)
  const last = useMemo(() => summen(faellig, entwurf), [entwurf, faellig])
  const kraftVon = (z: PlanZimmer): number | null => entwurf.get(zielVon(z)) ?? null
  const offen = faellig.filter(z => kraftVon(z) === null)

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

  // Karten: wer im Dienst ist, und wer schon Zimmer hat, auch ohne Haken.
  const karten = plan.staff.filter(k =>
    heute.has(k.userId) || faellig.some(z => kraftVon(z) === k.userId))

  const fallen = (e: DragEvent, kraft: number | null): void => {
    e.preventDefault()
    const ziel = e.dataTransfer.getData('text/plain')
    if (faellig.some(z => zielVon(z) === ziel && z.taskStatus !== 'done')) zuteilen(ziel, kraft)
  }
  const zulassen = (e: DragEvent): void => { e.preventDefault() }

  const chip = (z: PlanZimmer, imPool: boolean): JSX.Element => {
    const ziel = zielVon(z)
    const art = artVon(z)
    const erledigt = z.taskStatus === 'done'
    const ausgelassen = z.taskStatus === 'skipped'
    const verzicht = gesperrt(z)
    // Mit Wasser bleibt das Zimmer zuteilbar: die Flasche muss jemand
    // hinstellen. Ohne ist es gesperrt.
    const fest = erledigt || ausgelassen || (verzicht && !z.water)
    const farbe = verzicht ? 'border-red-700 bg-red-600 text-white line-through'
      : erledigt ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
      : ausgelassen ? 'border-neutral-300 bg-neutral-50 text-neutral-500'
      : art === 'departure' ? 'border-red-300 bg-red-50 text-red-800 hover:bg-red-100'
      : 'border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100'
    const titel = [
      mehrereHaeuser ? hausName(z.propertyId) : null,
      t(z.areaId !== null ? 'cleaningPlan.area'
        : art === 'departure' ? 'cleaningPlan.departure' : 'cleaningPlan.stayover'),
      z.departureCheckedOut ? t('cleaningPlan.checkedOut') : null,
      z.arrivalToday ? t('cleaningPlan.arrival') : null,
      z.waived ? t('cleaningPlan.waived') : null,
      z.kindChanged ? t('cleaningPlan.kindChanged') : null,
      erledigt ? t('cleaningPlan.done') : null,
      ausgelassen ? t('cleaningPlan.skipped') : null,
      z.source === 'legacy' ? t('cleaningPlan.legacy') : null
    ].filter(x => x !== null).join(' · ')
    const antippen = (): void => {
      if (fest) return
      if (imPool) { if (gewaehlt !== null) zuteilen(ziel, gewaehlt); return }
      zuteilen(ziel, gewaehlt !== null && gewaehlt !== kraftVon(z) ? gewaehlt : null)
    }
    return <button key={ziel} type="button" title={titel} aria-label={`${z.code}, ${titel}`}
                   draggable={!fest}
                   onDragStart={e => { e.dataTransfer.setData('text/plain', ziel) }}
                   onClick={antippen}
                   className={`inline-flex items-baseline gap-1 min-w-[3.25rem] justify-center
                               px-2 py-1 rounded-sm border text-sm font-medium tabular-nums
                               ${farbe} ${fest ? 'cursor-default' : 'cursor-pointer'}`}>
      {z.code}
      {z.departureCheckedOut && !fest && <span aria-hidden className="text-[0.6rem]">●</span>}
      {z.arrivalToday && !fest && <span aria-hidden className="text-xs">↘</span>}
      {z.kindChanged && <span aria-hidden className="text-xs font-bold">!</span>}
      {erledigt && <span aria-hidden>✓</span>}
      {(ausgelassen || verzicht) && <span aria-hidden>⊘</span>}
      {!imPool && <span className="text-[0.65rem] font-normal opacity-70">{zaehlt(z)}′</span>}
    </button>
  }

  // Chips nach Haus gruppiert, wenn der Plan mehrere Haeuser traegt.
  const gruppiert = (liste: PlanZimmer[]): JSX.Element[] => {
    if (!mehrereHaeuser) return liste.map(z => chip(z, true))
    return plan.houses.flatMap(h => {
      const im = liste.filter(z => z.propertyId === h.id)
      if (im.length === 0) return []
      return [<div key={h.id} className="w-full flex flex-wrap gap-1.5 items-center">
        <span className="w-full text-xs text-neutral-500">{h.name}</span>
        {im.map(z => chip(z, true))}
      </div>]
    })
  }

  const pool = (art: ReinigungsArt): JSX.Element => {
    const liste = offen.filter(z => artVon(z) === art)
    const rot = art === 'departure'
    return <div onDragOver={zulassen} onDrop={e => fallen(e, null)}
                className={`rounded-sm border border-dashed p-2 min-h-16
                            ${rot ? 'border-red-300 bg-red-50/40' : 'border-sky-300 bg-sky-50/40'}`}>
      <h3 className={`text-sm font-semibold mb-1.5 ${rot ? 'text-red-800' : 'text-sky-800'}`}>
        {t(rot ? 'cleaningPlan.openDepartures' : 'cleaningPlan.openStayovers')}
        <span className="ml-1 font-normal text-neutral-500">{liste.length}</span>
      </h3>
      {liste.length === 0
        ? <p className="text-xs text-neutral-500">{t('cleaningPlan.poolEmpty')}</p>
        : <div className="flex flex-wrap gap-1.5">{gruppiert(liste)}</div>}
    </div>
  }

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      {offen.length > 0 && (
        <span className="text-sm text-amber-800">
          {t('cleaningPlan.unassigned', { rooms: offen.length })}
        </span>
      )}
      <div className="grow" />
      {geaendert && <span className="text-sm text-neutral-500">{t('cleaningPlan.unsaved')}</span>}
      <button type="button" onClick={vorschlagen}
              disabled={!online || heute.size === 0 || faellig.length === 0
                        || vorschlag.isPending}
              className="text-sm px-3 py-1 rounded-sm border border-neutral-300 bg-white
                         hover:bg-neutral-50 disabled:opacity-40">
        {t(vorschlag.isPending ? 'common.loading' : 'cleaningPlan.suggest')}
      </button>
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
    {vorschlag.isError && <Fehler error={vorschlag.error} />}

    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      <span className="text-neutral-600 mr-1">{t('cleaningPlan.staff')}</span>
      {plan.staff.length === 0 && (
        <span className="text-neutral-600">{t('cleaningPlan.noStaff')}</span>
      )}
      {plan.staff.map(k => (
        <label key={k.userId}
               className={`flex items-center gap-1 px-2 py-0.5 rounded-full border
                           ${heute.has(k.userId) ? 'border-neutral-700 bg-neutral-100'
                                                 : 'border-neutral-300'}
                           ${k.active ? '' : 'opacity-50'}`}
               title={k.active ? undefined : t('cleaningPlan.inactive')}>
          <input type="checkbox" disabled={!k.active} checked={heute.has(k.userId)}
                 onChange={e => setHeute(alt => {
                   const neu = new Set(alt)
                   if (e.target.checked) neu.add(k.userId); else neu.delete(k.userId)
                   return neu
                 })} />
          {k.displayName}
        </label>
      ))}
    </div>
    <p className="text-xs text-neutral-500">{t('cleaningPlan.suggestHint')}</p>

    {faellig.length === 0
      ? <p className="text-sm text-neutral-600">{t('cleaningPlan.nothingDue')}</p>
      : <>
          <div className="grid gap-3 lg:grid-cols-2">
            {pool('departure')}
            {pool('stayover')}
          </div>
          <p className="text-xs text-neutral-500">
            {t('cleaningPlan.boardHint')} {t('cleaningPlan.legend')}
          </p>

          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {karten.map(k => {
              const s = last.get(k.userId)
                ?? { abreisen: 0, abreiseMinuten: 0, bleiber: 0, bleiberMinuten: 0 }
              const meine = faellig.filter(z => kraftVon(z) === k.userId)
              const aktiv = gewaehlt === k.userId
              const reihe = (art: ReinigungsArt): JSX.Element => {
                const liste = meine.filter(z => artVon(z) === art)
                const rot = art === 'departure'
                return <div className={`border-l-2 pl-2 ${rot ? 'border-red-400' : 'border-sky-400'}`}>
                  <div className={`text-xs font-semibold mb-1 ${rot ? 'text-red-800' : 'text-sky-800'}`}>
                    {t(rot ? 'cleaningPlan.departures' : 'cleaningPlan.stayovers')}
                    <span className="ml-1 font-normal text-neutral-500">
                      {t('cleaningPlan.part', {
                        rooms: rot ? s.abreisen : s.bleiber,
                        time: stunden(rot ? s.abreiseMinuten : s.bleiberMinuten) })}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 min-h-8">
                    {liste.map(z => chip(z, false))}
                  </div>
                </div>
              }
              return <section key={k.userId} onDragOver={zulassen}
                              onDrop={e => fallen(e, k.userId)}
                              className={`rounded-sm border bg-white p-3 space-y-2
                                          ${aktiv ? 'border-emerald-500 ring-2 ring-emerald-200'
                                                  : 'border-neutral-200'}`}>
                <button type="button" onClick={() => setGewaehlt(aktiv ? null : k.userId)}
                        aria-pressed={aktiv}
                        className="w-full flex items-center gap-2 text-left">
                  <span className="font-semibold">{k.displayName}</span>
                  {aktiv && <span className="text-xs text-emerald-700">
                    {t('cleaningPlan.selected')}</span>}
                  <span className="grow" />
                  <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-900 text-white
                                   tabular-nums">
                    {t('cleaningPlan.total',
                       { time: stunden(s.abreiseMinuten + s.bleiberMinuten) })}
                  </span>
                </button>
                {k.elsewhere.map(a => (
                  <p key={a.propertyId} className="text-xs text-neutral-500">
                    {t('cleaningPlan.elsewhere', { house: a.propertyName, rooms: a.rooms,
                                                   minutes: a.minutes })}
                  </p>
                ))}
                {meine.length === 0
                  ? <p className="text-sm text-neutral-400 border border-dashed border-neutral-300
                                  rounded-sm py-4 text-center">{t('cleaningPlan.dropHere')}</p>
                  : <>{reihe('departure')}{reihe('stayover')}</>}
              </section>
            })}
          </div>
        </>}
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
  /*
   * "Keine Zwischenreinigung" ist dasselbe wie null Bleiber-Minuten -- so
   * rechnet der Plan schon (`liesZimmer`), und das Gaestehaus der alten App
   * stand genau so fest im Code. Als Haken ist es aber auffindbar (Sven,
   * 08.10.2026: "muss in den Einstellungen auswaehlbar sein").
   */
  const ohneZwischen = (cat: number | null, room: number | null): JSX.Element => {
    const k = `stayover/${cat ?? ''}/${room ?? ''}`
    const an = werte.get(k)?.trim() === '0'
    return <label className="ml-2 inline-flex items-center gap-1 text-xs text-neutral-700">
      <input type="checkbox" checked={an}
             onChange={e => setWerte(alt => new Map(alt).set(k, e.target.checked ? '0' : ''))} />
      {t('cleaningPlan.noStayover')}
    </label>
  }
  const feld = (kind: ReinigungsArt, cat: number | null, room: number | null): JSX.Element => {
    const k = `${kind}/${cat ?? ''}/${room ?? ''}`
    const aus = kind === 'stayover' && werte.get(k)?.trim() === '0'
    if (aus) return ohneZwischen(cat, room)
    return <><input type="number" min={0} max={480} inputMode="numeric"
                  value={werte.get(k) ?? ''}
                  placeholder={cat === null && room === null
                    ? t('cleaningPlan.normDefault', { minutes: plan.defaults[kind] }) : ''}
                  onChange={e => setWerte(alt => new Map(alt).set(k, e.target.value))}
                  className="w-32 border border-neutral-300 rounded-sm px-1 py-0.5 text-right" />
      {kind === 'stayover' && ohneZwischen(cat, room)}</>
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
