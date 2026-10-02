import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../lib/api.js'
import { useEscape } from '../lib/tasten.js'
import { useT } from '../lib/i18n/index.js'
import { useReservationTerminal, useSendTerminalJob, useCancelTerminalJob, istOffen,
         type TerminalKind } from '../lib/queries/terminal.js'
import { Fehler } from './Shell.tsx'

/**
 * "Am Terminal oeffnen" -- an der Reservierung und am Meldeschein
 * (Dokument 31).
 *
 * **Eine eigene Komponente**, nicht ein Abschnitt im Seitenfenster: dort
 * arbeiten mehrere zugleich, und ein Einschub von einer Zeile vertraegt
 * sich mit jeder anderen Aenderung.
 *
 * **Was erscheint, entscheidet die Schnittstelle.** Sie liefert die Arten,
 * die fuer diese Reservierung angeboten werden (`offers`). Fuer einen
 * inlaendischen Gast steht dort keine Unterschrift -- seit dem 1.1.2025
 * gibt es dafuer keinen Rechtsgrund --, und dann erscheint auch kein Knopf.
 * Die Regel steht damit an einer Stelle und nicht noch einmal hier.
 *
 * **Ein Terminal: direkt.** Bei mehreren eine Auswahl, die Escape wieder
 * schliesst. Solange ein Auftrag offen ist, fragt die Abfrage alle zwei
 * Sekunden nach, und die Zeile zeigt "wartet", "geoeffnet", "erledigt".
 */
export function AmTerminal({ reservationRef }: { reservationRef: string }): JSX.Element | null {
  const t = useT()
  const qc = useQueryClient()
  const q = useReservationTerminal(reservationRef)
  const senden = useSendTerminalJob(reservationRef)
  const abbrechen = useCancelTerminalJob(reservationRef)
  const [waehlt, setWaehlt] = useState<TerminalKind | null>(null)

  useEscape(() => setWaehlt(null), waehlt !== null)

  /*
   * Ist der Auftrag erledigt, hat sich der Meldeschein geaendert: die
   * Check-in-Maske und das Seitenfenster sollen das sehen, ohne dass
   * jemand neu laedt. Einmal je Auftrag, nicht bei jedem Abruf.
   */
  const gemeldet = useRef<string | null>(null)
  const job = q.data?.job ?? null
  useEffect(() => {
    if (job === null || job.state !== 'done' || gemeldet.current === job.jobRef) return
    gemeldet.current = job.jobRef
    void qc.invalidateQueries({ queryKey: ['registration-form', reservationRef] })
    void qc.invalidateQueries({ queryKey: ['reservation', reservationRef] })
  }, [job, qc, reservationRef])

  // Ohne das Recht zum Einchecken gibt es hier nichts zu tun; ein roter
  // Kasten im Seitenfenster waere eine Fehlermeldung ohne Fehler.
  if (q.error instanceof ApiError && q.error.status === 403) return null
  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return null

  const { terminals, offers } = q.data
  // Nichts anzubieten und nichts im Gange: kein leerer Kasten im Fenster.
  if ((terminals.length === 0 || offers.length === 0) && job === null) return null
  const offen = istOffen(job?.state)

  const schicken = (kind: TerminalKind, deviceRef: string): void => {
    setWaehlt(null)
    senden.mutate({ kind, deviceRef })
  }

  return (
    <section className="bg-white border border-neutral-200 rounded p-3 space-y-2">
      <h3 className="text-sm font-medium">{t('terminal.title')}</h3>

      {!offen && offers.length > 0 && terminals.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {offers.map(kind => (
            <button key={kind} type="button" disabled={senden.isPending}
                    onClick={() => {
                      if (terminals.length === 1) schicken(kind, terminals[0]!.deviceRef)
                      else setWaehlt(kind)
                    }}
                    className="px-3 py-1.5 text-sm rounded border border-neutral-300
                               hover:bg-neutral-50 disabled:opacity-40">
              {t(`terminal.send.${kind}`)}
            </button>
          ))}
        </div>
      )}

      {waehlt !== null && (
        <div className="border border-neutral-200 rounded p-2 space-y-1">
          <div className="text-xs text-neutral-600">{t('terminal.chooseDevice')}</div>
          {terminals.map(d => (
            <button key={d.deviceRef} type="button" disabled={d.busy}
                    onClick={() => schicken(waehlt, d.deviceRef)}
                    className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-neutral-50
                               disabled:text-neutral-400">
              {d.name}
              {!d.online && <span className="text-xs text-amber-700">
                {' · '}{t('terminal.deviceOffline')}</span>}
              {d.busy && <span className="text-xs">{' · '}{t('terminal.deviceBusy')}</span>}
            </button>
          ))}
          <button type="button" onClick={() => setWaehlt(null)}
                  className="text-xs text-neutral-500 underline">
            {t('common.cancel')}
          </button>
        </div>
      )}

      {job !== null && (
        <div className="flex items-center gap-3 text-sm" role="status" aria-live="polite">
          <span className={`grow ${job.state === 'done' ? 'text-emerald-700'
            : job.state === 'expired' || job.state === 'canceled' ? 'text-amber-800'
            : 'text-neutral-700'}`}>
            {job.state === 'done' && '✓ '}
            {t(`terminal.state.${job.state}`, { terminal: job.deviceName })}
            {job.state === 'canceled' && job.canceledBy !== null
              && ` (${t(`terminal.canceledBy.${job.canceledBy}`)})`}
          </span>
          {offen && (
            <button type="button" disabled={abbrechen.isPending}
                    onClick={() => abbrechen.mutate(job.jobRef)}
                    className="px-2 py-1 text-xs rounded border border-neutral-300
                               hover:bg-neutral-50 disabled:opacity-40">
              {t('terminal.cancel')}
            </button>
          )}
        </div>
      )}

      {senden.isError && <Fehler error={senden.error} />}
      {abbrechen.isError && <Fehler error={abbrechen.error} />}
    </section>
  )
}
