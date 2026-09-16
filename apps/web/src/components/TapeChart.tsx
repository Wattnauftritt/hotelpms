import { useMemo, useRef, useState, useEffect, useCallback } from 'react'
import type { TapeChart as TapeChartData } from '@hotelpms/contracts'
import { eachDay, isWeekend, daysBetween, addDays } from '../lib/dates.js'
import { auswahlZeitraum, gruppenAuswahl } from '../lib/tapeSelection.js'
import { useT, useLocale, formatDate, weekdayShort } from '../lib/i18n/index.js'

/**
 * Der Zimmerplan.
 *
 * Er ist der Bildschirm, auf den die Rezeption den ganzen Tag sieht, und
 * deshalb der einzige, bei dem die Darstellung selbst eine fachliche
 * Entscheidung ist:
 *
 * - **Ein Balken je Reservierung, nicht eine Zelle je Nacht.** Ein Aufenthalt
 *   ist eine Sache und wird als eine gelesen. Zellen zu färben sieht aus wie
 *   fünf einzelne Nächte.
 * - **Der Balken endet am Abreisetag, beginnt aber am Anreisetag.** Die
 *   Abreisenacht gibt es nicht; das Zimmer ist an dem Tag ab mittags wieder
 *   frei. Ein Balken, der bis in den Abreisetag hineinreicht, lässt ein
 *   verkäufliches Zimmer belegt aussehen.
 * - **Nicht zugewiesene Reservierungen stehen oben**, nicht unsichtbar unten.
 *   Sie sind die Arbeit des Tages.
 *
 * - **Mehrere Zimmerzeilen zugleich markieren ist eine Gruppenbuchung.**
 *   Nicht acht Buchungen nebeneinander, sondern eine mit acht Zimmern --
 *   genau das, was eine Reisegruppe ist. Die Geste dafür ist Strg (oder ⌘,
 *   oder Umschalt) gedrückt halten und über die Zeilen ziehen; ohne
 *   Modifikator bleibt es beim einen Zimmer, damit sich das gewohnte
 *   Aufziehen nicht ändert.
 *
 * **Erst fragen, dann springen (A2–A4).** Waehrend des Ziehens zeigt ein
 * Schattenbalken die Absicht; der echte Balken bewegt sich erst, wenn die
 * API zugestimmt hat und die Daten neu geladen sind. Schlaegt der Aufruf
 * fehl, ist nichts gesprungen, das nun zurueckspringen muesste -- der
 * Schatten verschwindet einfach, und der Fehler steht im Seitenfenster.
 */

const SPALTE = 44        // Pixel je Tag
const ZEILE = 34
const LABEL_BREITE = 160
/** Ab dieser Bewegung ist es ein Ziehen und kein Klick mehr. */
const KLICK_SCHWELLE = 5

const FARBE: Record<string, string> = {
  Optional: 'bg-status-optional',
  Confirmed: 'bg-status-confirmed',
  InHouse: 'bg-status-inhouse'
}

type ReservationRow = TapeChartData['reservations'][number]

type DragState =
  | { kind: 'create'; resourceId: number; categoryId: number; startDay: number; day: number }
  /** Mehrere Zimmerzeilen zugleich: die Gruppenbuchung. Zeilen als Index,
      nicht als id -- aufgezogen wird über die sichtbare Reihenfolge. */
  | { kind: 'group'; startIndex: number; index: number; startDay: number; day: number }
  | { kind: 'move'; reservationRef: string; arrival: string; departure: string
      pointerDownX: number; pointerDownY: number; overResourceId: number | null
      moved: boolean }
  | { kind: 'resize'; reservationRef: string; resourceId: number; edge: 'start' | 'end'
      arrival: string; departure: string; day: number }

interface Props {
  data: TapeChartData
  onSelect?: (reservationRef: string) => void
  /** Im leeren Bereich aufgezogen: Vorschlag fuer eine neue Buchung (A2). */
  onCreate?: (sel: {
    resourceId: number; categoryId: number; arrival: string; departure: string
  }) => void
  /**
   * Über mehrere Zimmerzeilen aufgezogen: eine Buchung mit mehreren
   * Zimmern. Die Zimmer kommen in der Reihenfolge des Plans.
   */
  onCreateGroup?: (sel: {
    rooms: Array<{ resourceId: number; categoryId: number }>
    arrival: string; departure: string
  }) => void
  /** Balken auf eine andere Zimmerzeile gezogen (A3). */
  onMove?: (reservationRef: string, resourceId: number) => void
  /** Balkenrand gezogen (A4). */
  onChangeStay?: (reservationRef: string, arrival: string, departure: string) => void
}

export function TapeChart({ data, onSelect, onCreate, onCreateGroup, onMove,
                            onChangeStay }: Props): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const tage = useMemo(() => eachDay(data.from, data.to), [data.from, data.to])
  const rasterRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  // Der aktuelle Zustand, synchron lesbar in den Fensterereignissen -- die
  // koennen nicht auf den naechsten Render warten wie `drag` selbst.
  const dragRef = useRef<DragState | null>(null)
  const setDragState = (d: DragState | null): void => { dragRef.current = d; setDrag(d) }

  const nichtZugewiesen = useMemo(
    () => data.reservations.filter(r => r.resource_id === null),
    [data.reservations])

  const jeZimmer = useMemo(() => {
    const m = new Map<number, typeof data.reservations>()
    for (const r of data.reservations) {
      if (r.resource_id === null) continue
      const liste = m.get(r.resource_id)
      if (liste) liste.push(r); else m.set(r.resource_id, [r])
    }
    return m
  }, [data.reservations])

  /**
   * Welche Zeile ist das sechste Zimmer? Für die Mehrfachauswahl wird über
   * Zeilen aufgezogen, und der Bereich dazwischen ergibt sich nur aus der
   * sichtbaren Reihenfolge, nicht aus den ids.
   */
  const zeileVonZimmer = useMemo(
    () => new Map(data.units.map((u, i) => [u.id, i])),
    [data.units])

  const blockeJeZimmer = useMemo(() => {
    const m = new Map<number, typeof data.blocks>()
    for (const b of data.blocks) {
      const liste = m.get(b.resource_id)
      if (liste) liste.push(b); else m.set(b.resource_id, [b])
    }
    return m
  }, [data.blocks])

  /** Wo im Raster liegt ein Zeitraum, auf den sichtbaren Ausschnitt beschnitten. */
  const balken = useCallback((von: string, bis: string) => {
    const start = Math.max(0, daysBetween(data.from, von))
    const ende = Math.min(tage.length, daysBetween(data.from, bis))
    return { left: start * SPALTE, width: Math.max(ende - start, 0) * SPALTE - 4 }
  }, [data.from, tage.length])

  /** Tagesindex unter dem Zeiger, auf den sichtbaren Ausschnitt begrenzt. */
  const tagUnter = useCallback((clientX: number): number => {
    const rect = rasterRef.current?.getBoundingClientRect()
    if (!rect) return 0
    const x = clientX - rect.left - LABEL_BREITE
    return Math.max(0, Math.min(tage.length - 1, Math.floor(x / SPALTE)))
  }, [tage.length])

  useEffect(() => {
    if (drag === null) return
    const aufBewegung = (e: PointerEvent): void => {
      const d = dragRef.current
      if (d === null) return
      if (d.kind === 'create') {
        setDragState({ ...d, day: tagUnter(e.clientX) })
        return
      }
      if (d.kind === 'resize') {
        setDragState({ ...d, day: tagUnter(e.clientX) })
        return
      }
      if (d.kind === 'group') {
        const zeile = document.elementFromPoint(e.clientX, e.clientY)
          ?.closest<HTMLElement>('[data-resource-row]')
        const ueber = zeile ? zeileVonZimmer.get(Number(zeile.dataset.resourceRow)) : undefined
        // Über dem Rand des Plans bleibt die zuletzt getroffene Zeile
        // stehen: die Auswahl soll nicht zusammenschnappen, nur weil der
        // Zeiger kurz über der Kopfzeile war.
        setDragState({ ...d, day: tagUnter(e.clientX), index: ueber ?? d.index })
        return
      }
      // move: welche Zimmerzeile liegt gerade unter dem Zeiger.
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const zeile = el?.closest<HTMLElement>('[data-resource-row]')
      const ueber = zeile ? Number(zeile.dataset.resourceRow) : null
      const bewegt = d.moved
        || Math.abs(e.clientX - d.pointerDownX) > KLICK_SCHWELLE
        || Math.abs(e.clientY - d.pointerDownY) > KLICK_SCHWELLE
      setDragState({ ...d, overResourceId: ueber, moved: bewegt })
    }
    // Die Aufrufe an `onCreate`/`onMove`/`onSelect`/`onChangeStay` loesen bei
    // den Elternkomponenten selbst wieder `setState` aus. Das darf nicht
    // innerhalb eines `setDrag`-Updaters stehen -- React haelt Updater fuer
    // rein und meldet sonst "Cannot update a component while rendering a
    // different component". Deshalb erst der (reine) Zustandswechsel, dann,
    // als eigene Anweisung im Ereignis, die Seiteneffekte.
    const aufLoslassen = (): void => {
      const d = dragRef.current
      setDragState(null)
      if (d === null) return
      if (d.kind === 'create') {
        onCreate?.({
          resourceId: d.resourceId, categoryId: d.categoryId,
          ...auswahlZeitraum(tage, d.startDay, d.day)
        })
      } else if (d.kind === 'group') {
        onCreateGroup?.(gruppenAuswahl(data.units, tage, d))
      } else if (d.kind === 'move') {
        if (d.moved && d.overResourceId !== null) onMove?.(d.reservationRef, d.overResourceId)
        else if (!d.moved) onSelect?.(d.reservationRef)
      } else if (d.kind === 'resize') {
        const neuerTag = tage[d.day] ?? d.arrival
        if (d.edge === 'start') {
          if (neuerTag < d.departure) onChangeStay?.(d.reservationRef, neuerTag, d.departure)
        } else {
          const abreise = addDays(neuerTag, 1)
          if (abreise > d.arrival) onChangeStay?.(d.reservationRef, d.arrival, abreise)
        }
      }
    }
    window.addEventListener('pointermove', aufBewegung)
    window.addEventListener('pointerup', aufLoslassen)
    return () => {
      window.removeEventListener('pointermove', aufBewegung)
      window.removeEventListener('pointerup', aufLoslassen)
    }
    // Bewusst nur an- und abgeklemmt, wenn ein Ziehen beginnt oder endet: die
    // Griffe innerhalb dieser Geste (ein paar hundert Millisekunden) aendern
    // sich nicht, ein Neuverdrahten bei jeder Bewegung waere teuer und
    // unnoetig.
  }, [drag !== null])

  /**
   * Der Schattenbalken. Eine Menge von Zeilen, nicht eine: bei der
   * Mehrfachauswahl liegt in jeder markierten Zeile einer.
   */
  const ghost = useMemo((): {
    resourceIds: Set<number>; left: number; width: number
    /** Zeile, an der die Anzahl steht. Nur bei der Mehrfachauswahl gesetzt. */
    zaehlerAn?: number
  } | null => {
    if (drag === null) return null
    if (drag.kind === 'create') {
      const von = Math.min(drag.startDay, drag.day)
      const bis = Math.max(drag.startDay, drag.day)
      return { resourceIds: new Set([drag.resourceId]),
               left: von * SPALTE, width: (bis - von + 1) * SPALTE - 4 }
    }
    if (drag.kind === 'group') {
      const von = Math.min(drag.startDay, drag.day)
      const bis = Math.max(drag.startDay, drag.day)
      const vonZeile = Math.min(drag.startIndex, drag.index)
      const bisZeile = Math.max(drag.startIndex, drag.index)
      const zeilen = data.units.slice(vonZeile, bisZeile + 1)
      return {
        resourceIds: new Set(zeilen.map(u => u.id)),
        zaehlerAn: zeilen[0]?.id,
        left: von * SPALTE, width: (bis - von + 1) * SPALTE - 4 }
    }
    if (drag.kind === 'resize') {
      const startTag = drag.edge === 'start' ? drag.day : daysBetween(data.from, drag.arrival)
      const endTag = drag.edge === 'end' ? drag.day + 1 : daysBetween(data.from, drag.departure)
      const von = Math.max(0, Math.min(startTag, endTag - 1))
      const bis = Math.max(von + 1, endTag)
      return { resourceIds: new Set([drag.resourceId]),
               left: von * SPALTE, width: (bis - von) * SPALTE - 4 }
    }
    if (drag.moved && drag.overResourceId !== null) {
      const b = balken(drag.arrival, drag.departure)
      return { resourceIds: new Set([drag.overResourceId]), ...b }
    }
    return null
  }, [drag, balken, data.from, data.units])

  const beginneErstellen = (resourceId: number, categoryId: number) => (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    const startDay = tagUnter(e.clientX)
    /*
     * Mit Modifikator wird über Zeilen hinweg aufgezogen, ohne ihn wie
     * bisher nur in dieser einen. Umschalt steht daneben, weil es auf jeder
     * Tastatur dieselbe Taste ist -- Strg und ⌘ sind es nicht, und wer am
     * Mac arbeitet, greift nach beidem.
     */
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      const index = zeileVonZimmer.get(resourceId)
      if (index !== undefined) {
        setDragState({ kind: 'group', startIndex: index, index, startDay, day: startDay })
        return
      }
    }
    setDragState({ kind: 'create', resourceId, categoryId, startDay, day: startDay })
  }

  const beginneVerschieben = (r: ReservationRow) => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragState({ kind: 'move', reservationRef: r.public_ref, arrival: r.arrival, departure: r.departure,
               pointerDownX: e.clientX, pointerDownY: e.clientY, overResourceId: null, moved: false })
  }

  const beginneGroesseAendern = (r: ReservationRow, edge: 'start' | 'end') =>
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragState({ kind: 'resize', reservationRef: r.public_ref, resourceId: r.resource_id!,
                 edge, arrival: r.arrival, departure: r.departure, day: tagUnter(e.clientX) })
    }

  return (
    <div className="overflow-auto border border-neutral-200 rounded" ref={rasterRef}>
      <div style={{ minWidth: LABEL_BREITE + tage.length * SPALTE }}>
        {/* Kopfzeile mit Tagen */}
        <div className="flex sticky top-0 z-20 bg-white border-b border-neutral-200">
          <div className="w-40 shrink-0 px-2 py-1 text-xs font-medium text-neutral-500
                          border-r border-neutral-200">
            {t('common.room')}
          </div>
          {tage.map(d => (
            <div key={d}
                 style={{ width: SPALTE }}
                 className={`shrink-0 text-center text-[11px] leading-tight py-1
                             border-r border-neutral-100
                             ${isWeekend(d) ? 'bg-neutral-50' : ''}`}>
              <div className="text-neutral-400">{weekdayShort(d, locale)}</div>
              <div className="tabular-nums">{d.slice(8)}</div>
            </div>
          ))}
        </div>

        {/* Ohne Zimmer: die Arbeit des Tages, deshalb oben. */}
        {nichtZugewiesen.length > 0 && (
          <div className="flex relative bg-amber-50 border-b border-amber-200"
               style={{ height: ZEILE * Math.min(nichtZugewiesen.length, 4) }}>
            <div className="w-40 shrink-0 px-2 py-1 text-xs text-amber-800
                            border-r border-amber-200">
              {t('today.needsRoom')} ({nichtZugewiesen.length})
            </div>
            <div className="relative grow">
              {nichtZugewiesen.slice(0, 4).map((r, i) => {
                const b = balken(r.arrival, r.departure)
                return (
                  <button key={r.id}
                          onPointerDown={beginneVerschieben(r)}
                          title={`${r.last_name ?? ''} · ${r.public_ref}`}
                          style={{ ...b, top: i * ZEILE + 4, height: ZEILE - 8 }}
                          className={`absolute rounded px-1 text-[11px] text-white
                                      truncate text-left cursor-move
                                      ${FARBE[r.status] ?? 'bg-neutral-400'}`}>
                    {r.last_name ?? r.public_ref}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Eine Zeile je Zimmer */}
        {data.units.map(u => (
          <div key={u.id} className="flex relative border-b border-neutral-100"
               data-resource-row={u.id}
               style={{ height: ZEILE }}>
            <div className="w-40 shrink-0 px-2 py-1 text-xs border-r border-neutral-200
                            flex items-center gap-2">
              <span className="font-medium tabular-nums">{u.code}</span>
              <span className="text-neutral-400 truncate">{u.category_name}</span>
            </div>
            <div className="relative grow cursor-crosshair"
                 onPointerDown={beginneErstellen(u.id, u.category_id)}>
              {tage.map((d, i) => (
                <div key={d}
                     style={{ left: i * SPALTE, width: SPALTE }}
                     className={`absolute inset-y-0 border-r border-neutral-100
                                 pointer-events-none
                                 ${isWeekend(d) ? 'bg-neutral-50' : ''}`} />
              ))}
              {(blockeJeZimmer.get(u.id) ?? []).map((b, i) => (
                <div key={i}
                     style={{ ...balken(b.from_date, b.to_date), top: 4, height: ZEILE - 8 }}
                     title={b.reason}
                     className="absolute rounded bg-status-blocked/60 px-1 text-[11px]
                                text-white truncate
                                [background-image:repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(255,255,255,.35)_4px,rgba(255,255,255,.35)_8px)]">
                  {b.reason}
                </div>
              ))}
              {(jeZimmer.get(u.id) ?? []).map(r => {
                const b = balken(r.arrival, r.departure)
                const versteckt = drag !== null
                  && ((drag.kind === 'move' && drag.reservationRef === r.public_ref && drag.moved)
                      || (drag.kind === 'resize' && drag.reservationRef === r.public_ref))
                return (
                  <button key={r.id}
                          onPointerDown={beginneVerschieben(r)}
                          title={`${r.last_name ?? ''} ${r.first_name ?? ''} · `
                               + `${formatDate(r.arrival, locale)} – `
                               + `${formatDate(r.departure, locale)} · `
                               + `${t(`status.${r.status}` as never)}`
                               + (r.notes ? ` · ${r.notes}` : '')}
                          style={{ ...b, top: 4, height: ZEILE - 8,
                                   opacity: versteckt ? 0.35 : 1 }}
                          /*
                           * `cursor-move` ist hier keine Kosmetik. Das
                           * Verschieben gab es lange, und es wurde nicht
                           * benutzt: der Zeiger blieb ein Pfeil, und nichts
                           * am Balken sagte, dass er anfassbar ist. Eine
                           * Funktion, die niemand findet, ist keine.
                           */
                          className={`absolute rounded px-1 text-[11px] text-white truncate
                                      text-left hover:ring-2 ring-black/30 cursor-move
                                      ${FARBE[r.status] ?? 'bg-neutral-400'}`}>
                    {/* Die Notiz ist der Grund, warum man den Balken anders
                        behandelt als jeden anderen -- deshalb ein Merkmal am
                        Balken selbst, nicht erst im Seitenfenster. */}
                    {r.notes && <span aria-hidden className="mr-0.5">📌</span>}
                    {r.last_name ?? r.public_ref}
                    {/* Griffe an den Raendern: verkuerzen und verlaengern (A4). */}
                    <span onPointerDown={beginneGroesseAendern(r, 'start')}
                          className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" />
                    <span onPointerDown={beginneGroesseAendern(r, 'end')}
                          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" />
                  </button>
                )
              })}
              {ghost !== null && ghost.resourceIds.has(u.id) && (
                <div style={{ left: ghost.left, width: ghost.width, top: 4, height: ZEILE - 8 }}
                     className="absolute rounded border-2 border-dashed border-neutral-900
                                bg-neutral-900/10 pointer-events-none
                                text-[11px] leading-[18px] px-1 truncate">
                  {/* Wie viele Zimmer es werden, steht an der obersten Zeile
                      der Auswahl -- in jeder zu wiederholen waere Laerm. */}
                  {ghost.zaehlerAn === u.id
                    && `${ghost.resourceIds.size} ${t('group.rooms')}`}
                </div>
              )}
            </div>
          </div>
        ))}

        {data.units.length === 0 && (
          <div className="p-6 text-sm text-neutral-500">{t('common.none')}</div>
        )}
      </div>
    </div>
  )
}
