import { useState } from 'react'
import type { Guest, Block } from '@hotelpms/contracts'
import { useCreateBooking, istAusgebucht, type CreateBookingBody }
  from '../lib/queries/booking.js'
import { useT, useLocale, formatMoney } from '../lib/i18n/index.js'
import { daysBetween } from '../lib/dates.js'
import { preisFelder, alsGesamt, LEERER_PREIS, type Preiseingabe }
  from '../lib/preisEingabe.js'
import { eingabeAusCent } from '../lib/preisraster.js'
import { gruppenpreisJeZimmer, zimmernaechte } from '../lib/gruppenPreis.js'
import { GuestPicker, useGastAusEingabe } from './GuestPicker.tsx'
import { gastNameAnzeige } from '../lib/gastName.js'
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
                 /**
                  * Plaetze der Zimmergruppe -- das Gewicht, mit dem ein
                  * Gruppenpreis auf die Zimmer faellt. Sechs Doppelzimmer und
                  * zwei Einzelzimmer zu gleichen Teilen aufzuteilen hiesse,
                  * das Einzelzimmer so teuer zu machen wie das Doppelzimmer.
                  */
                 maxOccupancy: number
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
  const locale = useLocale()
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

  /*
   * **Wo der Preis herkommt -- nicht, wo er hindarf.**
   *
   * Hier stand ein Umschalter: entweder ein Betrag fuer die Gruppe oder
   * einer je Zimmer, und das jeweils andere Feld gab es gar nicht. Das
   * bildete die Schnittstelle ab (sie nimmt genau eines an) und nicht das
   * Gespraech am Tresen: verhandelt wird ein Gesamtbetrag, dann stimmt
   * eine Zeile nicht, und danach will man wissen, was die Summe jetzt
   * ist.
   *
   * Beide Felder sind deshalb immer da und immer tippbar. `quelle` haelt
   * nur fest, welche Seite zuletzt angefasst wurde; die andere rechnet
   * mit. Hinaus geht weiterhin genau eine -- die Schnittstelle weist die
   * Doppelangabe ab, und das zu Recht: zwei Preise fuer dieselbe Buchung
   * sind keine Angabe, sondern eine Frage.
   */
  const [quelle, setQuelle] = useState<'gruppe' | 'zimmer'>('gruppe')
  /*
   * Personen je Zimmer, vorbelegt mit der Belegung der Zimmergruppe -- wie
   * in der Einzelbuchung. Die Maske fragte bisher gar nicht danach, und
   * jede Gruppe stand ohne Personen im Plan; am ersten Zimmer las der
   * Balken dann den Besteller als "1 P." (Sven, 08.10.2026: "hat die ganze
   * Gruppe jetzt eine Person auf 5 Zimmern?"). Je Zeile, weil eine Gruppe
   * aus Doppel- und Einzelzimmern keine gemeinsame Zahl hat.
   */
  const [personen, setPersonen] = useState<Record<number, { erw: string; ki: string }>>(
    () => Object.fromEntries(selection.rooms.map(r =>
      [r.resourceId, { erw: String(r.maxOccupancy), ki: '' }])))
  const personenVon = (resourceId: number, maxOccupancy: number): { erw: string; ki: string } =>
    personen[resourceId] ?? { erw: String(maxOccupancy), ki: '' }
  const personenSetzen = (resourceId: number, maxOccupancy: number,
                          feld: 'erw' | 'ki', wert: string): void =>
    setPersonen(v => ({ ...v,
      [resourceId]: { ...(v[resourceId] ?? { erw: String(maxOccupancy), ki: '' }),
                      [feld]: wert } }))
  /*
   * Was je Zimmer hinausgeht. Ein leeres Erwachsenenfeld heisst "nicht
   * gesagt", wie in der Einzelbuchung; `null` heisst ungueltig.
   */
  const personenJeZimmer = zimmer.map(z => {
    const { erw, ki } = personenVon(z.resourceId, z.maxOccupancy)
    if (erw.trim() === '') return ki.trim() === '' ? {} : null
    const adults = Number(erw)
    const children = ki.trim() === '' ? undefined : Number(ki)
    if (!Number.isInteger(adults) || adults < 1) return null
    if (children !== undefined && (!Number.isInteger(children) || children < 0)) return null
    return children === undefined ? { adults } : { adults, children }
  })
  const [gruppenPreis, setGruppenPreis] = useState<Preiseingabe>(LEERER_PREIS)
  const [zimmerPreis, setZimmerPreis] = useState<Record<number, Preiseingabe>>({})
  const buchen = useCreateBooking(propertyId)
  // Ein eingetippter Besteller wird beim Speichern angelegt, wie in der
  // Einzelbuchung (`useGastAusEingabe`).
  const gast = useGastAusEingabe(guest, setGuest)

  const naechte = daysBetween(arrival, departure)

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

  /*
   * Die Zeitraeume und die Naechte je Zimmer -- einmal gerechnet, nicht in
   * jeder Zelle wieder. Die Preisvorschau braucht sie genauso wie die
   * Tabelle, und zwei Fassungen liefen beim naechsten Feld auseinander.
   */
  const zeitraeume = zimmer.map(z => {
    const eigen = eigeneTage[z.resourceId]
    return { von: eigen?.arrival ?? arrival, bis: eigen?.departure ?? departure }
  })
  const zeilen = zimmer.map((z, i) => ({
    naechte: daysBetween(zeitraeume[i]!.von, zeitraeume[i]!.bis),
    personen: z.maxOccupancy
  }))
  const naechteGesamt = zimmernaechte(zeilen)

  /*
   * Was der Gruppenpreis je Zimmer bedeutet. `null`, solange nichts
   * Brauchbares dasteht -- eine Spalte voller Nullen waere eine Aussage,
   * die niemand gemacht hat.
   */
  const vorschau = gruppenpreisJeZimmer(gruppenPreis, zeilen)

  /*
   * Der Weg zurueck: was bei "je Zimmer" in den Feldern steht, und was das
   * fuer die Gruppe zusammen ergibt.
   *
   * `undefined` in einer Zeile heisst nicht null Euro, sondern "kein Preis
   * vereinbart" -- dort gilt der Ratenplan. Deshalb wird die Summe aus den
   * gefuellten Zeilen gebildet und daneben gesagt, wie viele fehlen; eine
   * Summe, die leere Zeilen als Null mitzaehlt, sieht vollstaendig aus und
   * ist es nicht.
   */
  const zimmerGesamt = zimmer.map((z, i) =>
    alsGesamt(zimmerPreis[z.resourceId] ?? LEERER_PREIS, zeilen[i]!.naechte))
  const summeJeZimmer = zimmerGesamt.reduce<number>((sum, g) => sum + (g ?? 0), 0)

  /**
   * Was in einer Zimmerzeile steht.
   *
   * Kommt der Preis von der Gruppe, ist es deren Anteil -- und trotzdem
   * ein richtiges Eingabefeld: wer hineintippt, hat damit die Zeile
   * uebernommen, und das ist genau die Geste, um die es geht ("eigentlich
   * passt es, nur die Suite nicht").
   */
  const zimmerFeld = (i: number): Preiseingabe => {
    if (quelle === 'zimmer') return zimmerPreis[zimmer[i]!.resourceId] ?? LEERER_PREIS
    const anteil = vorschau?.[i]
    return anteil === undefined
      ? LEERER_PREIS
      : { modus: 'gesamt', text: eingabeAusCent(anteil.gesamtCent) }
  }

  /**
   * Was im Gruppenfeld steht: der getippte Betrag oder die Summe der
   * Zimmer. Auch das bleibt tippbar -- wer die Gesamtsumme wieder
   * verhandelt, faengt nicht damit an, erst alle Zimmer zu leeren.
   */
  const gruppenFeld: Preiseingabe = quelle === 'gruppe'
    ? gruppenPreis
    : { modus: 'gesamt',
        text: zimmerGesamt.every(g => g === undefined)
          ? '' : eingabeAusCent(summeJeZimmer) }

  /**
   * Zeilen ohne Preis, obwohl andere einen haben.
   *
   * Nur wenn die Zimmer die Quelle sind: nach einem Gruppenpreis zeigt
   * jede Zeile ihren Anteil, da gibt es keine Luecke. Und gar kein Preis
   * ist keine Luecke, sondern der Ratenplan.
   */
  const luecken = quelle !== 'zimmer' || zimmerGesamt.every(g => g === undefined)
    ? []
    : zimmer.filter((_, i) => zimmerGesamt[i] === undefined)
  const ohnePreis = zimmerGesamt.filter(g => g === undefined).length

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
    /*
     * Halb gefuellte Zimmerpreise sind der teure Fall.
     *
     * Gar kein Preis heisst "es gilt der Ratenplan" und ist in Ordnung.
     * Drei von vier Zimmern mit Betrag heisst dagegen: fuer das vierte
     * greift stillschweigend der Ratenplan, und die Summe unter der
     * Tabelle stimmt trotzdem -- sie zaehlt ja nur, was dasteht. Das
     * faellt erst auf der Rechnung auf.
     */
    : luecken.length > 0 ? 'group.needAllRoomPrices'
    : personenJeZimmer.some(p => p === null) ? 'verlegen.personsInvalid'
    : null
  const gueltig = grund === null


  /**
   * In eine Zimmerzeile tippen.
   *
   * **Die uebrigen Zeilen werden dabei festgeschrieben.** Stand gerade
   * eine Aufteilung aus dem Gruppenpreis da, wandert sie in die Felder --
   * sonst haette die Rezeption nach dem Aendern der Suite sieben leere
   * Zeilen vor sich und muesste Zahlen abschreiben, die eben noch
   * dastanden. Genau danach ist auch die Luecke keine: alle Zeilen haben
   * einen Betrag, einer davon ist von Hand.
   */
  const zimmerpreisSetzen = (resourceId: number, wert: Preiseingabe): void => {
    setZimmerPreis(v => {
      const uebernommen = quelle === 'gruppe' && vorschau !== null
        ? Object.fromEntries(zimmer.map((z, i) => [
          z.resourceId,
          { modus: 'gesamt' as const, text: eingabeAusCent(vorschau[i]!.gesamtCent) }]))
        : v
      return { ...uebernommen, [resourceId]: wert }
    })
    setQuelle('zimmer')
  }

  /** In das Gruppenfeld tippen: der Betrag gilt, die Zimmer rechnen mit. */
  const gruppenpreisSetzen = (wert: Preiseingabe): void => {
    setGruppenPreis(wert)
    setQuelle('gruppe')
  }

  /*
   * Gespeichert ist alles getan: die Maske geht zu, und die Balken stehen im
   * Plan (Sven, 05.10.2026). Ist eine der Zimmergruppen voll, wird gefragt
   * statt abgewiesen, wie in der Einzelbuchung (Migration 0093).
   */
  const gruppeBuchen = (body: CreateBookingBody): void => buchen.mutate(body, {
    onSuccess: onClose,
    onError: fehler => {
      if (istAusgebucht(fehler) && confirm(t('plan.overbookConfirm'))) {
        buchen.mutate({ ...body, allowOverbooking: true }, { onSuccess: onClose })
      }
    }
  })

  return (
    <Dialog breite="weit" onClose={onClose}
            titel={t('group.title')}
            unterzeile={`${zimmer.length} ${t('group.rooms')}`}
            fuss={
              <>
                <button type="button"
                        disabled={buchen.isPending || gast.anlegen.isPending || !gueltig}
                        onClick={() => { void gast.guestRef().then(guestRef => gruppeBuchen({
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
                          rooms: zimmer.map((z, i) => {
                            const eigen = eigeneTage[z.resourceId]
                            return {
                              categoryId: z.categoryId, resourceId: z.resourceId,
                              // Was nicht abweicht, geht als `undefined` hinaus:
                              // die Schnittstelle erbt dann den Zeitraum der
                              // Buchung, und die Absicht steht nicht doppelt da.
                              arrival: eigen?.arrival,
                              departure: eigen?.departure,
                              ...personenJeZimmer[i],
                              totalCent: quelle === 'zimmer'
                                ? alsGesamt(zimmerPreis[z.resourceId] ?? LEERER_PREIS,
                                            daysBetween(eigen?.arrival ?? arrival,
                                                        eigen?.departure ?? departure))
                                : undefined
                            }
                          }),
                          ...(quelle === 'zimmer' ? {} : preisFelder(gruppenPreis)),
                          blockRef: abruf?.blockRef,
                          guestRef,
                          notes: notes.trim() === '' ? undefined : notes.trim()
                        }),
                        // Schlaegt das Anlegen fehl, steht der Fehler unter der
                        // Maske, und die Buchung geht nicht ohne Besteller hinaus.
                        () => undefined) }}
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
            }>
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
            * Der Preis -- **beide Seiten zugleich**.
            *
            * Verhandelt wird meist ein Betrag fuer alles; wer ihn hier
            * eintraegt, sieht in der Tabelle sofort, was daraus je Zimmer
            * wird. Stimmt dann eine Zeile nicht, wird sie dort geaendert,
            * und dieser Betrag hier rechnet mit. Vorher stand an dieser
            * Stelle ein Umschalter, und das jeweils andere Feld gab es
            * gar nicht -- die Schnittstelle abgebildet, nicht das
            * Gespraech am Tresen.
            */}
          <Abschnitt titel={t('group.sectionPrice')}>
            {/*
              * `naechteGesamt` und nicht die Naechte der Buchung: die
              * Schnittstelle legt einen Preis je Nacht auf **jede** Nacht
              * **jedes** Zimmers. Vorher stand neben "100,00 je Nacht" bei
              * drei Zimmern ueber zwei Naechte ein Gesamtpreis von 200,00,
              * und gebucht wurden 600,00.
              */}
            <PreisFelder wert={gruppenFeld} naechte={naechteGesamt}
                         onChange={gruppenpreisSetzen} />
            <p className="text-xs text-neutral-500">
              {t('group.priceRoomNightHint', { n: naechteGesamt })}
            </p>
            {/* Welche Seite gerade gilt, steht als Satz da und nicht als
                Farbe: "grau heisst abgeleitet" muss man wissen, einen Satz
                liest man. */}
            <p className="text-xs text-neutral-500">
              {quelle === 'zimmer'
                ? t('group.priceFromRooms')
                : t('group.priceSplitHint')}
            </p>
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
              <GuestPicker value={guest} onChange={setGuest} onEingabe={gast.setEingabe} />
              {gast.neu !== null && (
                <span className="block text-xs text-neutral-500 mt-1">
                  {t('booking.guestWillBeCreated', { name: gastNameAnzeige(gast.neu) })}
                </span>
              )}
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
        <Abschnitt titel={t('group.selection')}
                   hinweis={quelle === 'gruppe' ? t('group.pricePreviewHint')
                            : undefined}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-neutral-500 text-left">
                <th className="font-medium py-1">{t('common.room')}</th>
                <th className="font-medium">{t('common.category')}</th>
                <th className="font-medium">{t('booking.arrival')}</th>
                <th className="font-medium">{t('booking.departure')}</th>
                <th className="font-medium text-right pr-2">{t('group.nightsHead')}</th>
                <th className="font-medium pr-2">{t('booking.adults')}</th>
                <th className="font-medium pr-2">{t('booking.children')}</th>
                {/*
                  * Beide Preisspalten stehen immer da, auch wenn der Preis
                  * fuer die ganze Gruppe gilt -- dann zeigen sie, was daraus
                  * je Zimmer wird. Vorher war die Aufteilung erst **nach**
                  * dem Buchen zu sehen, und der Reiseleiter fragt vorher.
                  */}
                <th className="font-medium text-right pr-2">{t('group.priceNight')}</th>
                <th className="font-medium text-right">{t('group.total')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {zimmer.map((z, i) => {
                const eigen = eigeneTage[z.resourceId]
                const { von, bis } = zeitraeume[i]!
                const zeileNaechte = zeilen[i]!.naechte
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
                             className="border border-neutral-300 rounded-sm px-2 py-1 text-sm
                                        disabled:bg-neutral-100 disabled:text-neutral-500" />
                    </td>
                    <td className="pr-2">
                      <input type="date" value={bis} disabled={abruf !== null}
                             onChange={e => tagSetzen(z.resourceId, 'departure', e.target.value)}
                             className="border border-neutral-300 rounded-sm px-2 py-1 text-sm
                                        disabled:bg-neutral-100 disabled:text-neutral-500" />
                    </td>
                    <td className={`tabular-nums text-right pr-2
                                    ${zeileNaechte <= 0 ? 'text-red-700 font-medium' : ''}`}>
                      {zeileNaechte}
                    </td>
                    <td className="pr-2">
                      <input value={personenVon(z.resourceId, z.maxOccupancy).erw}
                             onChange={e => personenSetzen(z.resourceId, z.maxOccupancy,
                                                           'erw', e.target.value)}
                             inputMode="numeric" placeholder="—"
                             aria-label={`${z.roomCode} ${t('booking.adults')}`}
                             className="border border-neutral-300 rounded-sm px-2 py-1 text-sm
                                        w-14 tabular-nums" />
                    </td>
                    <td className="pr-2">
                      <input value={personenVon(z.resourceId, z.maxOccupancy).ki}
                             onChange={e => personenSetzen(z.resourceId, z.maxOccupancy,
                                                           'ki', e.target.value)}
                             inputMode="numeric" placeholder="0"
                             aria-label={`${z.roomCode} ${t('booking.children')}`}
                             className="border border-neutral-300 rounded-sm px-2 py-1 text-sm
                                        w-14 tabular-nums" />
                    </td>
                    {/*
                      * Immer ein Eingabefeld, auch wenn der Betrag gerade
                      * aus dem Gruppenpreis stammt.
                      *
                      * Vorher stand dort in dem Fall nur Text, und der Weg
                      * zu "eigentlich passt alles, nur die Suite nicht"
                      * fuehrte ueber einen Umschalter weiter oben. Wer den
                      * Betrag aendern will, tippt ihn an -- und die
                      * uebrigen Zeilen werden dabei festgeschrieben
                      * (`zimmerpreisSetzen`), damit keine Luecke entsteht.
                      *
                      * Die beiden Felder haengen ueber die Naechte
                      * **dieses** Zimmers zusammen und stehen deshalb unter
                      * beiden Ueberschriften.
                      */}
                    <td colSpan={2} className="text-right">
                      <div className="flex justify-end">
                        <PreisFelder klein naechte={zeileNaechte}
                                     wert={zimmerFeld(i)}
                                     fehlt={luecken.includes(z)}
                                     onChange={w => zimmerpreisSetzen(z.resourceId, w)} />
                      </div>
                    </td>
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
            {/*
              * Die Summe steht unter der Tabelle und nicht nur oben im
              * Preisfeld: bei "je Zimmer" gibt es oben gar keinen
              * Gruppenbetrag, und was die Gruppe zusammen kostet, ist die
              * Zahl, die der Reiseleiter hoeren will.
              */}
            {zimmer.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-neutral-200 text-sm">
                  <td className="py-1.5 text-neutral-500" colSpan={4}>
                    {t('group.priceSum')}
                  </td>
                  <td className="tabular-nums text-right pr-2">{naechteGesamt}</td>
                  <td colSpan={2} />
                  <td />
                  <td className="tabular-nums text-right font-medium">
                    {quelle === 'zimmer'
                      ? formatMoney(summeJeZimmer, locale)
                      : vorschau === null ? '—'
                        : formatMoney(
                          vorschau.reduce((sum, a) => sum + a.gesamtCent, 0), locale)}
                  </td>
                  <td />
                </tr>
                {/* Leere Zeilen sind nicht null Euro. Eine Summe, die sie
                    mitzaehlt, sieht vollstaendig aus und ist es nicht --
                    deshalb steht hier, wie viele fehlen, und der Knopf
                    bleibt gesperrt. */}
                {luecken.length > 0 && (
                  <tr>
                    <td colSpan={10} className="text-xs text-red-700 pt-1">
                      {t('group.priceFromRatePlan', { n: ohnePreis })}
                    </td>
                  </tr>
                )}
              </tfoot>
            )}
          </table>
          {zimmer.length === 0 && (
            <div className="text-sm text-amber-800">{t('group.empty')}</div>
          )}
        </Abschnitt>

        {gast.anlegen.isError && <Fehler error={gast.anlegen.error} />}
        {buchen.isError && <Fehler error={buchen.error} />}
      </div>
    </Dialog>
  )
}
