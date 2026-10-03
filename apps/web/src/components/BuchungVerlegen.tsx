import { useState, type JSX } from 'react'
import { useT, formatDate, useLocale } from '../lib/i18n/index.js'
import { daysBetween } from '../lib/dates.js'
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
}

export interface Ziel {
  resourceId: number | null
  arrival: string
  departure: string
}

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
  onSpeichern: (ziel: Ziel) => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [raum, setRaum] = useState<number | null>(verlegung.neu.resourceId)
  const [anreise, setAnreise] = useState(verlegung.neu.arrival)
  const [abreise, setAbreise] = useState(verlegung.neu.departure)

  const gewaehlt = zimmer.find(z => z.id === raum)
  const vorher = zimmer.find(z => z.id === verlegung.alt.resourceId)
  const gruppe = verlegung.gruppe

  const anders = gruppe !== undefined
    || raum !== verlegung.alt.resourceId
    || anreise !== verlegung.alt.arrival
    || abreise !== verlegung.alt.departure

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
                <button type="button" disabled={grund !== null || laeuft}
                        onClick={() => onSpeichern({ resourceId: raum,
                                                     arrival: anreise,
                                                     departure: abreise })}
                        /* Rot, wenn das Zimmer zu klein ist: der Knopf sagt
                           dann nicht "weiter", sondern "trotzdem". */
                        className={`px-4 py-2 text-sm rounded-sm text-white
                                    disabled:bg-neutral-300
                                    ${zuKlein ? 'bg-red-700' : 'bg-neutral-900'}`}>
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
            {t('group.nights', { n: daysBetween(anreise, abreise) })}
          </p>
        )}

        {raum === null && gruppe === undefined && (
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
