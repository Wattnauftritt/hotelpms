import { CHECKIN_PATH, FOLDER_PATH } from '@hotelpms/contracts'

/**
 * Welche Gastseite in der Adresse steht -- ohne React und ohne die Seiten
 * selbst.
 *
 * `boot.ts` entscheidet damit, welche Anwendung geladen wird. Saesse die
 * Pruefung in `routes/Terminal.tsx` oder `routes/GastCheckin.tsx`, holte
 * schon die Frage "bin ich die Terminalseite?" die ganze Seite herunter --
 * und fuer die Rezeption ist die Antwort fast immer nein. Pfad als
 * Parameter wie in `personal/adresse.ts`, damit die Auswertung ohne Browser
 * pruefbar bleibt.
 */

export const TERMINAL_PFAD = '/terminal'

/** Steht die Terminalseite in der Adresse? Wie `zugangAusAdresse`, zum Pruefen ohne Browser. */
export function istTerminalAdresse(pathname: string = location.pathname): boolean {
  return pathname.replace(/\/+$/, '') === TERMINAL_PFAD
}

/** Steht der Online-Check-in des Gastes (`/checkin#...`) in der Adresse? */
export function istCheckinAdresse(pathname: string = location.pathname): boolean {
  return pathname.replace(/\/+$/, '') === CHECKIN_PATH
}

/** Steht die Gaestemappe (`/mappe#...`) in der Adresse? */
export function istMappeAdresse(pathname: string = location.pathname): boolean {
  return pathname.replace(/\/+$/, '') === FOLDER_PATH
}
