import { useEffect, useMemo, useState } from 'react'
import type { TapeChart as TapeChartData } from '@hotelpms/contracts'
import { useTapeChart, useCategories } from '../lib/queries.js'
import { useAssignUnit, useChangeStay, useShiftBooking } from '../lib/queries/booking.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { today, addDays, addMonths, eachDay } from '../lib/dates.js'
import { platzbedarf } from '../lib/tapeSelection.js'
import { istTextEingabe } from '../lib/tasten.js'
import { TapeChart } from '../components/TapeChart.tsx'
import { BuchungVerlegen, AenderungZurueck, type Verlegung, type Ziel,
         type Aenderung } from '../components/BuchungVerlegen.tsx'
import { ReservationPanel } from '../components/ReservationPanel.tsx'
import { BookingDialog } from '../components/BookingDialog.tsx'
import { GroupBookingDialog, type GroupSelection }
  from '../components/GroupBookingDialog.tsx'
import { GroupPanel } from '../components/GroupPanel.tsx'
import type { KontextZiel } from '../components/Kontextmenue.tsx'
import { PlanKontextmenue } from '../components/PlanKontextmenue.tsx'
import { ZimmerSperren } from '../components/ZimmerSperren.tsx'
import { VerlaufDialog } from '../components/Verlauf.tsx'
import { Fehler, Laedt, DatumsWahl } from '../components/Shell.tsx'
import { PlanStatusLegende, ZahlungsStand } from '../components/PlanZeichen.tsx'
import { usePlanReinigung } from '../lib/queries/housekeeping.js'
import { useHausrechte } from '../lib/rechte.js'

const SPANNEN = [14, 30, 60] as const
/** Wie viele Schritte Strg+Z zurueckreicht. */
const RUECKGAENGIG_MAX = 20
const PLANUNG_SCHLUESSEL = 'plan.planungsmodus'
/** Zustaende, die ein Zimmer wirklich belegen. Storniert und No-Show nicht. */
const BINDEND = new Set(['Optional', 'Confirmed', 'InHouse'])

interface Auswahl {
  resourceId: number; categoryId: number; categoryName: string; roomCode: string
  /** Plaetze der Zimmergruppe. Entscheidet, ob bei Ueberbelegung gefragt wird. */
  maxOccupancy?: number
  arrival: string; departure: string
}

export function Tape({ propertyId, onFolio, onCheckIn }: {
  propertyId: number; onFolio: (folioRef: string) => void
  onCheckIn: (reservationRef: string) => void
}): JSX.Element {
  const [von, setVon] = useState(today())
  const [tage, setTage] = useState<number>(30)
  /*
   * Zimmer nach Gruppe oder nach Nummer.
   *
   * Nach Gruppe ist die Vorgabe und fuer den Verkauf richtig: wer ein
   * Doppelzimmer sucht, sieht alle nebeneinander. Fuer alles, was am
   * Gebaeude haengt -- Handwerker im dritten Stock, Reinigung einer Etage --
   * ist die Zimmernummer die Reihenfolge, in der ein Mensch laeuft.
   */
  const [gruppiert, setGruppiert] = useState(true)
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
      neu: ziel(r), gruppe
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
  }, danach: () => void): void => {
    const { reservationRef, alt, ziel, gruppe } = was
    const fertig = (): void => {
      if (was.merken) {
        setRueckgaengig(st => [...st.slice(-(RUECKGAENGIG_MAX - 1)), {
          reservationRef, gast: was.gast,
          vorher: { ...alt, roomCode: zimmerCode(alt.resourceId) },
          nachher: { ...ziel, roomCode: zimmerCode(ziel.resourceId) },
          gruppe
        }])
      }
      danach()
    }
    if (gruppe !== undefined) {
      gruppeVerschieben.mutate(
        { bookingRef: gruppe.bookingRef, shiftDays: gruppe.shiftDays },
        { onSuccess: fertig })
      return
    }
    if (ziel.arrival === alt.arrival && ziel.departure === alt.departure) {
      zuweisen.mutate({ reservationRef, resourceId: ziel.resourceId },
        { onSuccess: fertig })
      return
    }
    umbuchen.mutate({
      reservationRef, arrival: ziel.arrival, departure: ziel.departure,
      // Hier ausdruecklich auch `null`: wer in der Maske "ohne Zimmer"
      // waehlt und dabei die Tage aendert, meint beides.
      resourceId: ziel.resourceId
    }, { onSuccess: fertig })
  }

  /** Die Maske und der Zug im Planungsmodus reichen dasselbe weiter. */
  const speichern = (v: Verlegung, ziel: Ziel, danach: () => void): void =>
    anwenden({ reservationRef: v.reservationRef, gast: v.gast, alt: v.alt, ziel,
               gruppe: v.gruppe, merken: true }, danach)

  const schreibt = zuweisen.isPending || umbuchen.isPending || gruppeVerschieben.isPending
  const schreibfehler = zuweisen.error ?? umbuchen.error ?? gruppeVerschieben.error

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
    else setVerlegung(v)
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <DatumsWahl value={von} onChange={setVon} step={7} />
        {/* Monat und Jahr zum Durchklicken. Die Wochenpfeile daneben bleiben:
            im Alltag blaettert die Rezeption wochenweise, im Jahresgeschaeft
            monatsweise, und beides an einem Regler unterzubringen hiesse,
            das haeufigere umstaendlicher zu machen. */}
        <div className="flex items-center gap-1">
          <button onClick={() => setVon(addMonths(von, -12))}
                  title={t('plan.yearBack')} aria-label={t('plan.yearBack')}
                  className="px-2 py-1 border border-neutral-300 rounded text-sm">«</button>
          <button onClick={() => setVon(addMonths(von, -1))}
                  title={t('plan.monthBack')} aria-label={t('plan.monthBack')}
                  className="px-2 py-1 border border-neutral-300 rounded text-sm">‹</button>
          <button onClick={() => setVon(addMonths(von, 1))}
                  title={t('plan.monthForward')} aria-label={t('plan.monthForward')}
                  className="px-2 py-1 border border-neutral-300 rounded text-sm">›</button>
          <button onClick={() => setVon(addMonths(von, 12))}
                  title={t('plan.yearForward')} aria-label={t('plan.yearForward')}
                  className="px-2 py-1 border border-neutral-300 rounded text-sm">»</button>
        </div>
        <button onClick={() => setVon(today())}
                className="text-sm px-2 py-1 border border-neutral-300 rounded">
          {t('common.today')}
        </button>
        <div className="flex gap-1">
          {SPANNEN.map(n => (
            <button key={n} onClick={() => setTage(n)}
                    className={`text-sm px-2 py-1 rounded border
                                ${tage === n
                                  ? 'bg-neutral-900 text-white border-neutral-900'
                                  : 'border-neutral-300'}`}>
              {n}
            </button>
          ))}
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
               className={`text-sm flex items-center gap-1.5 rounded px-1.5 py-0.5
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
                className="text-sm px-2 py-1 border border-neutral-300 rounded">
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
             className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs
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
        : <TapeChart data={daten} nachGruppe={gruppiert}
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

      {/* Die Gesten stehen unter dem Plan, nicht in einer Hilfe: Ziehen und
          Mehrfachauswahl gab es zum Teil schon, und niemand hat sie gefunden. */}
      <p className="text-xs text-neutral-500">{t('plan.dragHint')}</p>
      <p className="text-xs text-neutral-500">{t('plan.dragHintGroup')}</p>

      {ausgewaehlt !== null && (
        <ReservationPanel reservationRef={ausgewaehlt}
                          onClose={() => setAusgewaehlt(null)}
                          onOpenFolio={onFolio}
                          onOpenCheckIn={onCheckIn}
                          onOpenGroup={setGruppenBuchung}>
          <ZahlungsStand zahlung={daten?.reservations
            .find(r => r.public_ref === ausgewaehlt)?.payment} />
        </ReservationPanel>
      )}

      {verlegung !== null && daten !== undefined && (
        <BuchungVerlegen verlegung={verlegung} zimmer={daten.units}
                         laeuft={schreibt} fehler={schreibfehler}
                         onClose={() => setVerlegung(null)}
                         onSpeichern={ziel => speichern(verlegung, ziel,
                           () => setVerlegung(null))} />
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

function Legende({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const rechte = useHausrechte(propertyId)
  const punkte: Array<[string, 'status.Optional' | 'status.Confirmed' | 'status.InHouse']> = [
    ['bg-status-optional', 'status.Optional'],
    ['bg-status-confirmed', 'status.Confirmed'],
    ['bg-status-inhouse', 'status.InHouse']
  ]
  return (
    <div className="flex items-center gap-3 text-xs text-neutral-600">
      {punkte.map(([farbe, key]) => (
        <span key={key} className="flex items-center gap-1">
          <span className={`inline-block w-3 h-3 rounded ${farbe}`} />
          {t(key)}
        </span>
      ))}
      {/* Nur, was der Benutzer zu sehen bekommt: dieselben Rechte, an
          denen die Felder im Plan haengen. */}
      <PlanStatusLegende reinigung={rechte.darf('housekeeping:read')}
                         zahlung={rechte.darf('folio:read')} />
    </div>
  )
}

