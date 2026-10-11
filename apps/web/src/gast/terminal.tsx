import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TerminalSeite } from '../routes/Terminal.tsx'
import '../styles.css'

/*
 * Einstieg der Seite am Gaesteterminal (Dokument 31).
 *
 * Eine eigene Datei und nicht ein Zweig in `main.tsx`: davor stand die ganze
 * Rezeption -- Zimmerplan, Preisraster, Kassenbuch, Adminpanel --, und der
 * Touchscreen lud sie bei jedem Neuaufbau nach einem Auftrag, um ein
 * Formular zu zeigen (Performance-Audit 11.10.2026, Befund 10).
 *
 * **Kein Service Worker und kein TanStack Query.** Der Worker gehoert der
 * installierbaren Oberflaeche des Personals (Dokument 33); hier soll nichts
 * im Browser liegen bleiben, was nicht jeder Aufruf ohnehin neu holt. Der
 * Zwischenspeicher von TanStack hielte Gastdaten ueber den Auftrag hinaus
 * (CLAUDE.md), die Seite fuehrt ihren Zustand deshalb selbst.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TerminalSeite />
  </StrictMode>)
