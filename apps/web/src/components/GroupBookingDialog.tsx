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
import { Dialog, Abschnitt, Feld, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
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
 * **Der Zeitraum der Gruppe ist die Vorgabe, nicht das Gesetz.** Aufgezogen
 * wurde ein Rechteck, und ein Rechteck hat eine Breite -- aber das
 * Brautpaar bleibt drei Nächte und die Eltern zwei. Jede Zeile der Tabelle
 * trägt deshalb ihre eigenen Datumsfelder; wer sie nicht anfasst, erbt den
 * Zeitraum der Gruppe, und nur was wirklich abweicht, geht auch als
 * Abweichung hinaus.
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
   * Eigene Tage je Zimmer. **Nur die Abweichungen.**
   *
   * Die Felder stehen inzwischen in jeder Zeile der Tabelle, der Zustand
   * aber nicht: eine Zeile, die niemand angefasst hat, hat hier keinen
   * Eintrag und zeigt die Tage der Gruppe. Das ist der Unterschied zwischen
   * "erbt" und "ist zufaellig gleich" -- wer oben den Zeitraum der Gruppe
   * verschiebt, nimmt die erbenden Zimmer mit und laesst die abweichenden
   * stehen. Waere jede Zeile im Zustand, ginge das Verschieben verloren,
   * und nach aussen stuende die Absicht doppelt da: `undefined` heisst an
   * der Schnittstelle genau "Zeitraum der Buchung".
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

  /**
   * Ein Datum einer einzelnen Zeile setzen.
   *
   * Der Eintrag entsteht mit **beiden** Tagen, auch wenn nur einer getippt
   * wurde: ein halber Eintrag waere ein Zimmer mit eigener Anreise und
   * geerbter Abreise, und welche von beiden gemeint war, liesse sich
   * hinterher nicht mehr sagen.
   */
  const tagSetzen = (resourceId: number, feld: 'arrival' | 'departure',
                     wert: string): void =>
    setEigeneTage(v => {
      const jetzt = v[resourceId] ?? { arrival, departure }
      return { ...v, [resourceId]: { ...jetzt, [feld]: wert } }
    })

  return (
    <Dialog breite="weit" onClose={onClose}
            titel={t('group.title')}
            unterzeile={`${zimmer.length} ${t('group.rooms')}`}
            fuss={buchen.isSuccess ? (
              <>
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('common.back')}
                </button>
                <span className="text-sm text-emerald-800">
                  ✓ {t('group.created')} — {buchen.data.bookingRef}
                  {' · '}
                  {t('group.createdDetail', { n: buchen.data.reservations.length })}
                </span>
              </>
            ) : (
              <>
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
                        className={KNOPF}>
                  {t('group.submit')}
                </button>
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('booking.close')}
                </button>
                {/* Daneben und nicht im `title`: ein gesperrter Knopf nimmt keine
                    Zeigerereignisse an, sein Tooltip erscheint in den meisten
                    Browsern gar nicht. */}
                {grund !== null && (
                  <span className="self-center text-xs text-amber-800">{t(grund)}</span>
                )}
              </>
            )}>
      {/*
        * Oben die drei Entscheidungen, die fuer die ganze Gruppe gelten --
        * Zeitraum, Preisebene, Besteller --, darunter die Zimmer als
        * Tabelle. Vorher standen alle drei unter der Zimmerliste, und wer
        * acht Zimmer ausgewaehlt hatte, fand den Gast erst nach dem Rollen.
        */}
      <div className="space-y-6">
        <div className="grid gap-x-8 gap-y-6 lg:grid-cols-3">
          <Abschnitt titel={t('group.sectionPeriod')} hinweis={t('group.periodHint')}>
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
            <div className="grid grid-cols-2 gap-3">
              <Feld label={t('booking.arrival')}>
                <input type="date" value={arrival}
                       onChange={e => setArrival(e.target.value)}
                       disabled={abruf !== null} className={FELD} />
              </Feld>
              <Feld label={t('booking.departure')}>
                <input type="date" value={departure}
                       onChange={e => setDeparture(e.target.value)}
                       disabled={abruf !== null} className={FELD} />
              </Feld>
            </div>
            {naechte > 0 && (
              <div className="text-xs text-neutral-500 tabular-nums">
                {t('group.nights', { n: naechte })}
              </div>
            )}
          </Abschnitt>

          {/*
            * Der Preis, und darueber die Frage, auf welcher Ebene er gilt.
            *
            * Die Vorgabe ist der Gruppenpreis, weil das der Normalfall ist:
            * verhandelt wird ein Betrag fuer alles. Je Zimmer ist der
            * Sonderfall -- getrennte Zahler, oder die Suite kostet eben
            * anders als das Doppelzimmer.
            */}
          <Abschnitt titel={t('group.sectionPrice')}>
            <div className="space-y-1 text-sm">
              <span className="block text-xs text-neutral-600">{t('group.priceLevel')}</span>
              <label className="flex items-center gap-2">
                <input type="radio" checked={!jeZimmer} onChange={() => setJeZimmer(false)} />
                {t('group.priceWhole')}
              </label>
              <label className="flex items-center gap-2">
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
          </Abschnitt>

          <Abschnitt titel={t('group.sectionGuest')}>
            {/*
              * Kein <label> um die Gastauswahl, und das ist keine Stilfrage.
              *
              * Ein Klick auf einen Treffer der Liste loeste die Auswahl aus --
              * und nahm sie im selben Wimpernschlag wieder zurueck. Der Grund
              * liegt im <label>: es leitet einen Klick an sein erstes
              * bedienbares Kind weiter. Vor der Auswahl ist das das Suchfeld,
              * danach steht dort der Knopf "Aendern" -- und der ruft
              * `onChange(null)`. Das Ergebnis war eine Buchungsmaske, in der
              * sich schlicht kein Gast setzen liess; der Aufruf ging ohne
              * `guestRef` hinaus, und niemandem fiel es auf, weil die Buchung
              * ja gelang.
              *
              * Auch `Feld` faellt darunter: es rendert ein <label>.
              */}
            <div className="block text-sm">
              <span className="block text-xs text-neutral-600 mb-1">{t('booking.guest')}</span>
              <GuestPicker value={guest} onChange={setGuest} />
              <span className="block text-xs text-neutral-500 mt-1">{t('group.guestHint')}</span>
            </div>
            <Feld label={t('booking.notes')}>
              <input value={notes} onChange={e => setNotes(e.target.value)}
                     className={FELD} />
            </Feld>
          </Abschnitt>
        </div>

        {/*
          * Die Zimmer als Tabelle, mit den Datumsfeldern **in** der Zeile.
          *
          * Vorher standen sie hinter einem Knopf "eigene Tage" und klappten
          * darunter auf. Der Grund dafuer war die Breite der Maske: acht
          * Zeilen mit je zwei Datumsfeldern passten nicht in 448 Pixel. In
          * einer breiten Tabelle passen sie, und dann ist das Aufklappen nur
          * ein Klick, der verbirgt, was ohnehin jeder sehen will.
          *
          * Der Zustand bleibt derselbe: gespeichert wird nur, was abweicht.
          * Eine Zeile, die niemand angefasst hat, zeigt die Tage der Gruppe
          * und schickt keine eigenen -- sie geht mit, wenn die Gruppe oben
          * verschoben wird.
          */}
        <Abschnitt titel={t('group.selection')}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-neutral-500 text-left">
                <th className="font-medium py-1">{t('common.room')}</th>
                <th className="font-medium">{t('common.category')}</th>
                <th className="font-medium">{t('booking.arrival')}</th>
                <th className="font-medium">{t('booking.departure')}</th>
                <th className="font-medium text-right">{t('group.nightsHead')}</th>
                {jeZimmer && <th className="font-medium">{t('group.sectionPrice')}</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {zimmer.map(z => {
                const eigen = eigeneTage[z.resourceId]
                const von = eigen?.arrival ?? arrival
                const bis = eigen?.departure ?? departure
                const zeileNaechte = daysBetween(von, bis)
                return (
                  <tr key={z.resourceId}
                      className={`border-t border-neutral-100 align-middle
                                  ${eigen !== undefined ? 'bg-amber-50/60' : ''}`}>
                    <td className="py-1.5 tabular-nums font-medium whitespace-nowrap">
                      {z.roomCode}
                      {/* Die Abweichung wird benannt, nicht nur eingefaerbt:
                          eine Farbe allein sagt nicht, was sie bedeutet. */}
                      {eigen !== undefined && (
                        <span className="ml-2 text-xs font-normal text-amber-800">
                          {t('group.ownDates')}
                        </span>
                      )}
                    </td>
                    <td className="text-neutral-500 truncate max-w-48">{z.categoryName}</td>
                    <td className="pr-2">
                      <input type="date" value={von} disabled={abruf !== null}
                             onChange={e => tagSetzen(z.resourceId, 'arrival', e.target.value)}
                             className="border border-neutral-300 rounded px-2 py-1 text-sm
                                        disabled:bg-neutral-100 disabled:text-neutral-500" />
                    </td>
                    <td className="pr-2">
                      <input type="date" value={bis} disabled={abruf !== null}
                             onChange={e => tagSetzen(z.resourceId, 'departure', e.target.value)}
                             className="border border-neutral-300 rounded px-2 py-1 text-sm
                                        disabled:bg-neutral-100 disabled:text-neutral-500" />
                    </td>
                    <td className={`tabular-nums text-right pr-2
                                    ${zeileNaechte <= 0 ? 'text-red-700 font-medium' : ''}`}>
                      {zeileNaechte}
                    </td>
                    {jeZimmer && (
                      <td className="pr-2">
                        <PreisFelder klein naechte={zeileNaechte}
                                     wert={zimmerPreis[z.resourceId] ?? LEERER_PREIS}
                                     onChange={w => setZimmerPreis(
                                       { ...zimmerPreis, [z.resourceId]: w })} />
                      </td>
                    )}
                    <td className="text-right whitespace-nowrap">
                      {/*
                        * Zurueck auf die Tage der Gruppe -- beim Abruf aus
                        * einem Kontingent gar nicht erst angeboten: dort
                        * gilt dessen Zeitraum fuer alle, und ein Knopf, der
                        * eine Fehlermeldung erzeugt, laesst die Rezeption
                        * den Fehler bei sich suchen.
                        */}
                      {abruf === null && eigen !== undefined && (
                        <button type="button"
                                onClick={() => setEigeneTage(v => {
                                  // Den Eintrag entfernen, nicht auf die
                                  // Gruppentage setzen: nur "nicht da" heisst
                                  // "erbt", und ein gesetzter Wert bliebe
                                  // stehen, wenn die Gruppentage sich aendern.
                                  const rest = { ...v }
                                  delete rest[z.resourceId]
                                  return rest
                                })}
                                className="text-xs text-neutral-600 px-1 underline
                                           decoration-dotted">
                          {t('group.sameDates')}
                        </button>
                      )}
                      <button type="button"
                              onClick={() => setZimmer(
                                zimmer.filter(x => x.resourceId !== z.resourceId))}
                              title={t('group.remove')}
                              className="text-neutral-400 hover:text-red-700 px-2">
                        ×
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {zimmer.length === 0 && (
            <div className="text-sm text-amber-800">{t('group.empty')}</div>
          )}
        </Abschnitt>

        {buchen.isError && <Fehler error={buchen.error} />}
      </div>
    </Dialog>
  )
}
