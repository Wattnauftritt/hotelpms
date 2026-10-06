import { useEffect, useMemo, useState } from 'react'
import type { TapeChart as TapeChartData, ReservationDetail } from '@hotelpms/contracts'
import { useTapeChart, useCategories } from '../lib/queries.js'
import { useAssignUnit, useChangeStay, useShiftBooking, useSetGuestOf, useSetPersons,
         useSwapRoom, istAusgebucht }
  from '../lib/queries/booking.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { today, addDays, eachDay } from '../lib/dates.js'
import { platzbedarf } from '../lib/tapeSelection.js'
import { istTextEingabe, useEscape } from '../lib/tasten.js'
import { TapeChart, ZEILE_MIN, ZEILE_MAX, ZEILE_STANDARD, LABEL_BREITE }
  from '../components/TapeChart.tsx'
import { QuerLeiste } from '../components/QuerLeiste.tsx'
import { BuchungVerlegen, AenderungZurueck, type Verlegung, type Ziel,
         type Aenderung, type Zusatz } from '../components/BuchungVerlegen.tsx'
import { ReservationPanel } from '../components/ReservationPanel.tsx'
import { BookingDialog } from '../components/BookingDialog.tsx'
import { GroupBookingDialog, type GroupSelection }
  from '../components/GroupBookingDialog.tsx'
import { GroupPanel } from '../components/GroupPanel.tsx'
import type { KontextZiel } from '../components/Kontextmenue.tsx'
import { PlanKontextmenue } from '../components/PlanKontextmenue.tsx'
import { ZimmerSperren } from '../components/ZimmerSperren.tsx'
import { VerlaufDialog } from '../components/Verlauf.tsx'
import { Fehler, Laedt } from '../components/Shell.tsx'
import { PlanStatusLegende, ZahlungsStand } from '../components/PlanZeichen.tsx'
import { usePlanReinigung } from '../lib/queries/housekeeping.js'
import { useHausrechte } from '../lib/rechte.js'
import { PlanSuche } from '../components/PlanSuche.tsx'

const SPANNEN = [14, 30, 60] as const
/** Wie viele Schritte Strg+Z zurueckreicht. */
const RUECKGAENGIG_MAX = 20
const PLANUNG_SCHLUESSEL = 'plan.planungsmodus'
const ZEILE_SCHLUESSEL = 'plan.zeilenhoehe'
const TAGE_SCHLUESSEL = 'plan.tage'
/** Zustaende, die ein Zimmer wirklich belegen. Storniert und No-Show nicht. */
const BINDEND = new Set(['Optional', 'Confirmed', 'InHouse'])

interface Auswahl {
  resourceId: number; categoryId: number; categoryName: string; roomCode: string
  /** Plaetze der Zimmergruppe. Entscheidet, ob bei Ueberbelegung gefragt wird. */
  maxOccupancy?: number
  arrival: string; departure: string
}

/*
 * Der Plan beginnt mit dem Vortag, nicht mit heute. Heute ist der Tag mit
 * Anreisen *und* Abreisen; steht er ganz links, sieht man von den Gaesten,
 * die heute abreisen, nur noch das Ende, und der Tag klebt am Rand
 * (Sven, 05.10.2026). Eine Spalte davor macht ihn zur zweiten.
 */
function startHeute(): string { return addDays(today(), -1) }

export function Tape({ propertyId, onFolio, onCheckIn }: {
  propertyId: number; onFolio: (folioRef: string) => void
  onCheckIn: (reservationRef: string) => void
}): JSX.Element {
  const [von, setVon] = useState(startHeute)
  /*
   * 14, 30 oder 60 Tage, gemerkt wie die Zeilenhoehe und aus demselben
   * Grund: es haengt am Bildschirm, und wer 60 eingestellt hat, will nicht
   * jeden Morgen wieder auf 30 stehen (Sven, 04.10.2026).
   */
  const [tage, setTageRoh] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem(TAGE_SCHLUESSEL))
      return (SPANNEN as readonly number[]).includes(n) ? n : 30
    } catch { return 30 }
  })
  const setTage = (n: number): void => {
    setTageRoh(n)
    try { localStorage.setItem(TAGE_SCHLUESSEL, String(n)) } catch { /* gesperrt */ }
  }
  /*
   * Zimmer nach Gruppe oder nach Nummer.
   *
   * Nach Gruppe ist die Vorgabe und fuer den Verkauf richtig: wer ein
   * Doppelzimmer sucht, sieht alle nebeneinander. Fuer alles, was am
   * Gebaeude haengt -- Handwerker im dritten Stock, Reinigung einer Etage --
   * ist die Zimmernummer die Reihenfolge, in der ein Mensch laeuft.
   */
  const [gruppiert, setGruppiert] = useState(true)
  /*
   * Die Zeilenhoehe, damit ein ganzes Haus auf einen Bildschirm passt.
   *
   * Im `localStorage` und nicht in der Sitzung: sie haengt am Bildschirm,
   * an dem jemand sitzt, nicht an der Schicht, und wer sie einmal passend
   * gestellt hat, will das nicht jeden Morgen wieder tun. Eine Zahl, keine
   * Gastdaten. Gesperrter Speicher heisst einfach: Standardhoehe.
   */
  const [zeile, setZeile] = useState(() => {
    try {
      const n = Number(localStorage.getItem(ZEILE_SCHLUESSEL))
      return n >= ZEILE_MIN && n <= ZEILE_MAX ? n : ZEILE_STANDARD
    } catch { return ZEILE_STANDARD }
  })
  const zeileSetzen = (n: number): void => {
    setZeile(n)
    try { localStorage.setItem(ZEILE_SCHLUESSEL, String(n)) } catch { /* gesperrt */ }
  }
  // Balken anklicken zeigt die Reservierung im Seitenfenster (A1); der Plan
  // bleibt dahinter sichtbar.
  const [ausgewaehlt, setAusgewaehlt] = useState<string | null>(null)
  const [auswahl, setAuswahl] = useState<Auswahl | null>(null)
  // Mehrere Zimmerzeilen zugleich markiert: daraus wird **eine** Buchung
  // mit mehreren Zimmern, nicht eine Buchung je Zimmer.
  const [gruppe, setGruppe] = useState<GroupSelection | null>(null)
  /*
   * **Kein Zug schreibt unmittelbar.** Was gezogen wurde, landet hier und
   * wird erst gespeichert, wenn jemand in der Maske darauf klickt.
   *
   * Ein Zug dauert zwei Zehntelsekunden, und danebengegriffen sieht
   * genauso aus wie richtig: der Balken liegt, wo man ihn losgelassen hat.
   * Aufgefallen ist das bisher erst, wenn der Gast vor dem Tresen stand --
   * ein Zimmer doppelt belegt, eine Anreise einen Tag zu frueh. Beides
   * kostet Geld, als Ausfall oder als Ersatzunterkunft.
   *
   * Die Maske ist dabei ein Formular und keine Rueckfrage: wer danebenzieht,
   * will nicht abbrechen und noch einmal zielen, sondern einen Tag
   * korrigieren.
   */
  const [verlegung, setVerlegung] = useState<Verlegung | null>(null)
  /*
   * Der Planungsmodus haengt an der Sitzung, nicht am Bildschirm.
   *
   * Wer eine Woche umsortiert, wechselt zwischendurch in die Anreiseliste
   * und zurueck; waere der Modus an dieser Komponente, waere er dann
   * wieder aus, ohne dass jemand ihn ausgeschaltet hat. `sessionStorage`
   * und nicht `localStorage`: eine ausgeschaltete Sicherung soll den
   * Feierabend nicht ueberleben.
   */
  const [planung, setPlanung] = useState(() => {
    try { return sessionStorage.getItem(PLANUNG_SCHLUESSEL) === 'an' }
    catch { return false }
  })
  /*
   * Was zuletzt geschrieben wurde -- fuer Strg+Z.
   *
   * Nur im Speicher und nur fuer diesen Bildschirm: ein Stapel, der einen
   * Neuladen ueberlebt, verspricht ein Zuruecknehmen von Aenderungen, die
   * inzwischen jemand anders ueberschrieben hat. Zwanzig Schritte sind
   * mehr, als jemand ohne Blick in den Plan zurueckdenkt.
   */
  const [rueckgaengig, setRueckgaengig] = useState<Aenderung[]>([])
  const [zurueck, setZurueck] = useState<Aenderung | null>(null)
  /*
   * Der hausweite Verlauf: was zuletzt am Plan geaendert wurde, ueber alle
   * Benutzer. Die Frage stellt sich am Plan und nirgends sonst -- deshalb
   * der Knopf in der Leiste und kein eigener Bildschirm.
   */
  const [verlauf, setVerlauf] = useState(false)
  /*
   * Die Gruppenmaske: alle Zimmer einer Buchung nebeneinander.
   *
   * Ein eigener Zustand neben `ausgewaehlt`, weil beides nebeneinander
   * Sinn ergibt -- aus der Gruppe heraus ein einzelnes Zimmer oeffnen ist
   * der Weg zum Detail, und die Gruppe dabei zu schliessen hiesse, danach
   * wieder suchen zu muessen.
   */
  const [gruppenBuchung, setGruppenBuchung] = useState<string | null>(null)
  /** Was unter dem rechten Knopf lag. Null heisst: kein Menue offen. */
  const [kontext, setKontext] = useState<KontextZiel | null>(null)
  const [sperren, setSperren] = useState<
    { zimmer: Array<{ resourceId: number; roomCode: string }>
      ab: string; bis: string } | null>(null)
  const t = useT()
  const bis = addDays(von, tage)
  const q = useTapeChart(propertyId, von, bis)
  const kategorien = useCategories(propertyId)
  const zuweisen = useAssignUnit()
  const umbuchen = useChangeStay()
  const gruppeVerschieben = useShiftBooking()
  const gastSetzen = useSetGuestOf()
  const personenSetzen = useSetPersons()
  const tauschen = useSwapRoom()
  const reinigung = usePlanReinigung(propertyId)

  const warnungen = useWarnungen(q.data, kategorien.data?.categories ?? [])

  const zimmerCode = (id: number | null): string =>
    id === null ? '' : (daten?.units.find(u => u.id === id)?.code ?? '')

  /**
   * Aus einem gezogenen Balken den Vorschlag bauen, ueber den die Maske
   * entscheidet.
   *
   * Die Reservierung wird hier nachgeschlagen und nicht im Plan
   * mitgegeben: Gast, Zustand und Personenzahl stehen ohnehin schon in den
   * Daten des Bildschirms, und sie durch die Geste zu reichen hiesse, den
   * Plan um Felder zu erweitern, die er selbst nicht braucht.
   */
  const vorschlag = (reservationRef: string,
                     ziel: (r: TapeChartData['reservations'][number]) => Ziel,
                     gruppe?: Verlegung['gruppe']): Verlegung | null => {
    const r = daten?.reservations.find(x => x.public_ref === reservationRef)
    if (r === undefined) return null
    return {
      reservationRef, status: r.status, categoryId: r.category_id,
      gast: [r.first_name, r.last_name].filter(x => x !== null && x !== '').join(' '),
      bedarf: platzbedarf({ occupants: r.occupants,
                            categoryMaxOccupancy: r.category_max_occupancy }),
      alt: { resourceId: r.resource_id, arrival: r.arrival, departure: r.departure },
      neu: ziel(r), gruppe,
      personen: gruppe === undefined
        ? { guestCount: r.guest_count, adults: r.adults, children: r.children }
        : undefined
    }
  }

  /**
   * Schreiben, und den Schritt fuer Strg+Z merken.
   *
   * **Drei Routen, eine Entscheidung.** Wandern die Tage, ist es
   * `change-stay`: die Route verlegt den Aufenthalt und nimmt das
   * Zielzimmer mit, damit ein schraeger Zug in einem Aufruf durchgeht.
   * Bleiben sie, reicht `assign-unit` -- die schmalere Route, und die
   * einzige, die auch fuer einen Abruf aus einem Kontingent gilt: dessen
   * Tage gehoeren dem Kontingent und sind nicht verschiebbar, ein Zimmer
   * bekommt er trotzdem. Die ganze Gruppe wandert ueber ihren eigenen
   * Aufruf mit dem Versatz.
   *
   * Gemerkt wird erst nach dem Erfolg. Ein Stapel, in dem ein
   * fehlgeschlagener Schritt steht, bietet an, etwas zurueckzunehmen, das
   * nie passiert ist.
   */
  const anwenden = (was: {
    reservationRef: string; gast: string; alt: Ziel; ziel: Ziel
    gruppe?: Verlegung['gruppe']
    /**
     * Auf den Stapel fuer Strg+Z? Nur der Weg hin, nicht der zurueck: sonst
     * ist der naechste Tastendruck ein Wiederherstellen, und zweimal Strg+Z
     * stuende wieder am Anfang, statt zwei Schritte zurueckzugehen.
     */
    merken: boolean
    /** Preis und Gast aus der Maske. Ein Zug im Planungsmodus hat keine. */
    zusatz?: Zusatz
  }, danach: () => void): void => {
    const { reservationRef, alt, ziel, gruppe } = was
    const tageGleich = ziel.arrival === alt.arrival && ziel.departure === alt.departure
    const zimmerGleich = ziel.resourceId === alt.resourceId
    const preis = was.zusatz?.preis ?? null
    const guestRef = was.zusatz?.guestRef
    const personen = was.zusatz?.personen
    const tauschMit = was.zusatz?.tauschMit
    const gemerkt = (): void => {
      // Nur, was Zimmer oder Tage bewegt hat: ein Strg+Z, das einen Preis
      // oder einen Namen "zuruecknimmt", indem es nichts tut, waere eine
      // Zusage, die nicht stimmt. Ein Tausch auch nicht: zurueck ginge er
      // ueber `assign-unit`, und das alte Zimmer ist dann belegt.
      const bewegt = gruppe !== undefined || !tageGleich || !zimmerGleich
      if (was.merken && tauschMit === undefined && bewegt) {
        setRueckgaengig(st => [...st.slice(-(RUECKGAENGIG_MAX - 1)), {
          reservationRef, gast: was.gast,
          vorher: { ...alt, roomCode: zimmerCode(alt.resourceId) },
          nachher: { ...ziel, roomCode: zimmerCode(ziel.resourceId) },
          gruppe
        }])
      }
      danach()
    }
    /*
     * Der Gast kommt nach dem Aufenthalt: scheitert der (Zimmer belegt),
     * bleibt alles beim Alten, und die Maske steht noch mit allen Feldern
     * da. Umgekehrt haette die Buchung schon den neuen Namen und noch die
     * alten Tage.
     */
    // Die Personen zuletzt, aus demselben Grund: sie gehen nur hinaus,
    // wenn Aufenthalt und Gast durch sind.
    const nachGast = personen === undefined ? gemerkt
      : (): void => personenSetzen.mutate({ reservationRef, ...personen },
                                          { onSuccess: gemerkt })
    const fertig = guestRef === undefined ? nachGast
      : (): void => gastSetzen.mutate({ reservationRef, guestRef },
                                      { onSuccess: nachGast })
    /*
     * Die volle Zimmergruppe ist eine Rueckfrage, kein Ende (Sven,
     * 06.10.2026). Die Maske hat schon gewarnt und schickt die Bestaetigung
     * gleich mit; ein Zug im Planungsmodus und ein Strg+Z haben keine
     * Maske und fragen hier.
     */
    const nachfragen = (nochmal: () => void) => (fehler: unknown): void => {
      if (istAusgebucht(fehler) && confirm(t('plan.overbookConfirm'))) nochmal()
    }
    const ueberbuchen = was.zusatz?.ueberbuchen === true
    /*
     * Tausch: beide Zimmer in einem Aufruf. Ein vereinbarter Preis geht
     * danach ueber `change-stay` mit denselben Tagen hinaus -- der Tausch
     * selbst kennt keinen.
     */
    if (tauschMit !== undefined) {
      const nachTausch = preis === null ? fertig
        : (): void => umbuchen.mutate({ reservationRef, arrival: ziel.arrival,
                                        departure: ziel.departure, ...preis },
                                      { onSuccess: fertig })
      tauschen.mutate({ reservationRef, withReservationRef: tauschMit },
                      { onSuccess: nachTausch })
      return
    }
    if (gruppe !== undefined) {
      const verschieben = (erlaubt: boolean): void => gruppeVerschieben.mutate(
        { bookingRef: gruppe.bookingRef, shiftDays: gruppe.shiftDays,
          allowOverbooking: erlaubt || undefined },
        { onSuccess: fertig,
          onError: erlaubt ? undefined : nachfragen(() => verschieben(true)) })
      verschieben(ueberbuchen)
      return
    }
    if (tageGleich && preis === null) {
      // Nur der Gast: kein Aufruf fuer Zimmer und Tage, die bleiben.
      if (zimmerGleich) { fertig(); return }
      zuweisen.mutate({ reservationRef, resourceId: ziel.resourceId },
        { onSuccess: fertig })
      return
    }
    const verlegen = (erlaubt: boolean): void => umbuchen.mutate({
      reservationRef, arrival: ziel.arrival, departure: ziel.departure,
      // Hier ausdruecklich auch `null`: wer in der Maske "ohne Zimmer"
      // waehlt und dabei die Tage aendert, meint beides.
      resourceId: ziel.resourceId,
      // Ein vereinbarter Preis geht mit derselben Aenderung hinaus, nicht
      // als zweiter Aufruf -- sonst stuende zwischen beiden der gerechnete.
      ...(preis ?? {}),
      allowOverbooking: erlaubt || undefined
    }, { onSuccess: fertig,
         onError: erlaubt ? undefined : nachfragen(() => verlegen(true)) })
    verlegen(ueberbuchen)
  }

  /** Die Maske und der Zug im Planungsmodus reichen dasselbe weiter. */
  const speichern = (v: Verlegung, ziel: Ziel, danach: () => void, zusatz?: Zusatz): void =>
    anwenden({ reservationRef: v.reservationRef, gast: v.gast, alt: v.alt, ziel,
               gruppe: v.gruppe, merken: true, zusatz }, danach)

  const schreibt = zuweisen.isPending || umbuchen.isPending || gruppeVerschieben.isPending
    || gastSetzen.isPending || personenSetzen.isPending || tauschen.isPending
  const schreibfehler = zuweisen.error ?? umbuchen.error ?? gruppeVerschieben.error
    ?? gastSetzen.error ?? personenSetzen.error ?? tauschen.error

  /**
   * Die Maske oeffnen -- mit leerem Fehlerstand.
   *
   * Die Mutationen leben laenger als eine Maske. Ohne das Zuruecksetzen
   * stuende der Fehler eines abgebrochenen Versuchs in der naechsten
   * Maske, an einer Buchung, die damit nichts zu tun hat.
   */
  const maskeOeffnen = (v: Verlegung): void => {
    zuweisen.reset(); umbuchen.reset(); gruppeVerschieben.reset(); gastSetzen.reset()
    personenSetzen.reset(); tauschen.reset()
    setVerlegung(v)
  }

  /**
   * "Aendern" im Seitenfenster: dieselbe Maske wie nach einem Zug, nur
   * ohne Vorschlag -- Zimmer und Tage stehen, wie sie sind.
   *
   * Aus den Daten des Plans, wenn der Balken darin liegt; sonst aus der
   * Reservierung selbst. Die Platzfrage stellt sich dann nur, wenn jemand
   * die Zimmergruppe wechselt, und die Plaetze stehen im Plan.
   */
  const aendern = (r: ReservationDetail): void => {
    const gleich = (x: TapeChartData['reservations'][number]): Ziel =>
      ({ resourceId: x.resource_id, arrival: x.arrival, departure: x.departure })
    const ausPlan = vorschlag(r.reservationRef, gleich)
    if (ausPlan !== null) { maskeOeffnen(ausPlan); return }
    const ziel: Ziel = { resourceId: r.resourceId, arrival: r.arrival,
                         departure: r.departure }
    maskeOeffnen({ reservationRef: r.reservationRef, status: r.status,
                   categoryId: r.categoryId, gast: r.guestName ?? '',
                   bedarf: 0, alt: ziel, neu: ziel,
                   personen: { guestCount: r.guestCount, adults: r.adults,
                               children: r.children } })
  }

  /**
   * Den obersten Schritt zurueckholen.
   *
   * Zurueck ist derselbe Weg wie hin, nur mit vertauschten Enden -- und
   * bei einer Gruppe der umgekehrte Versatz. Aus dem Stapel faellt der
   * Schritt erst, wenn der Aufruf durch ist: scheitert er, weil das alte
   * Zimmer inzwischen belegt ist, soll er noch einmal versucht werden
   * koennen.
   */
  const zuruecknehmen = (a: Aenderung): void => {
    anwenden({
      reservationRef: a.reservationRef, gast: a.gast,
      alt: a.nachher, ziel: a.vorher,
      gruppe: a.gruppe === undefined ? undefined
        : { ...a.gruppe, shiftDays: -a.gruppe.shiftDays },
      merken: false
    }, () => {
      setRueckgaengig(st => st.filter(x => x !== a))
      setZurueck(null)
    })
  }

  /*
   * Strg+Z holt den letzten Schritt zurueck -- und fragt dabei.
   *
   * Die Taste sitzt aus dem Textverarbeitungsprogramm in den Fingern, und
   * sie bedeutet hier etwas anderes: einen Gast noch einmal umlegen.
   * Deshalb die Frage mit Zimmer und Datum auf beiden Seiten.
   *
   * Nicht in einem Feld und nicht ueber einer Maske: dort meint die Taste
   * die Eingabe, und die Maske liegt oben.
   */
  useEffect(() => {
    const aufTaste = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return
      // Im Textfeld gehoert die Taste dem Feld -- im Ankreuzfeld des
      // Planungsmodus aber nicht, und genau dort steht der Fokus, wenn
      // jemand ihn gerade eingeschaltet hat.
      if (istTextEingabe(e.target)) return
      if (document.querySelector('[role="dialog"]') !== null) return
      const letzte = rueckgaengig.at(-1)
      if (letzte === undefined) return
      e.preventDefault()
      setZurueck(letzte)
    }
    window.addEventListener('keydown', aufTaste)
    return () => { window.removeEventListener('keydown', aufTaste) }
  }, [rueckgaengig])

  /**
   * Was ein Zug ausloest: die Maske -- oder, im Planungsmodus, den Aufruf.
   *
   * Der Modus ist keine Abkuerzung um die Vorsicht herum, sondern die
   * Stelle, an der sie stoert: wer eine Woche umsortiert, zieht zwanzigmal
   * und bestaetigt zwanzigmal dasselbe. Sichtbar bleibt er trotzdem -- er
   * steht in der Leiste und faerbt sie --, und Strg+Z ist dann der Weg
   * zurueck.
   */
  const gezogen = (v: Verlegung | null): void => {
    if (v === null) return
    if (planung) speichern(v, v.neu, () => {})
    else maskeOeffnen(v)
  }

  /*
   * Die Sortierung liegt hier und nicht in der Schnittstelle: sie ist eine
   * Frage der Ansicht, und ein zweiter Aufruf nur zum Umsortieren waere
   * eine Runde fuer etwas, das schon im Speicher liegt.
   *
   * `numeric` im Vergleich, sonst steht 110 vor 2 -- die Zimmernummer ist
   * eine Zeichenkette, aber gelesen wird sie als Zahl.
   */
  const daten = useMemo(() => {
    if (q.data === undefined || gruppiert) return q.data
    return { ...q.data, units: [...q.data.units].sort(
      (a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })) }
  }, [q.data, gruppiert])

  return (
    /*
     * Eng gestapelt: jeder Pixel ueber und unter dem Plan fehlt ihm, und
     * KWHotel zeigt mit mehr Knoepfen mehr Zimmer (Sven, 04.10.2026).
     */
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {/* Die Schnellsuche vorn: sie ist der kuerzeste Weg zu einem Balken,
            kuerzer als jedes Blaettern daneben. */}
        <PlanSuche propertyId={propertyId} von={von} bis={bis} onVon={setVon}
                   onOeffnen={setAusgewaehlt} />
        {/*
          * Eine Leiste statt drei Gruppen: aussen die Woche, innen der Tag,
          * in der Mitte der Rueckweg nach heute. Vorher standen -7 -1 +1 +7,
          * << < > >> und Heute nebeneinander, und welcher Pfeil wie weit
          * springt, musste man sich merken (Sven, 05.10.2026: "verwirrend
          * und chaotisch"). Monat und Jahr sind weg: dorthin fuehrt das
          * Datumsfeld daneben in zwei Klicks, und wer so weit springt, will
          * meist ein bestimmtes Datum, nicht "einen Monat weiter".
          */}
        <div className="inline-flex items-stretch rounded-sm border border-neutral-300
                        divide-x divide-neutral-300 text-sm">
          <button onClick={() => setVon(addDays(von, -7))}
                  title={t('plan.weekBack')} aria-label={t('plan.weekBack')}
                  className="px-2 py-1 hover:bg-neutral-100">«</button>
          <button onClick={() => setVon(addDays(von, -1))}
                  title={t('plan.dayBack')} aria-label={t('plan.dayBack')}
                  className="px-2.5 py-1 hover:bg-neutral-100">‹</button>
          <button onClick={() => setVon(startHeute())} title={t('plan.todayHint')}
                  className="px-3 py-1 font-medium hover:bg-neutral-100">
            {t('common.today')}
          </button>
          <button onClick={() => setVon(addDays(von, 1))}
                  title={t('plan.dayForward')} aria-label={t('plan.dayForward')}
                  className="px-2.5 py-1 hover:bg-neutral-100">›</button>
          <button onClick={() => setVon(addDays(von, 7))}
                  title={t('plan.weekForward')} aria-label={t('plan.weekForward')}
                  className="px-2 py-1 hover:bg-neutral-100">»</button>
        </div>
        <input type="date" value={von} onChange={e => { if (e.target.value) setVon(e.target.value) }}
               title={t('plan.jumpToDate')} aria-label={t('plan.jumpToDate')}
               className="border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
        {/* Die Spanne als eine Leiste wie das Blaettern daneben: drei
            Werte einer Einstellung, nicht drei Knoepfe. */}
        <div className="inline-flex items-stretch rounded-sm border border-neutral-300
                        divide-x divide-neutral-300 text-sm">
          {SPANNEN.map(n => (
            <button key={n} onClick={() => setTage(n)} aria-pressed={tage === n}
                    className={`px-2.5 py-1
                                ${tage === n
                                  ? 'bg-neutral-900 text-white'
                                  : 'hover:bg-neutral-100'}`}>
              {n}
            </button>
          ))}
        </div>
        {/* Kein <label>: es reichte einen Klick auf das Wort an den ersten
            Knopf darin weiter, und die Zeilen wuerden niedriger. */}
        <div role="group" aria-label={t('plan.rowHeight')}
             className="text-sm flex items-center gap-1.5 text-neutral-700"
             title={t('plan.rowHeightHint')}>
          {t('plan.rowHeight')}
          {/*
            * Jeder Pixel eine Stufe, und dazu zwei Knoepfe fuer genau einen.
            * In Zweierschritten auf 96 Pixeln Breite lag eine Stufe bei
            * sechs Pixeln Mausweg; die passende Hoehe -- die, bei der das
            * letzte Zimmer gerade noch auf den Bildschirm passt -- wurde
            * oft uebersprungen (Sven, 05.10.2026).
            */}
          <button type="button" onClick={() => zeileSetzen(Math.max(ZEILE_MIN, zeile - 1))}
                  disabled={zeile <= ZEILE_MIN} aria-label={t('plan.rowHeightSmaller')}
                  title={t('plan.rowHeightSmaller')}
                  className="px-1.5 border border-neutral-300 rounded disabled:opacity-40">−</button>
          <input type="range" min={ZEILE_MIN} max={ZEILE_MAX} step={1} value={zeile}
                 onChange={e => zeileSetzen(Number(e.target.value))}
                 onDoubleClick={() => zeileSetzen(ZEILE_STANDARD)}
                 aria-label={t('plan.rowHeight')} className="w-40 accent-neutral-900" />
          <button type="button" onClick={() => zeileSetzen(Math.min(ZEILE_MAX, zeile + 1))}
                  disabled={zeile >= ZEILE_MAX} aria-label={t('plan.rowHeightLarger')}
                  title={t('plan.rowHeightLarger')}
                  className="px-1.5 border border-neutral-300 rounded disabled:opacity-40">+</button>
          <span className="tabular-nums w-6 text-right text-neutral-500">{zeile}</span>
        </div>
        <label className="text-sm flex items-center gap-1.5 text-neutral-700">
          <input type="checkbox" checked={gruppiert}
                 onChange={e => setGruppiert(e.target.checked)} />
          {t('plan.groupByCategory')}
        </label>
        {/*
          * Der Planungsmodus steht neben der Sortierung und nicht in einem
          * Menue: eine ausgeschaltete Sicherung gehoert dorthin, wo man sie
          * im Vorbeigehen sieht. Eingeschaltet faerbt sich die Beschriftung,
          * und unter dem Plan steht, was er bedeutet.
          */}
        <label title={t('verlegen.planningModeHint')}
               className={`text-sm flex items-center gap-1.5 rounded-sm px-1.5 py-0.5
                           ${planung ? 'bg-amber-100 text-amber-900 font-medium'
                                     : 'text-neutral-700'}`}>
          <input type="checkbox" checked={planung}
                 onChange={e => {
                   setPlanung(e.target.checked)
                   try {
                     sessionStorage.setItem(PLANUNG_SCHLUESSEL,
                       e.target.checked ? 'an' : 'aus')
                   } catch { /* Privater Modus: dann gilt er nur hier. */ }
                 }} />
          {t('verlegen.planningMode')}
        </label>
        <div className="grow" />
        <button onClick={() => setVerlauf(true)}
                className="text-sm px-2 py-1 border border-neutral-300 rounded-sm">
          {t('verlauf.title')}
        </button>
        <Legende propertyId={propertyId} />
      </div>

      {/*
        * Eine Zeile, nicht eine je Warnung.
        *
        * Gestapelt schoben drei Hinweise den Plan um drei Zeilen nach
        * unten -- und der Plan ist der Bildschirm, auf den die Rezeption
        * den ganzen Tag sieht. Der volle Text steht weiterhin im Titel,
        * falls die Zeile abschneidet.
        */}
      {warnungen.length > 0 && (
        <div title={warnungen.join('\n')}
             className="rounded-sm border border-amber-200 bg-amber-50 px-2 py-1 text-xs
                        text-amber-900 truncate">
          <span className="font-medium">{t('warnings.title')}:</span>{' '}
          {warnungen.join(' · ')}
        </div>
      )}

      {/* Nur, wenn keine Maske offen ist: dort steht derselbe Fehler, und
          zweimal derselbe Satz liest sich wie zwei Fehler. */}
      {schreibfehler !== null && verlegung === null && zurueck === null && (
        <Fehler error={schreibfehler} />
      )}
      {/* Der Reinigungsstand fuer sich: `schreibfehler` geht auch in die
          Maske des Verschiebens, und dort waere er ein fremder Fehler. */}
      {reinigung.error !== null && <Fehler error={reinigung.error} />}

      {/* Der Modus faellt sonst nicht auf, und er nimmt die Rueckfrage vor
          jeder Verschiebung weg. Unter der Leiste und nicht als Kasten:
          er soll erinnern, nicht den Plan nach unten schieben. */}
      {planung && (
        <p className="text-xs text-amber-900">
          {t('verlegen.planningModeOn')} · {t('verlegen.planningModeHint')}
        </p>
      )}

      {q.isError && daten === undefined ? <Fehler error={q.error} />
        : daten === undefined ? <Laedt />
        : <TapeChart data={daten} nachGruppe={gruppiert} zeile={zeile}
                      onSelect={setAusgewaehlt}
                      onCreate={sel => {
                        const u = daten.units.find(x => x.id === sel.resourceId)
                        setAuswahl({ ...sel, roomCode: u?.code ?? '',
                                      categoryName: u?.category_name ?? '',
                                      maxOccupancy: u?.max_occupancy })
                      }}
                      onCreateGroup={sel => {
                        const zimmer = new Map(daten.units.map(u => [u.id, u]))
                        setGruppe({
                          arrival: sel.arrival, departure: sel.departure,
                          rooms: sel.rooms.map(r => ({
                            ...r,
                            roomCode: zimmer.get(r.resourceId)?.code ?? '',
                            categoryName: zimmer.get(r.resourceId)?.category_name ?? '',
                            /*
                             * Die Plaetze der Zimmergruppe, damit die Maske
                             * einen Gruppenpreis so aufteilen kann, wie es
                             * die Route tut. Ohne sie waere die Vorschau
                             * gleichmaessig verteilt und das Einzelzimmer so
                             * teuer wie das Doppelzimmer -- also falsch, und
                             * zwar auffaellig erst auf der Rechnung.
                             */
                            maxOccupancy: zimmer.get(r.resourceId)?.max_occupancy ?? 1
                          }))
                        })
                      }}
                      /*
                       * Alle vier Gesten laufen durch dieselbe Stelle:
                       * Zeile wechseln, Rand ziehen, Gruppe schieben,
                       * ins Band legen. Jede aendert, wo ein Gast liegt
                       * oder wann er kommt -- und keine davon soll das
                       * unbemerkt tun.
                       */
                      onMove={u => gezogen(vorschlag(u.reservationRef, r => ({
                        // Was der Zug nicht angefasst hat, bleibt: `null`
                        // heisst bei der Zeile "dieselbe", nicht "keine".
                        resourceId: u.resourceId ?? r.resource_id,
                        arrival: u.zeitraum?.arrival ?? r.arrival,
                        departure: u.zeitraum?.departure ?? r.departure
                      })))}
                      onChangeStay={(reservationRef, arrival, departure) =>
                        gezogen(vorschlag(reservationRef,
                          r => ({ resourceId: r.resource_id, arrival, departure })))}
                      onShiftGroup={(bookingRef, shiftDays) => {
                        // Irgendeine Reservierung der Buchung: gezeigt wird
                        // der Versatz, nicht ihre Tage.
                        const erste = daten.reservations.find(
                          x => x.booking_ref === bookingRef)
                        if (erste === undefined) return
                        const zimmer = daten.reservations.filter(
                          x => x.booking_ref === bookingRef).length
                        gezogen(vorschlag(erste.public_ref, r => ({
                          resourceId: r.resource_id,
                          arrival: addDays(r.arrival, shiftDays),
                          departure: addDays(r.departure, shiftDays)
                        }), { bookingRef, shiftDays, zimmer }))
                      }}
                      onUnassign={reservationRef =>
                        gezogen(vorschlag(reservationRef, r => ({
                          resourceId: null,
                          arrival: r.arrival, departure: r.departure })))}
                      onKontext={setKontext} />}
      {daten !== undefined && (
        <QuerLeiste von={von} tage={tage} onVon={setVon} links={LABEL_BREITE} />
      )}

      {ausgewaehlt !== null && (
        <ReservationPanel reservationRef={ausgewaehlt}
                          onClose={() => setAusgewaehlt(null)}
                          onOpenFolio={onFolio}
                          onOpenCheckIn={onCheckIn}
                          onOpenGroup={setGruppenBuchung}
                          onAendern={aendern}>
          <ZahlungsStand zahlung={daten?.reservations
            .find(r => r.public_ref === ausgewaehlt)?.payment} />
        </ReservationPanel>
      )}

      {verlegung !== null && daten !== undefined && (
        <BuchungVerlegen verlegung={verlegung} zimmer={daten.units}
                         belegtVon={(id, an, ab) => daten.reservations
                           // Dieselben Zustaende, die `assertUnitAssignable`
                           // als belegt zaehlt.
                           .filter(x => x.resource_id === id
                                        && x.public_ref !== verlegung.reservationRef
                                        && (x.status === 'Confirmed' || x.status === 'InHouse')
                                        && x.arrival < ab && x.departure > an)
                           .map(x => ({ reservationRef: x.public_ref,
                                        gast: [x.first_name, x.last_name]
                                          .filter(n => n !== null && n !== '').join(' ') }))}
                         laeuft={schreibt} fehler={schreibfehler}
                         onClose={() => setVerlegung(null)}
                         onSpeichern={(ziel, zusatz) => speichern(verlegung, ziel,
                           () => setVerlegung(null), zusatz)} />
      )}

      {verlauf && (
        <VerlaufDialog was={{ art: 'haus', propertyId }}
                       titel={t('verlauf.hausTitle')}
                       onClose={() => setVerlauf(false)} />
      )}

      {zurueck !== null && (
        <AenderungZurueck aenderung={zurueck} laeuft={schreibt} fehler={schreibfehler}
                          onClose={() => setZurueck(null)}
                          onConfirm={() => zuruecknehmen(zurueck)} />
      )}

      {gruppe !== null && (
        <GroupBookingDialog propertyId={propertyId} selection={gruppe}
                            onClose={() => setGruppe(null)} />
      )}

      {kontext !== null && (
        <PlanKontextmenue propertyId={propertyId} ziel={kontext}
                          onClose={() => setKontext(null)}
                          onOeffnen={setAusgewaehlt}
                          onCheckIn={onCheckIn}
                          onGruppe={setGruppenBuchung}
                          onAnlegen={z => {
                            /*
                             * Alle oder keines: liegt der Klick in einer
                             * Markierung ueber mehreren Zimmern, entsteht
                             * **eine** Buchung mit diesen Zimmern und nicht
                             * eine fuer das Zimmer unter dem Zeiger.
                             */
                            const markiert = z.auswahl ?? [z]
                            const zimmer = new Map(
                              (daten?.units ?? []).map(u => [u.id, u]))
                            if (markiert.length > 1) {
                              setGruppe({
                                // Die Klammer ueber alles Markierte: die
                                // Maske zeigt sie oben und uebernimmt sie
                                // fuer jedes Zimmer, das nicht abweicht.
                                arrival: markiert.reduce(
                                  (fr, x) => x.arrival < fr ? x.arrival : fr,
                                  markiert[0]!.arrival),
                                departure: markiert.reduce(
                                  (sp, x) => x.departure > sp ? x.departure : sp,
                                  markiert[0]!.departure),
                                rooms: markiert.map(x => ({
                                  resourceId: x.resourceId, categoryId: x.categoryId,
                                  arrival: x.arrival, departure: x.departure,
                                  roomCode: zimmer.get(x.resourceId)?.code ?? '',
                                  categoryName:
                                    zimmer.get(x.resourceId)?.category_name ?? '',
                                  maxOccupancy:
                                    zimmer.get(x.resourceId)?.max_occupancy ?? 1
                                }))
                              })
                              return
                            }
                            const u = zimmer.get(z.resourceId)
                            setAuswahl({
                              resourceId: z.resourceId, categoryId: z.categoryId,
                              arrival: z.arrival, departure: z.departure,
                              roomCode: u?.code ?? '',
                              categoryName: u?.category_name ?? '',
                              maxOccupancy: u?.max_occupancy })
                          }}
                          onSperren={setSperren}
                          reinigungsstand={id =>
                            daten?.units.find(u => u.id === id)?.housekeeping}
                          onReinigung={(resourceIds, status) =>
                            reinigung.mutate({ resourceIds, status })} />
      )}

      {sperren !== null && (
        <ZimmerSperren propertyId={propertyId} zimmer={sperren.zimmer}
                       ab={sperren.ab} bis={sperren.bis}
                       onClose={() => setSperren(null)} />
      )}

      {gruppenBuchung !== null && (
        <GroupPanel propertyId={propertyId} bookingRef={gruppenBuchung}
                    categories={kategorien.data?.categories ?? []}
                    onClose={() => setGruppenBuchung(null)}
                    onSelect={setAusgewaehlt} />
      )}

      {auswahl !== null && (
        <BookingDialog propertyId={propertyId}
                        categoryId={auswahl.categoryId} categoryName={auswahl.categoryName}
                        resourceId={auswahl.resourceId} roomCode={auswahl.roomCode}
                        maxOccupancy={auswahl.maxOccupancy}
                        arrival={auswahl.arrival} departure={auswahl.departure}
                        onClose={() => setAuswahl(null)} />
      )}
    </div>
  )
}

/**
 * Überbuchung sichtbar machen (A7). Gerechnet wird aus dem, was ohnehin
 * schon geladen ist -- Balken und Zimmergruppen -- kein zweiter Aufruf je
 * Zeile, nur eine zusätzliche, feste Anfrage für die Gruppendaten.
 */
function useWarnungen(
  data: TapeChartData | undefined,
  kategorien: Array<{ id: number; name: string }>
): string[] {
  const t = useT()
  const locale = useLocale()
  return useMemo(() => {
    if (data === undefined) return []
    const out: string[] = []

    /*
     * Die Zahl allein sagt nicht, ob es eilt.
     *
     * "3 Buchungen ohne Zimmer" liest sich im November wie im Anreisetag;
     * dabei ist das eine normal und das andere eine Lage. Deshalb steht die
     * frueheste Anreise daneben -- und nur die von Buchungen, die Bestand
     * halten: ein Storno ohne Zimmer ist kein offener Punkt.
     */
    const ohne = data.reservations
      .filter(r => r.resource_id === null && BINDEND.has(r.status))
      .map(r => r.arrival)
      .sort()
    if (ohne.length > 0) {
      out.push(`${ohne.length} ${t('warnings.unassigned')}`
        + ` (${t('warnings.nextArrival')} ${formatDate(ohne[0]!, locale)})`)
    }

    const kapazitaet = new Map<number, number>()
    for (const u of data.units) {
      kapazitaet.set(u.category_id, (kapazitaet.get(u.category_id) ?? 0) + 1)
    }
    const namen = new Map(kategorien.map(k => [k.id, k.name]))
    const tageListe = eachDay(data.from, data.to)

    for (const [categoryId, kapa] of kapazitaet) {
      let betroffeneTage = 0
      for (const tag of tageListe) {
        const belegt = data.reservations.filter(r =>
          r.category_id === categoryId && BINDEND.has(r.status)
          && r.arrival <= tag && r.departure > tag).length
        if (belegt > kapa) betroffeneTage++
      }
      if (betroffeneTage > 0) {
        out.push(`${t('warnings.overbooked')}: ${namen.get(categoryId) ?? categoryId} `
          + `(${betroffeneTage})`)
      }
    }
    return out
  }, [data, kategorien, t, locale])
}

/**
 * Legende und Gesten, aufklappbar hinter einem Knopf in der Steuerzeile.
 *
 * Offen stand sie neben den Steuerungen und brach auf jedem gewoehnlichen
 * Bildschirm in eine zweite Zeile um; darunter stand noch eine Zeile mit
 * den Gesten. Beides zusammen nahm dem Plan zwei Zimmerzeilen weg, jeden
 * Tag, fuer etwas, das man nach der ersten Woche kennt (Sven, 04.10.2026).
 * Aufgeklappt liegt sie ueber dem Plan und schiebt nichts.
 */
function Legende({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const rechte = useHausrechte(propertyId)
  const [offen, setOffen] = useState(false)
  useEscape(() => setOffen(false), offen)
  const punkte: Array<[string, 'status.Optional' | 'status.Confirmed' | 'status.InHouse'
                               | 'status.CheckedOut']> = [
    ['bg-status-optional', 'status.Optional'],
    ['bg-status-confirmed', 'status.Confirmed'],
    ['bg-status-inhouse', 'status.InHouse'],
    ['bg-status-checkedout', 'status.CheckedOut']
  ]
  return (
    <div className="relative">
      <button type="button" onClick={() => setOffen(o => !o)} aria-expanded={offen}
              className={`text-sm px-2 py-1 border rounded-sm
                          ${offen ? 'bg-neutral-900 text-white border-neutral-900'
                                  : 'border-neutral-300'}`}>
        {t('plan.legend')} {offen ? '▴' : '▾'}
      </button>
      {offen && (
        <div className="absolute right-0 top-full mt-1 z-40 w-[46rem] max-w-[90vw] space-y-2
                        rounded-sm border border-neutral-200 bg-white p-3 text-xs
                        text-neutral-600 shadow-lg">
          <div className="flex flex-wrap items-center gap-3">
            {punkte.map(([farbe, key]) => (
              <span key={key} className="flex items-center gap-1">
                <span className={`inline-block w-3 h-3 rounded-sm ${farbe}`} />
                {t(key)}
              </span>
            ))}
          </div>
          {/* Nur, was der Benutzer zu sehen bekommt: dieselben Rechte, an
              denen die Felder im Plan haengen. */}
          <div className="flex flex-col items-start gap-2 whitespace-nowrap">
            <PlanStatusLegende reinigung={rechte.darf('housekeeping:read')}
                               zahlung={rechte.darf('folio:read')} />
          </div>
          {/* Die Gesten stehen hier und nicht in einer Hilfe: Ziehen und
              Mehrfachauswahl gab es zum Teil schon, und niemand hat sie
              gefunden. Unter dem Plan nahmen sie ihm eine Zeile weg. */}
          <p className="border-t border-neutral-100 pt-2">{t('plan.dragHint')}</p>
          <p>{t('plan.dragHintGroup')}</p>
        </div>
      )}
    </div>
  )
}
