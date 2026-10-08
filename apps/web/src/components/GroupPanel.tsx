import { useState, type JSX } from 'react'
import { useBooking, useShiftBooking, useAddBookingRoom, useChangeStay, istAusgebucht,
         useReservationStatusAction, useSetPersons } from '../lib/queries/booking.js'
import { useT, useLocale, formatDate, formatMoney } from '../lib/i18n/index.js'
import { daysBetween } from '../lib/dates.js'
import { Dialog, Abschnitt, Feld, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
import { VerlaufDialog } from './Verlauf.tsx'
import { Fehler, Laedt } from './Shell.tsx'

/**
 * Die Gruppe als eine Maske: alle Zimmer einer Buchung nebeneinander.
 *
 * **Warum es sie geben muss.** Eine Reisegruppe ist im Datenmodell eine
 * `booking` mit mehreren `reservation`, und an der Rezeption wird sie auch
 * als eine behandelt: "die Gruppe Petersen kommt einen Tag spaeter", "wir
 * brauchen noch ein neuntes Zimmer". Ohne diese Maske hiess das, acht
 * Balken im Plan einzeln zu suchen und einzeln anzufassen -- und nach dem
 * fuenften einen Zustand zu haben, den niemand gewollt hat.
 *
 * **Verschieben gilt fuer alle, Daten aendern fuer eines.** Das ist die
 * Trennung, die der Alltag vorgibt: der Bus kommt einen Tag spaeter
 * (Gruppe), aber die Eltern des Brautpaars bleiben eine Nacht laenger
 * (ein Zimmer). Beides braucht einen eigenen Knopf, sonst macht einer der
 * beiden Faelle den anderen kaputt.
 *
 * **Ein Zimmer herausnehmen heisst stornieren, nicht loeschen.** Die
 * Reservierung bleibt mit ihrem Beleg stehen; geloescht waere sie aus der
 * Statistik verschwunden, und der Abend haette einen Storno weniger als
 * das Haus.
 */
/** Wann die Personenzahl noch aendert -- dieselbe Regel wie die Schnittstelle. */
const PERSONEN_AENDERBAR = new Set(['Inquired', 'Optional', 'Confirmed', 'InHouse'])

/** "2" oder "2 + 1" -- Erwachsene und Kinder, wo getrennt bekannt. */
function PersonenZelle({ z }: {
  z: { guestCount: number | null; adults: number | null; children: number | null }
}): JSX.Element {
  if (z.guestCount === null) return <span className="text-neutral-400">—</span>
  return (
    <span className="tabular-nums">
      {z.adults !== null && z.children !== null && z.children > 0
        ? `${z.adults} + ${z.children}` : z.guestCount}
    </span>
  )
}

export function GroupPanel({ propertyId, bookingRef, categories, onClose, onSelect }: {
  propertyId: number
  bookingRef: string
  /**
   * Die Zimmergruppen des Hauses, fuer das Zimmer, das dazukommt.
   *
   * Als Eigenschaft und nicht als eigene Abfrage: die Maske wird aus dem
   * Plan geoeffnet, und der hat die Gruppen laengst geladen. Eine zweite
   * Abfrage waere eine Runde mehr fuer eine Antwort, die schon dasteht.
   */
  categories: ReadonlyArray<{ id: number; code: string; name: string }>
  onClose: () => void
  /** Ein Zimmer im Seitenfenster oeffnen -- von hier aus der Weg zum Detail. */
  onSelect?: (reservationRef: string) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const q = useBooking(bookingRef)
  const verschieben = useShiftBooking()
  const dazu = useAddBookingRoom(propertyId)
  const umbuchen = useChangeStay()
  const personenSetzen = useSetPersons()

  /** Welches Zimmer gerade seine Tage aendert. Nur eines auf einmal. */
  const [aendert, setAendert] = useState<string | null>(null)
  const [von, setVon] = useState('')
  const [bis, setBis] = useState('')
  /*
   * Die Personen des Zimmers, das gerade geaendert wird. Hier und nicht nur
   * in der Maske am Balken: bei einer Gruppe sucht die Rezeption die Zahl in
   * der Gruppenmaske, und dort gab es bisher nur die Tage (Sven,
   * 08.10.2026: "ich kann die Personenanzahl in gespeicherten Buchungen
   * nicht mehr aendern").
   */
  const [erw, setErw] = useState('')
  const [ki, setKi] = useState('')
  const [neueGruppe, setNeueGruppe] = useState<number | ''>('')

  const daten = q.data
  const [verlauf, setVerlauf] = useState(false)

  return (
    <>
    <Dialog breite="weit" onClose={onClose}
            titel={t('group.panelTitle')} unterzeile={bookingRef}
            fuss={
              <>
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('booking.close')}
                </button>
                {/* Bei einer Gruppe ist der Verlauf der haeufigere Fall:
                    acht Zimmer, drei Umbuchungen, und niemand weiss mehr,
                    welche davon zusammengehoerten. */}
                <button type="button" onClick={() => setVerlauf(true)}
                        className={KNOPF_LEISE}>
                  {t('verlauf.title')}
                </button>
              </>
            }>
      {q.isError ? <Fehler error={q.error} />
        : daten === undefined ? <Laedt />
        : (
          <div className="space-y-6">
            {/*
              * Die Eckdaten als Kacheln statt als Zeile: in einer breiten
              * Maske ist eine Zeile aus drei Angaben ein Streifen, in dem
              * keine der drei auffaellt.
              */}
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                { k: t('booking.guest'), v: daten.companyName ?? daten.guestName ?? '—' },
                { k: t('group.rooms'), v: String(daten.rooms.length) },
                { k: t('group.total'), v: formatMoney(daten.totalCent, locale) }
              ].map(f => (
                <div key={f.k} className="bg-neutral-50 rounded-sm px-3 py-2">
                  <div className="text-xs text-neutral-500">{f.k}</div>
                  <div className="text-base tabular-nums truncate">{f.v}</div>
                </div>
              ))}
            </div>

            {/*
              * Verschieben der ganzen Gruppe.
              *
              * Ein Versatz in Tagen, kein neuer Zeitraum: liegen die
              * Zimmer nach einzelnen Aenderungen nicht mehr
              * deckungsgleich, erhaelt der Versatz das. Ein gemeinsamer
              * Zeitraum machte daraus wieder einen Block und loeschte
              * genau die Abweichungen, die jemand eingetragen hat.
              */}
            <Abschnitt titel={t('group.shift')} hinweis={t('group.shiftHint')}>
              <div className="flex flex-wrap items-center gap-2">
                {[-7, -1, 1, 7].map(n => (
                  <button key={n} type="button" disabled={verschieben.isPending}
                          onClick={() => verschieben.mutate({ bookingRef, shiftDays: n }, {
                            // Volle Zimmergruppe: nachfragen statt abweisen (0093).
                            onError: fehler => {
                              if (istAusgebucht(fehler) && confirm(t('plan.overbookConfirm'))) {
                                verschieben.mutate(
                                  { bookingRef, shiftDays: n, allowOverbooking: true })
                              }
                            }
                          })}
                          className="px-3 py-2 rounded-sm border border-neutral-300 text-sm
                                     tabular-nums bg-white hover:bg-neutral-50
                                     disabled:opacity-50">
                    {n > 0 ? `+${n}` : n}
                  </button>
                ))}
              </div>
              {verschieben.isError && <Fehler error={verschieben.error} />}
            </Abschnitt>

            <Abschnitt titel={t('group.selection')}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-neutral-500 text-left">
                    <th className="font-medium py-1">{t('common.room')}</th>
                    <th className="font-medium">{t('common.status')}</th>
                    <th className="font-medium">{t('booking.arrival')}</th>
                    <th className="font-medium">{t('booking.departure')}</th>
                    <th className="font-medium text-right">{t('group.nightsHead')}</th>
                    <th className="font-medium pl-3">{t('group.personsHead')}</th>
                    <th className="font-medium text-right">{t('group.total')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {daten.rooms.map(z => {
                    const storniert = z.status === 'Canceled' || z.status === 'NoShow'
                    /*
                     * Geaendert wird **in** der Zeile und nicht in einem
                     * Formular darunter: bei zwoelf Zimmern stand dort
                     * zuletzt ein Paar Datumsfelder, dem man nicht mehr
                     * ansah, zu welcher Zeile es gehoert.
                     */
                    const offen = aendert === z.reservationRef
                    const personenAenderbar = PERSONEN_AENDERBAR.has(z.status)
                    const erwVorher = z.adults ?? z.guestCount
                    const kiVorher = z.children ?? 0
                    const anzErw = erw.trim() === '' ? null : Number(erw)
                    const anzKi = ki.trim() === '' ? 0 : Number(ki)
                    const personenAnders = personenAenderbar
                      && !(anzErw === null && erwVorher === null && anzKi === 0)
                      && (anzErw !== erwVorher || anzKi !== kiVorher)
                    const personenGueltig = anzErw !== null && Number.isInteger(anzErw)
                      && anzErw >= 1 && Number.isInteger(anzKi) && anzKi >= 0
                    const tageAnders = von !== z.arrival || bis !== z.departure
                    return (
                      <tr key={z.reservationRef}
                          className={`border-t border-neutral-100 align-middle
                                      ${offen ? 'bg-neutral-50' : ''}
                                      ${storniert ? 'text-neutral-400 line-through' : ''}`}>
                        <td className="py-1.5">
                          <button type="button" onClick={() => onSelect?.(z.reservationRef)}
                                  className="tabular-nums font-medium underline
                                             decoration-dotted">
                            {z.roomCode ?? t('group.unassigned')}
                          </button>
                          <span className="text-neutral-500 text-xs ml-2">
                            {z.categoryCode}
                          </span>
                        </td>
                        <td className="text-neutral-600">{t(`status.${z.status}` as never)}</td>
                        {offen ? (
                          <>
                            <td className="pr-2">
                              <input type="date" value={von}
                                     onChange={e => setVon(e.target.value)}
                                     className="border border-neutral-300 rounded-sm
                                                px-2 py-1 text-sm" />
                            </td>
                            <td className="pr-2">
                              <input type="date" value={bis}
                                     onChange={e => setBis(e.target.value)}
                                     className="border border-neutral-300 rounded-sm
                                                px-2 py-1 text-sm" />
                            </td>
                            <td className="tabular-nums text-right pr-2">
                              {daysBetween(von, bis)}
                            </td>
                            <td className="pl-3 pr-2 whitespace-nowrap">
                              {personenAenderbar ? (
                                <>
                                  <input value={erw} onChange={e => setErw(e.target.value)}
                                         inputMode="numeric" placeholder="—"
                                         aria-label={t('booking.adults')}
                                         title={t('booking.adults')}
                                         className="border border-neutral-300 rounded-sm
                                                    px-2 py-1 text-sm w-12 tabular-nums" />
                                  <span className="text-neutral-400 px-1">+</span>
                                  <input value={ki} onChange={e => setKi(e.target.value)}
                                         inputMode="numeric" placeholder="0"
                                         aria-label={t('booking.children')}
                                         title={t('booking.children')}
                                         className="border border-neutral-300 rounded-sm
                                                    px-2 py-1 text-sm w-12 tabular-nums" />
                                </>
                              ) : <PersonenZelle z={z} />}
                            </td>
                            <td />
                            <td className="text-right whitespace-nowrap">
                              <button type="button"
                                      disabled={umbuchen.isPending || personenSetzen.isPending
                                                || daysBetween(von, bis) <= 0
                                                || (personenAnders && !personenGueltig)
                                                || (!tageAnders && !personenAnders)}
                                      onClick={() => {
                                        const body = { reservationRef: aendert,
                                                       arrival: von, departure: bis }
                                        const fertig = (): void => {
                                          setAendert(null); void q.refetch() }
                                        // Die Personen nach den Tagen: scheitern
                                        // die Tage, bleibt alles beim Alten.
                                        const nachTagen = !personenAnders ? fertig
                                          : (): void => personenSetzen.mutate(
                                            { reservationRef: z.reservationRef,
                                              adults: anzErw!,
                                              children: anzKi > 0 || kiVorher > 0
                                                ? anzKi : undefined },
                                            { onSuccess: fertig })
                                        if (!tageAnders) { nachTagen(); return }
                                        umbuchen.mutate(body, {
                                          onSuccess: nachTagen,
                                          onError: fehler => {
                                            if (istAusgebucht(fehler)
                                                && confirm(t('plan.overbookConfirm'))) {
                                              umbuchen.mutate(
                                                { ...body, allowOverbooking: true },
                                                { onSuccess: nachTagen })
                                            }
                                          }
                                        })
                                      }}
                                      className="px-2 py-1 text-xs rounded-sm bg-neutral-900
                                                 text-white disabled:bg-neutral-300">
                                {t('common.save')}
                              </button>
                              <button type="button" onClick={() => setAendert(null)}
                                      className="px-2 py-1 text-xs rounded-sm border
                                                 border-neutral-300 ml-1">
                                {t('common.cancel')}
                              </button>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="tabular-nums">{formatDate(z.arrival, locale)}</td>
                            <td className="tabular-nums">{formatDate(z.departure, locale)}</td>
                            <td className="tabular-nums text-right pr-2">
                              {daysBetween(z.arrival, z.departure)}
                            </td>
                            <td className="pl-3"><PersonenZelle z={z} /></td>
                            <td className="tabular-nums text-right">
                              {formatMoney(z.totalCent, locale)}
                            </td>
                            <td className="text-right whitespace-nowrap">
                              {!storniert && (
                                <>
                                  <button type="button"
                                          onClick={() => {
                                            setAendert(z.reservationRef)
                                            setVon(z.arrival)
                                            setBis(z.departure)
                                            setErw(erwVorher === null ? '' : String(erwVorher))
                                            setKi(kiVorher === 0 ? '' : String(kiVorher))
                                          }}
                                          className="text-xs text-neutral-600 px-1 underline
                                                     decoration-dotted">
                                    {t('group.changeDates')}
                                  </button>
                                  <ZimmerRaus reservationRef={z.reservationRef} />
                                </>
                              )}
                            </td>
                          </>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {umbuchen.isError && <Fehler error={umbuchen.error} />}
              {personenSetzen.isError && <Fehler error={personenSetzen.error} />}
            </Abschnitt>

            {/*
              * Ein Zimmer dazu.
              *
              * Ohne Zimmernummer: welches es wird, entscheidet die
              * Zuweisung im Plan. Hier geht es um den Platz in der
              * Zimmergruppe -- das ist die Frage, die der Bestand
              * beantwortet.
              */}
            <Abschnitt titel={t('group.addRoom')} hinweis={t('group.addHint')}>
              <div className="flex flex-wrap items-end gap-3">
                <Feld label={t('common.category')} className="grow max-w-sm">
                  <select value={neueGruppe}
                          onChange={e => setNeueGruppe(
                            e.target.value === '' ? '' : Number(e.target.value))}
                          className={FELD}>
                    <option value="">{t('group.pickCategory')}</option>
                    {categories.map(k => (
                      <option key={k.id} value={k.id}>{k.code} · {k.name}</option>
                    ))}
                  </select>
                </Feld>
                <button type="button" disabled={neueGruppe === '' || dazu.isPending}
                        onClick={() => {
                          const body = { bookingRef, categoryId: neueGruppe as number }
                          dazu.mutate(body, {
                            onSuccess: () => setNeueGruppe(''),
                            onError: fehler => {
                              if (istAusgebucht(fehler) && confirm(t('plan.overbookConfirm'))) {
                                dazu.mutate({ ...body, allowOverbooking: true },
                                            { onSuccess: () => setNeueGruppe('') })
                              }
                            }
                          })
                        }}
                        className={KNOPF}>
                  {t('group.add')}
                </button>
              </div>
              {dazu.isError && <Fehler error={dazu.error} />}
            </Abschnitt>
          </div>
        )}
    </Dialog>

    {/* Neben der Gruppenmaske und nicht in ihr: der Verlauf gehoert zur
        Buchung, nicht zu einem ihrer Abschnitte, und Escape schliesst
        dank der gemeinsamen Lage erst ihn und dann sie. */}
    {verlauf && (
      <VerlaufDialog was={{ art: 'buchung', ref: bookingRef }}
                     titel={t('verlauf.title')} unterzeile={bookingRef}
                     onClose={() => setVerlauf(false)} />
    )}
    </>
  )
}

/**
 * Ein Zimmer aus der Gruppe nehmen.
 *
 * Eine eigene kleine Komponente, weil `useReservationStatusAction` je
 * Reservierung einen eigenen Hook braucht -- in einer Schleife ueber die
 * Zeilen ginge das nicht, Hooks duerfen nicht in Schleifen stehen.
 *
 * Mit Rueckfrage: ein Storno ist nicht zurueckzunehmen, ohne dass er im
 * Protokoll steht, und ein Klick daneben trifft hier eine Zeile, die
 * neben der gemeinten liegt.
 */
function ZimmerRaus({ reservationRef }: { reservationRef: string }): JSX.Element {
  const t = useT()
  const aktion = useReservationStatusAction(reservationRef)
  return (
    <button type="button" disabled={aktion.isPending}
            onClick={() => {
              if (confirm(t('group.removeConfirm'))) aktion.mutate('cancel')
            }}
            title={t('group.remove')}
            className="text-xs text-neutral-500 hover:text-red-700 px-1 disabled:opacity-50">
      ×
    </button>
  )
}
