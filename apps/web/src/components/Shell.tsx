import { useState, type ReactNode } from 'react'
import { I18nContext, useT, useLocale, LOCALES, type Locale }
  from '../lib/i18n/index.js'
import { fehlerMeldung } from '../lib/meldungen.js'
import { useOnline } from '../lib/offline.js'
import type { ScreenDefinition } from '../screens.js'

export interface Haus {
  id: number
  code: string
  name: string
  isTraining: boolean
}

interface Props {
  screen: string
  onScreen: (s: string) => void
  /** Nur die Bildschirme, die dieser Benutzer hier benutzen darf. */
  screens: readonly ScreenDefinition[]
  locale: Locale
  onLocale: (l: Locale) => void
  /** Wer gerade angemeldet ist. Steht neben dem Abmelden-Knopf. */
  benutzer: string
  onAbmelden: () => void
  haeuser: readonly Haus[]
  haus: Haus | undefined
  onHaus: (id: number) => void
  children: ReactNode
}

function Nav({ screen, onScreen, screens }: Pick<Props, 'screen' | 'onScreen' | 'screens'>
): JSX.Element {
  const t = useT()
  return (
    <nav className="flex gap-1">
      {screens.map(s => (
        <button key={s.key} onClick={() => onScreen(s.key)}
                aria-current={screen === s.key ? 'page' : undefined}
                className={`px-3 py-1.5 text-sm rounded
                            ${screen === s.key
                              ? 'bg-neutral-900 text-white'
                              : 'text-neutral-700 hover:bg-neutral-100'}`}>
          {t(s.nav)}
        </button>
      ))}
    </nav>
  )
}

/**
 * Die Kennzeichnung des Uebungshauses.
 *
 * Dokument 13 verlangt sie ausdruecklich (C11): wer nicht sieht, dass er
 * uebt, uebt irgendwann versehentlich am echten Haus. Die API liefert
 * `isTraining` seit jeher mit; angezeigt wurde es nie. Deshalb oben,
 * durchgehend und in einer Farbe, die man nicht uebersieht -- nicht als
 * Zeile in einer Einstellungsmaske.
 */
function Uebungshinweis({ haus }: { haus: Haus }): JSX.Element {
  return (
    <div role="status"
         className="bg-violet-700 text-white text-sm px-4 py-1 font-medium">
      Uebungsbetrieb — {haus.name}. Nichts hiervon geht in Buchhaltung,
      Statistik oder Gastpost.
    </div>
  )
}

/** Haus wechseln. Nur sichtbar, wer mehr als eines hat. */
function Hauswahl({ haeuser, haus, onHaus }: Pick<Props, 'haeuser' | 'haus' | 'onHaus'>
): JSX.Element | null {
  if (haeuser.length < 2) return null
  return (
    <select value={haus?.id ?? ''} onChange={e => onHaus(Number(e.target.value))}
            aria-label="Haus"
            className="text-sm border border-neutral-300 rounded px-2 py-1">
      {haeuser.map(h => <option key={h.id} value={h.id}>{h.code} — {h.name}</option>)}
    </select>
  )
}

/**
 * Abmelden.
 *
 * **Warum das ueberhaupt erwaehnenswert ist.** An einer Rezeption steht ein
 * geteilter Rechner, und die Sitzung laeuft zwoelf Stunden ohne Taetigkeit
 * weiter. Wer Feierabend hat und nur den Bildschirm zuklappt, laesst sie fuer
 * die Nachtschicht offen -- und im Protokoll steht danach sein Name an
 * fremden Buchungen. Ohne diesen Knopf gab es keinen Weg, das zu beenden,
 * ausser das Cookie von Hand zu loeschen.
 *
 * Der Name daneben ist kein Schmuck: an einem geteilten Rechner ist die
 * erste Frage "bin ich das ueberhaupt", und sie wird sonst nicht gestellt.
 */
function Abmelden(
  { benutzer, onAbmelden }: { benutzer: string; onAbmelden: () => void }
): JSX.Element {
  const t = useT()
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-neutral-600 max-w-40 truncate" title={benutzer}>
        {benutzer}
      </span>
      <button type="button" onClick={onAbmelden}
              className="text-sm px-2 py-1 border border-neutral-300 rounded
                         hover:bg-neutral-50">
        {t('auth.logout')}
      </button>
    </div>
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
            <Nav screen={props.screen} onScreen={props.onScreen} screens={props.screens} />
            <div className="grow" />
            <Hauswahl haeuser={props.haeuser} haus={props.haus} onHaus={props.onHaus} />
            <select value={props.locale}
                    onChange={e => props.onLocale(e.target.value as Locale)}
                    aria-label="Sprache"
                    className="text-sm border border-neutral-300 rounded px-2 py-1">
              {LOCALES.map(l => <option key={l} value={l}>{l.toUpperCase()}</option>)}
            </select>
            <Abmelden benutzer={props.benutzer} onAbmelden={props.onAbmelden} />
          </div>
          {props.haus?.isTraining === true && <Uebungshinweis haus={props.haus} />}
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

/**
 * Ein Fehler der Schnittstelle, in der Sprache des Personals.
 *
 * Die Meldungen an einzelnen Feldern stehen mit da. Sie nur zu verschlucken
 * waere bequem und liesse den Benutzer raten, welches der acht Felder die
 * Maske nicht annimmt.
 */
export function Fehler({ error }: { error: unknown }): JSX.Element {
  const t = useT()
  const locale = useLocale()
  const { text, felder } = fehlerMeldung(error, locale)
  return (
    <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm">
      <div className="font-medium text-red-900">{t('error.title')}</div>
      <div className="text-red-800">{text}</div>
      {felder.length > 0 && (
        <ul className="mt-1 text-red-800">
          {felder.map(([feld, meldung], i) => (
            <li key={`${feld}-${i}`}>
              <span className="font-mono text-xs">{feld}</span>: {meldung}
            </li>
          ))}
        </ul>
      )}
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
