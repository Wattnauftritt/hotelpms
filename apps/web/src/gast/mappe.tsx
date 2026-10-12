import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { GastMappeSeite, mappeRefAusAdresse } from '../routes/GastMappe.tsx'
import '../styles.css'

/*
 * Einstieg der digitalen Gaestemappe (Migration 0143).
 *
 * Eigener Einstieg wie der Online-Check-in: wer den Code im Zimmer scannt,
 * ist Gast, am Telefon, und soll die Rezeption weder sehen noch
 * herunterladen. Kein Service Worker, aus demselben Grund.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GastMappeSeite roomRef={mappeRefAusAdresse()} />
  </StrictMode>)
