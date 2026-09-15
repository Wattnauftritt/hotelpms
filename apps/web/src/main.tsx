import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient }
  from '@tanstack/react-query'
import { Shell, type Haus } from './components/Shell.tsx'
import { Login } from './routes/Login.tsx'
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
  const [adresse, setAdresse] = useAdresse()
  // Das Folio liegt ueber dem Tagesgeschaeft, nicht daneben: es wird von dort
  // geoeffnet und danach wieder geschlossen.
  const [folioRef, setFolioRef] = useState<string | null>(null)
  // Der Check-in liegt ebenso ueber dem jeweiligen Bildschirm -- meist dem
  // Plan (A9) -- und schliesst sich danach wieder von selbst.
  const [checkInRef, setCheckInRef] = useState<string | null>(null)
  const qc = useQueryClient()

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
    return <I18nContext.Provider value={locale}>
      <Hinweis><Text k="app.noProperty" /></Hinweis>
    </I18nContext.Provider>
  }

  const rechte = me.data.properties.find(p => p.id === haus.id)?.permissions ?? []
  const erlaubte = visibleScreens(rechte)
  const screen = resolveScreen(adresse.screen, rechte)

  if (screen === undefined) {
    return <I18nContext.Provider value={locale}>
      <Hinweis><Text k="app.noScreen" params={{ haus: haus.name }} /></Hinweis>
    </I18nContext.Provider>
  }

  return (
    <Shell screen={screen.key} onScreen={k => { setAdresse({ screen: k }) }}
           screens={erlaubte}
           locale={locale} onLocale={setLocale}
           haeuser={haeuser} haus={haus}
           onHaus={id => { setAdresse({ property: id, screen: null }) }}>
      {folioRef !== null
        ? <Folio folioRef={folioRef} propertyId={haus.id}
                 onClose={() => setFolioRef(null)} />
        : checkInRef !== null
          ? <CheckIn reservationRef={checkInRef} propertyId={haus.id}
                     onClose={() => setCheckInRef(null)} />
          : screen.render({ propertyId: haus.id, openFolio: setFolioRef,
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
