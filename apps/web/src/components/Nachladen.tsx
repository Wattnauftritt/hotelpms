import { Component, Suspense, type ReactNode } from 'react'
import { useT } from '../lib/i18n/index.js'
import { Laedt } from './Shell.tsx'

/**
 * Die Grenze um einen Bildschirm, der erst beim Oeffnen geladen wird
 * (`screens.tsx`, Performance-Audit 11.10.2026, Befund 10).
 *
 * **Warum ein Fehlerfall, den es vorher nicht gab.** Solange alles in einer
 * Datei stand, war geladen, was die Rezeption je brauchen wuerde. Jetzt holt
 * der erste Klick auf einen Bildschirm dessen Datei. Zwei Faelle lassen das
 * scheitern: die Verbindung ist weg, oder seit dem Laden der Seite kam eine
 * Auslieferung, und die Datei mit dem alten Hash gibt es auf dem Server
 * nicht mehr -- der neue Service Worker hat auch den alten Speicher schon
 * verworfen. Ohne Grenze stuende dann eine weisse Flaeche da.
 *
 * Neu geladen wird **nicht von selbst**: in einem anderen Reiter kann ein
 * halb ausgefuelltes Formular stehen, und ohne Netz liefe ein selbsttaetiges
 * Neuladen im Kreis. Die Rezeption entscheidet mit einem Knopf.
 *
 * `schluessel` setzt den Fehler zurueck, sobald man woanders hingeht --
 * sonst bliebe die Meldung auch ueber dem naechsten Bildschirm stehen.
 */
export function Nachladen({ schluessel, children }: {
  schluessel: string; children: ReactNode
}): JSX.Element {
  return (
    <Ladegrenze schluessel={schluessel}>
      <Suspense fallback={<Laedt />}>{children}</Suspense>
    </Ladegrenze>
  )
}

class Ladegrenze extends Component<
  { schluessel: string; children: ReactNode },
  { fehler: boolean; bei: string }
> {
  override state = { fehler: false, bei: this.props.schluessel }

  static getDerivedStateFromError(): Partial<{ fehler: boolean }> {
    return { fehler: true }
  }

  static getDerivedStateFromProps(
    props: { schluessel: string }, state: { fehler: boolean; bei: string }
  ): { fehler: boolean; bei: string } | null {
    return props.schluessel === state.bei ? null : { fehler: false, bei: props.schluessel }
  }

  override render(): ReactNode {
    return this.state.fehler ? <Ladefehler /> : this.props.children
  }
}

function Ladefehler(): JSX.Element {
  const t = useT()
  return (
    <div role="alert" className="p-6 grid gap-3 justify-items-start text-sm max-w-md">
      <div>{t('app.loadFailed')}</div>
      <button type="button" onClick={() => { location.reload() }}
              className="px-3 py-1 border border-neutral-300 rounded-sm bg-white
                         hover:bg-neutral-50">
        {t('app.reload')}
      </button>
    </div>
  )
}
