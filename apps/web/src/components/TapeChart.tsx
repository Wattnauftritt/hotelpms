import { useMemo, useRef, useState, useEffect, useCallback, memo, type JSX } from 'react'
import type { TapeChart as TapeChartData } from '@hotelpms/contracts'
import { eachDay, isWeekend, isWeekEnd, daysBetween, addDays, today }
  from '../lib/dates.js'
import type { KontextZiel } from './Kontextmenue.tsx'
import { auswahlZeitraum, gruppenAuswahl, zimmerPassung, type Passung }
  from '../lib/tapeSelection.js'
import { spaltenBreite, spanne, balkenUmriss } from '../lib/tapeGeometrie.js'
import { useT, useLocale, formatDate, weekdayShort } from '../lib/i18n/index.js'
import { useEscape, istTextEingabe } from '../lib/tasten.js'
import { ReinigungsZeichen, ZahlungsZeichen, PersonenZeichen, useBalkenTitel }
  from './PlanZeichen.tsx'
import { Schwebehinweis } from './Schwebehinweis.tsx'

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
 * - **Der Balken läuft von Tagesmitte zu Tagesmitte.** Am Anreisetag beginnt
 *   er in der Mitte der Spalte, am Abreisetag endet er dort. Das ist der
 *   Tag, wie er an der Rezeption abläuft: vormittags räumt der eine,
 *   nachmittags bezieht der andere — am Wechseltag gehört das Zimmer
 *   beiden. An der Spaltenkante gezeichnet stießen zwei Aufenthalte
 *   zwischen dem 24. und dem 25. aneinander, und der 25. sah aus, als
 *   gehöre er ganz dem neuen Gast; dass am selben Morgen noch jemand drin
 *   lag, musste man sich denken. Gerechnet wird das in
 *   [`lib/tapeGeometrie.ts`](../lib/tapeGeometrie.ts).
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

/**
 * Zeilenhoehe und Breite der Zimmerspalte.
 *
 * Beide waren enger, und beides zusammen machte den Plan schwer lesbar:
 * ein Balken von 26 Pixeln mit 11-Pixel-Schrift ist aus einem Meter
 * Entfernung ein farbiger Strich. Die Zimmerspalte steht als Zahl hier und
 * nicht als Tailwind-Klasse an drei Stellen -- sie muss mit `LABEL_BREITE`
 * uebereinstimmen, weil `tagUnter` daraus den Tag unter dem Zeiger
 * rechnet, und zwei Zahlen, die uebereinstimmen muessen, tun es
 * irgendwann nicht mehr.
 */
export const ZEILE_STANDARD = 38
export const LABEL_BREITE = 176
/**
 * Spanne des Reglers fuer die Zeilenhoehe.
 *
 * Nach unten so weit, dass ein Haus mit vierzig Zimmern auf einen
 * Bildschirm passt -- dafuer ist der Regler da (Sven, 04.10.2026). Unter 18
 * Pixeln ist die Zimmernummer nicht mehr lesbar, und ein Balken, den man
 * nicht mehr greifen kann, laesst sich auch nicht verschieben. Nach oben
 * nur wenig ueber den Standard: groesser hilft niemandem, der etwas sucht.
 */
export const ZEILE_MIN = 18
export const ZEILE_MAX = 48

/**
 * Der Balken fuellt die Zeile; zwischen zwei Zeilen steht nur die
 * Gitterlinie, ein Pixel.
 *
 * Vorher hielt er oben und unten zwei bis vier Pixel Abstand, also bis zu
 * acht Pixel je Zimmer, die nichts zeigten. Bei vierzig Zimmern sind das
 * zehn Zeilen Plan. Das Gitter trennt die Zimmer ohnehin, wie in KWHotel,
 * an das die Rezeption gewoehnt ist (Sven, 04.10.2026).
 */
const GITTER = 1

/**
 * Die rechte Kante einer Tagesspalte.
 *
 * **Drei Staerken, nicht eine.** Vorher trennte jede Spalte dieselbe
 * hauchduenne Linie, und ueber dreissig oder sechzig Spalten war der Plan
 * eine Flaeche: welcher Balken an welchem Tag endet, liess sich nur durch
 * Abzaehlen an der Kopfzeile feststellen. Die Woche bekommt deshalb eine
 * kraeftigere Kante -- gesucht wird im Alltag "die Woche danach", und
 * dafuer braucht das Auge alle sieben Spalten einen Halt. Die Linie sitzt
 * am Sonntag und damit zwischen Sonntag und Montag, wo die Woche endet.
 */
const TAGESRAND = (d: string, ton: 'grau' | 'bernstein' = 'grau'): string =>
  ton === 'bernstein'
    // Im bernsteinfarbenen Band braucht die Linie denselben Ton wie der
    // Grund. Eine graue Linie auf Bernstein ergibt einen dritten Ton, den
    // niemand gemeint hat, und verschwindet dabei trotzdem fast.
    ? (isWeekEnd(d) ? 'border-r-2 border-r-amber-400' : 'border-r border-r-amber-200')
    : (isWeekEnd(d) ? 'border-r-2 border-r-neutral-400' : 'border-r border-r-neutral-200')
/**
 * So hoch ist das Band der Buchungen ohne Zimmer, in Zeilen. Vier, weil der
 * Plan darunter der eigentliche Bildschirm ist; darüber hinaus wird
 * gescrollt statt abgeschnitten.
 */
const BAND_ZEILEN = 4
/** Darunter scrollt wieder die Seite: ein Plan mit drei sichtbaren Zeilen ist keiner. */
const RASTER_MIN_HOEHE = 320
/**
 * Unter dem Plan: nur noch die Scrollleiste und der Seitenrand. Die
 * Gestenhilfe stand hier als eigene Zeile und ist in die Legende gezogen,
 * damit der Plan bis an den Fensterrand reicht.
 */
const RAUM_DARUNTER = 36
/** Ab dieser Bewegung ist es ein Ziehen und kein Klick mehr. */
const KLICK_SCHWELLE = 5

const FARBE: Record<string, string> = {
  Optional: 'bg-status-optional',
  Confirmed: 'bg-status-confirmed',
  InHouse: 'bg-status-inhouse',
  CheckedOut: 'bg-status-checkedout'
}

/**
 * Die Fuellung eines hervorgehobenen Balkens, zwei Pixel nach innen
 * versetzt; der Balken selbst traegt dann die Farbe des Rands.
 *
 * Ein Rand von innen und kein Ring von aussen: der Balken ist mit
 * `clip-path` spitz zugeschnitten (`balkenUmriss`), und der schneidet einen
 * Ring ausserhalb seiner Kanten mit ab. Die Fuellung bleibt die Farbe des
 * Zustands -- sie zu ueberschreiben tauschte eine Information gegen eine
 * andere.
 */
function Fuellung({ farbe, umriss }: { farbe: string; umriss: string }): JSX.Element {
  return <span aria-hidden style={{ clipPath: umriss }}
               className={`absolute inset-[2px] -z-10 ${farbe}`} />
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
      /**
       * Abgereist: der Balken steht fest. Der Zug bleibt ein Klick, der
       * die Reservierung oeffnet; verschieben laesst sich Vergangenheit
       * nicht, und die Schnittstelle wiese es ohnehin ab.
       */
      fest: boolean
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

/**
 * Eine Zeile der stehenden Mehrfachauswahl.
 *
 * Der Zeitraum steht **je Zeile** und nicht einmal oben: seit die
 * Schnittstelle abweichende Tage je Zimmer annimmt (`CreateBookingRoom`),
 * waere ein gemeinsamer Zeitraum eine Einschraenkung, die nur noch die
 * Oberflaeche macht.
 */
interface AuswahlZeile { resourceId: number; arrival: string; departure: string }

export interface Umzug {
  reservationRef: string
  /**
   * Das Zielzimmer, oder `null`, wenn der Balken in seiner Zeile geblieben
   * ist und nur die Tage gewandert sind.
   */
  resourceId: number | null
  roomCode: string
  /**
   * Die neuen Tage, oder `null`, wenn nur die Zeile gewechselt hat.
   *
   * Beides zugleich ist der Fall, den es lange nicht gab: schraeg gezogen,
   * anderes Zimmer **und** andere Tage. Die Geste tat bis hierher genau
   * eines von beidem -- der Zeitversatz zaehlte nur in derselben Zeile.
   * Das war als Vorsicht gedacht und war eine Sackgasse: liegt die freie
   * Luecke schraeg, laesst sie sich auch nicht in zwei Schritten
   * erreichen. Das Zielzimmer ist an den alten Tagen belegt, die alte
   * Zeile an den neuen; beide Haelften werden einzeln abgewiesen.
   */
  zeitraum: { arrival: string; departure: string } | null
}

interface Props {
  data: TapeChartData
  /** Zeilenhoehe in Pixeln, vom Regler; begrenzt auf ZEILE_MIN bis ZEILE_MAX. */
  zeile?: number
  /**
   * Sind die Zimmer nach Zimmergruppe sortiert?
   *
   * Der Plan zieht dann einen Trennstrich, wo die Gruppe wechselt. Er
   * kann das nicht selbst erkennen: nach Zimmernummer sortiert wechselt
   * die Gruppe fast in jeder Zeile, und ein Strich, der ueberall steht,
   * trennt nichts.
   */
  nachGruppe?: boolean
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
    /**
     * Jedes Zimmer mit **seinem** Zeitraum. Der oben ist die Klammer und
     * die Vorgabe der Maske; abweichende Tage stehen hier.
     */
    rooms: Array<{ resourceId: number; categoryId: number
                   arrival: string; departure: string }>
    arrival: string; departure: string
  }) => void
  /**
   * Balken auf eine andere Zimmerzeile gezogen (A3).
   *
   * Der Plan meldet nur, **was** gezogen wurde -- was daraus wird,
   * entscheidet der Bildschirm. Er zeigt es in der Maske an, und erst dort
   * wird gespeichert: ein Zug ist eine Geste von zwei Zehntelsekunden, und
   * danebengegriffen sieht genauso aus wie richtig gezogen.
   *
   * Die Warnung vor der kleineren Zimmergruppe steht deshalb auch dort und
   * nicht hier: in der Maske laesst sich das Zimmer noch aendern, und die
   * Warnung gilt dann fuer das gewaehlte.
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

export function TapeChart({ data, nachGruppe, onSelect, onCreate, onCreateGroup, onMove,
                            onChangeStay, onShiftGroup, onUnassign,
                            onKontext, zeile: zeileWunsch }: Props): JSX.Element {
  const t = useT()
  const ZEILE = Math.min(ZEILE_MAX, Math.max(ZEILE_MIN, zeileWunsch ?? ZEILE_STANDARD))
  const locale = useLocale()
  const balkenTitel = useBalkenTitel()
  const tage = useMemo(() => eachDay(data.from, data.to), [data.from, data.to])
  const rasterRef = useRef<HTMLDivElement>(null)
  /*
   * Die Breite des Rasters, gemessen statt geraten.
   *
   * Vor der ersten Messung steht hier 0, und `spaltenBreite` liefert dann
   * die Untergrenze -- der Plan ist also schon beim ersten Bild richtig
   * gezeichnet, nur schmaler, und rueckt eine Bildfolge spaeter auf. Ein
   * Ladezustand dafuer waere ein Flackern fuer nichts.
   */
  const [rasterBreite, setRasterBreite] = useState(0)
  useEffect(() => {
    const el = rasterRef.current
    if (el === null) return
    const beobachter = new ResizeObserver(eintraege => {
      setRasterBreite(eintraege[0]?.contentRect.width ?? 0)
    })
    beobachter.observe(el)
    return () => { beobachter.disconnect() }
  }, [])
  /*
   * Die Hoehe des Rasters: bis zum unteren Fensterrand, nicht weiter.
   *
   * Ohne Grenze wuchs der Rahmen mit dem Haus, und gescrollt hat die Seite.
   * Die Kopfzeile mit den Tagen klebt mit `sticky` aber am naechsten
   * scrollenden Vorfahren -- dem Rahmen, der selbst nie scrollte. Sie lief
   * also mit nach oben weg, und ab dem zehnten Zimmer stand kein Datum mehr
   * ueber den Balken. Begrenzt scrollt der Rahmen selbst, und die Kopfzeile
   * bleibt stehen.
   *
   * Gemessen statt als feste Zahl im Stil: was ueber dem Plan steht (Leiste,
   * Legende), bricht je nach Fensterbreite in eine oder zwei Zeilen um. Die
   * Untergrenze haelt den Plan auf einem niedrigen Fenster benutzbar; dann
   * scrollt eben wieder die Seite mit.
   */
  const [rasterHoehe, setRasterHoehe] = useState<number | null>(null)
  useEffect(() => {
    const el = rasterRef.current
    if (el === null) return
    const messen = (): void => {
      const oben = el.getBoundingClientRect().top + window.scrollY
      setRasterHoehe(Math.max(RASTER_MIN_HOEHE,
                              Math.floor(window.innerHeight - oben - RAUM_DARUNTER)))
    }
    messen()
    // Der Koerper und nicht nur das Fenster: die Legende erscheint erst mit
    // den Daten und schiebt den Plan nach unten, ohne dass sich das Fenster
    // aendert.
    const beobachter = new ResizeObserver(messen)
    beobachter.observe(document.body)
    window.addEventListener('resize', messen)
    return () => {
      beobachter.disconnect()
      window.removeEventListener('resize', messen)
    }
  }, [])
  /** Die Breite einer Tagesspalte auf diesem Bildschirm. */
  const spalte = spaltenBreite(rasterBreite - LABEL_BREITE, tage.length)
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
   * Jetzt sammelt jeder Zug mit Modifikator dazu, und **jeder bringt seinen
   * eigenen Zeitraum mit**. Vorher galt der zuletzt gezogene fuer alle; das
   * war die naheliegende Vereinfachung und die falsche, denn eine
   * Reisegruppe reist selten geschlossen an -- das Brautpaar bleibt drei
   * Naechte, die Eltern zwei. Wer dieselbe Zeile noch einmal zieht, aendert
   * ihren Zeitraum; wer eine neue zieht, legt sie mit ihrem eigenen dazu.
   */
  const [auswahl, setAuswahl] = useState<AuswahlZeile[] | null>(null)
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

  /**
   * Wo im Raster liegt ein Zeitraum, auf den sichtbaren Ausschnitt
   * beschnitten. Von Tagesmitte zu Tagesmitte -- die Begruendung steht in
   * `lib/tapeGeometrie.ts`.
   */
  const balken = useCallback((von: string, bis: string) => spanne(
    daysBetween(data.from, von), daysBetween(data.from, bis), tage.length, spalte),
  [data.from, tage.length, spalte])

  /** Spitz, wo der Aufenthalt im Ausschnitt anfaengt oder endet, sonst flach. */
  const umriss = useCallback((von: string, bis: string) => balkenUmriss(
    daysBetween(data.from, von) >= 0, daysBetween(data.from, bis) < tage.length),
  [data.from, tage.length])

  /** Tagesindex unter dem Zeiger, auf den sichtbaren Ausschnitt begrenzt. */
  const tagUnter = useCallback((clientX: number): number => {
    const rect = rasterRef.current?.getBoundingClientRect()
    if (!rect) return 0
    const x = clientX - rect.left - LABEL_BREITE
    return Math.max(0, Math.min(tage.length - 1, Math.floor(x / spalte)))
  }, [tage.length, spalte])

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
      const bewegt = !d.fest && (d.moved
        || Math.abs(e.clientX - d.pointerDownX) > KLICK_SCHWELLE
        || Math.abs(e.clientY - d.pointerDownY) > KLICK_SCHWELLE)
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
        /*
         * **Auch ein einzelnes Zimmer wird erst markiert, nicht gebucht.**
         *
         * Hier oeffnete das Loslassen sofort die Buchungsmaske. Das war
         * der schnelle Weg fuer den haeufigsten Fall und zugleich eine
         * Sackgasse: solange die Maske aufgeht, bevor man die Maustaste
         * losgelassen hat, kommt niemand dazu, mit dem rechten Knopf etwas
         * anderes mit der Markierung zu tun -- ein Zimmer sperren zum
         * Beispiel. Eine Geste, ein Ergebnis, und kein zweiter Gedanke
         * moeglich.
         *
         * Jetzt gilt fuer eine Zeile dasselbe wie fuer acht: der Zug
         * markiert, und **danach** wird entschieden -- mit der Leiste
         * unten, mit Enter oder mit dem rechten Knopf. Esc raeumt die
         * Markierung weg, ein neuer Zug ohne Modifikator ersetzt sie.
         */
        const z = auswahlZeitraum(tage, d.startDay, d.day)
        setAuswahl([{ resourceId: d.resourceId, arrival: z.arrival, departure: z.departure }])
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
        setAuswahl(vorher => {
          /*
           * Jeder Zug bringt seinen eigenen Zeitraum mit.
           *
           * Wer dieselbe Zeile noch einmal zieht, meint einen anderen
           * Zeitraum fuer sie -- deshalb ersetzt der neue Zug die Zeile,
           * statt sie ein zweites Mal aufzunehmen. Ein `Set` ueber die
           * Zimmer reichte dafuer nicht mehr: es haette den alten Zeitraum
           * behalten.
           */
          const dazu = new Set(neu.rooms.map(r => r.resourceId))
          return [
            ...(vorher ?? []).filter(z => !dazu.has(z.resourceId)),
            ...neu.rooms.map(r => ({ resourceId: r.resourceId,
                                     arrival: neu.arrival, departure: neu.departure }))
          // In der Reihenfolge des Plans, nicht in der des Ziehens: die
          // Leiste und die Maske lesen sich sonst von unten nach oben.
          ].sort((a, b) => (zeileVonZimmer.get(a.resourceId) ?? 0)
                         - (zeileVonZimmer.get(b.resourceId) ?? 0))
        })
      } else if (d.kind === 'move') {
        // Der Zeitversatz zaehlt jetzt auch dann, wenn die Zeile gewechselt
        // hat -- siehe `Umzug.zeitraum`.
        const versatz = d.day - d.startDay
        const zeileAnders = d.overResourceId !== null
          && d.overResourceId !== d.quelleResourceId
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
        } else if (d.moved && !zeileAnders && versatz !== 0
                   && d.bookingRooms > 1 && d.alleDerGruppe) {
          /*
           * Mit **Alt** waagerecht gezogen: die ganze Gruppe wandert.
           *
           * Nur in derselben Zeile. Eine Gruppe in eine andere Zeile zu
           * ziehen hiesse, acht Zimmer in eines zu legen; gemeint ist
           * dann dieses eine, und das faellt in den Fall darunter.
           *
           * Die Vorgabe ist das einzelne Zimmer, weil das die vorsichtige
           * Richtung ist: wer daneben greift, verschiebt eine Reservierung
           * und nicht acht -- acht zurueckzuholen ist Arbeit, eine ist ein
           * Zug.
           */
          onShiftGroup?.(d.bookingRef, versatz)
        } else if (d.moved && (zeileAnders || versatz !== 0)) {
          /*
           * **Eine Geste, beide Achsen.** Zeile, Tage oder beides -- was
           * sich geaendert hat, geht mit; der Bildschirm entscheidet
           * daraus, welcher Aufruf es wird.
           */
          const ziel = zeileAnders ? zimmerNach.get(d.overResourceId!) : undefined
          onMove?.({
            reservationRef: d.reservationRef,
            resourceId: zeileAnders ? d.overResourceId : null,
            roomCode: ziel?.code ?? '',
            zeitraum: versatz === 0 ? null : {
              arrival: addDays(d.arrival, versatz),
              departure: addDays(d.departure, versatz) }
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
    /**
     * Je Zeile ein eigenes Rechteck.
     *
     * Vorher stand hier **ein** Rechteck fuer alle markierten Zeilen, weil
     * der Zeitraum einer fuer alle war. Seit jede Zeile ihren eigenen
     * haben darf, waere das eine Vorschau, die luegt: acht gleich breite
     * Kaesten fuer acht verschieden lange Aufenthalte.
     */
    kaesten: Map<number, { left: number; width: number; naechte?: number }>
    /** Zeile, an der die Anzahl steht. Nur bei der Mehrfachauswahl gesetzt. */
    zaehlerAn?: number
    /** Zimmer der Gruppe, die beim Loslassen mitwandern. */
    gruppenZahl?: number
  } | null => {
    /** Ein Rechteck fuer eine einzelne Zeile -- der haeufigste Fall. */
    const eins = (resourceId: number, left: number, width: number, naechte?: number) =>
      ({ kaesten: new Map([[resourceId, { left, width, naechte }]]) })
    /*
     * Die Naechte stehen in der Markierung (Sven, 04.10.2026: "2 N.").
     * Gezaehlt wird aus den Tagen, nicht aus der Breite: am Rand des
     * Ausschnitts ist der Kasten abgeschnitten, der Aufenthalt nicht.
     */
    const stehend = (z: AuswahlZeile) =>
      ({ ...balken(z.arrival, z.departure), naechte: daysBetween(z.arrival, z.departure) })

    if (drag === null) {
      // Kein Zug, aber eine stehende Auswahl: die Schattenbalken bleiben
      // sichtbar, sonst waere nicht zu sehen, was ausgewaehlt ist.
      if (auswahl === null || auswahl.length === 0) return null
      return {
        kaesten: new Map(auswahl.map(z => [z.resourceId, stehend(z)])),
        zaehlerAn: auswahl[0]!.resourceId
      }
    }
    if (drag.kind === 'create') {
      const von = Math.min(drag.startDay, drag.day)
      const bis = Math.max(drag.startDay, drag.day)
      // `bis` ist der letzte **Nacht**-Tag, die Abreise liegt einen dahinter.
      const k = spanne(von, bis + 1, tage.length, spalte)
      return eins(drag.resourceId, k.left, k.width, bis + 1 - von)
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
       * Streifen.
       *
       * Die bereits gewaehlten Zeilen behalten dabei ihre eigene Breite:
       * sie wandern **nicht** mit, weil der neue Zug nur die Zeilen meint,
       * ueber die er laeuft.
       */
      const laufend = { ...spanne(von, bis + 1, tage.length, spalte), naechte: bis + 1 - von }
      const kaesten = new Map((auswahl ?? []).map(z => [z.resourceId, stehend(z)]))
      for (const u of zeilen) kaesten.set(u.id, laufend)
      const erste = data.units.find(u => kaesten.has(u.id))
      return { kaesten, zaehlerAn: erste?.id }
    }
    if (drag.kind === 'resize') {
      const startTag = drag.edge === 'start' ? drag.day : daysBetween(data.from, drag.arrival)
      const endTag = drag.edge === 'end' ? drag.day + 1 : daysBetween(data.from, drag.departure)
      const von = Math.max(0, Math.min(startTag, endTag - 1))
      const bis = Math.max(von + 1, endTag)
      const k = spanne(von, bis, tage.length, spalte)
      return eins(drag.resourceId, k.left, k.width, bis - von)
    }
    if (drag.moved && drag.overResourceId !== null) {
      /*
       * **Der Schatten liegt, wo der Balken landet -- auf beiden Achsen.**
       *
       * Hier stand: liegt der Zeiger in einer anderen Zeile, bleibt der
       * Zeitraum; liegt er in derselben, bleibt das Zimmer. Beides zugleich
       * waeren zwei Aufrufe gewesen, und dazwischen ein Zustand, den
       * niemand gewollt hat.
       *
       * Die Route kann es inzwischen in einem: `change-stay` nimmt das
       * Zielzimmer mit. Der Schatten darf deshalb zeigen, was wirklich
       * passiert -- und muss es, denn ein Schatten, der nur die halbe
       * Bewegung vorwegnimmt, ist eine Vorschau, die luegt.
       */
      const versatz = drag.day - drag.startDay
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
        kaesten: new Map([[drag.overResourceId, b]]),
        // Die Gruppe wandert nur in derselben Zeile mit; quer gezogen ist
        // dieses eine Zimmer gemeint.
        gruppenZahl: versatz !== 0 && drag.overResourceId === drag.quelleResourceId
          && drag.bookingRooms > 1 && drag.alleDerGruppe
          ? drag.bookingRooms : undefined }
    }
    return null
  }, [drag, auswahl, balken, data.from, data.units, tage.length, spalte])

  /**
   * Die Klammer um die Auswahl: frueheste Anreise, spaeteste Abreise -- und
   * ob die Zimmer ueberhaupt dieselben Tage haben.
   *
   * Sie ist die Vorgabe fuer die Maske und fuer jedes Zimmer richtig, das
   * nicht abweicht. `gemischt` sagt, ob daneben noch etwas zu sagen ist.
   */
  const klammer = useMemo(() => {
    const zeilen = auswahl ?? []
    if (zeilen.length === 0) return { arrival: '', departure: '', gemischt: false }
    const an = zeilen.map(z => z.arrival).sort()
    const ab = zeilen.map(z => z.departure).sort()
    return {
      arrival: an[0]!, departure: ab.at(-1)!,
      gemischt: an[0] !== an.at(-1) || ab[0] !== ab.at(-1)
    }
  }, [auswahl])

  /*
   * Esc hebt die Auswahl auf.
   *
   * Der zweite Weg zurueck neben dem Klick ohne Modifikator, und der
   * gewohnte: wer etwas ausgewaehlt hat und es doch nicht will, drueckt
   * Esc. Ueber `useEscape` und nicht mit eigenem Horcher am Fenster: liegt
   * ein Kontextmenue oder eine Maske darueber, meint der Druck **die** und
   * nicht die Markierung darunter -- sonst war mit dem Menue auch das weg,
   * worauf es sich bezog.
   */
  useEscape(() => setAuswahl(null), auswahl !== null)

  /*
   * Enter bucht, was markiert ist -- derselbe Weg wie der Knopf in der
   * Leiste. Der Knopf ist der Weg fuer den, der die Taste nicht kennt; die
   * Taste der fuer den, der die Hand nicht von der Tastatur nehmen will.
   *
   * Nicht, waehrend jemand in einem Feld tippt: ein Enter im Suchfeld ueber
   * dem Plan meint das Feld, nicht die Markierung. Und nicht, solange eine
   * Maske offen ist: dort ist Enter das Abschicken **dieser** Maske.
   */
  useEffect(() => {
    if (auswahl === null) return
    const aufTaste = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter') return
      if (istTextEingabe(e.target)) return
      if (document.querySelector('[role="dialog"]') !== null) return
      e.preventDefault()
      auswahlBuchen()
    }
    window.addEventListener('keydown', aufTaste)
    return () => { window.removeEventListener('keydown', aufTaste) }
    /*
     * Ohne Abhaengigkeitsliste, also bei jedem Bild neu eingehaengt.
     *
     * Der Horcher ruft `auswahlBuchen`, und das liest die Markierung, die
     * Zimmer und die Rueckrufe von aussen. Mit einer Liste haette er eine
     * Fassung davon festgehalten -- und Enter buchte, was beim letzten
     * Wechsel der Markierung dastand, nicht was jetzt dasteht. Ein
     * `addEventListener` je Bild ist dagegen nichts.
     */
  })

  /**
   * Was aus der Markierung wird, wenn sie gebucht wird.
   *
   * **Ein Zimmer ist keine Gruppe.** Eine Gruppenbuchung mit einem Zimmer
   * waere eine Buchung mit einem Besteller, einer Namensliste und einer
   * Aufteilung -- fuer einen Gast, der ein Zimmer nimmt. Die
   * Reservierungsmaske ist dafuer die richtige, und sie war es schon
   * immer; nur fuehrte der Weg dorthin bisher ueber das Loslassen der
   * Maustaste statt ueber eine Entscheidung.
   */
  const auswahlBuchen = (): void => {
    if (auswahl === null || auswahl.length === 0) return
    if (auswahl.length === 1) {
      const z = auswahl[0]!
      const u = zimmerNach.get(z.resourceId)
      if (u !== undefined) {
        onCreate?.({ resourceId: z.resourceId, categoryId: u.category_id,
                     arrival: z.arrival, departure: z.departure })
      }
    } else {
      onCreateGroup?.({
        rooms: auswahl.flatMap(z => {
          const u = zimmerNach.get(z.resourceId)
          return u === undefined ? [] : [{
            resourceId: z.resourceId, categoryId: u.category_id,
            arrival: z.arrival, departure: z.departure }]
        }),
        // Oben die Klammer: sie ist die Vorgabe der Maske und fuer jedes
        // Zimmer richtig, das nicht abweicht.
        arrival: klammer.arrival, departure: klammer.departure
      })
    }
    /*
     * Buchen leert die Auswahl.
     *
     * Sie ist ab hier in der Maske aufgehoben -- dort stehen dieselben
     * Zimmer und lassen sich einzeln entfernen. Stehen zu bleiben hiesse,
     * nach dem Anlegen einen Schatten ueber den frischen Balken zu haben,
     * der aussieht wie eine zweite, ungebuchte Gruppe.
     */
    setAuswahl(null)
  }

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
               fest: r.status === 'CheckedOut',
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
      /*
       * Liegt der Klick **in** der stehenden Markierung, meint er sie --
       * und zwar ganz. Vorher erwischte man nach einer Mehrfachmarkierung
       * genau eines der Zimmer, ohne dass irgendwo stand, welches.
       *
       * Geprueft wird die Zelle und nicht nur die Zeile: wer seine
       * markierten Zimmer am 20. anklickt, waehrend die Markierung auf dem
       * 5. liegt, zeigt auf den 20.
       */
      const inAuswahl = (auswahl ?? []).some(
        z => z.resourceId === resourceId && anreise >= z.arrival && anreise < z.departure)

      /*
       * **Neben einer Mehrfachmarkierung passiert nichts.**
       *
       * Wer acht Zimmer zusammengesucht hat und daneben klickt, meint
       * nicht, sie wegzuwerfen. Vorher tat der Klick genau das -- lautlos
       * und fuer ein Menue, das sich dann auf ein einzelnes Zimmer bezog.
       * Die Grenze liegt bei zwei, weil eine Mehrfachmarkierung Arbeit
       * ist: bei einer einzelnen Zelle ist der Klick daneben offensichtlich
       * der Wunsch, woanders hinzuzeigen.
       */
      if (!inAuswahl && auswahl !== null && auswahl.length > 1) return

      /*
       * Der rechte Knopf markiert, was er trifft -- wie der linke.
       *
       * Ein Menue, das "hier anlegen" anbietet, ohne dass zu sehen ist,
       * **wo** hier ist, laesst die Wahl des Tages dem Gedaechtnis. Die
       * Markierung ist die optische Kontrolle davor, und sie bleibt
       * stehen, waehrend das Menue offen ist.
       */
      if (!inAuswahl) {
        setAuswahl([{ resourceId, arrival: anreise, departure: addDays(anreise, 1) }])
      }

      onKontext?.({
        art: 'frei', punkt: { x: e.clientX, y: e.clientY },
        resourceId, categoryId,
        roomCode: zimmerNach.get(resourceId)?.code ?? '',
        // **Eine Nacht**, nicht der sichtbare Zeitraum. Wer im Plan rechts
        // klickt, meint diesen Tag; ein Vorschlag ueber sechzig Tage waere
        // eine Buchung, die niemand wollte.
        arrival: anreise, departure: addDays(anreise, 1),
        leeren: () => setAuswahl(null),
        auswahl: !inAuswahl || auswahl === null ? null : auswahl.flatMap(z => {
          const u = zimmerNach.get(z.resourceId)
          return u === undefined ? [] : [{
            resourceId: z.resourceId, categoryId: u.category_id, roomCode: u.code,
            arrival: z.arrival, departure: z.departure }]
        }) })
    }, [onKontext, tagUnter, tage, zimmerNach, auswahl])

  /*
   * Der rechte Knopf auf der Zimmernummer.
   *
   * Gehoert die Zeile zur stehenden Markierung, meint er alle markierten
   * Zimmer -- alle oder keines, wie auf der freien Flaeche. Sonst das eine
   * Zimmer, und die Markierung bleibt unangetastet: anders als auf der
   * Flaeche gibt es hier keinen Tag, auf den man zeigen koennte, also auch
   * nichts neu zu markieren.
   */
  const zimmerKontext = useCallback((resourceId: number, e: React.MouseEvent) => {
    e.preventDefault()
    const inAuswahl = (auswahl ?? []).some(z => z.resourceId === resourceId)
    const ids = inAuswahl && auswahl !== null ? auswahl.map(z => z.resourceId) : [resourceId]
    onKontext?.({
      art: 'zimmer', punkt: { x: e.clientX, y: e.clientY },
      zimmer: ids.map(id => ({ resourceId: id, roomCode: zimmerNach.get(id)?.code ?? '' })) })
  }, [onKontext, auswahl, zimmerNach])

  const beginneGroesseAendern = useCallback(
    (r: ReservationRow, edge: 'start' | 'end', e: React.PointerEvent) => {
      if (nurLinks(e)) return
      e.preventDefault()
      e.stopPropagation()
      setDragState({ kind: 'resize', reservationRef: r.public_ref, resourceId: r.resource_id!,
                 edge, arrival: r.arrival, departure: r.departure, day: tagUnter(e.clientX) })
    }, [tagUnter, setDragState])

  return (
    <div className="overflow-auto border border-neutral-200 rounded-sm" ref={rasterRef}
         style={rasterHoehe === null ? undefined : { maxHeight: rasterHoehe }}>
      <Schwebehinweis bereich={rasterRef} />
      <div style={{ minWidth: LABEL_BREITE + tage.length * spalte }}>
        {/* Kopfzeile mit Tagen */}
        <div className="flex sticky top-0 z-20 bg-white border-b border-neutral-200">
          {/*
            * Waehrend ein Balken mit Zimmer gehalten wird, ist die Ecke oben
            * links die Ablage "ohne Zimmer".
            *
            * Vorher klappte dafuer das Band ueber dem Plan auf, sobald man
            * einen Balken anfasste, wenn es leer war. Der ganze Plan rueckte
            * um eine Zeile nach unten, und der Balken rutschte unter dem
            * Zeiger weg (Sven, 04.10.2026: "super irritierend"). Die Ecke
            * steht fest und klebt beim Scrollen oben, also verschiebt sich
            * nichts, und sie ist sichtbar, wo immer man im Plan zieht.
            *
            * Die Ecke und nicht die ganze Kopfzeile: ueber den Tagen endet
            * auch ein Zug, der knapp danebengeht, und daraus ein Abnehmen zu
            * machen, kostete bei jedem Fehlgriff ein Zimmer.
            */}
          <div style={{ width: LABEL_BREITE }}
               data-unassigned-band={bandAlsZiel ? '' : undefined}
               className={`shrink-0 px-2 py-1.5 text-xs border-r transition-colors
                           ${!bandAlsZiel
                             ? 'font-medium text-neutral-500 border-neutral-200'
                             : drag.ueberBand
                               ? 'bg-amber-200 text-amber-900 border-amber-500 ring-2 ring-inset ring-amber-500'
                               : 'bg-amber-50 text-amber-800 border-amber-200 ring-2 ring-inset ring-amber-300'}`}>
            {bandAlsZiel ? (
              <div className="font-medium leading-tight line-clamp-2">
                {t('plan.dropToUnassign')}
              </div>
            ) : t('common.room')}
          </div>
          {tage.map(d => (
            <div key={d}
                 style={{ width: spalte }}
                 className={`shrink-0 text-center text-xs leading-tight py-1.5
                             ${TAGESRAND(d)}
                             ${d === heute ? 'bg-sky-200 text-sky-950'
                               : isWeekend(d) ? 'bg-neutral-100 text-neutral-600'
                               : ''}`}>
              <div className={d === heute ? 'font-medium' : 'text-neutral-400'}>
                {weekdayShort(d, locale)}
              </div>
              <div className={`tabular-nums ${d === heute ? 'font-bold' : 'font-medium'}`}>
                {d.slice(8)}
              </div>
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
          * Leer bleibt das Band weg, auch waehrend eines Zugs: die Ablage
          * ist dann die Ecke oben links (siehe Kopfzeile). Liegt etwas
          * darin, ist es selbst auch Ablage -- es steht ja schon da, und
          * nichts verschiebt sich.
          */}
        {nichtZugewiesen.length > 0 && (
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
                    style={{ width: LABEL_BREITE }}
                    className="shrink-0 px-2 py-1 text-xs text-amber-800 text-left
                               border-r border-amber-200 disabled:cursor-default">
              <div className="font-medium">
                {nichtZugewiesen.length > BAND_ZEILEN && (bandOffen ? '▾ ' : '▸ ')}
                {t('today.needsRoom')} ({nichtZugewiesen.length})
              </div>
              {/* Der Satz zur Ablage steht in der Ecke, nicht hier: eine
                  zusaetzliche Zeile machte das Band beim Anfassen hoeher,
                  und der Plan darunter rueckte nach. */}
              {!bandOffen && verdeckt !== null && (
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
            <div className="relative grow overflow-y-auto overflow-x-hidden overscroll-contain"
                 style={{ maxHeight: ZEILE * (bandOffen ? nichtZugewiesen.length
                                                        : BAND_ZEILEN) }}>
              <div className="relative"
                   style={{ height: ZEILE * nichtZugewiesen.length }}>
                {/*
                  * Dieselben Tagesgrenzen wie unten im Plan, nur in
                  * Bernstein und ohne Flaechenfarbe: das Band hat seinen
                  * eigenen Grund, und eine Wochenendfaerbung darueber ergibt
                  * einen dritten Ton, den niemand gemeint hat. Ohne die
                  * Linien liess sich hier nicht ablesen, an welchem Tag eine
                  * Buchung anreist -- und genau danach wird in diesem Band
                  * gesucht.
                  */}
                {tage.map((d, i) => (
                  <div key={d}
                       style={{ left: i * spalte, width: spalte }}
                       className={`absolute inset-y-0 pointer-events-none
                                   ${TAGESRAND(d, 'bernstein')}`} />
                ))}
                {nichtZugewiesen.map((r, i) => {
                  const b = balken(r.arrival, r.departure)
                  const gruppe = gruppeNach.get(r.category_id)
                  return (
                    <button key={r.id} data-reservation-ref={r.public_ref}
                            onPointerDown={e => beginneVerschieben(r, e)}
                            // Die Zimmergruppe nur hier: beim Ziehen aus dem
                            // Band entscheidet sich, in welches Zimmer.
                            data-tip={balkenTitel(r, gruppe?.name)}
                            style={{ ...b, top: i * ZEILE, height: ZEILE - GITTER,
                                     lineHeight: `${ZEILE - GITTER}px`,
                                     clipPath: umriss(r.arrival, r.departure) }}
                            /*
                             * Ein roter Rand, wenn die Anreise binnen zwei
                             * Tagen ist.
                             *
                             * Eine Buchung ohne Zimmer ist nicht per se ein
                             * Problem -- im November ist sie normal, morgen
                             * ist sie eine Lage. Ohne diesen Unterschied
                             * sieht das Band an einem ruhigen Tag genauso
                             * aus wie an dem, an dem gleich jemand am
                             * Tresen steht.
                             *
                             * Ein Rand und keine andere Fuellfarbe: die
                             * Fuellung sagt den Zustand (Option,
                             * bestaetigt), und den zu ueberschreiben
                             * tauschte eine Information gegen eine andere.
                             */
                            className={`absolute isolate flex items-center px-2
                                        text-xs text-white text-left cursor-move
                                        hover:brightness-110
                                        ${dringlich(r.arrival)
                                          ? 'bg-red-600' : FARBE[r.status] ?? 'bg-neutral-400'}`}>
                      {dringlich(r.arrival) && (
                        <Fuellung farbe={FARBE[r.status] ?? 'bg-neutral-400'}
                                  umriss={umriss(r.arrival, r.departure)} />
                      )}
                      {/* Die Zimmergruppe steht am Balken, nicht nur im
                          Hinweis: hier liegen Doppelzimmer, Einzelzimmer und
                          Suiten nebeneinander, und beim Ziehen entscheidet
                          sich in einer Sekunde, wohin. */}
                      {gruppe !== undefined && (
                        <span className="mr-1 px-1 rounded-sm bg-black/25 tabular-nums">
                          {gruppe.code}
                        </span>
                      )}
                      <SchlossZeichen fest={r.room_fixed} />
                      <ZahlungsZeichen zahlung={r.payment} />
                      <span className="truncate min-w-0">
                        {r.last_name ?? t('tape.noGuest')}
                        {/* Die Notiz gehoert auf den Balken, nicht zwei Klicks
                            tiefer: hier steht, was beim naechsten Blick auf den
                            Plan zaehlt -- "Balkon", "1. Stock", "Spaetanreise".
                            Die Schnittstelle liefert sie seit jeher mit, nur
                            angezeigt wurde sie nie. */}
                        {r.short_note && (
                          <span className="ml-1 opacity-75">· {r.short_note}</span>
                        )}
                      </span>
                      <PersonenZeichen r={r} />
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
        {data.units.map((u, i) => {
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
          const kasten = ghost?.kaesten.get(u.id)
          return (
            <Zimmerzeile key={u.id} unit={u} tage={tage} zeile={ZEILE}
                         reservations={jeZimmer.get(u.id)} blocks={blockeJeZimmer.get(u.id)}
                         balken={balken} umriss={umriss} spalte={spalte} heute={heute}
                         gruppenAnfang={nachGruppe === true && i > 0
                           && data.units[i - 1]?.category_id !== u.category_id}
                         passung={passung}
                         versteckterRef={versteckterRef}
                         gruppenRef={gehaltenerGruppenRef}
                         ghostHier={kasten !== undefined}
                         ghostLinks={kasten?.left ?? 0}
                         ghostBreite={kasten?.width ?? 0}
                         ghostNaechte={kasten?.naechte ?? null}
                         /* Erst ab zwei Zeilen: "1 rooms" stand sonst im
                            Schatten, sobald jemand ein einzelnes Zimmer
                            aufzieht -- und die Zahl beantwortet dort keine
                            Frage, die Zeile steht ja daneben. */
                         ghostZaehler={ghost?.gruppenZahl ?? (
                           ghost?.zaehlerAn === u.id && ghost.kaesten.size > 1
                             ? ghost.kaesten.size : null)}
                         onCreatePointerDown={beginneErstellen}
                         onMovePointerDown={beginneVerschieben}
                         onResizePointerDown={beginneGroesseAendern}
                         onBalkenKontext={balkenKontext}
                         onFreiKontext={freiKontext}
                         onZimmerKontext={zimmerKontext} />
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
        * **Am Fenster und nicht am Raster.** Hier stand `sticky bottom-0`,
        * und das klang richtig: unten kleben, oben die Kopfzeile mit den
        * Tagen freilassen, die man beim Auswaehlen eines Zeitraums liest.
        * Nur klebt `sticky` am naechsten scrollenden Vorfahren, und das ist
        * der Rahmen des Plans -- der hat keine feste Hoehe, waechst also
        * mit dem Haus und endet bei vierzig Zimmern weit unterhalb des
        * Bildschirms. Die Leiste sass damit am Fuss eines Kastens, den man
        * erst suchen musste: markiert, und dann nichts zu sehen.
        *
        * `fixed` haelt sie am unteren Fensterrand, wo sie bei jedem
        * Scrollstand steht. Der Dialog liegt mit `z-50` darueber, die
        * Leiste verdeckt ihn also nicht.
        */}
      {auswahl !== null && auswahl.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 flex flex-wrap items-center gap-2
                        bg-neutral-900 text-white px-3 py-1.5 text-sm shadow-lg">
          <span className="font-medium">
            {auswahl.length === 1 ? t('plan.selectedRoom')
              : t('plan.selectedRooms', { n: auswahl.length })}
          </span>
          {/*
            * Der Zeitraum, und wenn die Zimmer verschiedene haben, die
            * Klammer darum plus ein Hinweis. Nur die Klammer zu zeigen
            * hiesse, eine Deckungsgleichheit zu behaupten, die es nicht
            * gibt; sie wegzulassen hiesse, gar nichts ueber die Tage zu
            * sagen. Welches Zimmer welche hat, steht in der Maske.
            */}
          <span className="opacity-75 text-xs">
            {formatDate(klammer.arrival, locale)} – {formatDate(klammer.departure, locale)}
            {/* Die Naechte nur, wenn sie fuer alle gelten: bei gemischten
                Zeitraeumen stehen sie je Zeile in der Markierung, und eine
                Zahl fuer die Klammer stimmte fuer kein einzelnes Zimmer. */}
            {klammer.gemischt
              ? ` · ${t('plan.mixedDates')}`
              : ` · ${t('tape.nightsShort', { n: daysBetween(klammer.arrival, klammer.departure) })}`}
          </span>
          <div className="grow" />
          {/* Enter tut dasselbe; der Knopf ist der Weg fuer den, der das
              nicht weiss. Die Begruendung steht an `auswahlBuchen`. */}
          <button type="button" onClick={auswahlBuchen}
                  className="px-3 py-1 rounded-sm bg-white text-neutral-900 text-sm">
            {auswahl.length === 1 ? t('booking.title') : t('plan.bookSelection')}
          </button>
          {/* Esc tut dasselbe; der Knopf ist der Weg fuer den, der das
              nicht weiss. */}
          <button type="button" onClick={() => setAuswahl(null)}
                  className="px-2 py-1 rounded-sm border border-white/40 text-sm">
            {t('plan.clearSelection')}
          </button>
        </div>
      )}
    </div>
  )
}

interface ZimmerzeileProps {
  unit: TapeChartData['units'][number]
  /** Zeilenhoehe in Pixeln, vom Regler. */
  zeile: number
  tage: readonly string[]
  reservations: ReservationRow[] | undefined
  blocks: TapeChartData['blocks'] | undefined
  /** Stabil ueber `useCallback` in der Elternkomponente. */
  balken: (von: string, bis: string) => { left: number; width: number }
  /** Ebenso stabil; die Umrisslinie als `clip-path`. */
  umriss: (von: string, bis: string) => string
  /** Breite einer Tagesspalte. Eine Zahl, also vertraegt `memo` sie. */
  spalte: number
  /** Der heutige Tag, fuer die hervorgehobene Spalte. */
  heute: string
  /**
   * Erste Zeile einer Zimmergruppe -- setzt den Trennstrich darueber.
   *
   * Nur beim Sortieren nach Gruppe gesetzt: nach Zimmernummer sortiert
   * wechselt die Gruppe fast in jeder Zeile, und ein Strich, der ueberall
   * steht, trennt nichts.
   */
  gruppenAnfang: boolean
  passung: Passung | null
  versteckterRef: string | null
  /** Buchung, deren Balken gerade festgehalten wird. Hebt ihre Geschwister hervor. */
  gruppenRef: string | null
  ghostHier: boolean
  ghostLinks: number
  ghostBreite: number
  /** Naechte der Markierung; nicht beim Verschieben, das aendert sie nicht. */
  ghostNaechte: number | null
  ghostZaehler: number | null
  onCreatePointerDown: (resourceId: number, categoryId: number, e: React.PointerEvent) => void
  onMovePointerDown: (r: ReservationRow, e: React.PointerEvent) => void
  onResizePointerDown: (r: ReservationRow, edge: 'start' | 'end', e: React.PointerEvent) => void
  /** Rechter Knopf auf einem Balken dieser Zeile. */
  onBalkenKontext: (r: ReservationRow, e: React.MouseEvent) => void
  /** Rechter Knopf auf freier Flaeche dieser Zeile. */
  onFreiKontext: (resourceId: number, categoryId: number, e: React.MouseEvent) => void
  /** Rechter Knopf auf der Zimmernummer. */
  onZimmerKontext: (resourceId: number, e: React.MouseEvent) => void
}

/**
 * Eine Zimmerzeile, gemerkt. Die Begruendung steht am Dateikopf: nur
 * einfache, ueber einen Zug hinweg stabile Merkmale, nie das rohe
 * `drag`-Objekt -- sonst zeichnete jede Zeile bei jedem `pointermove` neu,
 * genau der Fehler, den das Preisraster schon einmal gemessen hat.
 */
const Zimmerzeile = memo(function Zimmerzeile(p: ZimmerzeileProps): JSX.Element {
  const t = useT()
  const ZEILE = p.zeile
  // Die Gitterlinie unten und, am Anfang einer Zimmergruppe, die
  // kraeftigere oben liegen innerhalb der Zeile; der Balken fuellt den Rest.
  const innen = ZEILE - GITTER - (p.gruppenAnfang ? 2 : 0)
  const balkenHoehe = { top: 0, height: innen, lineHeight: `${innen}px` }
  const balkenTitel = useBalkenTitel()
  const u = p.unit
  return (
    <div className={`flex relative border-b border-neutral-200
                     ${p.gruppenAnfang ? 'border-t-2 border-t-neutral-400' : ''}
                     ${p.passung === 'passt' ? 'bg-emerald-50/70' : ''}
                     ${p.passung === 'zuKlein' ? 'bg-red-50/70' : ''}`}
         data-resource-row={u.id}
         style={{ height: ZEILE }}>
      <div style={{ width: LABEL_BREITE }}
           onContextMenu={e => p.onZimmerKontext(u.id, e)}
           className="shrink-0 px-2 text-xs border-r border-neutral-200
                      flex items-center gap-2 overflow-hidden">
        <span className={`${ZEILE < 26 ? 'text-xs' : 'text-sm'} font-medium tabular-nums`}
        >{u.code}</span>
        {/* Direkt hinter der Nummer und nicht am Zeilenende: die Nummer
            ist, was das Auge sucht, und die Gruppe daneben wird bei
            schmaler Spalte abgeschnitten -- das Zeichen soll es nicht. */}
        <ReinigungsZeichen stand={u.housekeeping} />
        {/* Der Name statt der Gruppe, wenn es einen gibt: die Gruppe zeigt
            der Plan schon durch die Trennlinie und auf dem Balken, den
            Namen sonst nirgends. Die Gruppe bleibt im Titel. */}
        <span className={`truncate ${u.name === null ? 'text-neutral-400' : 'text-neutral-700'}`}
              title={u.name === null ? u.category_name : `${u.name} · ${u.category_name}`}>
          {u.name ?? u.category_name}
        </span>
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
               style={{ left: i * p.spalte, width: p.spalte }}
               className={`absolute inset-y-0 pointer-events-none ${TAGESRAND(d)}
                           ${d === p.heute ? 'bg-sky-100/70'
                             : isWeekend(d) ? 'bg-neutral-100' : ''}`} />
        ))}
        {(p.blocks ?? []).map((b, i) => (
          <div key={i}
               style={{ ...p.balken(b.from_date, b.to_date), ...balkenHoehe }}
               title={b.reason}
               className="absolute rounded-sm bg-status-blocked/60 px-1.5 text-xs
                          text-white truncate
                          bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(255,255,255,.35)_4px,rgba(255,255,255,.35)_8px)]">
            {b.reason}
          </div>
        ))}
        {(p.reservations ?? []).map(r => {
          const b = p.balken(r.arrival, r.departure)
          const umriss = p.umriss(r.arrival, r.departure)
          const versteckt = r.public_ref === p.versteckterRef
          // Geschwister derselben Buchung, solange einer davon gehalten
          // wird. Ein Rand und keine andere Farbe: die Farbe sagt den
          // Zustand (Option, bestaetigt, angereist), und den zu
          // ueberschreiben hiesse, eine Information gegen eine andere zu
          // tauschen.
          const inGehaltenerGruppe = p.gruppenRef !== null
            && r.booking_ref === p.gruppenRef
          const fest = r.status === 'CheckedOut'
          return (
            <button key={r.id} data-reservation-ref={r.public_ref}
                    // Daran findet die Schnellsuche (`PlanSuche`) den Balken,
                    // zu dem sie springt -- im Band oben wie in der Zeile.
                    onPointerDown={e => p.onMovePointerDown(r, e)}
                    // `stopPropagation` in der Behandlung: sonst liefe das
                    // Ereignis weiter an die freie Flaeche darunter und
                    // oeffnete das Menue fuer "hier ist nichts" -- ueber
                    // einem Balken, auf den man gerade gezielt hat.
                    onContextMenu={e => p.onBalkenKontext(r, e)}
                    data-tip={balkenTitel(r)}
                    style={{ ...b, ...balkenHoehe, clipPath: umriss,
                             opacity: versteckt ? 0.35 : 1 }}
                    /*
                     * `cursor-move` ist hier keine Kosmetik. Das
                     * Verschieben gab es lange, und es wurde nicht
                     * benutzt: der Zeiger blieb ein Pfeil, und nichts
                     * am Balken sagte, dass er anfassbar ist. Eine
                     * Funktion, die niemand findet, ist keine.
                     */
                    className={`absolute isolate flex items-center px-2
                                text-xs text-white text-left hover:brightness-110
                                ${fest ? 'cursor-pointer' : 'cursor-move'}
                                ${inGehaltenerGruppe
                                  ? 'bg-sky-500 z-10' : FARBE[r.status] ?? 'bg-neutral-400'}`}>
              {inGehaltenerGruppe && (
                <Fuellung farbe={FARBE[r.status] ?? 'bg-neutral-400'} umriss={umriss} />
              )}
              {/* Vor dem Namen: am schmalen Balken schneidet `truncate`
                  hinten ab, und der Zahlungsstand soll stehen bleiben. */}
              <SchlossZeichen fest={r.room_fixed} />
              <ZahlungsZeichen zahlung={r.payment} />
              <span className="truncate min-w-0">
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
              </span>
              {/* Ganz rechts und ausserhalb des gekuerzten Teils: der Balken
                  ist eine Zeile mit drei Teilen, und nur der mittlere gibt
                  nach, wenn der Platz knapp wird. */}
              <PersonenZeichen r={r} />
              {/* Griffe an den Raendern: verkuerzen und verlaengern (A4).
                  Nicht am abgereisten Aufenthalt: der ist Vergangenheit. */}
              {!fest && (
                <>
                  <span onPointerDown={e => p.onResizePointerDown(r, 'start', e)}
                        className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" />
                  <span onPointerDown={e => p.onResizePointerDown(r, 'end', e)}
                        className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" />
                </>
              )}
            </button>
          )
        })}
        {p.ghostHier && (
          <div style={{ left: p.ghostLinks, width: p.ghostBreite, ...balkenHoehe,
                        lineHeight: `${innen - 4}px` }}
               className="absolute flex items-center gap-1 rounded-sm border-2 border-dashed
                          border-neutral-900 bg-neutral-900/10 pointer-events-none
                          text-xs px-1.5 whitespace-nowrap overflow-hidden">
            {/* Wie viele Zimmer es werden, steht an der obersten Zeile
                der Auswahl -- in jeder zu wiederholen waere Laerm. */}
            {p.ghostZaehler !== null && (
              <span className="truncate min-w-0">{`${p.ghostZaehler} ${t('group.rooms')}`}</span>
            )}
            {/* Rechts, wie die Personenzahl am Balken, und als Letztes
                gekuerzt: bei einer Nacht ist der Kasten 44 Pixel breit. */}
            {p.ghostNaechte !== null && p.ghostNaechte > 0 && (
              <span className="ml-auto shrink-0 font-semibold tabular-nums">
                {t('tape.nightsShort', { n: p.ghostNaechte })}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

/**
 * "Zimmer fest" am Balken (Migration 0103): wer im Plan umsortiert, soll
 * sehen, welcher Gast sein Zimmer zugesagt bekommen hat, bevor er ihn zieht.
 */
function SchlossZeichen({ fest }: { fest: boolean }): JSX.Element | null {
  const t = useT()
  if (!fest) return null
  return (
    <span role="img" aria-label={t('plan.roomFixed')} title={t('plan.roomFixedHint')}
          className="mr-1 shrink-0">🔒</span>
  )
}
