import { useState, type JSX } from 'react'
import { useT, useLocale, formatDate } from '../lib/i18n/index.js'
import { addDays, daysBetween, today } from '../lib/dates.js'
import { useSortierVorschau, useSortierenUebernehmen, useSortierenZuruecknehmen,
         type SortierVorschau } from '../lib/queries/zimmerSortieren.js'
import { Dialog, FELD, KNOPF, KNOPF_LEISE } from './Dialog.tsx'
import { Fehler } from './Shell.tsx'

/**
 * Der Knopf "Zimmer sortieren" im Zimmerplan (Migration 0121).
 *
 * **Erst zeigen, dann schreiben.** Sven wollte die Pruefung vor dem
 * Schreiben ausdruecklich: ein Sortierer, der auf Knopfdruck zwanzig Gaeste
 * umsetzt, ohne vorher zu sagen welche, ist an einer Rezeption nicht zu
 * gebrauchen -- dort steht vielleicht gerade jemand, dem man Zimmer 12
 * versprochen hat. Uebernommen werden genau die Zuege, die hier stehen; hat
 * sich der Plan seitdem geaendert, lehnt die API ab, und die Vorschau wird
 * neu berechnet.
 *
 * **Rueckgaengig bleibt im Fenster.** Nur gleich danach, solange noch
 * niemand an den umgesetzten Gaesten etwas getan hat; die API prueft das
 * je Reservierung und nimmt sonst gar nichts zurueck.
 */

/** Wie die API (`MAX_SORT_DAYS`); hier nur, damit der Fehler vor dem Klick steht. */
const MAX_TAGE = 62

export function ZimmerSortieren({ propertyId, onClose }: {
  propertyId: number; onClose: () => void
}): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const [von, setVon] = useState(today())
  const [bis, setBis] = useState(addDays(today(), 14))
  const [vorschau, setVorschau] = useState<SortierVorschau | null>(null)
  const [lauf, setLauf] = useState<{ runRef: string; moved: number } | null>(null)
  const [zurueck, setZurueck] = useState(false)

  const rechnen = useSortierVorschau(propertyId)
  const uebernehmen = useSortierenUebernehmen(propertyId)
  const zuruecknehmen = useSortierenZuruecknehmen(propertyId)

  const tage = daysBetween(von, bis)
  const zeitraumOk = tage > 0 && tage <= MAX_TAGE

  const berechnen = () => {
    setLauf(null); setZurueck(false); uebernehmen.reset(); zuruecknehmen.reset()
    rechnen.mutate({ from: von, to: bis }, { onSuccess: setVorschau })
  }

  // Ein geaenderter Zeitraum macht die Vorschau ungueltig; sie gehoerte zu
  // einem anderen, und "Uebernehmen" darunter waere eine Verwechslung.
  const zeitraum = (setzen: (v: string) => void) => (v: string) => {
    setzen(v); setVorschau(null)
  }

  const fuss = (
    <>
      {lauf === null && (
        <button type="button" className={KNOPF_LEISE} disabled={!zeitraumOk || rechnen.isPending}
                onClick={berechnen}>
          {t('roomSort.preview')}
        </button>
      )}
      {vorschau !== null && lauf === null && vorschau.moves.length > 0 && (
        <button type="button" className={KNOPF} disabled={uebernehmen.isPending}
                onClick={() => uebernehmen.mutate(vorschau, { onSuccess: setLauf })}>
          {t('roomSort.apply')}
        </button>
      )}
      {lauf !== null && !zurueck && (
        <button type="button" className={KNOPF_LEISE} disabled={zuruecknehmen.isPending}
                onClick={() => zuruecknehmen.mutate(lauf.runRef,
                  { onSuccess: () => setZurueck(true) })}>
          {t('roomSort.undo')}
        </button>
      )}
      <button type="button" className={`${KNOPF_LEISE} ml-auto`} onClick={onClose}>
        {t('common.close')}
      </button>
    </>
  )

  return (
    <Dialog titel={t('roomSort.button')} breite="mittel" fuss={fuss} onClose={onClose}>
      <p className="text-sm text-neutral-600 mb-4">{t('roomSort.dialogHint')}</p>

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <label className="text-sm">
          <span className="block text-neutral-600 mb-1">{t('roomSort.from')}</span>
          <input type="date" value={von} className={FELD}
                 onChange={e => zeitraum(setVon)(e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="block text-neutral-600 mb-1">{t('roomSort.to')}</span>
          <input type="date" value={bis} min={von} className={FELD}
                 onChange={e => zeitraum(setBis)(e.target.value)} />
        </label>
      </div>
      {tage > MAX_TAGE && (
        <p className="text-sm text-red-800 mb-3">{t('roomSort.rangeTooLong', { max: MAX_TAGE })}</p>
      )}

      {rechnen.isError && <Fehler error={rechnen.error} />}
      {uebernehmen.isError && <Fehler error={uebernehmen.error} />}
      {zuruecknehmen.isError && <Fehler error={zuruecknehmen.error} />}

      {lauf !== null && (
        <p role="status" className="text-sm rounded-sm bg-green-50 border border-green-200
                                     text-green-900 p-3 mb-3">
          {zurueck ? t('roomSort.undoneDone') : t('roomSort.applied', { n: lauf.moved })}
        </p>
      )}

      {vorschau !== null && (
        <div className="space-y-3">
          {vorschau.moves.length === 0
            ? <p className="text-sm">{t('roomSort.nothingToDo')}</p>
            : (
              <>
                <div className="text-sm font-medium">
                  {t('roomSort.movesCount', { n: vorschau.moves.length })}
                </div>
                <ul className="text-sm divide-y divide-neutral-100 border border-neutral-200
                               rounded-sm">
                  {vorschau.moves.map(m => (
                    <li key={m.reservationRef} className="flex gap-3 px-3 py-1.5">
                      <span className="grow truncate">{m.guestName ?? m.reservationRef}</span>
                      <span className="text-neutral-500 tabular-nums">
                        {formatDate(m.arrival, locale)} – {formatDate(m.departure, locale)}
                      </span>
                      <span className="tabular-nums w-28 text-right">
                        {m.fromRoomCode ?? t('roomSort.unassigned')} → <b>{m.toRoomCode}</b>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          {vorschau.unplaced.length > 0 && (
            <div className="text-sm">
              <div className="text-amber-900">{t('roomSort.unplaced')}</div>
              <ul className="mt-1">
                {vorschau.unplaced.map(u => (
                  <li key={u.reservationRef}>
                    {u.guestName ?? u.reservationRef}, {formatDate(u.arrival, locale)} –{' '}
                    {formatDate(u.departure, locale)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {vorschau.fixed > 0 && (
            <p className="text-xs text-neutral-500">
              {t('roomSort.fixedCount', { n: vorschau.fixed })}
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}
