import { useT } from '../lib/i18n/index.js'
import { useTerminalPult, useSendTerminalJob, useCancelTerminalJob, istOffen, wunschAus,
         type Angebot } from '../lib/queries/terminal.js'
import { AuftragZeile } from '../components/AmTerminal.tsx'
import { Fehler, Laedt } from '../components/Shell.tsx'

/**
 * Das Bedienfeld der Gaesteterminals (Dokument 31, §8).
 *
 * Fuer das, was keine Reservierung braucht: eine Seite des Hauses oder eine
 * freigegebene Adresse auf ein Terminal schicken -- die Speisekarte, das
 * WLAN, ein Angebot. Ein Klick je Inhalt und Terminal. Was einen Gast
 * betrifft (Meldeschein, Hausbedingung), schickt die Reservierung; hier
 * stuende es ohne Bezug.
 *
 * Ein Aufruf fuer den ganzen Bildschirm (`terminal-desk`), alle zwei
 * Sekunden, solange irgendwo ein Auftrag offen ist.
 */
export function TerminalPult({ propertyId }: { propertyId: number }): JSX.Element {
  const t = useT()
  const q = useTerminalPult(propertyId)
  const schluessel = ['terminal-desk', propertyId] as const
  const senden = useSendTerminalJob(schluessel)
  const abbrechen = useCancelTerminalJob(schluessel)

  if (q.isError) return <Fehler error={q.error} />
  if (q.data === undefined) return <Laedt />
  const { terminals, offers } = q.data

  const schicken = (deviceRef: string, a: Angebot): void => {
    senden.mutate({ deviceRef, kind: a.kind, propertyId, ...wunschAus(a) })
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-lg font-semibold">{t('pult.title')}</h1>
      <p className="text-sm text-neutral-600">{t('pult.hint')}</p>
      {senden.isError && <Fehler error={senden.error} />}
      {abbrechen.isError && <Fehler error={abbrechen.error} />}

      {terminals.length === 0 && <p className="text-sm text-neutral-500">{t('pult.none')}</p>}
      {terminals.map(d => (
        <section key={d.deviceRef}
                 className="rounded-sm border border-neutral-200 bg-white p-3 space-y-2">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium grow">{d.name}</h2>
            <span className={`text-xs ${d.online ? 'text-emerald-700' : 'text-amber-700'}`}>
              {t(d.online ? 'terminal.settings.online' : 'terminal.settings.offline')}
            </span>
          </div>
          {d.job === null
            ? <p className="text-sm text-neutral-500">{t('pult.idle')}</p>
            : <AuftragZeile job={d.job} wirdAbgebrochen={abbrechen.isPending}
                            onAbbrechen={() => abbrechen.mutate(d.job!.jobRef)} />}
          {!istOffen(d.job?.state) && (
            offers.length === 0
              ? <p className="text-xs text-neutral-500">{t('pult.noContent')}</p>
              : <div className="flex flex-wrap gap-2">
                  {offers.map(a => (
                    <button key={`${a.kind}:${a.ref}`} type="button"
                            disabled={senden.isPending}
                            onClick={() => schicken(d.deviceRef, a)}
                            className="px-3 py-1.5 text-sm rounded-sm border border-neutral-300
                                       hover:bg-neutral-50 disabled:opacity-40">
                      {a.kind === 'url' ? '↗ ' : ''}{a.label}
                    </button>
                  ))}
                </div>
          )}
        </section>
      ))}
    </div>
  )
}
