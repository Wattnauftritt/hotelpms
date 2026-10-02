import { useState, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { I18nContext, useT, useLocale, LOCALES, type Locale }
  from '../lib/i18n/index.js'
import { fehlerMeldung } from '../lib/meldungen.js'
import { useOnline } from '../lib/offline.js'
import { useEscape } from '../lib/tasten.js'
import { Hauswahl, type Haus } from './Hauswahl.tsx'
import type { ScreenDefinition } from '../screens.js'

export type { Haus }

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
  /** Arbeitsplatz: Person wechseln, eigenen PIN setzen. */
  onArbeitsplatz: () => void
  /** Es handelt gerade jemand anderes als der Angemeldete. */
  gewechselt: boolean
  haeuser: readonly Haus[]
  haus: Haus | undefined
  onHaus: (id: number) => void
  children: ReactNode
}

/** Abstand zwischen zwei Eintraegen der Leiste, `gap-1`. */
const NAV_ABSTAND = 4

/**
 * Wie viele Eintraege vorne in die Leiste passen; der Rest geht ins Menue.
 *
 * Gerechnet wird mit dem **Mehr-Knopf, wie er dann aussieht**: steht der
 * aktive Bildschirm im Menue, traegt der Knopf dessen Namen und ist breiter
 * als "Mehr". Mit der schmalen Breite gerechnet, ragte er genau in dem Fall
 * ueber den Rand, in dem man ihn am meisten braucht.
 */
export function navPasst(
  breiten: readonly number[], mehrBreiten: readonly number[], mehrLeer: number,
  aktiv: number, verfuegbar: number
): number {
  const summe = (bis: number): number =>
    breiten.slice(0, bis).reduce((a, b) => a + b + NAV_ABSTAND, 0)
  if (summe(breiten.length) - NAV_ABSTAND <= verfuegbar) return breiten.length
  for (let k = breiten.length - 1; k > 0; k--) {
    const mehr = aktiv >= k ? (mehrBreiten[aktiv] ?? mehrLeer) : mehrLeer
    if (summe(k) + mehr <= verfuegbar) return k
  }
  return 0
}

function navKnopf(aktiv: boolean): string {
  return `shrink-0 whitespace-nowrap px-3 py-1.5 text-sm rounded
          ${aktiv ? 'bg-neutral-900 text-white' : 'text-neutral-700 hover:bg-neutral-100'}`
}

/**
 * Die Bildschirmleiste: vorne, was passt, dahinter "Mehr".
 *
 * **Warum sie einklappt.** Die Leiste stand als eine Zeile ohne Umbruch,
 * und mit dreizehn Bildschirmen war sie rund 2 100 Pixel breit -- bei 1 920
 * lagen Sprachwahl und Abmelden rechts ausserhalb des Bildschirms. An einem
 * geteilten Rechner ist Abmelden kein Komfort (CLAUDE.md, "Das eigene
 * Konto"), und dass es nur verschwand, weil ein Bildschirm dazukam, merkt
 * niemand, der ihn hinzufuegt.
 *
 * **Weggelassen wird nichts**, nur verschoben, und die Reihenfolge bleibt:
 * was vorne steht, steht in `SCREENS` vorne. Den aktiven Bildschirm nach
 * vorn zu holen waere bequemer zu rechnen und liesse die Leiste bei jedem
 * Wechsel umspringen.
 *
 * **Umbrechen statt Einklappen** waere ohne Messung gegangen, hob aber die
 * Kopfleiste auf zwei Zeilen, und sie steht klebend ueber jedem Bildschirm
 * -- im Zimmerplan ist das eine Zimmerzeile weniger.
 *
 * Gemessen wird an einer unsichtbaren Abschrift der Leiste, weil die Breite
 * von Sprache und Schrift abhaengt und ein fester Schaetzwert in Tuerkisch
 * nicht stimmt. Dass die rechte Seite bleibt, haengt aber nicht an der
 * Messung: der Rahmen darf schrumpfen (`min-w-0`), die rechte Seite nicht
 * (`shrink-0`). Stimmte die Rechnung einmal nicht, laege die Leiste unter
 * dem Abmelden-Knopf, statt ihn hinauszuschieben.
 */
function Nav({ screen, onScreen, screens }: Pick<Props, 'screen' | 'onScreen' | 'screens'>
): JSX.Element {
  const t = useT()
  const rahmen = useRef<HTMLDivElement>(null)
  const muster = useRef<HTMLDivElement>(null)
  const menue = useRef<HTMLDivElement>(null)
  const [sichtbar, setSichtbar] = useState(screens.length)
  const [offen, setOffen] = useState(false)

  const aktiv = screens.findIndex(s => s.key === screen)

  useLayoutEffect(() => {
    const r = rahmen.current
    const m = muster.current
    if (r === null || m === null) return
    const rechne = (): void => {
      const breite = (sel: string): number[] =>
        Array.from(m.querySelectorAll<HTMLElement>(sel))
          .map(el => el.getBoundingClientRect().width)
      const mehrLeer = breite('[data-mehr-leer]')[0] ?? 0
      setSichtbar(navPasst(breite('[data-eintrag]'), breite('[data-mehr]'),
                           mehrLeer, aktiv, r.clientWidth))
    }
    rechne()
    // Beide beobachten: den Rahmen fuer die Fensterbreite, das Muster fuer
    // Sprachwechsel und nachgeladene Schrift.
    const beobachter = new ResizeObserver(rechne)
    beobachter.observe(r)
    beobachter.observe(m)
    return () => { beobachter.disconnect() }
  }, [aktiv, screens])

  // Zu wie die Hauswahl: Druck daneben in der Fangphase, Esc ueber die
  // gemeinsame Lage.
  useEffect(() => {
    if (!offen) return
    const zu = (e: Event): void => {
      if (e.target instanceof Node && menue.current?.contains(e.target)) return
      setOffen(false)
    }
    window.addEventListener('pointerdown', zu, true)
    return () => { window.removeEventListener('pointerdown', zu, true) }
  }, [offen])
  useEscape(() => setOffen(false), offen)

  const vorne = screens.slice(0, sichtbar)
  const hinten = screens.slice(sichtbar)
  // Liegt der aktive Bildschirm im Menue, traegt der Knopf seinen Namen:
  // sonst stuende nirgends, wo man gerade ist.
  const aktivHinten = aktiv >= sichtbar ? screens[aktiv] : undefined

  // Ein offenes Menue, das beim Breiterziehen leer wird, schliesst sich.
  useEffect(() => { if (hinten.length === 0) setOffen(false) }, [hinten.length])

  const waehlen = (key: string): void => {
    setOffen(false)
    onScreen(key)
  }

  return (
    <div ref={rahmen} className="relative min-w-0 grow">
      {/*
        * Die Abschrift ist breiter als der Bildschirm. Ihr eigener
        * abschneidender Kasten haelt sie aus der Seitenbreite heraus --
        * sonst bekaeme die ganze Seite einen waagrechten Rollbalken.
        */}
      <div aria-hidden className="invisible pointer-events-none absolute inset-0 overflow-hidden">
        <div ref={muster} className="flex w-max gap-1">
          {screens.map(s => (
            <span key={s.key} data-eintrag className={navKnopf(false)}>{t(s.nav)}</span>
          ))}
          {screens.map(s => (
            <span key={s.key} data-mehr className={navKnopf(false)}>
              {t(s.nav)} <span className="text-xs">▾</span>
            </span>
          ))}
          <span data-mehr-leer className={navKnopf(false)}>
            {t('nav.more')} <span className="text-xs">▾</span>
          </span>
        </div>
      </div>

      <nav className="flex gap-1">
        {vorne.map(s => (
          <button key={s.key} type="button" onClick={() => onScreen(s.key)}
                  aria-current={screen === s.key ? 'page' : undefined}
                  className={navKnopf(screen === s.key)}>
            {t(s.nav)}
          </button>
        ))}
        {hinten.length > 0 && (
          <div ref={menue} className="relative shrink-0">
            <button type="button" onClick={() => setOffen(o => !o)}
                    title={t('nav.more')} aria-haspopup="menu" aria-expanded={offen}
                    aria-current={aktivHinten !== undefined ? 'page' : undefined}
                    className={navKnopf(aktivHinten !== undefined)}>
              {aktivHinten !== undefined ? t(aktivHinten.nav) : t('nav.more')}
              {' '}<span aria-hidden className="text-xs">▾</span>
            </button>
            {offen && (
              <div role="menu"
                   className="absolute left-0 z-40 mt-1 w-56 rounded border border-neutral-200
                              bg-white py-1 shadow-xl">
                {hinten.map(s => (
                  <button key={s.key} type="button" role="menuitem"
                          onClick={() => waehlen(s.key)}
                          aria-current={screen === s.key ? 'page' : undefined}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left
                                      text-sm hover:bg-neutral-100
                                      ${screen === s.key ? 'bg-neutral-50 font-medium' : ''}`}>
                    {/* Der Haken in fester Spalte, wie in der Hauswahl. */}
                    <span aria-hidden className="w-3">{screen === s.key ? '✓' : ''}</span>
                    <span className="grow truncate">{t(s.nav)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </nav>
    </div>
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
  const t = useT()
  return (
    <div role="status"
         className="bg-violet-700 text-white text-sm px-4 py-1 font-medium">
      {t('app.training', { haus: haus.name })}
    </div>
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
  { benutzer, onAbmelden, onArbeitsplatz, gewechselt }:
  { benutzer: string; onAbmelden: () => void
    onArbeitsplatz: () => void; gewechselt: boolean }
): JSX.Element {
  const t = useT()
  return (
    <div className="flex items-center gap-2">
      {/*
        * Der Name ist der Knopf. Am geteilten Rechner ist "bin ich das
        * ueberhaupt" die erste Frage, und die Antwort darauf ist auch der
        * Weg, es zu aendern -- ein zweiter Knopf daneben waere eine Zeile
        * mehr in einer Kopfleiste, die ohnehin voll ist.
        */}
      <button type="button" onClick={onArbeitsplatz} title={t('workstation.title')}
              className={`text-sm max-w-40 truncate px-2 py-1 rounded border
                          ${gewechselt
                            ? 'border-amber-300 bg-amber-50 text-amber-900'
                            : 'border-transparent text-neutral-600 hover:bg-neutral-100'}`}>
        {gewechselt && <span aria-hidden className="mr-1">⇄</span>}
        {benutzer}
      </button>
      <button type="button" onClick={onAbmelden}
              className="text-sm px-2 py-1 border border-neutral-300 rounded
                         hover:bg-neutral-50">
        {t('auth.logout')}
      </button>
    </div>
  )
}

/**
 * Das Kontextmenue des Browsers bleibt zu.
 *
 * **Warum.** An der Rezeption steht ein Arbeitsprogramm, kein Dokument.
 * Ein Menue mit "Zurueck", "Seite neu laden", "Bild speichern",
 * "Untersuchen" beantwortet keine Frage, die hier jemand hat -- und zwei
 * seiner Eintraege ("Zurueck", "Neu laden") werfen mitten im Vorgang eine
 * halb ausgefuellte Maske weg. Der rechte Knopf gehoert spaeter uns.
 *
 * **Ausgenommen sind Eingabefelder.** Dort ist Ausschneiden, Einfuegen und
 * die Rechtschreibpruefung genau das, was das Menue kann und was hier
 * gebraucht wird; es dort zu sperren waere Schaden ohne Gegenwert. Wer
 * angezeigten Text kopieren will, markiert ihn und nimmt Strg+C -- das
 * bleibt unberuehrt.
 *
 * Am `document` und nicht am aeusseren `div`: ein Dialog haengt am
 * Dokumentkoerper und nicht unter der Shell, und dort waere das Menue
 * sonst wieder offen.
 */
function useKeinKontextmenue(): void {
  useEffect(() => {
    const auf = (e: MouseEvent): void => {
      const ziel = e.target
      if (ziel instanceof HTMLElement
          && (ziel.closest('input, textarea, [contenteditable="true"]') !== null)) {
        return
      }
      e.preventDefault()
    }
    document.addEventListener('contextmenu', auf)
    return () => { document.removeEventListener('contextmenu', auf) }
  }, [])
}

export function Shell(props: Props): JSX.Element {
  const online = useOnline()
  useKeinKontextmenue()
  return (
    <I18nContext.Provider value={props.locale}>
      <div className="min-h-screen bg-neutral-50 text-neutral-900">
        <header className="bg-white border-b border-neutral-200 sticky top-0 z-30">
          <div className="flex items-center gap-4 px-4 py-2">
            <span className="shrink-0 font-semibold">StayGrid</span>
            <Nav screen={props.screen} onScreen={props.onScreen} screens={props.screens} />
            {/*
              * Die rechte Seite schrumpft nicht und liegt obenauf: was hier
              * steht, muss an einem geteilten Rechner immer erreichbar sein,
              * egal wie viele Bildschirme die Leiste links noch bekommt.
              */}
            <div className="relative z-10 flex shrink-0 items-center gap-4 bg-white">
              <Hauswahl haeuser={props.haeuser} haus={props.haus} onHaus={props.onHaus} />
              <Sprachwahl locale={props.locale} onLocale={props.onLocale} />
              <Abmelden benutzer={props.benutzer} onAbmelden={props.onAbmelden}
                        onArbeitsplatz={props.onArbeitsplatz}
                        gewechselt={props.gewechselt} />
            </div>
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
 * Die Sprachwahl.
 *
 * Eine eigene kleine Komponente, weil `useT` einen Haken braucht und die
 * `Shell` selbst ausserhalb des Anbieters steht, den sie aufspannt --
 * `aria-label` stand deshalb als deutsches Wort im Code.
 */
function Sprachwahl({ locale, onLocale }: Pick<Props, 'locale' | 'onLocale'>): JSX.Element {
  const t = useT()
  return (
    <select value={locale} onChange={e => onLocale(e.target.value as Locale)}
            aria-label={t('common.language')}
            className="text-sm border border-neutral-300 rounded px-2 py-1">
      {LOCALES.map(l => <option key={l} value={l}>{l.toUpperCase()}</option>)}
    </select>
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
