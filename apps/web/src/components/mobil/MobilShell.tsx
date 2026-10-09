import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { I18nContext, useT, type TextKey } from '../../lib/i18n/index.js'
import { useOnline } from '../../lib/offline.js'
import { useEscape } from '../../lib/tasten.js'
import { inLeistenReihenfolge } from '../../lib/leiste.js'
import { Hauswahl } from '../Hauswahl.tsx'
import { Detailsuche } from '../Detailsuche.tsx'
import { Abmelden, Installieren, OfflineHinweis, Sprachwahl, Uebungshinweis, ZurPersonalApp,
         type ShellProps } from '../Shell.tsx'

/**
 * Der Rahmen am Telefon: schmaler Kopf, Leiste unten.
 *
 * **Warum die Leiste unten steht.** Am Telefon erreicht der Daumen den
 * unteren Rand, nicht den oberen; Cloudbeds, Mews und Little Hotelier
 * stellen ihre Bereiche alle dort hin. Oben bleibt nur, was man liest: das
 * Haus und die Hinweise auf Uebungshaus und fehlendes Netz.
 *
 * **Warum nur drei Bildschirme vorn.** Heute, Plan und Zimmer sind das, was
 * man unterwegs im Haus braucht. Preise, Berichte und Einstellungen sind
 * Arbeit am Schreibtisch; sie stehen unter "Mehr" und oeffnen sich dort in
 * ihrer normalen Gestalt. Weggelassen wird nichts -- ein Bildschirm, den
 * man am Telefon nicht erreicht, waere eine Rechtefrage, die keiner
 * gestellt hat.
 *
 * Abmelden steht unter "Mehr" und nicht im Kopf. Es ist dort mit einem
 * Griff erreichbar, und die Regel aus CLAUDE.md ("Jeder Bildschirm sitzt in
 * der Shell") gilt hier genauso: dieser Rahmen ist die Shell, nur schmal.
 */

/** Die Bildschirme mit eigenem Platz in der Leiste, in dieser Reihenfolge. */
const VORN: ReadonlyArray<{ key: string; text: TextKey; icon: ReactNode }> = [
  { key: 'today', text: 'mobil.tab.today', icon: <IconHeute /> },
  { key: 'tape', text: 'mobil.tab.plan', icon: <IconPlan /> },
  { key: 'housekeeping', text: 'mobil.tab.rooms', icon: <IconZimmer /> }
]

export function MobilShell(props: ShellProps): JSX.Element {
  return (
    <I18nContext.Provider value={props.locale}>
      <Rahmen {...props} />
    </I18nContext.Provider>
  )
}

function Rahmen(props: ShellProps): JSX.Element {
  const t = useT()
  const online = useOnline()
  const [mehr, setMehr] = useState(false)
  const erlaubt = new Set(props.screens.map(s => s.key))
  const vorn = VORN.filter(v => erlaubt.has(v.key))
  const vornKeys = new Set(vorn.map(v => v.key))
  const hinten = inLeistenReihenfolge(props.screens.filter(s => !vornKeys.has(s.key)))
  const mehrAktiv = !vornKeys.has(props.screen)
  const kopf = useKopfhoehe()

  const waehlen = (key: string): void => {
    setMehr(false)
    props.onScreen(key)
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900
                    pb-[calc(4rem+env(safe-area-inset-bottom))]">
      <header ref={kopf} className="sticky top-0 z-30 bg-white border-b border-neutral-200">
        <div className="flex items-center gap-3 px-4 py-2">
          <span className="shrink-0 font-semibold">StayGrid</span>
          <div className="flex min-w-0 grow justify-end">
            <Hauswahl haeuser={props.haeuser} haus={props.haus} onHaus={props.onHaus} />
          </div>
        </div>
        {props.haus?.isTraining === true && <Uebungshinweis haus={props.haus} />}
        {!online && <OfflineHinweis />}
      </header>

      <main className="p-3">{props.children}</main>

      {mehr && (
        <MehrBlatt {...props} hinten={hinten} onWahl={waehlen}
                   onClose={() => setMehr(false)} />
      )}

      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-neutral-200 bg-white
                      pb-[env(safe-area-inset-bottom)]">
        {vorn.map(v => (
          <Platz key={v.key} aktiv={!mehr && props.screen === v.key}
                 text={t(v.text)} icon={v.icon} onClick={() => waehlen(v.key)} />
        ))}
        {/*
          * Die Suche oeffnet dasselbe Fenster wie Strg+K am Desktop. Ohne
          * Haus -- das Adminpanel -- und ohne Recht am Plan gibt es nichts
          * zu finden; dann fehlt der Platz, wie dort der Knopf.
          */}
        {props.haus !== undefined && (
          <Detailsuche propertyId={props.haus.id}
                       ausloeser={oeffnen => (
                         <Platz aktiv={false} text={t('mobil.tab.search')}
                                icon={<IconSuche />} onClick={oeffnen} />
                       )} />
        )}
        <Platz aktiv={mehr || mehrAktiv} text={t('nav.more')} icon={<IconMehr />}
               onClick={() => setMehr(m => !m)} />
      </nav>
    </div>
  )
}

/**
 * Die Hoehe des Kopfes als CSS-Variable `--kopf`.
 *
 * Die Tageszeile der Wochenansicht klebt darunter. Der Kopf ist nicht
 * immer gleich hoch -- Uebungshaus und fehlendes Netz bringen je eine Zeile
 * mit --, und mit einem festen Wert rutschte die Tageszeile genau dann
 * unter den Hinweis, wenn er gezeigt wird.
 */
function useKopfhoehe(): React.RefObject<HTMLElement> {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const setzen = (): void => {
      document.documentElement.style.setProperty('--kopf', `${el.offsetHeight}px`)
    }
    setzen()
    const beobachter = new ResizeObserver(setzen)
    beobachter.observe(el)
    return () => {
      beobachter.disconnect()
      document.documentElement.style.removeProperty('--kopf')
    }
  }, [])
  return ref
}

/**
 * Ein Platz der Leiste. 56 Pixel hoch: Apple und Google empfehlen 44 bis
 * 48 als kleinste Flaeche fuer einen Daumen, und darunter steht noch die
 * Beschriftung.
 */
function Platz({ aktiv, text, icon, onClick }: {
  aktiv: boolean; text: string; icon: ReactNode; onClick: () => void
}): JSX.Element {
  return (
    <button type="button" onClick={onClick} aria-current={aktiv ? 'page' : undefined}
            className={`flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5
                        text-[11px] ${aktiv ? 'font-semibold text-violet-700' : 'text-neutral-500'}`}>
      <span aria-hidden className="h-6 w-6">{icon}</span>
      <span className="max-w-full truncate px-1">{text}</span>
    </button>
  )
}

/**
 * Was nicht in die Leiste passt: die uebrigen Bildschirme, Sprache,
 * Installieren, Konto und Abmelden. Ueber die ganze Flaeche, weil ein
 * aufklappendes Menue am Telefon nach oben aus dem Bild liefe.
 */
function MehrBlatt({ hinten, onWahl, onClose, screen, ...props }: ShellProps & {
  hinten: ShellProps['screens']; onWahl: (key: string) => void; onClose: () => void
}): JSX.Element {
  const t = useT()
  useEscape(onClose)
  return (
    <div className="fixed inset-x-0 top-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))]
                    z-40 overflow-y-auto bg-white">
      <div className="space-y-5 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('nav.more')}</h2>
          <button type="button" onClick={onClose}
                  className="h-10 rounded-md border border-neutral-300 px-3 text-sm">
            {t('common.close')}
          </button>
        </div>

        {hinten.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              {t('mobil.more.screens')}
            </h3>
            <div className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
              {hinten.map(s => (
                <button key={s.key} type="button" onClick={() => onWahl(s.key)}
                        aria-current={screen === s.key ? 'page' : undefined}
                        className={`flex h-12 w-full items-center px-3 text-left text-sm
                                    ${screen === s.key ? 'font-semibold text-violet-700' : ''}`}>
                  <span className="grow truncate">{t(s.nav)}</span>
                  <span aria-hidden className="text-neutral-400">›</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-neutral-500">{t('mobil.more.desktopHint')}</p>
          </section>
        )}

        <section className="space-y-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            {t('mobil.more.account')}
          </h3>
          <div className="flex flex-wrap items-center gap-3">
            <Sprachwahl locale={props.locale} onLocale={props.onLocale} />
            <Installieren />
            {props.personalApp === true && <ZurPersonalApp />}
          </div>
          <Abmelden benutzer={props.benutzer} onAbmelden={props.onAbmelden}
                    onArbeitsplatz={() => { onClose(); props.onArbeitsplatz() }}
                    gewechselt={props.gewechselt} />
        </section>
      </div>
    </div>
  )
}

/*
 * Die Zeichen der Leiste. Als SVG und nicht als Emoji: ein Emoji sieht auf
 * jedem Telefon anders aus, und ein buntes Zeichen kann nicht anzeigen,
 * welcher Platz gerade aktiv ist -- `currentColor` kann es.
 */
function Svg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
         strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
      {children}
    </svg>
  )
}

function IconHeute(): JSX.Element {
  return <Svg><circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2
             M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>
}

function IconPlan(): JSX.Element {
  return <Svg><rect x="3" y="4" width="18" height="17" rx="2" />
    <path d="M3 9h18M8 2v4M16 2v4M7 13h6M10 17h7" /></Svg>
}

function IconZimmer(): JSX.Element {
  return <Svg><path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 18h18M3 18v2M21 18v2" />
    <path d="M6 10V7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" /></Svg>
}

function IconSuche(): JSX.Element {
  return <Svg><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></Svg>
}

function IconMehr(): JSX.Element {
  return <Svg><path d="M4 6h16M4 12h16M4 18h16" /></Svg>
}
