import { useState, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { I18nContext, useT, useLocale, LOCALES, type Locale, type TextKey }
  from '../lib/i18n/index.js'
import { fehlerMeldung } from '../lib/meldungen.js'
import { useOnline } from '../lib/offline.js'
import { useInstallation } from '../lib/pwa.js'
import { useEscape } from '../lib/tasten.js'
import { Hauswahl, type Haus } from './Hauswahl.tsx'
import { Detailsuche } from './Detailsuche.tsx'
import type { ScreenDefinition } from '../screens.js'
import { useSchmal } from '../lib/mobil.js'
import { MobilShell } from './mobil/MobilShell.tsx'

export type { Haus }
export type { Props as ShellProps }

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
  /**
   * Darf dieser Benutzer die Personal-App benutzen? Dann steht der Weg
   * dorthin in der Kopfleiste: die Hausdame plant hier am Rechner und
   * kontrolliert mit dem Telefon (Sven, 07.10.2026).
   */
  personalApp?: boolean
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
  return `shrink-0 whitespace-nowrap px-3 py-1.5 text-sm rounded-sm
          ${aktiv ? 'bg-neutral-900 text-white' : 'text-neutral-700 hover:bg-neutral-100'}`
}

/**
 * Ein Platz in der Leiste: ein Bildschirm oder ein Menue aus mehreren.
 *
 * Die Leiste rechnet mit Plaetzen, nicht mit Bildschirmen. Sonst nahmen
 * Einrichtung, Wartung, Einstellungen, Datenuebernahme und Gaesteterminals
 * fuenf Plaetze vorn ein, die man an der Rezeption fast nie braucht.
 */
export interface NavEintrag {
  key: string
  nav: TextKey
  screens: readonly ScreenDefinition[]
  gruppe: boolean
}

const GRUPPEN: Record<NonNullable<ScreenDefinition['group']>, TextKey> = {
  settings: 'nav.settings'
}

/**
 * Fasst die erlaubten Bildschirme zu Plaetzen zusammen.
 *
 * Die Bildschirme behalten ihre Reihenfolge aus `SCREENS`, das Adminpanel
 * bleibt hinten, weil es nicht zum Haus gehoert; die Menues stehen am
 * Schluss. Eine Gruppe ohne erlaubten Bildschirm erscheint nicht -- ein
 * leeres Menue ist ein Knopf ohne Wirkung.
 */
export function navEintraege(screens: readonly ScreenDefinition[]): NavEintrag[] {
  const einzeln = (s: ScreenDefinition): NavEintrag =>
    ({ key: s.key, nav: s.nav, screens: [s], gruppe: false })
  const haus = screens.filter(s => s.group === undefined && s.platformStaff !== true)
  const plattform = screens.filter(s => s.group === undefined && s.platformStaff === true)
  const gruppen = Object.entries(GRUPPEN).flatMap(([key, nav]) => {
    const darin = screens.filter(s => s.group === key)
    return darin.length === 0 ? [] : [{ key: `gruppe:${key}`, nav, screens: darin, gruppe: true }]
  })
  return [...haus.map(einzeln), ...plattform.map(einzeln), ...gruppen]
}

/**
 * Ein aufklappendes Menue der Leiste, fuer "Mehr" und fuer jede Gruppe.
 *
 * Zu wie die Hauswahl: Druck daneben in der Fangphase, Esc ueber die
 * gemeinsame Lage. Jedes Menue fuehrt sein eigenes `offen`; zwei zugleich
 * gibt es nicht, weil der Druck auf das zweite das erste schliesst.
 */
function Aufklapp(
  { beschriftung, titel, aktiv, children }:
  { beschriftung: string; titel: string; aktiv: boolean
    children: (zu: () => void) => ReactNode }
): JSX.Element {
  const menue = useRef<HTMLDivElement>(null)
  const [offen, setOffen] = useState(false)

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

  return (
    <div ref={menue} className="relative shrink-0">
      <button type="button" onClick={() => setOffen(o => !o)}
              title={titel} aria-haspopup="menu" aria-expanded={offen}
              aria-current={aktiv ? 'page' : undefined}
              className={navKnopf(aktiv)}>
        {beschriftung}
        {' '}<span aria-hidden className="text-xs">▾</span>
      </button>
      {offen && (
        <div role="menu"
             className="absolute left-0 z-40 mt-1 w-56 rounded-sm border border-neutral-200
                        bg-white py-1 shadow-xl">
          {children(() => setOffen(false))}
        </div>
      )}
    </div>
  )
}

/** Ein Bildschirm als Zeile in einem Menue. */
function MenueZeile(
  { s, screen, onWahl }:
  { s: ScreenDefinition; screen: string; onWahl: (key: string) => void }
): JSX.Element {
  const t = useT()
  return (
    <button type="button" role="menuitem" onClick={() => onWahl(s.key)}
            aria-current={screen === s.key ? 'page' : undefined}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm
                        hover:bg-neutral-100
                        ${screen === s.key ? 'bg-neutral-50 font-medium' : ''}`}>
      {/* Der Haken in fester Spalte, wie in der Hauswahl. */}
      <span aria-hidden className="w-3">{screen === s.key ? '✓' : ''}</span>
      <span className="grow truncate">{t(s.nav)}</span>
    </button>
  )
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
 * was vorne steht, steht in `navEintraege` vorne. Den aktiven Platz nach
 * vorn zu holen waere bequemer zu rechnen und liesse die Leiste bei jedem
 * Wechsel umspringen.
 *
 * **Die Menues klappen nicht ein.** "Einstellungen" steht immer sichtbar
 * am rechten Ende der Leiste, ausserhalb der Rechnung. Rechnete es mit,
 * laege es schon bei 1 920 Pixeln im "Mehr" -- ein Menue in einem Menue,
 * und gerade das, was man selten braucht und dann suchen muss.
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
  const alle = useMemo(() => navEintraege(screens), [screens])
  const eintraege = useMemo(() => alle.filter(e => !e.gruppe), [alle])
  const gruppen = alle.filter(e => e.gruppe)
  const [sichtbar, setSichtbar] = useState(eintraege.length)

  const aktiv = eintraege.findIndex(e => e.screens.some(s => s.key === screen))

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
  }, [aktiv, eintraege])

  const vorne = eintraege.slice(0, sichtbar)
  const hinten = eintraege.slice(sichtbar)
  // Liegt der aktive Platz im Menue, traegt der Knopf seinen Namen:
  // sonst stuende nirgends, wo man gerade ist.
  const aktivHinten = aktiv >= sichtbar ? eintraege[aktiv] : undefined

  const waehlen = (zu: () => void) => (key: string): void => {
    zu()
    onScreen(key)
  }

  return (
    <div className="flex min-w-0 grow items-center gap-1">
      <div ref={rahmen} className="relative min-w-0 grow">
        {/*
          * Die Abschrift ist breiter als der Bildschirm. Ihr eigener
          * abschneidender Kasten haelt sie aus der Seitenbreite heraus --
          * sonst bekaeme die ganze Seite einen waagrechten Rollbalken.
          */}
        <div aria-hidden className="invisible pointer-events-none absolute inset-0 overflow-hidden">
          <div ref={muster} className="flex w-max gap-1">
            {eintraege.map(e => (
              <span key={e.key} data-eintrag className={navKnopf(false)}>
                {t(e.nav)}
              </span>
            ))}
            {eintraege.map(e => (
              <span key={e.key} data-mehr className={navKnopf(false)}>
                {t(e.nav)} <span className="text-xs">▾</span>
              </span>
            ))}
            <span data-mehr-leer className={navKnopf(false)}>
              {t('nav.more')} <span className="text-xs">▾</span>
            </span>
          </div>
        </div>

        <nav className="flex gap-1">
          {vorne.map(e => (
            <button key={e.key} type="button" onClick={() => onScreen(e.key)}
                    aria-current={screen === e.key ? 'page' : undefined}
                    className={navKnopf(screen === e.key)}>
              {t(e.nav)}
            </button>
          ))}
          {hinten.length > 0 && (
            <Aufklapp beschriftung={aktivHinten !== undefined ? t(aktivHinten.nav) : t('nav.more')}
                      titel={t('nav.more')} aktiv={aktivHinten !== undefined}>
              {zu => hinten.map(e => (
                <MenueZeile key={e.key} s={e.screens[0]!} screen={screen} onWahl={waehlen(zu)} />
              ))}
            </Aufklapp>
          )}
        </nav>
      </div>
      {gruppen.map(g => (
        <Aufklapp key={g.key} beschriftung={t(g.nav)} titel={t(g.nav)}
                  aktiv={g.screens.some(s => s.key === screen)}>
          {zu => g.screens.map(s => (
            <MenueZeile key={s.key} s={s} screen={screen} onWahl={waehlen(zu)} />
          ))}
        </Aufklapp>
      ))}
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
export function Uebungshinweis({ haus }: { haus: Haus }): JSX.Element {
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
export function Abmelden(
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
              className={`text-sm max-w-40 truncate px-2 py-1 rounded-sm border
                          ${gewechselt
                            ? 'border-amber-300 bg-amber-50 text-amber-900'
                            : 'border-transparent text-neutral-600 hover:bg-neutral-100'}`}>
        {gewechselt && <span aria-hidden className="mr-1">⇄</span>}
        {benutzer}
      </button>
      <button type="button" onClick={onAbmelden}
              className="text-sm px-2 py-1 border border-neutral-300 rounded-sm
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

/** Der Weg in die Personal-App. Ein Link, kein Knopf: es ist eine andere Seite. */
export function ZurPersonalApp(): JSX.Element {
  const t = useT()
  return <a href="/personal"
            className="text-sm px-2 py-1 rounded-sm text-neutral-600 hover:bg-neutral-100">
    {t('shell.personalApp')}
  </a>
}

export function Shell(props: Props): JSX.Element {
  const online = useOnline()
  const schmal = useSchmal()
  useKeinKontextmenue()
  /*
   * Am Telefon ein eigener Rahmen: Kopf schmal, die Arbeit in einer Leiste
   * unten, Konto und Sprache unter "Mehr". Die Kopfleiste hier traegt
   * Suche, Leiste, Hauswahl, Sprache und Abmelden nebeneinander und braucht
   * dafuer gut tausend Pixel (`lib/mobil.ts`).
   */
  if (schmal) return <MobilShell {...props} />
  return (
    <I18nContext.Provider value={props.locale}>
      <div className="min-h-screen bg-neutral-50 text-neutral-900">
        <header className="bg-white border-b border-neutral-200 sticky top-0 z-30">
          {/* Nicht auf Papier: gedruckt wird der Bildschirm, nicht die Leiste.
              Der Uebungshinweis darunter bleibt -- ein Ausdruck aus dem
              Uebungshaus soll als solcher zu erkennen sein. */}
          <div className="flex items-center gap-4 px-4 py-2 print:hidden">
            <span className="shrink-0 font-semibold">StayGrid</span>
            {/*
              * Die Detailsuche (Strg+K) vorn neben dem Namen und nicht rechts
              * bei Sprache und Abmelden: sie gehoert zur Arbeit, nicht zum
              * Konto. Sie schrumpft nicht; die Bildschirmleiste dahinter
              * rechnet mit dem Platz, der uebrig bleibt. Ohne Haus -- das
              * Adminpanel ohne Support-Sitzung -- gibt es nichts zu finden.
              */}
            {props.haus !== undefined && (
              <div className="shrink-0">
                <Detailsuche propertyId={props.haus.id} />
              </div>
            )}
            <Nav screen={props.screen} onScreen={props.onScreen} screens={props.screens} />
            {/*
              * Die rechte Seite schrumpft nicht und liegt obenauf: was hier
              * steht, muss an einem geteilten Rechner immer erreichbar sein,
              * egal wie viele Bildschirme die Leiste links noch bekommt.
              */}
            <div className="relative z-10 flex shrink-0 items-center gap-4 bg-white">
              <Installieren />
              {props.personalApp === true && <ZurPersonalApp />}
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
 * Der Knopf zum Installieren als App. Steht nur da, solange der Browser es
 * anbietet (`lib/pwa.ts`); im installierten Fenster und in Safari gar nicht.
 */
export function Installieren(): JSX.Element | null {
  const t = useT()
  const installieren = useInstallation()
  if (installieren === null) return null
  return (
    <button type="button" onClick={installieren} title={t('app.installHint')}
            className="text-sm px-2 py-1 border border-neutral-300 rounded-sm
                       hover:bg-neutral-50">
      {t('app.install')}
    </button>
  )
}

/**
 * Die Sprachwahl.
 *
 * Eine eigene kleine Komponente, weil `useT` einen Haken braucht und die
 * `Shell` selbst ausserhalb des Anbieters steht, den sie aufspannt --
 * `aria-label` stand deshalb als deutsches Wort im Code.
 */
export function Sprachwahl({ locale, onLocale }: Pick<Props, 'locale' | 'onLocale'>): JSX.Element {
  const t = useT()
  return (
    <select value={locale} onChange={e => onLocale(e.target.value as Locale)}
            aria-label={t('common.language')}
            className="text-sm border border-neutral-300 rounded-sm px-2 py-1">
      {LOCALES.map(l => <option key={l} value={l}>{l.toUpperCase()}</option>)}
    </select>
  )
}

/**
 * Der Offline-Hinweis steht oben und bleibt stehen. Ein Betrieb, der nicht
 * merkt, dass er einen alten Stand ansieht, bucht doppelt.
 */
export function OfflineHinweis(): JSX.Element {
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
    <div role="alert" className="rounded-sm border border-red-200 bg-red-50 p-3 text-sm">
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
              className="px-2 py-1 border border-neutral-300 rounded-sm text-sm">←</button>
      <input type="date" value={value} onChange={e => onChange(e.target.value)}
             className="border border-neutral-300 rounded-sm px-2 py-1 text-sm" />
      <button onClick={() => schiebe(step)} aria-label={t('common.forward')}
              className="px-2 py-1 border border-neutral-300 rounded-sm text-sm">→</button>
    </div>
  )
}
