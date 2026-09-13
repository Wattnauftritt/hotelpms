import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Shell, type Screen } from './components/Shell.tsx'
import { Tape } from './routes/Tape.tsx'
import { Today } from './routes/Today.tsx'
import { Housekeeping } from './routes/Housekeeping.tsx'
import { Setup } from './routes/Setup.tsx'
import { Login } from './routes/Login.tsx'
import { LOCALES, I18nContext, type Locale } from './lib/i18n.js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './lib/api.js'
import './styles.css'

/**
 * Die Property steht in der Adresse, nicht in einem verborgenen Zustand.
 * Wer in einer Kette zwischen Häusern wechselt, will den Link weitergeben
 * können, und ein Lesezeichen soll dasselbe Haus öffnen.
 */
function propertyAusAdresse(): number | null {
  const p = new URLSearchParams(location.search).get('property')
  const n = Number(p)
  return Number.isFinite(n) && n > 0 ? n : null
}

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
  properties: Array<{ id: number; code: string; name: string }>
}

function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>('tape')
  const [locale, setLocale] = useState<Locale>(spracheDesBrowsers)
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
  const ausAdresse = propertyAusAdresse()
  const erlaubt = me.data.properties.map(p => p.id)
  const propertyId = ausAdresse !== null && erlaubt.includes(ausAdresse)
    ? ausAdresse
    : erlaubt[0] ?? 0

  if (propertyId === 0) {
    return <I18nContext.Provider value={locale}>
      <div className="min-h-screen grid place-items-center p-8 text-sm text-neutral-600">
        Diesem Benutzer ist noch kein Haus zugeordnet.
      </div>
    </I18nContext.Provider>
  }

  return (
    <Shell screen={screen} onScreen={setScreen} locale={locale} onLocale={setLocale}>
      {screen === 'tape' && <Tape propertyId={propertyId} />}
      {screen === 'today' && <Today propertyId={propertyId} />}
      {screen === 'housekeeping' && <Housekeeping propertyId={propertyId} />}
      {screen === 'setup' && <Setup propertyId={propertyId} />}
    </Shell>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>)
