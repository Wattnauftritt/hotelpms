import { useState, type JSX } from 'react'
import type { Guest } from '@hotelpms/contracts'
import { useT, formatDate, formatMoney, useLocale } from '../lib/i18n/index.js'
import { daysBetween } from '../lib/dates.js'
import { useStayPreview } from '../lib/queries/booking.js'
import { preisFelder, LEERER_PREIS, type Preiseingabe } from '../lib/preisEingabe.js'
import { eingabeAusCent } from '../lib/preisraster.js'
import { gastNameAnzeige } from '../lib/gastName.js'
import { GuestPicker, useGastAusEingabe } from './GuestPicker.tsx'
import { PreisFelder } from './PreisFelder.tsx'
import { Dialog, Feld, FELD, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler } from './Shell.tsx'

/**
 * Was ein Zug im Plan vorschlaegt -- und was bisher gilt.
 *
 * Absolute Werte und keine Verschiebung: die Maske laesst beides aendern,
 * und "zwei Tage weiter" ist nichts, was man in ein Datumsfeld schreibt.
 * Den Aufruf daraus baut der Bildschirm, indem er `alt` und das
 * Gespeicherte vergleicht.
 */
export interface Verlegung {
  reservationRef: string
  /** Fuer die Kopfzeile. Leer, wenn die Buchung keinen Namen traegt. */
  gast: string
  status: string
  /** Die gebuchte Zimmergruppe. Entscheidet, ob ein Wechsel angezeigt wird. */
  categoryId: number
  /** Plaetze, die die gebuchte Zimmergruppe zusagt (`platzbedarf`). */
  bedarf: number
  alt: Ziel
  /** Was der Zug vorschlaegt. Vorbelegung der Felder, nicht mehr. */
  neu: Ziel
  /**
   * Die ganze Gruppe wandert.
   *
   * Dann gibt es keine Felder: acht Zimmer liegen an acht verschiedenen
   * Tagen, und ein gemeinsames Datumsfeld waere fuer sieben davon falsch.
   * Gefragt wird trotzdem, und aus demselben Grund.
   */
  gruppe?: { bookingRef: string; shiftDays: number; zimmer: number }
  /**
   * Die Personen, wie sie gespeichert sind. Fehlt bei der Gruppe -- acht
   * Zimmer haben acht verschiedene Zahlen.
   */
  personen?: { guestCount: number | null; adults: number | null; children: number | null }
}

export interface Ziel {
  resourceId: number | null
  arrival: string
  departure: string
}

/**
 * Was ausser Zimmer und Tagen mit gespeichert wird.
 *
 * Der Preis ist `null`, wenn niemand einen getippt hat -- dann gilt der
 * gerechnete, den die Maske anzeigt. Der Gast ist `undefined`, wenn er
 * bleibt.
 */
export interface Zusatz {
  preis: { priceCent: number } | { totalCent: number } | null
  guestRef?: string
  /** Andere Personenzahl. `undefined`, wenn sie bleibt. */
  personen?: { adults: number; children?: number }
  /** Die Vorschau hat die volle Zimmergruppe gemeldet, die Maske gewarnt. */
  ueberbuchen?: boolean
}

/**
 * Wann der Hauptgast noch wechseln darf -- dieselbe Regel wie in der
 * Schnittstelle (`setzeHauptgast`): vor dem Check-in.
 */
const GAST_WECHSELBAR = new Set(['Inquired', 'Optional', 'Confirmed'])

export interface PlanZimmer {
  id: number
  code: string
  category_id: number
  category_name: string
  max_occupancy: number
}

/**
 * Die Maske, die vor **jedem** Verlegen steht.
 *
 * **Warum ueberhaupt gefragt wird.** Ein Zug im Plan ist eine Geste von
 * zwei Zehntelsekunden, und ihr Ergebnis ist eine andere Reservierung: ein
 * Gast in einem anderen Zimmer, an anderen Tagen. Danebengegriffen sieht
 * genauso aus wie richtig gezogen -- der Balken liegt dort, wo man ihn
 * losgelassen hat, und es sieht aus wie gewollt. Aufgefallen ist das
 * bisher erst an der Rezeption, wenn der Gast vor dem Tresen steht: ein
 * verkauftes Zimmer doppelt belegt, eine Ankunft einen Tag zu frueh. Beides
 * kostet Geld, entweder als Ausfall oder als Ersatz fuer die Nacht, die
 * das Haus dem Gast anderswo bezahlt.
 *
 * Deshalb schreibt kein Zug mehr direkt. Er schlaegt vor, die Maske zeigt
 * es an, und gespeichert wird auf Knopfdruck.
 *
 * **Warum eine Maske und keine Rueckfrage.** "Wirklich verschieben?" mit
 * Ja und Nein beantwortet die falsche Frage. Wer danebengegriffen hat,
 * will nicht abbrechen und noch einmal ziehen -- er will einen Tag
 * korrigieren. Hier stehen deshalb Zimmer, Anreise und Abreise als Felder:
 * der Zug ist die Vorgabe, nicht das Ergebnis.
 *
 * **Warum die Warnung vor der kleineren Zimmergruppe hier steht.** Sie
 * haengt am gewaehlten Zimmer, nicht am gezogenen: wer im Feld ein anderes
 * waehlt, bekommt sie fuer dieses. Ein Upgrade ist Alltag und bleibt
 * erlaubt; das Gegenteil -- zwei Personen in ein Einzelzimmer -- merkt sonst
 * erst der Gast.
 */
export function BuchungVerlegen({ verlegung, zimmer, laeuft, fehler,
                                  onClose, onSpeichern }: {
  verlegung: Verlegung
  /** Alle Zimmer des Hauses, in der Reihenfolge des Plans. */
  zimmer: PlanZimmer[]
  laeuft: boolean
  fehler: unknown
  onClose: () => void
  onSpeichern: (ziel: Ziel, zusatz: Zusatz) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [raum, setRaum] = useState<number | null>(verlegung.neu.resourceId)
  const [anreise, setAnreise] = useState(verlegung.neu.arrival)
  const [abreise, setAbreise] = useState(verlegung.neu.departure)
  /*
   * Was jemand ins Preisfeld getippt hat -- `null`, solange niemand es
   * angefasst hat. Dann steht dort der berechnete Preis aus der Vorschau
   * und wandert mit, wenn sich die Tage aendern (Sven, 05.10.2026: "nicht
   * einfach leer, sondern mit dem bisher gespeicherten Preis
   * vorausgefuellt"). Ein getippter Betrag ist eine Vereinbarung und geht
   * als genau **ein** Feld hinaus, wie beim Anlegen (`preisFelder`).
   */
  const [preis, setPreis] = useState<Preiseingabe | null>(null)
  /*
   * Ein anderer Gast. Der bisherige steht in der Kopfzeile; erst wer auf
   * "Anderer Gast" klickt, bekommt die Suche -- sonst stuende ein leeres
   * Suchfeld da, und die Maske saehe aus, als habe die Buchung keinen.
   */
  const [gastWechsel, setGastWechsel] = useState(false)
  const [neuerGast, setNeuerGast] = useState<Guest | null>(null)
  const gast = useGastAusEingabe(neuerGast, setNeuerGast)
  /*
   * Die Personen, vorbelegt mit dem Gespeicherten (Sven, 06.10.2026: "man
   * kann bei bestehenden Buchungen die Personenzahl nicht aendern"). Steht
   * nur eine Gesamtzahl da -- eine Buchung vom Telefon, ein Import --, gilt
   * sie als Erwachsene: so wird sie auch beim Anlegen gelesen.
   */
  const p = verlegung.personen
  const erwachseneVorher = p?.adults ?? p?.guestCount ?? null
  const kinderVorher = p?.children ?? 0
  const [erwachsene, setErwachsene] = useState(
    erwachseneVorher === null ? '' : String(erwachseneVorher))
  const [kinder, setKinder] = useState(kinderVorher === 0 ? '' : String(kinderVorher))
  const anzahlErwachsene = erwachsene.trim() === '' ? null : Number(erwachsene)
  const anzahlKinder = kinder.trim() === '' ? 0 : Number(kinder)
  const personenGueltig = anzahlErwachsene !== null
    && Number.isInteger(anzahlErwachsene) && anzahlErwachsene >= 1
    && Number.isInteger(anzahlKinder) && anzahlKinder >= 0
  // Ein geleertes Feld bei einer Buchung ohne Angabe ist keine Aenderung.
  const personenAnders = p !== undefined
    && !(erwachsene.trim() === '' && erwachseneVorher === null && anzahlKinder === 0)
    && (anzahlErwachsene !== erwachseneVorher || anzahlKinder !== kinderVorher)

  const gewaehlt = zimmer.find(z => z.id === raum)
  const vorher = zimmer.find(z => z.id === verlegung.alt.resourceId)
  const gruppe = verlegung.gruppe

  const gastAnders = gastWechsel && (neuerGast !== null || gast.neu !== null)
  /*
   * Der Preis danach, gerechnet von der Schnittstelle -- dieselbe Rechnung
   * wie beim Speichern, nur zurueckgenommen. Ein Zug, der den Aufenthalt
   * verlaengert, aendert den Preis; das soll vor dem Speichern zu sehen
   * sein, nicht erst auf der Rechnung (Sven, 05.10.2026).
   */
  const vorschau = useStayPreview(gruppe === undefined && abreise > anreise
    ? { reservationRef: verlegung.reservationRef, arrival: anreise, departure: abreise,
        resourceId: raum }
    : null)
  const naechte = abreise > anreise ? daysBetween(anreise, abreise) : 0

  const gerechnet: Preiseingabe = vorschau.data === undefined ? LEERER_PREIS
    : { modus: 'gesamt', text: eingabeAusCent(vorschau.data.totalCent) }
  /*
   * Nur ein **anderer** Betrag ist eine Vereinbarung. Wer ins Feld klickt
   * und den berechneten stehen laesst, hat nichts vereinbart -- sonst
   * stuende nach jeder Bearbeitung ein fester Gesamtpreis an der Buchung,
   * und die naechste Verlaengerung rechnete nicht mehr mit.
   */
  const getippt = preis === null ? null : preisFelder(preis)
  const vereinbart = getippt !== null && 'totalCent' in getippt
      && getippt.totalCent === vorschau.data?.totalCent
    ? null : getippt

  const anders = gruppe !== undefined
    || raum !== verlegung.alt.resourceId
    || anreise !== verlegung.alt.arrival
    || abreise !== verlegung.alt.departure
    || vereinbart !== null
    || gastAnders
    || personenAnders

  /*
   * Die Zimmergruppe ist voll: eine Warnung, kein Hindernis. Die Vorschau
   * hat trotzdem gerechnet, und gespeichert wird mit der Bestaetigung --
   * wer umsortiert, legt kurz zwei Buchungen auf einen Platz.
   */
  const ueberbucht = gruppe === undefined && vorschau.data?.overbooking === true
  const wechsel = gewaehlt !== undefined && gewaehlt.category_id !== verlegung.categoryId
  const zuKlein = wechsel && gewaehlt.max_occupancy < verlegung.bedarf

  /**
   * Warum der Knopf gesperrt ist -- `null`, wenn er es nicht ist.
   *
   * Der angereiste Gast liegt im Zimmer; die Route weist das ohnehin ab,
   * und eine Fehlermeldung nach dem Klick waere die schlechtere Antwort
   * als ein Satz davor.
   */
  const grund =
    gruppe !== undefined ? null
    : abreise <= anreise ? 'booking.needNights'
    : raum === null && verlegung.status === 'InHouse' ? 'verlegen.inHouseKeepsRoom'
    : personenAnders && !personenGueltig ? 'verlegen.personsInvalid'
    : !anders ? 'verlegen.nothingChanged'
    : null

  return (
    <Dialog breite="mittel" onClose={onClose}
            titel={t('verlegen.title')}
            unterzeile={verlegung.gast === ''
              ? verlegung.reservationRef
              : `${verlegung.reservationRef} · ${verlegung.gast}`}
            fuss={
              <>
                <button type="button"
                        disabled={grund !== null || laeuft || gast.anlegen.isPending}
                        onClick={() => {
                          void (async () => {
                            let guestRef: string | undefined
                            if (gastAnders) {
                              // Ein getippter Name wird hier angelegt; scheitert
                              // das, steht der Fehler in der Maske, und es geht
                              // nichts hinaus.
                              try { guestRef = await gast.guestRef() } catch { return }
                            }
                            onSpeichern({ resourceId: raum, arrival: anreise,
                                          departure: abreise },
                                        { preis: vereinbart, guestRef,
                                          ueberbuchen: ueberbucht,
                                          personen: personenAnders
                                            ? { adults: anzahlErwachsene!,
                                                children: anzahlKinder > 0 || kinderVorher > 0
                                                  ? anzahlKinder : undefined }
                                            : undefined })
                          })()
                        }}
                        /* Rot, wenn das Zimmer zu klein ist: der Knopf sagt
                           dann nicht "weiter", sondern "trotzdem". */
                        className={`px-4 py-2 text-sm rounded-sm text-white
                                    disabled:bg-neutral-300
                                    ${zuKlein || ueberbucht ? 'bg-red-700' : 'bg-neutral-900'}`}>
                  {t('common.save')}
                </button>
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('common.cancel')}
                </button>
                {grund !== null && (
                  <span className="self-center text-xs text-amber-800">{t(grund)}</span>
                )}
              </>
            }>
      <div className="space-y-4">
        {/* Was bisher gilt, in einer Zeile. Ohne sie ist an den Feldern
            nicht zu sehen, was der Zug ueberhaupt geaendert hat -- und
            genau das ist die Frage, die hier beantwortet werden soll. */}
        {gruppe === undefined && <p className="text-sm text-neutral-600">
          {t('verlegen.before', {
            raum: vorher?.code ?? t('verlegen.noRoom'),
            von: formatDate(verlegung.alt.arrival, locale),
            bis: formatDate(verlegung.alt.departure, locale) })}
        </p>}

        {gruppe !== undefined ? (
          /*
           * Die ganze Gruppe: kein Formular, nur der Satz. Acht Zimmer
           * liegen an acht verschiedenen Tagen -- ein gemeinsames
           * Datumsfeld waere fuer sieben davon falsch, und der Versatz ist
           * genau das, was gemeint war.
           */
          <p className="text-sm text-neutral-800 bg-neutral-50 border
                        border-neutral-200 rounded-sm p-3">
            {t('verlegen.groupShift', { n: gruppe.zimmer,
                                        tage: gruppe.shiftDays,
                                        ref: gruppe.bookingRef })}
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <Feld label={t('verlegen.room')}>
              <select value={raum ?? ''} className={FELD}
                      onChange={e => setRaum(
                        e.target.value === '' ? null : Number(e.target.value))}>
                {/* "Ohne Zimmer" ist kein Versehen, sondern der
                    Zwischenablageplatz beim Umsortieren -- dasselbe wie das
                    Ziehen ins Band oben. */}
                <option value="">{t('verlegen.noRoom')}</option>
                {zimmer.map(z => (
                  <option key={z.id} value={z.id}>
                    {z.code} · {z.category_name}
                  </option>
                ))}
              </select>
            </Feld>
            <Feld label={t('booking.arrival')}>
              <input type="date" value={anreise} className={FELD}
                     onChange={e => setAnreise(e.target.value)} />
            </Feld>
            <Feld label={t('booking.departure')}>
              <input type="date" value={abreise} className={FELD}
                     onChange={e => setAbreise(e.target.value)} />
            </Feld>
          </div>
        )}

        {gruppe === undefined && abreise > anreise && (
          <p className="text-sm text-neutral-600">
            {t('group.nights', { n: naechte })}
          </p>
        )}

        {/* Die Personen. Der Preis rechnet nicht mit: wer fuer die dritte
            Person mehr nimmt, traegt ihn unten ein. */}
        {gruppe === undefined && p !== undefined && (
          <div className="flex flex-wrap items-end gap-4">
            <Feld label={t('booking.adults')}>
              <input value={erwachsene} onChange={e => setErwachsene(e.target.value)}
                     inputMode="numeric" placeholder="—"
                     className="border border-neutral-300 rounded-sm px-3 py-2 text-sm w-24" />
            </Feld>
            <Feld label={t('booking.children')}>
              <input value={kinder} onChange={e => setKinder(e.target.value)}
                     inputMode="numeric" placeholder="0"
                     className="border border-neutral-300 rounded-sm px-3 py-2 text-sm w-24" />
            </Feld>
          </div>
        )}

        {/* Der Gast. Ein Tippfehler im Namen wird im Gastprofil
            korrigiert; hier wird ein **anderer** Gast an die Buchung
            gehaengt -- ein eingetippter Name entsteht dabei als neuer Gast,
            wie in der Buchungsmaske. */}
        {gruppe === undefined && (
          <div className="text-sm space-y-1">
            <span className="block text-xs text-neutral-600">{t('booking.guest')}</span>
            {!gastWechsel ? (
              <div className="flex items-center gap-2 border border-neutral-300
                              rounded-sm px-2 py-1.5">
                <span className="grow">
                  {verlegung.gast === ''
                    ? <span className="text-neutral-400">{t('plan.noGuest')}</span>
                    : verlegung.gast}
                </span>
                {/* Nach dem Check-in liegt der Meldeschein vor, und die
                    Schnittstelle weist den Wechsel ab. Der Satz steht hier
                    statt einer Fehlermeldung nach dem Klick. */}
                {GAST_WECHSELBAR.has(verlegung.status) ? (
                  <button type="button" onClick={() => setGastWechsel(true)}
                          className="text-xs text-neutral-500 underline">
                    {t('verlegen.otherGuest')}
                  </button>
                ) : (
                  <span className="text-xs text-neutral-500">
                    {t('verlegen.guestFixed')}
                  </span>
                )}
              </div>
            ) : (
              <>
                <GuestPicker value={neuerGast} onChange={setNeuerGast}
                             onEingabe={gast.setEingabe} />
                {neuerGast === null && gast.neu !== null && (
                  <div className="text-xs text-neutral-500">
                    {t('booking.guestWillBeCreated', { name: gastNameAnzeige(gast.neu) })}
                  </div>
                )}
                <button type="button" className="text-xs text-neutral-500 underline"
                        onClick={() => { setGastWechsel(false); setNeuerGast(null) }}>
                  {t('verlegen.keepGuest')}
                </button>
              </>
            )}
            {gast.anlegen.isError && <Fehler error={gast.anlegen.error} />}
          </div>
        )}

        {/*
          * Der Preis: bisher, nach der Aenderung, und ein Feld fuer einen
          * vereinbarten. Die Naechte stehen einzeln darunter, weil genau
          * dort zu sehen ist, was eine Verlaengerung kostet -- die neuen
          * Naechte zum Plan- oder bisherigen Preis, die alten wie gebucht.
          */}
        {gruppe === undefined && abreise > anreise && (
          <div className="space-y-2 border-t border-neutral-200 pt-3">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              <span className="text-xs text-neutral-600">{t('verlegen.price')}</span>
              {vorschau.data !== undefined && (
                <>
                  <span className="text-neutral-500 tabular-nums">
                    {t('verlegen.priceBefore')}{' '}
                    {formatMoney(vorschau.data.previousTotalCent, locale)}
                  </span>
                  <span className={`tabular-nums ${
                    vorschau.data.totalCent !== vorschau.data.previousTotalCent
                      ? 'font-medium text-amber-900' : ''}`}>
                    {t('verlegen.priceAfter')}{' '}
                    {formatMoney(vorschau.data.totalCent, locale)}
                  </span>
                </>
              )}
              {vorschau.isFetching && vorschau.data === undefined && (
                <span className="text-xs text-neutral-400">…</span>
              )}
            </div>
            {vorschau.data !== undefined && (
              <div className="max-h-40 overflow-y-auto border border-neutral-200 rounded-sm">
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-neutral-100">
                    {vorschau.data.nights.map(n => (
                      <tr key={n.date}>
                        <td className="px-2 py-1 text-neutral-500 tabular-nums">
                          {formatDate(n.date, locale)}
                          {n.posted && ` · ${t('verlegen.nightPosted')}`}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {formatMoney(n.priceCent, locale)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {vorschau.isError && <Fehler error={vorschau.error} />}
            <div className="flex flex-wrap items-end gap-3">
              <PreisFelder wert={preis ?? gerechnet} naechte={naechte} onChange={setPreis} />
              {/* Der Weg zurueck zur Rechnung, wenn sich nach dem Tippen die
                  Tage noch einmal aendern. */}
              {preis !== null && (
                <button type="button" onClick={() => setPreis(null)}
                        className="pb-2 text-xs text-neutral-500 underline">
                  {t('verlegen.priceCalculated')}
                </button>
              )}
            </div>
            <p className="text-xs text-neutral-500">{t('verlegen.priceHint')}</p>
          </div>
        )}

        {/* Nur, wenn es eines abzunehmen gibt: an einer Buchung, die schon
            im Band liegt, waere der Satz eine Ankuendigung von nichts. */}
        {raum === null && verlegung.alt.resourceId !== null && gruppe === undefined && (
          <p className="text-sm text-neutral-700 bg-neutral-50 border
                        border-neutral-200 rounded-sm p-2">
            {t('verlegen.unassignHint')}
          </p>
        )}

        {wechsel && (
          <p className="text-sm text-neutral-700 bg-amber-50 border
                        border-amber-200 rounded-sm p-2">
            {t('plan.moveUpgrade', {
              ref: verlegung.reservationRef,
              von: zimmer.find(z => z.category_id === verlegung.categoryId)
                     ?.category_name ?? '',
              nach: gewaehlt.category_name, raum: gewaehlt.code })}
          </p>
        )}

        {ueberbucht && (
          <p role="alert" className="text-sm text-amber-900 bg-amber-50 border
                                     border-amber-300 rounded-sm p-2">
            {t('verlegen.overbooking')}
          </p>
        )}

        {zuKlein && (
          <p role="alert" className="text-sm text-red-800 bg-red-50 border
                                     border-red-200 rounded-sm p-2">
            {t('plan.moveTooSmall', { raum: gewaehlt.code,
                                      platz: gewaehlt.max_occupancy,
                                      bedarf: verlegung.bedarf })}
          </p>
        )}

        {/* Der Fehler bleibt in der Maske stehen: sie schliesst erst, wenn
            der Aufruf durch ist. Sonst verschwindet mit ihr die Eingabe,
            und der Grund steht nirgends mehr. */}
        {fehler !== null && fehler !== undefined && <Fehler error={fehler} />}
      </div>
    </Dialog>
  )
}

/**
 * Eine ausgefuehrte Aenderung -- so, dass sie sich zuruecknehmen laesst.
 *
 * Gespeichert wird beides, der Zustand davor und der danach: die Frage vor
 * dem Zuruecknehmen nennt beide ("von … zu …"), und ohne den Zustand
 * danach stuende dort nur die Haelfte.
 */
export interface Aenderung {
  reservationRef: string
  gast: string
  vorher: Ziel & { roomCode: string }
  nachher: Ziel & { roomCode: string }
  /** Eine Gruppenverschiebung. Zurueck heisst dann: um denselben Versatz zurueck. */
  gruppe?: { bookingRef: string; shiftDays: number; zimmer: number }
}

/**
 * Die Frage vor dem Zuruecknehmen (Strg+Z).
 *
 * **Warum ueberhaupt gefragt wird**, obwohl Zuruecknehmen doch das
 * Vorsichtige ist: weil es das nicht ist. Zwischen der Aenderung und dem
 * Tastendruck kann eine zweite Aenderung liegen, ein Kollege kann dasselbe
 * Zimmer inzwischen belegt haben, und ein Strg+Z, das man aus dem
 * Textverarbeitungsprogramm kennt, sitzt schneller in den Fingern als der
 * Gedanke daran, was es hier bedeutet -- naemlich einen Gast noch einmal
 * umzulegen.
 *
 * **Deshalb steht in der Frage, was genau passiert**, mit Zimmer und
 * Datum auf beiden Seiten. "Letzte Aenderung rueckgaengig?" waere dieselbe
 * Frage ohne die einzige Angabe, die sie beantwortbar macht.
 */
export function AenderungZurueck({ aenderung, laeuft, fehler, onClose, onConfirm }: {
  aenderung: Aenderung
  laeuft: boolean
  fehler: unknown
  onClose: () => void
  onConfirm: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const a = aenderung

  const beschreibung = (z: Ziel & { roomCode: string }): string =>
    t('verlegen.state', { raum: z.roomCode === '' ? t('verlegen.noRoom') : z.roomCode,
                          von: formatDate(z.arrival, locale),
                          bis: formatDate(z.departure, locale) })

  return (
    <Dialog breite="mittel" onClose={onClose} titel={t('verlegen.undoTitle')}
            unterzeile={a.gast === '' ? a.reservationRef
              : `${a.reservationRef} · ${a.gast}`}
            fuss={
              <>
                <button type="button" disabled={laeuft} onClick={onConfirm}
                        className="px-4 py-2 text-sm rounded-sm bg-neutral-900 text-white
                                   disabled:bg-neutral-300">
                  {t('verlegen.undoConfirm')}
                </button>
                <button type="button" onClick={onClose} className={KNOPF_LEISE}>
                  {t('common.cancel')}
                </button>
              </>
            }>
      <div className="space-y-3">
        <p className="text-sm text-neutral-800">
          {a.gruppe !== undefined
            ? t('verlegen.undoGroup', { n: a.gruppe.zimmer, tage: a.gruppe.shiftDays,
                                        ref: a.gruppe.bookingRef })
            : t('verlegen.undoQuestion', {
                gast: a.gast === '' ? a.reservationRef : a.gast,
                von: beschreibung(a.nachher), zu: beschreibung(a.vorher) })}
        </p>

        {/* Der Hinweis steht immer da, nicht nur im Zweifel: zwischen der
            Aenderung und dem Tastendruck kann alles Moegliche liegen, und
            die Zeile im Plan ist die einzige Wahrheit. */}
        <p className="text-xs text-neutral-500">{t('verlegen.undoHint')}</p>

        {fehler !== null && fehler !== undefined && <Fehler error={fehler} />}
      </div>
    </Dialog>
  )
}
