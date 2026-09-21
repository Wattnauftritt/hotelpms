import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient }
  from '@tanstack/react-query'
import { Shell, type Haus } from './components/Shell.tsx'
import { Arbeitsplatz } from './components/Arbeitsplatz.tsx'
import { Login } from './routes/Login.tsx'
import { Zugang, zugangAusAdresse } from './routes/Zugang.tsx'
import { AdminpanelSeite } from './routes/Adminpanel.tsx'
import { Folio } from './routes/Folio.tsx'
import { CheckIn } from './routes/CheckIn.tsx'
import { visibleScreens, resolveScreen } from './screens.js'
import { useAdresse } from './lib/adresse.js'
import { LOCALES, I18nContext, useT, type Locale, type TextKey }
  from './lib/i18n/index.js'
import { api } from './lib/api.js'
import './styles.css'

function spracheDesBrowsers(): Locale {
  const l = navigator.language.slice(0, 2)
  return (LOCALES as readonly string[]).includes(l) ? (l as Locale) : 'de'
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Ein erneuter Blick auf das Fenster lädt nach: an der Rezeption
      // wechseln mehrere Menschen an demselben Bildschirm.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 30_000
    }
  }
})

interface Me {
  userId: number
  displayName: string
  /** Die eigene Anmeldeadresse. Steht in der Kontomaske als Ausgangswert. */
  email: string
  isPlatformStaff: boolean
  /** Der Account ist gesperrt oder archiviert -- nicht: kein Haus. */
  accountSuspended: boolean
  /** Rechte der Plattform. Haengen an keinem Haus. */
  platformPermissions: string[]
  /** Hat diese Person einen Arbeitsplatz-PIN hinterlegt? */
  workstationPinSet: boolean
  /** Es handelt gerade jemand anderes als der Angemeldete. */
  workstationSwitched: boolean
  properties: Array<{ id: number; code: string; name: string; isTraining: boolean
                      permissions: string[] }>
}

/**
 * Ein Text aus dem Katalog. Eine eigene Komponente, weil `useT` den Kontext
 * braucht und der erst innerhalb des Providers steht -- die Hinweise hier
 * werden gezeigt, **bevor** die Oberflaeche selbst aufgebaut ist.
 */
function Text(
  { k, params }: { k: TextKey; params?: Record<string, string | number> }
): JSX.Element {
  return <>{useT()(k, params)}</>
}

function Hinweis({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="min-h-screen grid place-items-center p-8 text-sm text-neutral-600">
    {children}
  </div>
}

function App(): JSX.Element {
  const [locale, setLocale] = useState<Locale>(spracheDesBrowsers)
  /*
   * Das `lang` des Dokuments folgt der Sprachwahl.
   *
   * In `index.html` steht `lang="de"` fest -- richtig, solange nichts
   * anderes angeboten wird. Ein Vorleseprogramm spricht danach aus: es
   * laese tuerkische Saetze nach deutschen Regeln, und dieselbe Angabe
   * entscheidet ueber Silbentrennung und darueber, welche Sprache ein
   * Uebersetzer im Browser zu erkennen glaubt. Der Effekt faellt sehend
   * niemandem auf, und genau deshalb bliebe er stehen.
   */
  useEffect(() => { document.documentElement.lang = locale }, [locale])
  /*
   * Einladung und Kennwortruecksetzung stehen **vor** allem anderen, auch vor
   * der Frage, wer angemeldet ist. Wer diesen Link aus einer E-Mail anklickt,
   * ist es naemlich gerade nicht -- und die Anmeldemaske waere hier die
   * falsche Antwort: sie verlangt genau das Kennwort, das er nicht hat.
   *
   * Einmal gelesen und dann festgehalten: der Zustand haengt an der Adresse
   * beim Aufruf, und die aendert sich waehrend dieser beiden Seiten nicht.
   */
  const [zugang] = useState(zugangAusAdresse)
  const [adresse, setAdresse] = useAdresse()
  // Das Folio liegt ueber dem Tagesgeschaeft, nicht daneben: es wird von dort
  // geoeffnet und danach wieder geschlossen.
  const [folioRef, setFolioRef] = useState<string | null>(null)
  // Der Check-in liegt ebenso ueber dem jeweiligen Bildschirm -- meist dem
  // Plan (A9) -- und schliesst sich danach wieder von selbst.
  const [checkInRef, setCheckInRef] = useState<string | null>(null)
  // Der Arbeitsplatz liegt ueber allem: der Personenwechsel betrifft nicht
  // einen Bildschirm, sondern wer gerade handelt.
  const [arbeitsplatz, setArbeitsplatz] = useState(false)
  const qc = useQueryClient()

  /*
   * Abmelden: Sitzung zurueckziehen und die Seite neu aufbauen.
   *
   * **Warum ein Neuaufbau und nicht das Leeren des Zwischenspeichers.**
   * Hier stand `qc.clear()` und danach ein `invalidateQueries` auf `me` --
   * und das war genau verkehrt herum: `clear()` wirft die Abfrage aus dem
   * Speicher, und `invalidateQueries` findet danach nichts mehr, was es
   * ungueltig machen koennte. Der Abruf, der 401 ergaebe und auf die
   * Anmeldemaske schaltete, blieb aus; die Oberflaeche stand weiter da, mit
   * Gastdaten darauf, bis jemand von Hand neu lud.
   *
   * Der Neuaufbau ist aber nicht nur die Reparatur, sondern die bessere
   * Bauform: er ist das Einzige, was **garantiert** nichts stehen laesst --
   * React-Zustand, offene Komponenten, abgeloestes DOM, der
   * Zwischenspeicher. Jede Loesung innerhalb der Anwendung laesst die Frage
   * offen, ob irgendeine Komponente noch etwas haelt, und an einer
   * Rezeption sieht der Naechste, was stehenblieb.
   *
   * `replace` und nicht `assign`: der abgemeldete Stand soll nicht als
   * Eintrag in der Geschichte liegen bleiben, den ein Druck auf Zurueck
   * wiederholt. Ohne Abfragezeichenfolge, damit nicht Haus und Bildschirm
   * des Vorgaengers in der Adresse stehen.
   *
   * **Dazu gehoert `Cache-Control: no-store` auf `index.html`**
   * (`ops/caddy/Caddyfile`). Der Neuaufbau allein genuegt nicht: mit
   * `no-cache` bleibt die Seite fuer den Vor-Zurueck-Speicher des Browsers
   * zulaessig, und ein Druck auf Zurueck holt sie vollstaendig gezeichnet
   * zurueck -- mit denselben Gastdaten und ohne eine einzige Anfrage. Die
   * Anwendung blaettert ueber `history.pushState` (`lib/adresse.ts`), es
   * gibt also Eintraege, auf die das zutraefe.
   *
   * Scheitert der Aufruf -- kein Netz --, wird trotzdem neu aufgebaut: der
   * Bildschirm muss leer sein, auch wenn die Sitzung noch steht. Ist die
   * API nicht erreichbar, scheitert danach auch `me`, und es erscheint die
   * Anmeldemaske.
   */
  const abmelden = async (): Promise<void> => {
    try {
      await api.post('/v1/auth/logout')
    } finally {
      location.replace(location.pathname)
    }
  }

  if (zugang !== null) {
    return <I18nContext.Provider value={locale}>
      <Zugang art={zugang.art} token={zugang.token} />
    </I18nContext.Provider>
  }

  // Wer ist angemeldet. Schlaegt das mit 401 fehl, kommt die Anmeldemaske.
  // Nicht erneut versuchen: 401 ist eine Antwort, kein Ausfall.
  const me = useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/v1/auth/me'),
    retry: false
  })

  if (me.isPending) {
    return <I18nContext.Provider value={locale}>
      <div className="min-h-screen grid place-items-center text-sm text-neutral-500">…</div>
    </I18nContext.Provider>
  }
  if (me.isError) {
    return <I18nContext.Provider value={locale}>
      <Login onDone={() => void qc.invalidateQueries({ queryKey: ['me'] })} />
    </I18nContext.Provider>
  }

  // Das Haus aus der Adresse, sonst das erste, auf das der Benutzer Zugriff
  // hat. Ein Haus zu raten, auf das er keinen Zugriff hat, ergaebe auf jedem
  // Bildschirm eine 403.
  const haeuser: Haus[] = me.data.properties.map(p => ({
    id: p.id, code: p.code, name: p.name, isTraining: p.isTraining }))
  const haus = haeuser.find(h => h.id === adresse.property) ?? haeuser[0]

  if (haus === undefined) {
    /*
     * Fuer Plattformpersonal ohne laufende Support-Sitzung ist "kein Haus"
     * der Normalzustand, keine Stoerung: ohne Freigabe des Kunden bleibt der
     * Mandantenkontext leer, und die Zeilenrichtlinie liefert nichts. Der
     * richtige Bildschirm ist deshalb die Konsole, nicht eine Fehlermeldung.
     *
     * Laeuft eine Sitzung, bringt sie Haeuser mit, und dieser Zweig wird
     * gar nicht erreicht -- dann steht die normale Oberflaeche da, im Haus
     * des Kunden.
     */
    if (me.data.isPlatformStaff) {
      /*
       * **In der Shell und nicht daneben.** Vorher stand das Adminpanel
       * fuer sich, ohne Kopfleiste -- und damit ohne Abmelden, ohne
       * Sprachwahl und ohne den Weg zum eigenen Konto. Wer hier arbeitete,
       * kam aus seiner Sitzung nur heraus, indem er das Cookie von Hand
       * loeschte.
       *
       * Ohne Haus bleiben Hauswahl und Bildschirmleiste leer; beide
       * vertragen das (Hauswahl zeigt sich erst ab zwei Haeusern).
       */
      return <Shell screen="adminpanel" onScreen={() => { /* nur ein Bildschirm */ }}
                    screens={[]}
                    locale={locale} onLocale={setLocale}
                    benutzer={me.data.displayName}
                    onAbmelden={() => { void abmelden() }}
                    onArbeitsplatz={() => setArbeitsplatz(true)}
                    gewechselt={me.data.workstationSwitched}
                    haeuser={[]} haus={undefined}
                    onHaus={() => { /* kein Haus zu waehlen */ }}>
        {arbeitsplatz && (
          <Arbeitsplatz benutzer={me.data.displayName} email={me.data.email}
                        pinGesetzt={me.data.workstationPinSet}
                        gewechselt={me.data.workstationSwitched}
                        /*
                         * Kein Personenwechsel ohne Haus: es gibt niemanden,
                         * auf den zu wechseln waere. Kennwort und Mailadresse
                         * stehen trotzdem da -- sie haengen an der Person,
                         * nicht am Haus.
                         */
                        mitArbeitsplatz={false}
                        onClose={() => setArbeitsplatz(false)} />
        )}
        <AdminpanelSeite userId={me.data.userId}
                         platformPermissions={me.data.platformPermissions} />
      </Shell>
    }
    /*
     * Zwei Gruende, kein Haus zu sehen, und sie brauchen verschiedene Saetze.
     * "Noch kein Haus zugeordnet" an jemanden, dessen Account gesperrt ist,
     * schickt ihn und den Support in die falsche Richtung.
     */
    return <I18nContext.Provider value={locale}>
      <Hinweis>
        <Text k={me.data.accountSuspended ? 'app.accountSuspended' : 'app.noProperty'} />
      </Hinweis>
    </I18nContext.Provider>
  }

  const rechte = me.data.properties.find(p => p.id === haus.id)?.permissions ?? []
  const erlaubte = visibleScreens(rechte, me.data.isPlatformStaff)
  const screen = resolveScreen(adresse.screen, rechte, me.data.isPlatformStaff)

  if (screen === undefined) {
    return <I18nContext.Provider value={locale}>
      <Hinweis><Text k="app.noScreen" params={{ haus: haus.name }} /></Hinweis>
    </I18nContext.Provider>
  }

  return (
    <Shell screen={screen.key} onScreen={k => { setAdresse({ screen: k }) }}
           screens={erlaubte}
           locale={locale} onLocale={setLocale}
           benutzer={me.data.displayName}
           onAbmelden={() => { void abmelden() }}
           onArbeitsplatz={() => setArbeitsplatz(true)}
           gewechselt={me.data.workstationSwitched}
           haeuser={haeuser} haus={haus}
           onHaus={id => { setAdresse({ property: id, screen: null }) }}>
      {arbeitsplatz && (
        <Arbeitsplatz benutzer={me.data.displayName} email={me.data.email}
                      pinGesetzt={me.data.workstationPinSet}
                      gewechselt={me.data.workstationSwitched}
                      mitArbeitsplatz
                      onClose={() => setArbeitsplatz(false)} />
      )}
      {folioRef !== null
        ? <Folio folioRef={folioRef} propertyId={haus.id}
                 onClose={() => setFolioRef(null)} />
        : checkInRef !== null
          ? <CheckIn reservationRef={checkInRef} propertyId={haus.id}
                     onClose={() => setCheckInRef(null)} />
          : screen.render({ propertyId: haus.id, permissions: rechte,
                            userId: me.data.userId,
                            platformPermissions: me.data.platformPermissions,
                            openFolio: setFolioRef,
                            openCheckIn: setCheckInRef })}
    </Shell>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>)
