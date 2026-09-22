import { useState } from 'react'
import type { Guest, Block } from '@hotelpms/contracts'
import { useCreateBooking } from '../lib/queries/booking.js'
import { useT } from '../lib/i18n/index.js'
import { daysBetween } from '../lib/dates.js'
import { preisFelder, LEERER_PREIS, type Preiseingabe } from '../lib/preisEingabe.js'
import { GuestPicker } from './GuestPicker.tsx'
import { KontingentWahl } from './KontingentWahl.tsx'
import { PreisFelder } from './PreisFelder.tsx'
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
         onClick={onClose}>
      <div className="w-full max-w-md bg-white rounded shadow-xl p-4 space-y-3"
           onClick={e => e.stopPropagation()}>
        <h2 className="text-sm font-medium">{t('booking.title')}</h2>

        <div className="text-sm bg-neutral-50 rounded p-2">
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
        </div>

        {/* Der Grund steht an der gesperrten Stelle, nicht am Knopf: wer
            dort sucht, warum nichts geht, sucht bei sich. */}
        {guest === null && (
          <div className="text-xs text-neutral-500">{t('booking.guestRequired')}</div>
        )}

        <div className="flex flex-wrap gap-3">
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">{t('booking.status')}</span>
            <select value={unverbindlich ? 'optional' : 'confirmed'}
                    onChange={e => setUnverbindlich(e.target.value === 'optional')}
                    className="border border-neutral-300 rounded px-2 py-1 text-sm">
              <option value="confirmed">{t('booking.statusConfirmed')}</option>
              <option value="optional">{t('booking.statusOptional')}</option>
            </select>
          </label>
          <PreisFelder wert={preis} naechte={naechte} onChange={setPreis} />
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">{t('booking.guests')}</span>
            <input value={personen} onChange={e => setPersonen(e.target.value)}
                   inputMode="numeric" placeholder="—"
                   className="border border-neutral-300 rounded px-2 py-1 text-sm w-20" />
          </label>
        </div>

        {/* Die Frist erscheint nur, wenn sie gebraucht wird. Ein Feld, das
            bei einer verbindlichen Buchung leer danebensteht, wird
            irgendwann versehentlich gefuellt. */}
        {unverbindlich && (
          <label className="block text-sm">
            <span className="block text-xs text-neutral-600 mb-1">
              {t('booking.optionUntil')}
            </span>
            <input type="date" value={optionBis}
                   onChange={e => setOptionBis(e.target.value)}
                   className="border border-neutral-300 rounded px-2 py-1 text-sm" />
            <div className="text-xs text-neutral-500 mt-0.5">{t('booking.optionHint')}</div>
          </label>
        )}

        <div className="text-xs text-neutral-500">
          {t('booking.priceHint')} {t('booking.guestsHint')}
        </div>

        {/* Erst das Merkmal, dann der Vorgang. In dieser Reihenfolge, weil
            die Kurznotiz die ist, die jeder Blick auf den Plan liest. */}
        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">
            {t('booking.shortNote')}
          </span>
          <input value={kurznotiz} onChange={e => setKurznotiz(e.target.value)}
                 maxLength={40} placeholder={t('booking.shortNotePlaceholder')}
                 className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
          <div className="text-xs text-neutral-500 mt-0.5">
            {t('booking.shortNoteHint')}
          </div>
        </label>

        <label className="block text-sm">
          <span className="block text-xs text-neutral-600 mb-1">{t('booking.notes')}</span>
          <input value={notes} onChange={e => setNotes(e.target.value)}
                 className="w-full border border-neutral-300 rounded px-2 py-1 text-sm" />
        </label>

        {buchen.isError && <Fehler error={buchen.error} />}
        {buchen.isSuccess ? (
          <>
            <p className="text-sm text-emerald-800">
              ✓ {t('booking.created')} — {buchen.data.reservationRef}
            </p>
            <button type="button" onClick={onClose}
                    className="px-3 py-1.5 text-sm rounded border border-neutral-300">
              {t('common.back')}
            </button>
          </>
        ) : (
          <div className="flex gap-2">
            <button type="button" disabled={buchen.isPending || !gueltig}
                    onClick={absenden}
                    className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white
                               disabled:bg-neutral-300">
              {t('booking.submit')}
            </button>
            <button type="button" onClick={onClose}
                    className="px-3 py-1.5 text-sm rounded border border-neutral-300">
              {t('booking.close')}
            </button>
            {/*
              * Der Grund steht **daneben**, nicht im `title`. Ein gesperrter
              * Knopf nimmt keine Zeigerereignisse an; sein Tooltip erscheint
              * in den meisten Browsern gar nicht -- er waere also genau dort
              * unsichtbar, wo er gebraucht wird.
              */}
            {grund !== null && (
              <span className="self-center text-xs text-amber-800">{t(grund)}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
