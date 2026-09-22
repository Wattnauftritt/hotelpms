import { useState } from 'react'
import type { Guest, Block } from '@hotelpms/contracts'
import { useCreateBooking } from '../lib/queries/booking.js'
import { useT } from '../lib/i18n/index.js'
import { daysBetween } from '../lib/dates.js'
import { preisFelder, LEERER_PREIS, type Preiseingabe } from '../lib/preisEingabe.js'
import { GuestPicker } from './GuestPicker.tsx'
import { KontingentWahl } from './KontingentWahl.tsx'
import { PreisFelder } from './PreisFelder.tsx'
import { Dialog, Abschnitt, Feld, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler } from './Shell.tsx'

/**
 * Neue Reservierung: im Plan aufgezogen (A2) oder aus einer Zelle des
 * Verfügbarkeitsrasters heraus (A8).
 *
 * **Reservierung, nicht Buchung.** Das Datenmodell trennt beides: eine
 * `booking` hält mehrere `reservation`, und hier entsteht ein Aufenthalt in
 * einem Zimmer. Die Rezeption trägt eine Buchung ein, sie erstellt keine --
 * gebucht hat der Gast.
 *
 * Zimmer, falls eines mitkommt, und Zeitraum stehen als Vorschlag fest --
 * aufgezogen oder angeklickt wurde genau das. Die Buchung entsteht mit
 * `resourceId` in einem Aufruf und landet deshalb im vorgeschlagenen
 * Zimmer, nicht in irgendeinem der Gruppe; ohne Zimmer bindet sie nur die
 * Gruppe, wie jede andere freie Buchung auch.
 */
/** Der Tag davor, als Kalenderdatum. Nie ueber `new Date(iso)` -- das
 *  verschiebt je nach Zeitzone um einen Tag (CLAUDE.md, "Geld und Datum"). */
function vortag(iso: string): string {
  const [j, m, t] = iso.split('-').map(Number)
  const d = new Date(Date.UTC(j!, m! - 1, t! - 1))
  return d.toISOString().slice(0, 10)
}

export function BookingDialog({ propertyId, categoryId, categoryName, resourceId, roomCode,
                                maxOccupancy,
                                arrival: anfangsAnreise, departure: anfangsAbreise, onClose }: {
  propertyId: number; categoryId: number; categoryName: string
  resourceId?: number; roomCode?: string
  /** Plaetze der Zimmergruppe. Ohne Angabe wird nicht nachgefragt. */
  maxOccupancy?: number
  arrival: string; departure: string
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const [guest, setGuest] = useState<Guest | null>(null)
  const [notes, setNotes] = useState('')
  const [arrival, setArrival] = useState(anfangsAnreise)
  const [departure, setDeparture] = useState(anfangsAbreise)
  const [unverbindlich, setUnverbindlich] = useState(false)
  /*
   * Die Option hält bis zum Vortag der Anreise, als Vorschlag. Kein fester
   * Abstand in Tagen: bei einer Anreise übermorgen wären sieben Tage eine
   * Frist nach der Anreise, und die Option verfiele nie.
   */
  const [optionBis, setOptionBis] = useState(() => vortag(anfangsAnreise))
  /*
   * Als Text, nicht als Zahl: ein leeres Feld ist etwas anderes als eine
   * Null, und `useState<number>` kann das leere Feld nicht halten.
   *
   * Dazu die Seite, auf der getippt wurde -- je Nacht oder insgesamt. Sie
   * entscheidet, welcher der beiden Betraege die Vereinbarung ist und
   * welcher nur mitgerechnet wird.
   */
  const [preis, setPreis] = useState<Preiseingabe>(LEERER_PREIS)
  /*
   * Abruf aus einem Kontingent statt aus dem freien Verkauf.
   *
   * Setzt den Zeitraum und sperrt ihn: ein Abruf verbraucht das Kontingent
   * ganz, und ein abweichender liesse an den uebrigen Tagen dauerhaft
   * Kapazitaet gebunden, die niemandem mehr gehoert.
   */
  const [abruf, setAbruf] = useState<Block | null>(null)
  /*
   * **Vorbelegt mit der Belegung der Zimmergruppe.** Ein Doppelzimmer wird
   * als Doppelzimmer verkauft, und in den allermeisten Faellen reisen auch
   * zwei an -- das Feld leer zu lassen hiesse, die Rezeption bei jeder
   * Buchung dieselbe Zahl eintippen zu lassen, und dann tippt sie irgendwann
   * gar nichts mehr.
   *
   * Kommt keine Belegung mit (das Verfuegbarkeitsraster kennt nur die
   * Gruppe, nicht das Zimmer), bleibt das Feld leer, und leer heisst
   * weiterhin "nicht gesagt" -- dann gilt, was verkauft wurde.
   */
  const [personen, setPersonen] = useState(
    maxOccupancy === undefined ? '' : String(maxOccupancy))
  const [kurznotiz, setKurznotiz] = useState('')
  const buchen = useCreateBooking(propertyId)

  /*
   * **Ohne Gast geht nichts hinaus.** Vorher war der Knopf auch dann aktiv,
   * wenn niemand ausgewählt war: `guestRef` blieb `undefined`, die
   * Reservierung entstand ohne Gast, und im Plan stand danach ihre Kennung
   * an der Stelle des Namens. Das sah aus, als erfinde das System Namen.
   *
   * Die Datenbank lässt eine Reservierung ohne Gast weiterhin zu, und das
   * bleibt richtig: aus einem Kanal kommt sie manchmal so an. Wer sie hier
   * von Hand anlegt, weiß dagegen immer einen Namen -- und sei es nur
   * „Meier".
   */
  // Die Naechte des Aufenthalts -- das Band zwischen den beiden Preisfeldern.
  // Aendert sich das Datum, rechnet das abgeleitete Feld mit.
  const naechte = daysBetween(arrival, departure)
  /**
   * Warum der Knopf gesperrt ist -- `null`, wenn er es nicht ist.
   *
   * **Ein gesperrter Knopf ohne Grund ist ein Knopf, der nicht
   * funktioniert.** Genau so kam es an: geklickt, nichts passiert, und
   * nichts auf dem Bildschirm sagte, was fehlt. Der haeufigste Fall ist der
   * Gast -- er steht weiter unten in der Maske, und wer oben Datum und
   * Zimmer ausgefuellt hat, haelt sie fuer fertig.
   *
   * Die Reihenfolge ist die der Maske von oben nach unten: genannt wird,
   * was man zuerst findet, nicht was zuerst geprueft wird.
   */
  const grund =
    departure <= arrival ? 'booking.needNights'
    : guest === null ? 'booking.needGuest'
    : unverbindlich && optionBis === '' ? 'booking.needOptionUntil'
    : null
  const gueltig = grund === null

  /*
   * Überbelegung ist erlaubt und braucht eine Rückfrage. Ein Kleinkind im
   * Doppelzimmer ist der Normalfall, kein Fehler -- es zu verbieten hieße,
   * die Rezeption zum Ausweichen auf eine falsche Zahl zu zwingen, und
   * dann stimmt die Kurtaxe nicht mehr.
   */
  const anzahl = personen.trim() === '' ? null : Number(personen)
  const zuViele = anzahl !== null && maxOccupancy !== undefined
    && Number.isFinite(anzahl) && anzahl > maxOccupancy

  const absenden = (): void => {
    if (zuViele && !confirm(
      t('booking.overCapacity', { max: maxOccupancy!, n: anzahl! }))) return
    buchen.mutate({
      propertyId, categoryId, arrival, departure, resourceId,
      guestRef: guest?.guestRef,
      notes: notes.trim() === '' ? undefined : notes.trim(),
      status: unverbindlich ? 'Optional' : undefined,
      optionExpiresAt: unverbindlich ? optionBis : undefined,
      /*
       * Euro im Feld, Cent auf der Leitung -- und genau **ein** Feld geht
       * hinaus, `priceCent` oder `totalCent`. Beide zugleich weist die
       * Schnittstelle ab: zwei Preise fuer dieselbe Buchung sind keine
       * Angabe, sondern eine Frage.
       *
       * Gerechnet wird ueber `centAusEingabe` und nicht mehr ueber
       * `Number(...) * 100`. Das war bei "19,90" noch harmlos, bei
       * "1.234,50" aber nicht: `Number('1.234.50')` ist `NaN`, und an einer
       * deutschen Rezeption wird der Tausenderpunkt getippt.
       */
      ...preisFelder(preis),
      blockRef: abruf?.blockRef,
      guestCount: anzahl ?? undefined,
      shortNote: kurznotiz.trim() === '' ? undefined : kurznotiz.trim()
    })
  }

  return (
    <Dialog breite="breit" onClose={onClose}
            titel={t('booking.title')}
            unterzeile={`${roomCode !== undefined ? `${roomCode} · ` : ''}${categoryName}`}
            fuss={buchen.isSuccess ? (
              <>
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('common.back')}
                </button>
                <span className="text-sm text-emerald-800">
                  ✓ {t('booking.created')} — {buchen.data.reservationRef}
                </span>
              </>
            ) : (
              <>
                <button type="button" disabled={buchen.isPending || !gueltig}
                        onClick={absenden} className={KNOPF}>
                  {t('booking.submit')}
                </button>
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('booking.close')}
                </button>
                {/*
                  * Der Grund steht **daneben**, nicht im `title`. Ein
                  * gesperrter Knopf nimmt keine Zeigerereignisse an; sein
                  * Tooltip erscheint in den meisten Browsern gar nicht -- er
                  * waere also genau dort unsichtbar, wo er gebraucht wird.
                  */}
                {grund !== null && (
                  <span className="self-center text-xs text-amber-800">{t(grund)}</span>
                )}
              </>
            )}>
      {/*
        * Zwei Spalten: links der Aufenthalt, rechts der Gast.
        *
        * Das ist die Reihenfolge, in der an der Rezeption gefragt wird --
        * "wann" steht fest, bevor "wer" getippt ist. Untereinander waren es
        * elf Felder in einer Rolle, und der Gast stand so weit unten, dass
        * die Maske darueber fertig aussah.
        */}
      <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
        <Abschnitt titel={t('booking.sectionStay')}>
          <div className="text-sm bg-neutral-50 rounded px-3 py-2">
            <div className="text-xs text-neutral-500">{t('booking.category')}</div>
            <div>{roomCode !== undefined ? `${roomCode} · ` : ''}{categoryName}</div>
          </div>

          <KontingentWahl propertyId={propertyId} categoryId={categoryId}
                          gewaehlt={abruf} benoetigt={1}
                          onChange={b => {
                            setAbruf(b)
                            // Die Tage kommen mit dem Kontingent, sie werden
                            // nicht vorgeschlagen: ein Abruf verbraucht es ganz.
                            if (b !== null) { setArrival(b.fromDate); setDeparture(b.toDate) }
                          }} />

          <div className="grid grid-cols-2 gap-3">
            <Feld label={t('booking.arrival')}>
              <input type="date" value={arrival} onChange={e => setArrival(e.target.value)}
                     disabled={abruf !== null} className={FELD} />
            </Feld>
            <Feld label={t('booking.departure')}>
              <input type="date" value={departure}
                     onChange={e => setDeparture(e.target.value)}
                     disabled={abruf !== null} className={FELD} />
            </Feld>
          </div>
          {/* Die Naechte als Zahl daneben: der Unterschied zwischen dem 3.
              und dem 10. ist sieben, und niemand rechnet ihn im Kopf, wenn
              der Monat dazwischen wechselt. */}
          {naechte > 0 && (
            <div className="text-xs text-neutral-500 tabular-nums">
              {t('group.nights', { n: naechte })}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Feld label={t('booking.status')}>
              <select value={unverbindlich ? 'optional' : 'confirmed'}
                      onChange={e => setUnverbindlich(e.target.value === 'optional')}
                      className={FELD}>
                <option value="confirmed">{t('booking.statusConfirmed')}</option>
                <option value="optional">{t('booking.statusOptional')}</option>
              </select>
            </Feld>
            {/* Die Frist erscheint nur, wenn sie gebraucht wird. Ein Feld,
                das bei einer verbindlichen Buchung leer danebensteht, wird
                irgendwann versehentlich gefuellt. */}
            {unverbindlich && (
              <Feld label={t('booking.optionUntil')} hinweis={t('booking.optionHint')}>
                <input type="date" value={optionBis}
                       onChange={e => setOptionBis(e.target.value)}
                       className={FELD} />
              </Feld>
            )}
          </div>
        </Abschnitt>

        <Abschnitt titel={t('booking.sectionGuest')}>
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
          </div>

          {/* Der Grund steht an der gesperrten Stelle, nicht am Knopf: wer
              dort sucht, warum nichts geht, sucht bei sich. */}
          {guest === null && (
            <div className="text-xs text-neutral-500">{t('booking.guestRequired')}</div>
          )}

          {/* Erst das Merkmal, dann der Vorgang. In dieser Reihenfolge, weil
              die Kurznotiz die ist, die jeder Blick auf den Plan liest. */}
          <Feld label={t('booking.shortNote')} hinweis={t('booking.shortNoteHint')}>
            <input value={kurznotiz} onChange={e => setKurznotiz(e.target.value)}
                   maxLength={40} placeholder={t('booking.shortNotePlaceholder')}
                   className={FELD} />
          </Feld>

          <Feld label={t('booking.notes')}>
            <input value={notes} onChange={e => setNotes(e.target.value)}
                   className={FELD} />
          </Feld>
        </Abschnitt>

        <Abschnitt titel={t('booking.sectionPrice')}
                   hinweis={`${t('booking.priceHint')} ${t('booking.guestsHint')}`}
                   className="md:col-span-2">
          <div className="flex flex-wrap items-end gap-4">
            <PreisFelder wert={preis} naechte={naechte} onChange={setPreis} />
            <Feld label={t('booking.guests')}>
              <input value={personen} onChange={e => setPersonen(e.target.value)}
                     inputMode="numeric" placeholder="—"
                     className="border border-neutral-300 rounded px-3 py-2 text-sm w-24" />
            </Feld>
          </div>
        </Abschnitt>

        {buchen.isError && (
          <div className="md:col-span-2"><Fehler error={buchen.error} /></div>
        )}
      </div>
    </Dialog>
  )
}
