import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../lib/api.js'
import { useEscape } from '../lib/tasten.js'
import { useT } from '../lib/i18n/index.js'
import { useReservationTerminal, useSendTerminalJob, useCancelTerminalJob, istOffen,
         wunschAus, type Angebot, type Auftragsstand } from '../lib/queries/terminal.js'
import { Fehler } from './Shell.tsx'

/**
 * "Am Terminal oeffnen" -- an der Reservierung und am Meldeschein
 * (Dokument 31).
 *
 * **Eine eigene Komponente**, nicht ein Abschnitt im Seitenfenster: dort
 * arbeiten mehrere zugleich, und ein Einschub von einer Zeile vertraegt
 * sich mit jeder anderen Aenderung.
 *
 * **Was erscheint, entscheidet die Schnittstelle.** Sie liefert die
 * Angebote fuer diese Reservierung (`offers`): Meldeformular, solange kein
 * Schein vorliegt; Unterschrift, wo der Schein eine verlangt -- fuer einen
 * inlaendischen Gast also nicht; jede noch offene Hausbedingung; dazu die
 * Seiten und Adressen des Hauses. Die Regeln stehen damit an einer Stelle
 * und nicht noch einmal hier.
 *
 * **Ein Terminal: direkt.** Bei mehreren eine Auswahl, die Escape wieder
 * schliesst. Solange ein Auftrag offen ist, fragt die Abfrage alle zwei
 * Sekunden nach, und die Zeile zeigt "wartet", "geoeffnet", "erledigt".
 */
export function AmTerminal({ reservationRef }: { reservationRef: string }): JSX.Element | null {
  const t = useT()
  const q = useReservationTerminal(reservationRef)
  const schluessel = ['reservation-terminal', reservationRef] as const
  const senden = useSendTerminalJob(schluessel)
  const abbrechen = useCancelTerminalJob(schluessel)
  const [waehlt, setWaehlt] = useState<Angebot | null>(null)

  useEscape(() => setWaehlt(null), waehlt !== null)

  const job = q.data?.job ?? null
  useNachAuftrag(job, reservationRef)

  // Ohne das Recht zum Einchecken gibt es hier nichts zu tun; ein roter
  // Kasten im Seitenfenster waere eine Fehlermeldung ohne Fehler.
  if (q.error instanceof ApiError && q.error.status === 403) return null
  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return null

  const { terminals, offers } = q.data
  // Nichts anzubieten und nichts im Gange: kein leerer Kasten im Fenster.
  if ((terminals.length === 0 || offers.length === 0) && job === null) return null
  const offen = istOffen(job?.state)
  const fuerGast = offers.filter(o => o.kind !== 'content' && o.kind !== 'url')
  const inhalte = offers.filter(o => o.kind === 'content' || o.kind === 'url')

  const schicken = (a: Angebot, deviceRef: string): void => {
    setWaehlt(null)
    senden.mutate({ deviceRef, kind: a.kind, reservationRef, ...wunschAus(a) })
  }
  const waehle = (a: Angebot): void => {
    if (terminals.length === 1) schicken(a, terminals[0]!.deviceRef)
    else setWaehlt(a)
  }

  return (
    <section className="bg-white border border-neutral-200 rounded-sm p-3 space-y-2">
      <h3 className="text-sm font-medium">{t('terminal.title')}</h3>

      {!offen && terminals.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {fuerGast.map(a => (
            <button key={`${a.kind}-${a.ref ?? ''}`} type="button" disabled={senden.isPending}
                    onClick={() => waehle(a)}
                    className="px-3 py-1.5 text-sm rounded-sm border border-neutral-300
                               hover:bg-neutral-50 disabled:opacity-40">
              {a.kind === 'terms_sign'
                ? t('terminal.send.terms_sign', { titel: a.label ?? '' })
                : t(`terminal.send.${a.kind as 'registration_fill' | 'registration_sign'}`)}
            </button>
          ))}
          {inhalte.length > 0 && (
            <label className="text-sm">
              <select value="" disabled={senden.isPending}
                      aria-label={t('terminal.showContent')}
                      onChange={e => {
                        const a = inhalte.find(x => `${x.kind}:${x.ref}` === e.target.value)
                        if (a !== undefined) waehle(a)
                      }}
                      className="border border-neutral-300 rounded-sm px-2 py-1.5 text-sm">
                <option value="">{t('terminal.showContent')} …</option>
                {inhalte.map(a => (
                  <option key={`${a.kind}:${a.ref}`} value={`${a.kind}:${a.ref}`}>
                    {a.kind === 'url' ? '↗ ' : ''}{a.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {waehlt !== null && (
        <GeraetWahl terminals={terminals}
                    onWahl={d => schicken(waehlt, d)} onAbbruch={() => setWaehlt(null)} />
      )}

      {job !== null && (
        <AuftragZeile job={job} wirdAbgebrochen={abbrechen.isPending}
                      onAbbrechen={() => abbrechen.mutate(job.jobRef)} />
      )}

      {senden.isError && <Fehler error={senden.error} />}
      {abbrechen.isError && <Fehler error={abbrechen.error} />}
    </section>
  )
}

/**
 * Ist der Auftrag erledigt, hat sich der Meldeschein oder die Bedingung
 * geaendert: die Check-in-Maske und das Seitenfenster sollen das sehen,
 * ohne dass jemand neu laedt. Einmal je Auftrag, nicht bei jedem Abruf.
 */
function useNachAuftrag(job: Auftragsstand | null, reservationRef: string): void {
  const qc = useQueryClient()
  const gemeldet = useRef<string | null>(null)
  useEffect(() => {
    if (job === null || job.state !== 'done' || gemeldet.current === job.jobRef) return
    gemeldet.current = job.jobRef
    void qc.invalidateQueries({ queryKey: ['registration-form', reservationRef] })
    void qc.invalidateQueries({ queryKey: ['reservation', reservationRef] })
    void qc.invalidateQueries({ queryKey: ['terms', reservationRef] })
  }, [job, qc, reservationRef])
}

/**
 * Ein einziger Auftrag als grosser Knopf -- fuer den Check-in-Dialog (Sven,
 * 05.10.2026): dort soll nichts zur Wahl stehen, nur "Meldeformular auf
 * Gaesteterminal oeffnen" oder, wenn nur die Unterschrift fehlt, deren
 * Anforderung. Ob die Art angeboten wird, entscheidet weiter die
 * Schnittstelle (`offers`); ohne Angebot und ohne laufenden Auftrag zeigt
 * die Komponente nichts, ohne Terminal den Ausweich-Inhalt `ohneTerminal`.
 */
export function TerminalAuftrag({ reservationRef, kind, beschriftung, ohneTerminal }: {
  reservationRef: string
  kind: 'registration_fill' | 'registration_sign'
  beschriftung: string
  ohneTerminal?: ReactNode
}): JSX.Element | null {
  const q = useReservationTerminal(reservationRef)
  const schluessel = ['reservation-terminal', reservationRef] as const
  const senden = useSendTerminalJob(schluessel)
  const abbrechen = useCancelTerminalJob(schluessel)
  const [waehlt, setWaehlt] = useState(false)
  const job = q.data?.job ?? null
  useNachAuftrag(job, reservationRef)
  useEscape(() => setWaehlt(false), waehlt)

  if (q.error instanceof ApiError && q.error.status === 403) return null
  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return null

  const { terminals, offers } = q.data
  const angebot = offers.find(o => o.kind === kind)
  if (terminals.length === 0 && job === null) return <>{ohneTerminal ?? null}</>
  const offen = istOffen(job?.state)

  const schicken = (deviceRef: string): void => {
    setWaehlt(false)
    senden.mutate({ deviceRef, kind, reservationRef })
  }

  return (
    <div className="space-y-3">
      {!offen && angebot !== undefined && (
        <div className="flex justify-center py-6">
          <button type="button" disabled={senden.isPending}
                  onClick={() => terminals.length === 1
                    ? schicken(terminals[0]!.deviceRef) : setWaehlt(true)}
                  className="px-8 py-4 text-lg rounded-sm bg-neutral-900 text-white
                             hover:bg-neutral-800 disabled:opacity-40">
            {beschriftung}
          </button>
        </div>
      )}
      {waehlt && (
        <GeraetWahl terminals={terminals} onWahl={schicken} onAbbruch={() => setWaehlt(false)} />
      )}
      {job !== null && (
        <AuftragZeile job={job} wirdAbgebrochen={abbrechen.isPending}
                      onAbbrechen={() => abbrechen.mutate(job.jobRef)} />
      )}
      {senden.isError && <Fehler error={senden.error} />}
      {abbrechen.isError && <Fehler error={abbrechen.error} />}
    </div>
  )
}

/** Die Auswahl des Terminals, wenn es mehr als eines gibt. */
export function GeraetWahl({ terminals, onWahl, onAbbruch }: {
  terminals: Array<{ deviceRef: string; name: string; online: boolean; busy?: boolean }>
  onWahl: (deviceRef: string) => void
  onAbbruch: () => void
}): JSX.Element {
  const t = useT()
  return (
    <div className="border border-neutral-200 rounded-sm p-2 space-y-1">
      <div className="text-xs text-neutral-600">{t('terminal.chooseDevice')}</div>
      {terminals.map(d => (
        <button key={d.deviceRef} type="button" disabled={d.busy === true}
                onClick={() => onWahl(d.deviceRef)}
                className="w-full text-left px-2 py-1.5 text-sm rounded-sm hover:bg-neutral-50
                           disabled:text-neutral-400">
          {d.name}
          {!d.online && <span className="text-xs text-amber-700">
            {' · '}{t('terminal.deviceOffline')}</span>}
          {d.busy === true && <span className="text-xs">{' · '}{t('terminal.deviceBusy')}</span>}
        </button>
      ))}
      <button type="button" onClick={onAbbruch} className="text-xs text-neutral-500 underline">
        {t('common.cancel')}
      </button>
    </div>
  )
}

/** Der Stand eines Auftrags, live, mit Abbrechen solange er offen ist. */
export function AuftragZeile({ job, onAbbrechen, wirdAbgebrochen }: {
  job: Auftragsstand; onAbbrechen: () => void; wirdAbgebrochen: boolean
}): JSX.Element {
  const t = useT()
  const offen = istOffen(job.state)
  return (
    <div className="flex items-center gap-3 text-sm" role="status" aria-live="polite">
      <span className={`grow ${job.state === 'done' ? 'text-emerald-700'
        : job.state === 'expired' || job.state === 'canceled' ? 'text-amber-800'
        : 'text-neutral-700'}`}>
        {job.state === 'done' && '✓ '}
        {t(`terminal.kind.${job.kind}`)}{job.label !== null ? ` „${job.label}“` : ''}
        {' — '}
        {t(`terminal.state.${job.state}`, { terminal: job.deviceName })}
        {job.state === 'canceled' && job.canceledBy !== null
          && ` (${t(`terminal.canceledBy.${job.canceledBy}`)})`}
      </span>
      {offen && (
        <button type="button" disabled={wirdAbgebrochen} onClick={onAbbrechen}
                className="px-2 py-1 text-xs rounded-sm border border-neutral-300
                           hover:bg-neutral-50 disabled:opacity-40">
          {t('terminal.cancel')}
        </button>
      )}
    </div>
  )
}
