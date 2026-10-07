import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PersonalApp } from './PersonalApp.tsx'
import { serviceWorkerAnmelden } from '../lib/pwa.js'
import '../styles.css'

/*
 * Das Manifest der Personal-App statt dem der Rezeption.
 *
 * `index.html` ist fuer beide dieselbe Datei und verweist auf das der
 * Rezeption. Installiert jemand vom Telefon aus `/personal`, soll auf dem
 * Startbildschirm "Personal" stehen und die App dort starten -- nicht die
 * Rezeption, in der das Personal nichts sieht. Der Browser liest den
 * Verweis, wenn er ueber das Installieren entscheidet, und das ist nach
 * diesem Skript.
 */
document.querySelector('link[rel="manifest"]')?.setAttribute('href', '/personal.webmanifest')
document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#171717')

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Das Telefon liegt in der Kitteltasche und kommt wieder heraus: beim
      // Zurueckkehren den Stand holen, nicht den von vor einer Stunde zeigen.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      staleTime: 30_000
    }
  }
})

serviceWorkerAnmelden()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PersonalApp />
    </QueryClientProvider>
  </StrictMode>)
