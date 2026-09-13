import { useState, type ReactNode } from 'react'
import { I18nContext, useT, LOCALES, type Locale } from '../lib/i18n.js'
import { useOnline } from '../lib/offline.js'

export type Screen = 'tape' | 'today' | 'housekeeping' | 'blocks' | 'setup'

interface Props {
  screen: Screen
  onScreen: (s: Screen) => void
  locale: Locale
  onLocale: (l: Locale) => void
  children: ReactNode
}

function Nav({ screen, onScreen }: Pick<Props, 'screen' | 'onScreen'>): JSX.Element {
  const t = useT()
  const eintraege: Array<[Screen, 'nav.tape' | 'nav.today' | 'nav.housekeeping'
                                | 'nav.blocks' | 'nav.setup']> = [
    ['tape', 'nav.tape'], ['today', 'nav.today'],
    ['housekeeping', 'nav.housekeeping'], ['blocks', 'nav.blocks'],
    ['setup', 'nav.setup']
  ]
  return (
    <nav className="flex gap-1">
      {eintraege.map(([key, label]) => (
        <button key={key} onClick={() => onScreen(key)}
                aria-current={screen === key ? 'page' : undefined}
                className={`px-3 py-1.5 text-sm rounded
                            ${screen === key
                              ? 'bg-neutral-900 text-white'
                              : 'text-neutral-700 hover:bg-neutral-100'}`}>
          {t(label)}
        </button>
      ))}
    </nav>
  )
}

export function Shell(props: Props): JSX.Element {
  const online = useOnline()
  return (
    <I18nContext.Provider value={props.locale}>
      <div className="min-h-screen bg-neutral-50 text-neutral-900">
        <header className="bg-white border-b border-neutral-200 sticky top-0 z-30">
          <div className="flex items-center gap-4 px-4 py-2">
            <span className="font-semibold">hotelpms</span>
            <Nav screen={props.screen} onScreen={props.onScreen} />
            <div className="grow" />
            <select value={props.locale}
                    onChange={e => props.onLocale(e.target.value as Locale)}
                    aria-label="Sprache"
                    className="text-sm border border-neutral-300 rounded px-2 py-1">
              {LOCALES.map(l => <option key={l} value={l}>{l.toUpperCase()}</option>)}
            </select>
          </div>
          {!online && <OfflineHinweis />}
        </header>
        <main className="p-4">{props.children}</main>
      </div>
    </I18nContext.Provider>
  )
}

/**
 * Der Offline-Hinweis steht oben und bleibt stehen. Ein Betrieb, der nicht
 * merkt, dass er einen alten Stand ansieht, bucht doppelt.
 */
function OfflineHinweis(): JSX.Element {
  const t = useT()
  return (
    <div role="status"
         className="bg-amber-100 text-amber-900 text-sm px-4 py-1 border-t border-amber-200">
      {t('common.offline')}
    </div>
  )
}

export function Fehler({ error }: { error: unknown }): JSX.Element {
  const t = useT()
  const text = error instanceof Error ? error.message : String(error)
  return (
    <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm">
      <div className="font-medium text-red-900">{t('error.title')}</div>
      <div className="text-red-800">{text}</div>
    </div>
  )
}

export function Laedt(): JSX.Element {
  const t = useT()
  return <div className="p-6 text-sm text-neutral-500">{t('common.loading')}</div>
}

export function DatumsWahl(
  { value, onChange, step = 1 }: { value: string; onChange: (v: string) => void
                                   step?: number }
): JSX.Element {
  const t = useT()
  const [, setTick] = useState(0)
  const schiebe = (tage: number) => {
    const d = new Date(`${value}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + tage)
    onChange(d.toISOString().slice(0, 10))
    setTick(x => x + 1)
  }
  return (
    <div className="flex items-center gap-1">
      <button onClick={() => schiebe(-step)} aria-label={t('common.back')}
              className="px-2 py-1 border border-neutral-300 rounded text-sm">←</button>
      <input type="date" value={value} onChange={e => onChange(e.target.value)}
             className="border border-neutral-300 rounded px-2 py-1 text-sm" />
      <button onClick={() => schiebe(step)} aria-label={t('common.forward')}
              className="px-2 py-1 border border-neutral-300 rounded text-sm">→</button>
    </div>
  )
}
