import { useMemo, useState } from 'react'
import type { TapeChart as TapeChartData } from '@hotelpms/contracts'
import { useTapeChart, useCategories } from '../lib/queries.js'
import { useAssignUnit, useChangeStay, useShiftBooking } from '../lib/queries/booking.js'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { today, addDays, addMonths, eachDay } from '../lib/dates.js'
import { TapeChart, type Umzug } from '../components/TapeChart.tsx'
import { ReservationPanel } from '../components/ReservationPanel.tsx'
import { BookingDialog } from '../components/BookingDialog.tsx'
import { GroupBookingDialog, type GroupSelection }
  from '../components/GroupBookingDialog.tsx'
import { GroupPanel } from '../components/GroupPanel.tsx'
import type { KontextZiel } from '../components/Kontextmenue.tsx'
import { PlanKontextmenue } from '../components/PlanKontextmenue.tsx'
import { ZimmerSperren } from '../components/ZimmerSperren.tsx'
import { Dialog, KNOPF_LEISE } from '../components/Dialog.tsx'
import { Fehler, Laedt, DatumsWahl } from '../components/Shell.tsx'

const SPANNEN = [14, 30, 60] as const
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
   * Ein Umzug in eine andere Zimmergruppe wird nicht stillschweigend
   * ausgefuehrt. Die API laesst ihn zu -- ein Upgrade ist Alltag --, aber
   * versehentlich passiert dabei auch das Gegenteil: eine Buchung fuer zwei
   * Personen landet in einem Einzelzimmer. Gefragt wird erst beim
   * Loslassen, nicht beim Ziehen; eine Frage mitten in der Geste waere im
   * Weg.
   */
  const [umzug, setUmzug] = useState<Umzug | null>(null)
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
    { resourceId: number; roomCode: string; ab: string } | null>(null)
  const t = useT()
  const bis = addDays(von, tage)
  const q = useTapeChart(propertyId, von, bis)
  const kategorien = useCategories(propertyId)
  const zuweisen = useAssignUnit()
  const umbuchen = useChangeStay()
  const gruppeVerschieben = useShiftBooking()

  const warnungen = useWarnungen(q.data, kategorien.data?.categories ?? [])

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
        <div className="grow" />
        <Legende />
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

      {(zuweisen.isError || umbuchen.isError || gruppeVerschieben.isError) && (
        <Fehler error={zuweisen.error ?? umbuchen.error ?? gruppeVerschieben.error} />
      )}

      {q.isError && daten === undefined ? <Fehler error={q.error} />
        : daten === undefined ? <Laedt />
        : <TapeChart data={daten}
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
                      onMove={u => {
                        if (u.wechsel === null) {
                          zuweisen.mutate({ reservationRef: u.reservationRef,
                                            resourceId: u.resourceId })
                        } else setUmzug(u)
                      }}
                      onChangeStay={(reservationRef, arrival, departure) =>
                        umbuchen.mutate({ reservationRef, arrival, departure })}
                      onShiftGroup={(bookingRef, shiftDays) =>
                        gruppeVerschieben.mutate({ bookingRef, shiftDays })}
                      onUnassign={reservationRef =>
                        zuweisen.mutate({ reservationRef, resourceId: null })}
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
                          onOpenGroup={setGruppenBuchung} />
      )}

      {umzug !== null && umzug.wechsel !== null && (
        <UmzugBestaetigen umzug={umzug} onClose={() => setUmzug(null)}
                          onConfirm={() => {
                            zuweisen.mutate({ reservationRef: umzug.reservationRef,
                                              resourceId: umzug.resourceId })
                            setUmzug(null)
                          }} />
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
                            const u = daten?.units.find(x => x.id === z.resourceId)
                            setAuswahl({
                              resourceId: z.resourceId, categoryId: z.categoryId,
                              arrival: z.arrival, departure: z.departure,
                              roomCode: u?.code ?? '',
                              categoryName: u?.category_name ?? '',
                              maxOccupancy: u?.max_occupancy })
                          }}
                          onSperren={setSperren} />
      )}

      {sperren !== null && (
        <ZimmerSperren propertyId={propertyId} resourceId={sperren.resourceId}
                       roomCode={sperren.roomCode} ab={sperren.ab}
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

function Legende(): JSX.Element {
  const t = useT()
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
    </div>
  )
}

/**
 * Nachfrage vor einem Umzug in eine andere Zimmergruppe.
 *
 * **Warum gefragt und nicht verboten.** Ein Upgrade ist Alltag: der Gast hat
 * ein Doppelzimmer gebucht und bekommt die Juniorsuite; abgerechnet wird,
 * was gebucht wurde. Die API laesst das deshalb bewusst zu. Versehentlich
 * passiert im Plan aber auch das Gegenteil, und **das** ist der Fall, für
 * den diese Maske da ist: zwei Personen in einem Einzelzimmer merkt sonst
 * erst der Gast.
 */
function UmzugBestaetigen({ umzug, onClose, onConfirm }: {
  umzug: Umzug; onClose: () => void; onConfirm: () => void
}): JSX.Element {
  const t = useT()
  const w = umzug.wechsel!
  const zuKlein = w.platz < w.bedarf

  return (
    /* `mittel` und nicht breiter: das hier ist eine Frage, kein Formular.
       Eine Maske, die den halben Bildschirm fuellt, um "ja" zu holen,
       wird nicht gelesen, sondern weggeklickt. */
    <Dialog breite="mittel" onClose={onClose} titel={t('plan.moveOtherCategory')}
            fuss={
              <>
                <button type="button" onClick={onConfirm}
                        className={`px-4 py-2 text-sm rounded text-white
                                    ${zuKlein ? 'bg-red-700' : 'bg-neutral-900'}`}>
                  {t('plan.moveConfirm')}
                </button>
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('booking.close')}
                </button>
              </>
            }>
      <div className="space-y-3">
        <p className="text-sm text-neutral-700">
          {t('plan.moveUpgrade', { ref: umzug.reservationRef, von: w.von,
                                   nach: w.nach, raum: umzug.roomCode })}
        </p>

        {zuKlein && (
          <p role="alert" className="text-sm text-red-800 bg-red-50 border
                                     border-red-200 rounded p-2">
            {t('plan.moveTooSmall', { raum: umzug.roomCode, platz: w.platz,
                                      bedarf: w.bedarf })}
          </p>
        )}
      </div>
    </Dialog>
  )
}
