import { useMemo, useRef, useState, useEffect, useCallback, memo, type JSX } from 'react'
import type { TapeChart as TapeChartData } from '@hotelpms/contracts'
import { eachDay, isWeekend, daysBetween, addDays } from '../lib/dates.js'
import { auswahlZeitraum, gruppenAuswahl, zimmerPassung, platzbedarf, type Passung }
  from '../lib/tapeSelection.js'
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
 * - **Das Band der Buchungen ohne Zimmer scrollt für sich.** Ein
 *   Kanalmanager legt seine Buchungen immer ohne Zimmer an; in einem vollen
 *   Haus stehen dort schnell zwanzig. Das Band zeigte davon vier und zählte
 *   zwanzig — die übrigen sechzehn waren unsichtbar und unerreichbar. Jetzt
 *   scrollt es innerhalb seiner eigenen Höhe, mit `overscroll-contain`,
 *   damit ein Rad im Band nicht die ganze Seite mitnimmt.
 *
 * **Erst fragen, dann springen (A2–A4).** Waehrend des Ziehens zeigt ein
 * Schattenbalken die Absicht; der echte Balken bewegt sich erst, wenn die
 * API zugestimmt hat und die Daten neu geladen sind. Schlaegt der Aufruf
 * fehl, ist nichts gesprungen, das nun zurueckspringen muesste -- der
 * Schatten verschwindet einfach, und der Fehler steht im Seitenfenster.
 *
 * **Warum die Zimmerzeilen gemerkt werden (Performanceaudit).** Ein Zug mit
 * der Maus loest `pointermove` bei praktisch jedem Pixel aus, und jeder
 * Aufruf zeichnete bislang alle Zimmerzeilen neu -- bei 250 Zimmern und 60
 * Tagen mehrere tausend Zellen, obwohl sich waehrend eines Zugs nur die
 * betroffene Zeile aendert. Dasselbe Muster hat das Preisraster schon
 * einmal gemessen (328 ms je Zug, `RateGrid.tsx`) und mit `memo` je Zeile
 * behoben; hier fehlte genau dieser Schritt trotz der groesseren
 * Zellenzahl. `Zimmerzeile` bekommt deshalb nur einfache, ueber einen Zug
 * hinweg stabile Werte als Merkmale (eine Zahl, eine Zeichenkette oder
 * `null`, nie das rohe `drag`-Objekt) -- eine Zeile zeichnet sich nur dann
 * neu, wenn sich fuer sie selbst etwas aendert.
 */

const SPALTE = 44        // Pixel je Tag
const ZEILE = 34
const LABEL_BREITE = 160
/**
 * So hoch ist das Band der Buchungen ohne Zimmer, in Zeilen. Vier, weil der
 * Plan darunter der eigentliche Bildschirm ist; darüber hinaus wird
 * gescrollt statt abgeschnitten.
 */
const BAND_ZEILEN = 4
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
      /** Die gebuchte Zimmergruppe. Faerbt die passenden Zeilen ein und
          entscheidet, ob beim Loslassen gefragt wird. */
      categoryId: number; occupants: number; categoryMaxOccupancy: number
      pointerDownX: number; pointerDownY: number; overResourceId: number | null
      moved: boolean }
  | { kind: 'resize'; reservationRef: string; resourceId: number; edge: 'start' | 'end'
      arrival: string; departure: string; day: number }

export interface Umzug {
  reservationRef: string
  resourceId: number
  roomCode: string
  wechsel: {
    von: string
    nach: string
    /** Plaetze im Zielzimmer. Weniger als `bedarf` heisst: zu klein. */
    platz: number
    /** Plaetze, die die **gebuchte** Zimmergruppe zusagt (`platzbedarf`). */
    bedarf: number
  } | null
}

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
  /**
   * Balken auf eine andere Zimmerzeile gezogen (A3).
   *
   * `wechsel` ist gesetzt, wenn das Zielzimmer zu einer **anderen**
   * Zimmergruppe gehört. Die API laesst das bewusst zu -- ein Upgrade ist
   * Alltag --, aber versehentlich passiert dabei auch das Gegenteil: eine
   * Buchung fuer zwei Personen landet in einem Einzelzimmer. Der Plan sagt
   * deshalb, was der Wechsel bedeutet, und der Bildschirm entscheidet, ob
   * er fragt.
   */
  onMove?: (umzug: Umzug) => void
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
  // Als `useCallback` mit leeren Abhaengigkeiten: `beginneVerschieben` &
  // Co. haengen davon ab, und nur mit einer stabilen Kennung bleiben auch
  // sie stabil -- sonst bekaeme jede Zimmerzeile bei jedem Render einen
  // neuen Ereignisverweis und `memo` griffe nie.
  const setDragState = useCallback((d: DragState | null): void => {
    dragRef.current = d; setDrag(d)
  }, [])

  /** Zimmer und Zimmergruppen zum Nachschlagen. */
  const zimmerNach = useMemo(
    () => new Map(data.units.map(u => [u.id, u])), [data.units])

  const gruppeNach = useMemo(() => {
    const m = new Map<number, { name: string; code: string; platz: number
                                reihe: number }>()
    for (const u of data.units) {
      if (!m.has(u.category_id)) {
        m.set(u.category_id, { name: u.category_name, code: u.category_code,
                               platz: u.max_occupancy, reihe: u.sort_order })
      }
    }
    return m
  }, [data.units])

  /*
   * Nach Zimmergruppe sortiert, dann nach Anreise.
   *
   * Ungeordnet steht im Band ein Doppelzimmer neben einem Einzelzimmer neben
   * einer Suite, und wer zwanzig davon abarbeitet, greift irgendwann daneben.
   * Beieinander ist es eine Liste, die man Gruppe für Gruppe abräumt.
   */
  const nichtZugewiesen = useMemo(
    () => data.reservations
      .filter(r => r.resource_id === null)
      .sort((a, b) =>
        (gruppeNach.get(a.category_id)?.reihe ?? 0)
          - (gruppeNach.get(b.category_id)?.reihe ?? 0)
        || a.category_id - b.category_id
        || a.arrival.localeCompare(b.arrival)),
    [data.reservations, gruppeNach])

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
        if (d.moved && d.overResourceId !== null) {
          const ziel = zimmerNach.get(d.overResourceId)
          const anders = ziel !== undefined && ziel.category_id !== d.categoryId
          onMove?.({
            reservationRef: d.reservationRef,
            resourceId: d.overResourceId,
            roomCode: ziel?.code ?? '',
            wechsel: anders
              ? { von: gruppeNach.get(d.categoryId)?.name ?? '',
                  nach: ziel.category_name,
                  platz: ziel.max_occupancy,
                  bedarf: platzbedarf(d) }
              : null
          })
        } else if (!d.moved) onSelect?.(d.reservationRef)
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

  /**
   * Welcher Balken waehrend eines Umzugs oder einer Groessenaenderung
   * ausgeblendet ist -- der Schattenbalken uebernimmt seine Stelle. Als
   * einzelne Zeichenkette statt als Eigenschaft je Reservierung: nur eine
   * kann je Zug betroffen sein, und eine einzelne Zeichenkette bleibt ueber
   * den ganzen Zug hinweg gleich (`memo` unten haelt sich daran).
   */
  const versteckterRef = drag === null ? null
    : drag.kind === 'move' && drag.moved ? drag.reservationRef
    : drag.kind === 'resize' ? drag.reservationRef
    : null

  /*
   * Als stabile, parametrisierte Aufrufe statt als Fabrik, die je Zimmer
   * einen neuen Ereignisverweis zurueckgibt: `Zimmerzeile` ist `memo`, und
   * ein neuer Verweis bei jedem Render der Elternkomponente wuerde das
   * Merken wirkungslos machen, egal wie stabil die uebrigen Merkmale sind.
   */
  const beginneErstellen = useCallback(
    (resourceId: number, categoryId: number, e: React.PointerEvent) => {
      if (e.target !== e.currentTarget) return
      e.preventDefault()
      const startDay = tagUnter(e.clientX)
      /*
       * Mit Modifikator wird über Zeilen hinweg aufgezogen, ohne ihn wie
       * bisher nur in dieser einen. Umschalt steht daneben, weil es auf
       * jeder Tastatur dieselbe Taste ist -- Strg und ⌘ sind es nicht, und
       * wer am Mac arbeitet, greift nach beidem.
       */
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        const index = zeileVonZimmer.get(resourceId)
        if (index !== undefined) {
          setDragState({ kind: 'group', startIndex: index, index, startDay, day: startDay })
          return
        }
      }
      setDragState({ kind: 'create', resourceId, categoryId, startDay, day: startDay })
    }, [tagUnter, zeileVonZimmer, setDragState])

  const beginneVerschieben = useCallback((r: ReservationRow, e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragState({ kind: 'move', reservationRef: r.public_ref,
               arrival: r.arrival, departure: r.departure,
               categoryId: r.category_id, occupants: r.occupants,
               categoryMaxOccupancy: r.category_max_occupancy,
               pointerDownX: e.clientX, pointerDownY: e.clientY,
               overResourceId: null, moved: false })
  }, [setDragState])

  const beginneGroesseAendern = useCallback(
    (r: ReservationRow, edge: 'start' | 'end', e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragState({ kind: 'resize', reservationRef: r.public_ref, resourceId: r.resource_id!,
                 edge, arrival: r.arrival, departure: r.departure, day: tagUnter(e.clientX) })
    }, [tagUnter, setDragState])

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

        {/*
          * Ohne Zimmer: die Arbeit des Tages, deshalb oben.
          *
          * Ein Kanalmanager legt jede Buchung ohne Zimmer an -- die Route
          * kennt das Feld gar nicht --, und in einem vollen Haus stehen hier
          * schnell zwanzig. Vorher zeigte das Band vier davon und schrieb
          * zwanzig daneben; die uebrigen sechzehn waren im Plan unsichtbar
          * und nicht erreichbar. Jetzt scrollt es fuer sich.
          */}
        {nichtZugewiesen.length > 0 && (
          <div className="flex relative bg-amber-50 border-b border-amber-200">
            <div className="w-40 shrink-0 px-2 py-1 text-xs text-amber-800
                            border-r border-amber-200">
              <div>{t('today.needsRoom')} ({nichtZugewiesen.length})</div>
              {nichtZugewiesen.length > BAND_ZEILEN && (
                <div className="text-[10px] text-amber-700 mt-0.5">
                  {t('plan.bandScroll')}
                </div>
              )}
            </div>
            {/*
              * `overscroll-contain`: ein Rad im Band scrollt das Band und
              * springt am Ende **nicht** weiter auf die Seite. Ohne das
              * rutscht der ganze Plan weg, sobald das Band unten ankommt --
              * und man sucht die Zeile wieder, die man gerade anfassen
              * wollte.
              */}
            <div className="relative grow overflow-y-auto overscroll-contain"
                 style={{ maxHeight: ZEILE * BAND_ZEILEN }}>
              <div className="relative"
                   style={{ height: ZEILE * nichtZugewiesen.length }}>
                {nichtZugewiesen.map((r, i) => {
                  const b = balken(r.arrival, r.departure)
                  const gruppe = gruppeNach.get(r.category_id)
                  return (
                    <button key={r.id}
                            onPointerDown={e => beginneVerschieben(r, e)}
                            title={`${r.last_name ?? ''} · ${gruppe?.name ?? ''}`
                                 + ` · ${t('plan.capacityUpTo', {
                                       n: platzbedarf({
                                         occupants: r.occupants,
                                         categoryMaxOccupancy: r.category_max_occupancy })
                                     })}`
                                 + ` · ${r.public_ref}`}
                            style={{ ...b, top: i * ZEILE + 4, height: ZEILE - 8 }}
                            className={`absolute rounded px-1 text-[11px] text-white
                                        truncate text-left cursor-move
                                        ${FARBE[r.status] ?? 'bg-neutral-400'}`}>
                      {/* Die Zimmergruppe steht am Balken, nicht nur im
                          Hinweis: hier liegen Doppelzimmer, Einzelzimmer und
                          Suiten nebeneinander, und beim Ziehen entscheidet
                          sich in einer Sekunde, wohin. */}
                      {gruppe !== undefined && (
                        <span className="mr-1 px-1 rounded bg-black/25 tabular-nums">
                          {gruppe.code}
                        </span>
                      )}
                      {r.last_name ?? t('tape.noGuest')}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/*
          * Eine Zeile je Zimmer, gemerkt (`Zimmerzeile` ist `memo`): waehrend
          * eines Zugs bekommen nur die tatsaechlich betroffenen Zeilen neue
          * Merkmale, siehe die Erklaerung am Dateikopf.
          */}
        {data.units.map(u => {
          /*
           * Waehrend eines Umzugs faerbt sich die Zeile nach ihrer
           * Eignung. Das ist die eigentliche Sicherung gegen "Doppelzimmer
           * versehentlich ins Einzelzimmer": man sieht vor dem Loslassen,
           * wohin es passt -- nicht erst danach an einer Meldung.
           *
           * Drei Zustaende, und die Mitte ist wichtig: eine andere
           * Zimmergruppe, die gross genug ist, ist ein Upgrade und damit
           * Alltag. Nur zu klein ist ein Fehler.
           *
           * Das ist eine reine, billige Funktion je Zimmer -- nicht JSX --
           * und laeuft deshalb unbedenklich bei jedem Zug erneut. Waehrend
           * eines einzelnen Zugs aendern sich `categoryId`/`occupants`/
           * `categoryMaxOccupancy` nicht, nur `moved` kippt einmal von
           * falsch auf wahr; danach bleibt der Wert je Zeile stehen, und
           * `memo` unten haelt sich daran.
           */
          const passung = drag?.kind === 'move' && drag.moved
            ? zimmerPassung(u, { categoryId: drag.categoryId,
                                 occupants: drag.occupants,
                                 categoryMaxOccupancy: drag.categoryMaxOccupancy })
            : null
          const ghostHier = ghost !== null && ghost.resourceIds.has(u.id)
          return (
            <Zimmerzeile key={u.id} unit={u} tage={tage}
                         reservations={jeZimmer.get(u.id)} blocks={blockeJeZimmer.get(u.id)}
                         balken={balken} passung={passung}
                         versteckterRef={versteckterRef}
                         ghostHier={ghostHier}
                         ghostLinks={ghostHier ? ghost!.left : 0}
                         ghostBreite={ghostHier ? ghost!.width : 0}
                         ghostZaehler={ghost?.zaehlerAn === u.id ? ghost.resourceIds.size : null}
                         onCreatePointerDown={beginneErstellen}
                         onMovePointerDown={beginneVerschieben}
                         onResizePointerDown={beginneGroesseAendern} />
          )
        })}

        {data.units.length === 0 && (
          <div className="p-6 text-sm text-neutral-500">{t('common.none')}</div>
        )}
      </div>
    </div>
  )
}

interface ZimmerzeileProps {
  unit: TapeChartData['units'][number]
  tage: readonly string[]
  reservations: ReservationRow[] | undefined
  blocks: TapeChartData['blocks'] | undefined
  /** Stabil ueber `useCallback` in der Elternkomponente. */
  balken: (von: string, bis: string) => { left: number; width: number }
  passung: Passung | null
  versteckterRef: string | null
  ghostHier: boolean
  ghostLinks: number
  ghostBreite: number
  ghostZaehler: number | null
  onCreatePointerDown: (resourceId: number, categoryId: number, e: React.PointerEvent) => void
  onMovePointerDown: (r: ReservationRow, e: React.PointerEvent) => void
  onResizePointerDown: (r: ReservationRow, edge: 'start' | 'end', e: React.PointerEvent) => void
}

/**
 * Eine Zimmerzeile, gemerkt. Die Begruendung steht am Dateikopf: nur
 * einfache, ueber einen Zug hinweg stabile Merkmale, nie das rohe
 * `drag`-Objekt -- sonst zeichnete jede Zeile bei jedem `pointermove` neu,
 * genau der Fehler, den das Preisraster schon einmal gemessen hat.
 */
const Zimmerzeile = memo(function Zimmerzeile(p: ZimmerzeileProps): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const u = p.unit
  return (
    <div className={`flex relative border-b border-neutral-100
                     ${p.passung === 'passt' ? 'bg-emerald-50/70' : ''}
                     ${p.passung === 'zuKlein' ? 'bg-red-50/70' : ''}`}
         data-resource-row={u.id}
         style={{ height: ZEILE }}>
      <div className="w-40 shrink-0 px-2 py-1 text-xs border-r border-neutral-200
                      flex items-center gap-2">
        <span className="font-medium tabular-nums">{u.code}</span>
        <span className="text-neutral-400 truncate">{u.category_name}</span>
        {p.passung === 'zuKlein' && (
          <span aria-hidden title={t('plan.tooSmall')}
                className="text-red-700 shrink-0">!</span>
        )}
      </div>
      <div className="relative grow cursor-crosshair"
           onPointerDown={e => p.onCreatePointerDown(u.id, u.category_id, e)}>
        {p.tage.map((d, i) => (
          <div key={d}
               style={{ left: i * SPALTE, width: SPALTE }}
               className={`absolute inset-y-0 border-r border-neutral-100
                           pointer-events-none
                           ${isWeekend(d) ? 'bg-neutral-50' : ''}`} />
        ))}
        {(p.blocks ?? []).map((b, i) => (
          <div key={i}
               style={{ ...p.balken(b.from_date, b.to_date), top: 4, height: ZEILE - 8 }}
               title={b.reason}
               className="absolute rounded bg-status-blocked/60 px-1 text-[11px]
                          text-white truncate
                          [background-image:repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(255,255,255,.35)_4px,rgba(255,255,255,.35)_8px)]">
            {b.reason}
          </div>
        ))}
        {(p.reservations ?? []).map(r => {
          const b = p.balken(r.arrival, r.departure)
          const versteckt = r.public_ref === p.versteckterRef
          return (
            <button key={r.id}
                    onPointerDown={e => p.onMovePointerDown(r, e)}
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
              {r.last_name ?? t('tape.noGuest')}
              {/* Griffe an den Raendern: verkuerzen und verlaengern (A4). */}
              <span onPointerDown={e => p.onResizePointerDown(r, 'start', e)}
                    className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" />
              <span onPointerDown={e => p.onResizePointerDown(r, 'end', e)}
                    className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" />
            </button>
          )
        })}
        {p.ghostHier && (
          <div style={{ left: p.ghostLinks, width: p.ghostBreite, top: 4, height: ZEILE - 8 }}
               className="absolute rounded border-2 border-dashed border-neutral-900
                          bg-neutral-900/10 pointer-events-none
                          text-[11px] leading-[18px] px-1 truncate">
            {/* Wie viele Zimmer es werden, steht an der obersten Zeile
                der Auswahl -- in jeder zu wiederholen waere Laerm. */}
            {p.ghostZaehler !== null && `${p.ghostZaehler} ${t('group.rooms')}`}
          </div>
        )}
      </div>
    </div>
  )
})
