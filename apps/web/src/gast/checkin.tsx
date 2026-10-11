import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { GastCheckinSeite, checkinAusAdresse } from '../routes/GastCheckin.tsx'
import '../styles.css'

/*
 * Einstieg des Online-Check-ins (Dokument 30).
 *
 * Wer den Link aus seiner Buchungsmail oeffnet, ist Gast, oft am Telefon
 * und unterwegs. Er bekam bisher die ganze Rezeption mit, rund 1,4 MB
 * JavaScript fuer ein Formular (Performance-Audit 11.10.2026, Befund 10).
 *
 * **Kein Service Worker.** Der Worker gehoert der installierbaren Oberflaeche
 * des Personals (Dokument 33). Auf dem Telefon eines Gastes haette er im
 * Hintergrund die Rezeption heruntergeladen und dort liegen lassen.
 *
 * `boot.ts` hat den Pfad schon geprueft; `null` kommt hier nicht vor und
 * faellt sonst auf die Seite ohne Link zurueck, nicht in die Rezeption.
 */
const adresse = checkinAusAdresse()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GastCheckinSeite token={adresse?.token ?? null} />
  </StrictMode>)
