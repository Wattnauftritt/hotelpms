import { useMemo, useRef, useState, useEffect, useCallback, memo, type JSX } from 'react'
import type { TapeChart as TapeChartData } from '@hotelpms/contracts'
import { eachDay, isWeekend, daysBetween, addDays, today } from '../lib/dates.js'
import type { KontextZiel } from './Kontextmenue.tsx'
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
      /** Die Zeile, in der der Balken losgezogen wurde. Null im Band oben. */
      quelleResourceId: number | null
      /** Die Buchung dieses Aufenthalts und wie viele Zimmer darin liegen.
          Mehr als eines heisst: mit Alt bewegt der Zug die ganze Gruppe. */
      bookingRef: string; bookingRooms: number
      /**
       * Alt gedrueckt: die **ganze** Gruppe wandert mit.
       *
       * Die Vorgabe ist das einzelne Zimmer, und das ist die vorsichtige
       * Richtung: wer daneben greift, verschiebt eine Reservierung und
       * nicht acht. Acht zurueckzuholen ist Arbeit, eine ist ein Zug.
       */
      alleDerGruppe: boolean
      /** Tagesspalte beim Aufsetzen und jetzt -- daraus der Zeitversatz. */
      startDay: number; day: number
      /**
       * Der Zeiger liegt ueber dem Band der Buchungen ohne Zimmer.
       *
       * Eigener Zustand und nicht `overResourceId === null`: "ueber keiner
       * Zeile" heisst auch "ueber der Kopfzeile" oder "neben dem Plan", und
       * daraus ein Abnehmen des Zimmers zu machen waere ein verlorenes
       * Zimmer bei jedem Zug, der danebengeht.
       */
      ueberBand: boolean
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
  /**
   * Ein Balken einer Gruppenbuchung waagerecht gezogen: die **ganze**
   * Gruppe wandert.
   *
   * Das ist, was die Rezeption meint, wenn sie sagt, die Gruppe komme
   * einen Tag spaeter -- nicht "eines der acht Zimmer". Der Versatz und
   * nicht ein neuer Zeitraum, damit Zimmer, die nach einer einzelnen
   * Aenderung abweichend liegen, abweichend bleiben.
   *
   * Wer doch nur dieses eine Zimmer meint, haelt Alt gedrueckt; dann
   * kommt `onChangeStay` wie bei einer Einzelbuchung.
   */
  onShiftGroup?: (bookingRef: string, shiftDays: number) => void
  /**
   * Ein Balken ins Band der Buchungen ohne Zimmer gezogen: das Zimmer wird
   * wieder abgenommen.
   *
   * Der Zwischenablageplatz beim Umsortieren. In einem vollen Haus lassen
   * sich zwei Buchungen nicht tauschen, ohne dass eine von beiden kurz
   * nirgends liegt -- und sie dafuer zu stornieren und neu zu buchen ist
   * zweimal falsch: der Vorgang verliert seine Geschichte, und zwischen
   * beidem steht der Platz im freien Verkauf.
   */
  onUnassign?: (reservationRef: string) => void
  /**
   * Rechter Knopf auf einem Balken oder auf freier Flaeche.
   *
   * Der Plan meldet nur, **was** dort lag; welche Eintraege das Menue
   * bekommt, entscheidet der Bildschirm. Er kennt die Rechte des
   * Benutzers und die Bildschirme, zu denen ein Eintrag fuehrt -- beides
   * geht den Plan nichts an, und beides hier zu wissen hiesse, ihm die
   * halbe Anwendung mitzugeben.
   */
  onKontext?: (ziel: KontextZiel) => void
}

/**
 * Nur der linke Knopf zieht.
 *
 * **Der rechte loest `pointerdown` genauso aus.** Ohne diese Pruefung
 * begann ein Rechtsklick auf einem Balken zugleich ein Verschieben --
 * das Menue ging auf, und dahinter haftete der Balken am Zeiger. Der
 * naechste Klick, der eigentlich einen Menueeintrag treffen sollte, liess
 * ihn irgendwo fallen.
 *
 * `buttons` und nicht `button`: bei `pointerdown` ist `button` zwar
 * gesetzt, aber bei einem Stift oder einer Beruehrung ist es 0 und
 * `buttons` 1 -- die Pruefung auf `buttons === 1` laesst Maus, Stift und
 * Finger durch und haelt nur den rechten und mittleren Knopf auf.
 */
function nurLinks(e: React.PointerEvent): boolean {
  return e.buttons !== 1
}

export function TapeChart({ data, onSelect, onCreate, onCreateGroup, onMove,
                            onChangeStay, onShiftGroup, onUnassign,
                            onKontext }: Props): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const tage = useMemo(() => eachDay(data.from, data.to), [data.from, data.to])
  const rasterRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  /**
   * Die stehende Mehrfachauswahl.
   *
   * **Warum sie ueber den einzelnen Zug hinaus bestehen bleibt.** Vorher war
   * die Auswahl ein Gummiband ueber einen Bereich von Zeile bis Zeile --
   * Zimmer 1 bis 8 ging, Zimmer 1 und 20 nicht. Ein Haus, das eine Gruppe
   * auf verstreute Zimmer legt, weil die dazwischen belegt sind, konnte sie
   * gar nicht als eine Buchung anlegen.
   *
   * Jetzt sammelt jeder Zug mit Modifikator dazu. Der Zeitraum ist dabei
   * einer fuer alle: die Gruppenbuchung kennt genau eine Anreise und eine
   * Abreise (`CreateBooking.rooms`), und der zuletzt gezogene gilt fuer die
   * ganze Auswahl -- sichtbar, weil alle Schattenbalken mitwandern.
   */
  const [auswahl, setAuswahl] = useState<
    { resourceIds: number[]; arrival: string; departure: string } | null>(null)
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
  /**
   * Die Buchungen ohne Zimmer -- **nach Anreise**, nicht nach Zimmergruppe.
   *
   * Hier stand die Zimmergruppe zuerst, und das war der Fehler hinter
   * "die gehen unter". Das Band zeigt vier Zeilen auf einmal; welche vier,
   * entschied damit eine Eigenschaft, die mit Dringlichkeit nichts zu tun
   * hat. Eine Buchung, die morgen anreist, stand auf Platz neun, weil sie
   * eine Suite ist -- und Platz neun sieht niemand.
   *
   * Nach Anreise sortiert ist die Reihenfolge dieselbe wie die Frage, die
   * man hat: was kommt als naechstes und hat noch kein Zimmer. Die
   * Zimmergruppe geht dabei nicht verloren, ihr Kuerzel steht am Balken.
   */
  const nichtZugewiesen = useMemo(
    () => data.reservations
      .filter(r => r.resource_id === null)
      .sort((a, b) =>
        a.arrival.localeCompare(b.arrival)
        || (gruppeNach.get(a.category_id)?.reihe ?? 0)
             - (gruppeNach.get(b.category_id)?.reihe ?? 0)
        || a.category_id - b.category_id),
    [data.reservations, gruppeNach])

  /**
   * Wie dringend ist eine Buchung ohne Zimmer?
   *
   * Gemessen an **heute**, nicht am linken Rand des Plans: wer im November
   * blaettert, hat dort keine Dringlichkeit, und ein Balken, der sich nach
   * der Blaetterstellung faerbt, sagt nichts ueber das Haus.
   *
   * Zwei Tage, weil der Abstand zur Anreise der Handlungsspielraum ist:
   * heute und morgen laesst sich noch umstellen, danach steht der Gast am
   * Tresen.
   */
  const heute = today()
  const dringlich = useCallback(
    (arrival: string) => daysBetween(heute, arrival) <= 2, [heute])

  /**
   * Das Band offen oder zusammengeklappt.
   *
   * **Warum ueberhaupt ein Innenscroll und nicht einfach alle Zeilen.** Bei
   * einem Kanalmanager, der jede Buchung ohne Zimmer anlegt, stehen hier
   * zwanzig; zwanzig Zeilen schoeben den Plan vom Bildschirm, und der Plan
   * ist das, worauf die Rezeption den ganzen Tag sieht.
   *
   * **Warum er trotzdem nicht genuegt.** Was unterhalb des vierten Eintrags
   * liegt, ist unsichtbar, und unsichtbar heisst vergessen. Deshalb ist das
   * Zusammenklappen jetzt eine Entscheidung und kein Zustand, den man nicht
   * bemerkt: die Kopfzeile ist ein Knopf, und im zugeklappten Zustand steht
   * dort, was fehlt -- mit der naechsten Anreise, nicht nur mit einer Zahl.
   */
  const [bandOffen, setBandOffen] = useState(false)

  /**
   * Was das zugeklappte Band verschweigt: wie viele, und ab wann es eilt.
   *
   * Die naechste Anreise **unter den verdeckten**, nicht die naechste
   * ueberhaupt -- sichtbare Zeilen sind kein Grund aufzuklappen. Weil nach
   * Anreise sortiert ist, ist das schlicht die erste verdeckte Zeile.
   */
  const verdeckt = useMemo(() => {
    const rest = nichtZugewiesen.slice(BAND_ZEILEN)
    if (rest.length === 0) return null
    return { anzahl: rest.length, naechste: rest[0]!.arrival }
  }, [nichtZugewiesen])

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
      const imBand = el?.closest('[data-unassigned-band]') !== null
                  && el?.closest('[data-unassigned-band]') !== undefined
      const bewegt = d.moved
        || Math.abs(e.clientX - d.pointerDownX) > KLICK_SCHWELLE
        || Math.abs(e.clientY - d.pointerDownY) > KLICK_SCHWELLE
      setDragState({ ...d, overResourceId: ueber, ueberBand: imBand, moved: bewegt,
                     day: tagUnter(e.clientX) })
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
        /*
         * Sammeln, nicht sofort buchen.
         *
         * Vorher oeffnete das Loslassen den Gruppendialog. Damit war die
         * Auswahl genau ein Zug lang -- und ein Zug ist ein
         * zusammenhaengender Bereich. Jetzt legt jeder Zug seine Zeilen
         * dazu, und gebucht wird ueber die Leiste oben, wenn die Auswahl
         * steht.
         */
        const neu = gruppenAuswahl(data.units, tage, d)
        setAuswahl(vorher => ({
          resourceIds: [...new Set([...(vorher?.resourceIds ?? []),
                                    ...neu.rooms.map(r => r.resourceId)])],
          // Der zuletzt gezogene Zeitraum gilt fuer die ganze Auswahl: die
          // Gruppenbuchung kennt genau eine Anreise und eine Abreise.
          arrival: neu.arrival, departure: neu.departure
        }))
      } else if (d.kind === 'move') {
        const versatz = d.overResourceId === d.quelleResourceId
          ? d.day - d.startDay
          : 0
        if (d.moved && d.ueberBand) {
          /*
           * Ins Band gezogen heisst: das Zimmer wieder abnehmen.
           *
           * **Vor** allen anderen Faellen geprueft, auch vor dem
           * Zeitversatz: wer den Balken nach oben ins Band zieht, hat ihn
           * dabei fast immer auch seitlich bewegt, und eine Umbuchung auf
           * ein anderes Datum waere dann ein zweiter, ungewollter Effekt
           * derselben Geste.
           *
           * Wozu ueberhaupt. Im vollen Haus geht Umsortieren nicht in
           * einem Zug: das Zimmer, das frei werden soll, ist erst frei,
           * wenn sein Gast woanders liegt -- und der passt nur dorthin, wo
           * der erste noch liegt. Das Band ist der Zwischenablageplatz.
           * Der Bestand bleibt dabei unberuehrt; nur die Zeile im Plan
           * wechselt.
           */
          if (d.quelleResourceId !== null) onUnassign?.(d.reservationRef)
        } else if (d.moved && versatz !== 0) {
          /*
           * In derselben Zeile waagerecht gezogen: der ganze Aufenthalt
           * wandert, seine Laenge bleibt. Das Zimmer bleibt ebenfalls --
           * die Zeile hat sich ja nicht geaendert.
           *
           * Mit **Alt** wandert die ganze Gruppe statt nur dieses
           * Balkens. Die Vorgabe ist das einzelne Zimmer, weil das die
           * vorsichtige Richtung ist: wer daneben greift, verschiebt eine
           * Reservierung und nicht acht -- acht zurueckzuholen ist Arbeit,
           * eine ist ein Zug.
           */
          if (d.bookingRooms > 1 && d.alleDerGruppe) {
            onShiftGroup?.(d.bookingRef, versatz)
          } else {
            onChangeStay?.(d.reservationRef,
              addDays(d.arrival, versatz), addDays(d.departure, versatz))
          }
        } else if (d.moved && d.overResourceId !== null
                   && d.overResourceId !== d.quelleResourceId) {
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
    /** Zimmer der Gruppe, die beim Loslassen mitwandern. */
    gruppenZahl?: number
  } | null => {
    if (drag === null) {
      // Kein Zug, aber eine stehende Auswahl: die Schattenbalken bleiben
      // sichtbar, sonst waere nicht zu sehen, was ausgewaehlt ist.
      if (auswahl === null) return null
      const ids = new Set(auswahl.resourceIds)
      return { resourceIds: ids, zaehlerAn: auswahl.resourceIds[0],
               ...balken(auswahl.arrival, auswahl.departure) }
    }
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
      /*
       * Das laufende Gummiband **und** was schon steht. So sieht man
       * waehrend des Zugs die ganze Auswahl und nicht nur den letzten
       * Streifen -- und weil der Zeitraum einer fuer alle ist, wandern die
       * bereits gewaehlten Zeilen sichtbar mit.
       */
      const ids = new Set([...(auswahl?.resourceIds ?? []), ...zeilen.map(u => u.id)])
      const erste = data.units.find(u => ids.has(u.id))
      return {
        resourceIds: ids,
        zaehlerAn: erste?.id,
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
      /*
       * **Eine Geste tut eine Sache.** Liegt der Zeiger in einer anderen
       * Zeile, ist es ein Zimmerwechsel und der Zeitraum bleibt; liegt er
       * in derselben, ist es eine Verschiebung in der Zeit und das Zimmer
       * bleibt.
       *
       * Beides zugleich waere zwei Aufrufe -- `assign-unit` und
       * `change-stay` --, und dazwischen liegt ein Zustand, den niemand
       * gewollt hat: entweder das neue Zimmer an den alten Tagen oder das
       * alte Zimmer an den neuen. Schlaegt der zweite Aufruf fehl, bleibt
       * genau der stehen. Der Schattenbalken zeigt waehrend des Zugs, was
       * passieren wird, also ist die Regel sichtbar und nicht geraten.
       */
      const versatz = drag.overResourceId === drag.quelleResourceId
        ? drag.day - drag.startDay
        : 0
      const b = balken(addDays(drag.arrival, versatz), addDays(drag.departure, versatz))
      /*
       * Bei einer Gruppe steht die Zahl der Zimmer am Schattenbalken.
       *
       * **Und nicht ein Schatten je Zimmer der Gruppe**, so naheliegend
       * das waere: die Zimmer einer Gruppe liegen nach einzelnen
       * Aenderungen nicht mehr deckungsgleich, und ein Schatten hat genau
       * eine Breite. Acht gleich breite Rechtecke zu zeichnen hiesse, eine
       * Deckungsgleichheit zu zeigen, die nach dem Loslassen nicht
       * eintritt -- eine Vorschau, die luegt, ist schlechter als keine.
       *
       * Die Zahl sagt, was zaehlt: es wandert nicht dieser eine Balken.
       */
      return {
        resourceIds: new Set([drag.overResourceId]),
        gruppenZahl: versatz !== 0 && drag.bookingRooms > 1 && drag.alleDerGruppe
          ? drag.bookingRooms : undefined,
        ...b }
    }
    return null
  }, [drag, auswahl, balken, data.from, data.units])

  /*
   * Esc hebt die Auswahl auf.
   *
   * Der zweite Weg zurueck neben dem Klick ohne Modifikator, und der
   * gewohnte: wer etwas ausgewaehlt hat und es doch nicht will, drueckt
   * Esc. Am Fenster und nicht am Plan, weil der Plan keinen Fokus haelt --
   * nach einem Zug liegt er auf dem zuletzt beruehrten Balken oder nirgends.
   */
  useEffect(() => {
    if (auswahl === null) return
    const aufTaste = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAuswahl(null)
    }
    window.addEventListener('keydown', aufTaste)
    return () => { window.removeEventListener('keydown', aufTaste) }
  }, [auswahl !== null])

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

  /**
   * Die Buchung, deren Balken gerade festgehalten wird -- **sobald** er
   * festgehalten wird, nicht erst beim Ziehen.
   *
   * Wozu. Einem Balken sieht man nicht an, dass sieben weitere dazugehoeren;
   * in einem Plan mit hundert Zeilen liegen sie ausserdem verstreut. Wer
   * einen anfasst, soll in derselben Sekunde sehen, was mit Alt mitwandern
   * wuerde -- und, ebenso wichtig, was **nicht**.
   *
   * Eine einzelne Zeichenkette und keine Menge von Referenzen: welche
   * Balken zur Buchung gehoeren, steht ohnehin in jeder Zeile
   * (`booking_ref`), und eine Zeichenkette bleibt ueber den ganzen Zug
   * gleich -- `memo` unten haelt sich daran, eine frisch gebaute Menge
   * haette es bei jeder Bewegung ausgehebelt.
   */
  const gehaltenerGruppenRef = drag !== null && drag.kind === 'move'
    && drag.bookingRooms > 1 ? drag.bookingRef : null

  /**
   * Das Band taugt gerade als Ablage: ein Balken **mit** Zimmer wird
   * gehalten.
   *
   * Ohne Zimmer liegt er schon dort, und ein Ziel anzubieten, das nichts
   * aendert, ist eine Zusage, die ins Leere geht.
   */
  const bandAlsZiel = drag !== null && drag.kind === 'move'
    && drag.quelleResourceId !== null

  /*
   * Als stabile, parametrisierte Aufrufe statt als Fabrik, die je Zimmer
   * einen neuen Ereignisverweis zurueckgibt: `Zimmerzeile` ist `memo`, und
   * ein neuer Verweis bei jedem Render der Elternkomponente wuerde das
   * Merken wirkungslos machen, egal wie stabil die uebrigen Merkmale sind.
   */
  const beginneErstellen = useCallback(
    (resourceId: number, categoryId: number, e: React.PointerEvent) => {
      if (e.target !== e.currentTarget) return
      if (nurLinks(e)) return
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
      // Ohne Modifikator irgendwo hinklicken hebt die Auswahl auf. Das ist
      // der Weg zurueck, den man ohne Anleitung findet -- Esc ist der
      // andere, und beide sind gewollt.
      setAuswahl(null)
      setDragState({ kind: 'create', resourceId, categoryId, startDay, day: startDay })
    }, [tagUnter, zeileVonZimmer, setDragState])

  const beginneVerschieben = useCallback((r: ReservationRow, e: React.PointerEvent) => {
    if (nurLinks(e)) return
    e.preventDefault()
    e.stopPropagation()
    const tag = tagUnter(e.clientX)
    setDragState({ kind: 'move', reservationRef: r.public_ref,
               arrival: r.arrival, departure: r.departure,
               categoryId: r.category_id, occupants: r.occupants,
               categoryMaxOccupancy: r.category_max_occupancy,
               quelleResourceId: r.resource_id,
               bookingRef: r.booking_ref, bookingRooms: r.booking_rooms,
               // Beim Aufsetzen abgelesen und festgehalten: waehrend des
               // Zugs liest niemand mehr die Tastatur, und ein `altKey`
               // beim Loslassen waere eine andere Frage als die, die der
               // Mensch beim Greifen beantwortet hat.
               alleDerGruppe: e.altKey,
               startDay: tag, day: tag,
               pointerDownX: e.clientX, pointerDownY: e.clientY,
               overResourceId: null, ueberBand: false, moved: false })
  }, [tagUnter, setDragState])

  /*
   * Der rechte Knopf, zweimal: auf einem Balken und auf freier Flaeche.
   *
   * `preventDefault` hier und nicht nur in der `Shell`: die Sperre dort
   * haelt das Browsermenue zu, aber das eigene Menue muss den Klick auch
   * bekommen, bevor irgendetwas anderes damit passiert.
   *
   * `stopPropagation` am Balken, weil er in der freien Flaeche der Zeile
   * liegt: ohne das oeffnete sich anschliessend das Menue fuer "hier ist
   * nichts" -- ueber einem Balken, auf den man gerade gezielt hat.
   */
  const balkenKontext = useCallback((r: ReservationRow, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onKontext?.({
      art: 'reservierung', punkt: { x: e.clientX, y: e.clientY },
      reservationRef: r.public_ref, bookingRef: r.booking_ref,
      bookingRooms: r.booking_rooms, status: r.status, resourceId: r.resource_id })
  }, [onKontext])

  const freiKontext = useCallback(
    (resourceId: number, categoryId: number, e: React.MouseEvent) => {
      e.preventDefault()
      const tag = tagUnter(e.clientX)
      const anreise = tage[Math.max(0, Math.min(tage.length - 1, tag))]
      if (anreise === undefined) return
      onKontext?.({
        art: 'frei', punkt: { x: e.clientX, y: e.clientY },
        resourceId, categoryId,
        roomCode: zimmerNach.get(resourceId)?.code ?? '',
        // **Eine Nacht**, nicht der sichtbare Zeitraum. Wer im Plan rechts
        // klickt, meint diesen Tag; ein Vorschlag ueber sechzig Tage waere
        // eine Buchung, die niemand wollte.
        arrival: anreise, departure: addDays(anreise, 1) })
    }, [onKontext, tagUnter, tage, zimmerNach])

  const beginneGroesseAendern = useCallback(
    (r: ReservationRow, edge: 'start' | 'end', e: React.PointerEvent) => {
      if (nurLinks(e)) return
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
        {/*
          * Das Band ist auch dann da, wenn es leer ist -- sobald ein Balken
          * mit Zimmer gehalten wird.
          *
          * Sonst fehlte das Ablageziel genau dann, wenn man es zum ersten
          * Mal braucht: in einem vollen, sauber zugewiesenen Haus steht
          * hier nichts, und gerade dort ist Umsortieren noetig. Ein Ziel,
          * das erst erscheint, wenn schon etwas darin liegt, ist keines.
          */}
        {(nichtZugewiesen.length > 0 || bandAlsZiel) && (
          <div data-unassigned-band
               className={`flex relative border-b transition-colors
                           ${drag?.kind === 'move' && drag.ueberBand
                             ? 'bg-amber-200 border-amber-500'
                             : 'bg-amber-50 border-amber-200'}`}>
            {/*
              * Die Kopfzeile ist ein Knopf, kein Etikett.
              *
              * Zugeklappt sagt sie, **was** fehlt und nicht nur wie viele:
              * die naechste Anreise unter den verdeckten. Eine Zahl allein
              * laesst offen, ob es eilt -- und wer das nicht weiss, klappt
              * nicht auf.
              */}
            <button type="button"
                    onClick={() => setBandOffen(o => !o)}
                    disabled={nichtZugewiesen.length <= BAND_ZEILEN}
                    className="w-40 shrink-0 px-2 py-1 text-xs text-amber-800 text-left
                               border-r border-amber-200 disabled:cursor-default">
              <div className="font-medium">
                {nichtZugewiesen.length > BAND_ZEILEN && (bandOffen ? '▾ ' : '▸ ')}
                {t('today.needsRoom')} ({nichtZugewiesen.length})
              </div>
              {/* Der Satz steht nur waehrend des Zugs da: eine Anleitung,
                  die immer danebensteht, liest nach der dritten Woche
                  niemand mehr, und Platz nimmt sie jeden Tag weg. */}
              {bandAlsZiel && (
                <div className="text-[10px] text-amber-700 mt-0.5">
                  {t('plan.dropToUnassign')}
                </div>
              )}
              {!bandAlsZiel && !bandOffen && verdeckt !== null && (
                <div className={`text-[10px] mt-0.5
                                 ${dringlich(verdeckt.naechste)
                                   ? 'text-red-700 font-medium' : 'text-amber-700'}`}>
                  {t('plan.bandHidden', { n: verdeckt.anzahl,
                                          datum: formatDate(verdeckt.naechste, locale) })}
                </div>
              )}
            </button>
            {/*
              * `overscroll-contain`: ein Rad im Band scrollt das Band und
              * springt am Ende **nicht** weiter auf die Seite. Ohne das
              * rutscht der ganze Plan weg, sobald das Band unten ankommt --
              * und man sucht die Zeile wieder, die man gerade anfassen
              * wollte.
              */}
            <div className="relative grow overflow-y-auto overscroll-contain"
                 style={{ maxHeight: ZEILE * (bandOffen ? nichtZugewiesen.length
                                                        : BAND_ZEILEN) }}>
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
                                 + ` · ${r.public_ref}`
                                 // Die lange Notiz nur hier, nie auf dem Balken.
                                 + (r.notes ? `\n${r.notes}` : '')}
                            style={{ ...b, top: i * ZEILE + 4, height: ZEILE - 8 }}
                            /*
                             * Ein roter Ring, wenn die Anreise binnen zwei
                             * Tagen ist.
                             *
                             * Eine Buchung ohne Zimmer ist nicht per se ein
                             * Problem -- im November ist sie normal, morgen
                             * ist sie eine Lage. Ohne diesen Unterschied
                             * sieht das Band an einem ruhigen Tag genauso
                             * aus wie an dem, an dem gleich jemand am
                             * Tresen steht.
                             *
                             * Ein Ring und keine andere Fuellfarbe: die
                             * Fuellung sagt den Zustand (Option,
                             * bestaetigt), und den zu ueberschreiben
                             * tauschte eine Information gegen eine andere.
                             */
                            className={`absolute rounded px-1 text-[11px] text-white
                                        truncate text-left cursor-move
                                        ${FARBE[r.status] ?? 'bg-neutral-400'}
                                        ${dringlich(r.arrival)
                                          ? 'ring-2 ring-red-600' : ''}`}>
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
                      {/* Die Notiz gehoert auf den Balken, nicht zwei Klicks
                          tiefer: hier steht, was beim naechsten Blick auf den
                          Plan zaehlt -- "Balkon", "1. Stock", "Spaetanreise".
                          Die Schnittstelle liefert sie seit jeher mit, nur
                          angezeigt wurde sie nie. */}
                      {r.short_note && (
                        <span className="ml-1 opacity-75">· {r.short_note}</span>
                      )}
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
                         gruppenRef={gehaltenerGruppenRef}
                         ghostHier={ghostHier}
                         ghostLinks={ghostHier ? ghost!.left : 0}
                         ghostBreite={ghostHier ? ghost!.width : 0}
                         ghostZaehler={ghost?.gruppenZahl ?? (
                           ghost?.zaehlerAn === u.id ? ghost.resourceIds.size : null)}
                         onCreatePointerDown={beginneErstellen}
                         onMovePointerDown={beginneVerschieben}
                         onResizePointerDown={beginneGroesseAendern}
                         onBalkenKontext={balkenKontext}
                         onFreiKontext={freiKontext} />
          )
        })}

        {data.units.length === 0 && (
          <div className="p-6 text-sm text-neutral-500">{t('common.none')}</div>
        )}
      </div>
      {/*
        * Die Leiste der stehenden Auswahl.
        *
        * Sie ist der Grund, warum die Auswahl ueberhaupt stehen bleiben
        * kann: ohne einen sichtbaren Weg zum Buchen waere ein Satz
        * markierter Zeilen eine Sackgasse. Sie nennt die Zahl, weil man
        * verstreute Zeilen nicht mit einem Blick zaehlt, und den Zeitraum,
        * weil der zuletzt gezogene fuer alle gilt.
        *
        * `sticky` an beiden Achsen, damit sie auch dann sichtbar bleibt,
        * wenn die Auswahl ueber Zimmer 3 und Zimmer 200 liegt und dazwischen
        * gescrollt wird. **Unten** und nicht oben: oben klebt die Kopfzeile
        * mit den Tagen, und die wird beim Auswaehlen eines Zeitraums
        * gebraucht -- eine Leiste davor haette genau die Angabe verdeckt,
        * die man gerade liest.
        */}
      {auswahl !== null && auswahl.resourceIds.length > 0 && (
        <div className="sticky bottom-0 left-0 z-30 flex flex-wrap items-center gap-2
                        bg-neutral-900 text-white px-3 py-1.5 text-sm">
          <span className="font-medium">
            {t('plan.selectedRooms', { n: auswahl.resourceIds.length })}
          </span>
          <span className="opacity-75 text-xs">
            {formatDate(auswahl.arrival, locale)} – {formatDate(auswahl.departure, locale)}
          </span>
          <div className="grow" />
          {/*
            * Buchen leert die Auswahl.
            *
            * Sie ist ab hier in der Maske aufgehoben -- dort stehen
            * dieselben Zimmer und lassen sich einzeln entfernen. Stehen zu
            * bleiben hiesse, nach dem Anlegen einen Schatten ueber den
            * frischen Balken zu haben, der aussieht wie eine zweite,
            * ungebuchte Gruppe.
            */}
          <button type="button"
                  onClick={() => {
                    onCreateGroup?.({
                      rooms: auswahl.resourceIds.flatMap(id => {
                        const u = zimmerNach.get(id)
                        return u === undefined
                          ? []
                          : [{ resourceId: id, categoryId: u.category_id }]
                      }),
                      arrival: auswahl.arrival, departure: auswahl.departure
                    })
                    setAuswahl(null)
                  }}
                  className="px-3 py-1 rounded bg-white text-neutral-900 text-sm">
            {t('plan.bookSelection')}
          </button>
          {/* Esc tut dasselbe; der Knopf ist der Weg fuer den, der das
              nicht weiss. */}
          <button type="button" onClick={() => setAuswahl(null)}
                  className="px-2 py-1 rounded border border-white/40 text-sm">
            {t('plan.clearSelection')}
          </button>
        </div>
      )}
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
  /** Buchung, deren Balken gerade festgehalten wird. Hebt ihre Geschwister hervor. */
  gruppenRef: string | null
  ghostHier: boolean
  ghostLinks: number
  ghostBreite: number
  ghostZaehler: number | null
  onCreatePointerDown: (resourceId: number, categoryId: number, e: React.PointerEvent) => void
  onMovePointerDown: (r: ReservationRow, e: React.PointerEvent) => void
  onResizePointerDown: (r: ReservationRow, edge: 'start' | 'end', e: React.PointerEvent) => void
  /** Rechter Knopf auf einem Balken dieser Zeile. */
  onBalkenKontext: (r: ReservationRow, e: React.MouseEvent) => void
  /** Rechter Knopf auf freier Flaeche dieser Zeile. */
  onFreiKontext: (resourceId: number, categoryId: number, e: React.MouseEvent) => void
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
           onPointerDown={e => p.onCreatePointerDown(u.id, u.category_id, e)}
           onContextMenu={e => p.onFreiKontext(u.id, u.category_id, e)}>
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
          // Geschwister derselben Buchung, solange einer davon gehalten
          // wird. Ein Ring und keine andere Farbe: die Farbe sagt den
          // Zustand (Option, bestaetigt, angereist), und den zu
          // ueberschreiben hiesse, eine Information gegen eine andere zu
          // tauschen.
          const inGehaltenerGruppe = p.gruppenRef !== null
            && r.booking_ref === p.gruppenRef
          return (
            <button key={r.id}
                    onPointerDown={e => p.onMovePointerDown(r, e)}
                    // `stopPropagation` in der Behandlung: sonst liefe das
                    // Ereignis weiter an die freie Flaeche darunter und
                    // oeffnete das Menue fuer "hier ist nichts" -- ueber
                    // einem Balken, auf den man gerade gezielt hat.
                    onContextMenu={e => p.onBalkenKontext(r, e)}
                    title={`${r.last_name ?? ''} ${r.first_name ?? ''} · `
                         + `${formatDate(r.arrival, locale)} – `
                         + `${formatDate(r.departure, locale)} · `
                         + `${t(`status.${r.status}` as never)}`
                         + (r.short_note ? ` · ${r.short_note}` : '')
                         + (r.notes ? `\n${r.notes}` : '')}
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
                                ${FARBE[r.status] ?? 'bg-neutral-400'}
                                ${inGehaltenerGruppe
                                  ? 'ring-2 ring-offset-1 ring-sky-500 z-10' : ''}`}>
              {r.last_name ?? t('tape.noGuest')}
              {/*
                * Die **Kurznotiz** im Klartext, nicht die lange.
                *
                * Hier stand zuerst eine Stecknadel: sie sagte, dass es eine
                * Notiz gibt, und verschwieg welche -- also genau das, was
                * man wissen will. Dann stand hier `notes`, und das war die
                * andere Haelfte des Fehlers: der Balken ist bei einer Nacht
                * 44 Pixel breit, und die ersten Zeichen eines Absatzes sind
                * "Gast hat angerufen weg...", also auch nichts.
                *
                * `short_note` ist fuer genau diese Stelle da und auf vierzig
                * Zeichen begrenzt. Der Vorgang steht im Titel und im
                * Seitenfenster.
                */}
              {r.short_note && (
                <span className="ml-1 opacity-75">· {r.short_note}</span>
              )}
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
