import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MeldescheinPortalSeite, meldescheinPortalAusAdresse } from '../routes/MeldescheinPortal.tsx'
import '../styles.css'

/*
 * Einstieg des festen Links je Haus zum Meldeschein (0216), fuer Gaeste von
 * Booking.com. Eigener Einstieg wie der Online-Check-in: ein Gast am Telefon
 * soll die Rezeption nicht mitladen, und ohne Service Worker.
 *
 * `boot.ts` hat den Pfad schon geprueft.
 */
const ref = meldescheinPortalAusAdresse()!

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MeldescheinPortalSeite portalRef={ref} />
  </StrictMode>)
