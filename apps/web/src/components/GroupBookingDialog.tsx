import { useState } from 'react'
import type { Guest, Block } from '@hotelpms/contracts'
import { useCreateBooking } from '../lib/queries/booking.js'
import { useT } from '../lib/i18n/index.js'
import { daysBetween } from '../lib/dates.js'
import { preisFelder, alsGesamt, LEERER_PREIS, type Preiseingabe }
  from '../lib/preisEingabe.js'
import { GuestPicker } from './GuestPicker.tsx'
import { KontingentWahl } from './KontingentWahl.tsx'
import { PreisFelder } from './PreisFelder.tsx'
import { Fehler } from './Shell.tsx'

/**
 * Gruppenbuchung: was aus einer Mehrfachauswahl im Belegungsplan wird.
 *
 * **Eine Buchung mit mehreren Zimmern, nicht mehrere Buchungen.** Das ist
 * der ganze Punkt: eine Reisegruppe hat einen Besteller, eine Herkunft und
 * am Ende eine Rechnung. Acht einzelne Buchungen wären acht Vorgänge, die
 * nichts mehr verbindet -- man sieht ihnen nicht an, dass sie
 * zusammengehören, und beim Storno fällt eine davon durch.
 *
 * **Der Zeitraum gilt für alle Zimmer.** Aufgezogen wurde ein Rechteck, und
 * ein Rechteck hat eine Breite. Wer für ein Zimmer andere Tage braucht,
 * zieht dessen Balken danach; das ist ein Handgriff und kostet keinen
 * zweiten Eingabeweg hier.
 *
 * **Zimmer lassen sich vor dem Buchen wieder herausnehmen.** Beim Aufziehen
 * über zwölf Zeilen sind selten alle zwölf gemeint; die Alternative wäre,
 * neu aufzuziehen.
 */
export interface GroupSelection {
  rooms: Array<{ resourceId: number; categoryId: number
                 roomCode: string; categoryName: string
                 /** Eigene Tage dieses Zimmers, falls beim Aufziehen abweichend. */
                 arrival?: string; departure?: string }>
  /** Die Klammer um die Auswahl -- Vorgabe fuer alles, was nicht abweicht. */
  arrival: string
  departure: string
}

export function GroupBookingDialog({ propertyId, selection, onClose }: {
  propertyId: number
  selection: GroupSelection
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const [guest, setGuest] = useState<Guest | null>(null)
  const [notes, setNotes] = useState('')
  const [arrival, setArrival] = useState(selection.arrival)
  const [departure, setDeparture] = useState(selection.departure)
  const [zimmer, setZimmer] = useState(selection.rooms)
  /*
   * Zwei Wege zum Preis, und sie schliessen einander aus.
   *
   * **Fuer die ganze Gruppe** ist der Normalfall: verhandelt wird ein
   * Betrag, und wer ihn zahlt, zahlt ihn fuer alle. Das System teilt ihn
   * nach Personenzahl je Zimmergruppe auf -- genau ist das nicht, aber es
   * geht auf, und mit irgendeiner Aufteilung muss die Buchhaltung arbeiten.
   *
   * **Je Zimmer** ist der Fall, in dem die Gruppe getrennt zahlt oder die
   * Suite eben anders kostet als das Doppelzimmer.
   *
   * Ein Umschalter und nicht beides zugleich: zwei Betraege fuer dieselbe
   * Sache weist die Schnittstelle ab, und das aus gutem Grund -- welcher
   * gilt, gehoert nicht geraten.
   */
  /*
   * Eigene Tage je Zimmer.
   *
   * **Warum als Abweichung und nicht als Pflichtfeld je Zeile.** Der
   * Normalfall ist die geschlossene Anreise; acht Zeilen mit je zwei
   * Datumsfeldern waeren sechzehn Felder fuer etwas, das in den meisten
   * Faellen ueberall gleich ist. Was nicht abweicht, steht deshalb nicht im
   * Zustand -- und geht als `undefined` hinaus, womit die Schnittstelle den
   * Zeitraum der Buchung erbt.
   */
  const [eigeneTage, setEigeneTage] = useState<
    Record<number, { arrival: string; departure: string }>>(
    // Was schon beim Aufziehen abwich, steht hier drin: die Maske soll
    // zeigen, was der Plan gezeigt hat, und nicht stillschweigend
    // gleichziehen.
    () => Object.fromEntries(selection.rooms
      .filter(r => r.arrival !== undefined && r.departure !== undefined
                && (r.arrival !== selection.arrival || r.departure !== selection.departure))
      .map(r => [r.resourceId, { arrival: r.arrival!, departure: r.departure! }])))

  /*
   * Abruf aus einem Kontingent.
   *
   * Schliesst eigene Tage aus, und das ist keine Bequemlichkeit: ein Abruf
   * verbraucht den ganzen Zeitraum des Kontingents. `picked_up` ist eine
   * Zahl ohne Datum, und die Freigabe des Rests rechnet ueber den ganzen
   * Zeitraum -- ein Abruf ueber nur einen Teil liesse an den uebrigen Tagen
   * dauerhaft Kapazitaet gebunden, die niemandem mehr gehoert.
   */
  const [abruf, setAbruf] = useState<Block | null>(null)

  const [jeZimmer, setJeZimmer] = useState(false)
  const [gruppenPreis, setGruppenPreis] = useState<Preiseingabe>(LEERER_PREIS)
  const [zimmerPreis, setZimmerPreis] = useState<Record<number, Preiseingabe>>({})
  const buchen = useCreateBooking(propertyId)

  const naechte = daysBetween(arrival, departure)
  /*
   * Gueltig heisst: der Zeitraum der Buchung **und** jeder abweichende
   * haben mindestens eine Nacht. Ein Zimmer mit Anreise gleich Abreise
   * liefe sonst bis zur Schnittstelle und kaeme als Fehler zurueck, bei
   * dem niemand sieht, welche Zeile gemeint ist.
   */
  const grund =
    zimmer.length === 0 ? 'group.needRooms'
    : departure <= arrival ? 'booking.needNights'
    : Object.values(eigeneTage).some(e => e.departure <= e.arrival)
      ? 'group.needRoomNights'
    : null
  const gueltig = grund === null

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
         onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded shadow-xl p-4 space-y-3
                      max-h-[90vh] overflow-auto"
           onClick={e => e.stopPropagation()}>
        <h2 className="text-sm font-medium">
          {t('group.title')} — {zimmer.length} {t('group.rooms')}
        </h2>

        <div className="text-sm bg-neutral-50 rounded p-2 space-y-1">
          <div className="text-xs text-neutral-500">{t('group.selection')}</div>
          {zimmer.map(z => {
            const eigen = eigeneTage[z.resourceId]
            const von = eigen?.arrival ?? arrival
            const bis = eigen?.departure ?? departure
            return (
              <div key={z.resourceId} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="tabular-nums font-medium">{z.roomCode}</span>
                  <span className="text-neutral-500 truncate grow">{z.categoryName}</span>
                  {/*
                    * Eigene Tage je Zimmer -- beim Abruf aus einem
                    * Kontingent gar nicht erst angeboten: dort gilt dessen
                    * Zeitraum fuer alle, und ein Knopf, der eine
                    * Fehlermeldung erzeugt, laesst die Rezeption den Fehler
                    * bei sich suchen.
                    */}
                  {abruf === null && (
                    <button type="button"
                            onClick={() => setEigeneTage(v => {
                              if (eigen !== undefined) {
                                // Den Eintrag entfernen, nicht auf die
                                // Gruppentage setzen: nur "nicht da" heisst
                                // "erbt", und ein gesetzter Wert bliebe
                                // stehen, wenn die Gruppentage sich aendern.
                                const rest = { ...v }
                                delete rest[z.resourceId]
                                return rest
                              }
                              return { ...v, [z.resourceId]: { arrival, departure } }
                            })}
                            className={`text-xs px-1 underline decoration-dotted
                                        ${eigen ? 'text-neutral-900' : 'text-neutral-500'}`}>
                      {eigen ? t('group.sameDates') : t('group.ownDates')}
                    </button>
                  )}
                  {jeZimmer && (
                    <PreisFelder klein naechte={daysBetween(von, bis)}
                                 wert={zimmerPreis[z.resourceId] ?? LEERER_PREIS}
                                 onChange={w => setZimmerPreis(
                                   { ...zimmerPreis, [z.resourceId]: w })} />
                  )}
                  <button type="button"
                          onClick={() => setZimmer(
                            zimmer.filter(x => x.resourceId !== z.resourceId))}
                          title={t('group.remove')}
                          className="text-xs text-neutral-500 hover:text-red-700 px-1">
                    ×
                  </button>
                </div>
                {eigen !== undefined && (
                  <div className="flex items-center gap-2 pl-4">
                    <input type="date" value={eigen.arrival}
                           onChange={e => setEigeneTage(v => ({ ...v,
                             [z.resourceId]: { ...eigen, arrival: e.target.value } }))}
                           className="border border-neutral-300 rounded px-2 py-1 text-xs" />
                    <span className="text-xs text-neutral-400">–</span>
                    <input type="date" value={eigen.departure}
                           onChange={e => setEigeneTage(v => ({ ...v,
                             [z.resourceId]: { ...eigen, departure: e.target.value } }))}
                           className="border border-neutral-300 rounded px-2 py-1 text-xs" />
                    <span className="text-xs text-neutral-500">
                      {t('group.nights', { n: daysBetween(eigen.arrival, eigen.departure) })}
                    </span>
                  </div>
                )}
              </div>
            )
          })}
          {zimmer.length === 0 && (
            <div className="text-xs text-amber-800">{t('group.empty')}</div>
          )}
        </div>

        <KontingentWahl propertyId={propertyId}
                        categoryId={[...new Set(zimmer.map(z => z.categoryId))].length === 1
                          ? zimmer[0]?.categoryId : undefined}
                        gewaehlt={abruf} benoetigt={zimmer.length}
                        onChange={b => {
                          setAbruf(b)
                          if (b !== null) {
                            setArrival(b.fromDate)
                            setDeparture(b.toDate)
                            // Abweichungen fallen weg: sie sind beim Abruf
                            // gar nicht erlaubt, und stehenzulassen hiesse,
                            // sie beim Absenden stillschweigend zu verwerfen.
                            setEigeneTage({})
                          }
                        }} />

        <div className="flex gap-2">
          <label className="block text-sm grow">
            <span className="block text-xs text-neutral-600 mb-1">{t('booking.arrival')}</span>
            <input type="date" value={arrival} onChange={e => setArrival(e.target.value)}
                   disabled={abruf !== null}
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm
                              disabled:bg-neutral-100 disabled:text-neutral-500" />
          </label>
          <label className="block text-sm grow">
            <span className="block text-xs text-neutral-600 mb-1">{t('booking.departure')}</span>
            <input type="date" value={departure} onChange={e => setDeparture(e.target.value)}
                   disabled={abruf !== null}
                   className="w-full border border-neutral-300 rounded px-2 py-1 text-sm
                              disabled:bg-neutral-100 disabled:text-neutral-500" />
          </label>
        </div>

        {/*
          * Der Preis, und darueber die Frage, auf welcher Ebene er gilt.
          *
          * Die Vorgabe ist der Gruppenpreis, weil das der Normalfall ist:
          * verhandelt wird ein Betrag fuer alles. Je Zimmer ist der
          * Sonderfall -- getrennte Zahler, oder die Suite kostet eben
          * anders als das Doppelzimmer.
          */}
        <div className="space-y-1">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-neutral-600">{t('group.priceLevel')}</span>
            <label className="flex items-center gap-1">
              <input type="radio" checked={!jeZimmer} onChange={() => setJeZimmer(false)} />
              {t('group.priceWhole')}
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={jeZimmer} onChange={() => setJeZimmer(true)} />
              {t('group.pricePerRoom')}
            </label>
          </div>
          {jeZimmer
            ? <p className="text-xs text-neutral-500">{t('group.pricePerRoomHint')}</p>
            : (
              <>
                <PreisFelder wert={gruppenPreis} naechte={naechte}
                             onChange={setGruppenPreis} />
                <p className="text-xs text-neutral-500">{t('group.priceSplitHint')}</p>
              </>
            )}
        </div>

        {/*
          * Kein <label> um die Gastauswahl, und das ist kein Stilfrage.
          *
          * Ein Klick auf einen Treffer der Liege loeste die Auswahl aus --
          * und nahm sie im selben Wimpernschlag wieder zurueck. Der Grund
          * liegt im <label>: es leitet einen Klick an sein erstes
          * bedienbares Kind weiter. Vor der Auswahl ist das das Suchfeld,
          * danach steht dort der Knopf "Aendern" -- und der ruft
          * `onChange(null)`. Das Ergebnis war eine Buchungsmaske, in der
          * sich schlicht kein Gast setzen liess; der Aufruf ging ohne
          * `guestRef` hinaus, und niemandem fiel es auf, weil die Buchung
          * ja gelang.
          */}
        <div className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">{t('booking.guest')}</span>
          <GuestPicker value={guest} onChange={setGuest} />
          <span className="block text-xs text-neutral-500 mt-1">{t('group.guestHint')}</span>
        </div>

        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">{t('booking.notes')}</span>
          <input value={notes} onChange={e => setNotes(e.target.value)}
                 className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
        </label>

        {buchen.isError && <Fehler error={buchen.error} />}
        {buchen.isSuccess ? (
          <>
            <p className="text-sm text-emerald-800">
              ✓ {t('group.created')} — {buchen.data.bookingRef}
              {' · '}
              {t('group.createdDetail', { n: buchen.data.reservations.length })}
            </p>
            <button type="button" onClick={onClose}
                    className="px-3 py-1.5 text-sm rounded border border-neutral-300">
              {t('common.back')}
            </button>
          </>
        ) : (
          <div className="flex gap-2">
            <button type="button" disabled={buchen.isPending || !gueltig}
                    onClick={() => buchen.mutate({
                      propertyId, arrival, departure,
                      /*
                       * Der Preis haengt entweder an der Buchung oder an
                       * den Zimmern, nie an beidem -- der Umschalter oben
                       * ist genau diese Entscheidung, und die
                       * Schnittstelle weist die Doppelangabe ab.
                       *
                       * Aufgeteilt wird auf dem Server: sowohl der
                       * Gruppenpreis auf die Zimmer als auch jeder
                       * Zimmerpreis auf die Naechte. Hier zu teilen hiesse,
                       * die Rechnung an zwei Stellen zu fuehren, und
                       * spaetestens der Rest-Cent laesst sie auseinander
                       * laufen.
                       */
                      rooms: zimmer.map(z => {
                        const eigen = eigeneTage[z.resourceId]
                        return {
                          categoryId: z.categoryId, resourceId: z.resourceId,
                          // Was nicht abweicht, geht als `undefined` hinaus:
                          // die Schnittstelle erbt dann den Zeitraum der
                          // Buchung, und die Absicht steht nicht doppelt da.
                          arrival: eigen?.arrival,
                          departure: eigen?.departure,
                          totalCent: jeZimmer
                            ? alsGesamt(zimmerPreis[z.resourceId] ?? LEERER_PREIS,
                                        daysBetween(eigen?.arrival ?? arrival,
                                                    eigen?.departure ?? departure))
                            : undefined
                        }
                      }),
                      ...(jeZimmer ? {} : preisFelder(gruppenPreis)),
                      blockRef: abruf?.blockRef,
                      guestRef: guest?.guestRef,
                      notes: notes.trim() === '' ? undefined : notes.trim()
                    })}
                    className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                               disabled:bg-neutral-300">
              {t('group.submit')}
            </button>
            <button type="button" onClick={onClose}
                    className="px-3 py-1.5 text-sm rounded border border-neutral-300">
              {t('booking.close')}
            </button>
            {/* Daneben und nicht im `title`: ein gesperrter Knopf nimmt keine
                Zeigerereignisse an, sein Tooltip erscheint in den meisten
                Browsern gar nicht. */}
            {grund !== null && (
              <span className="self-center text-xs text-amber-800">{t(grund)}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
