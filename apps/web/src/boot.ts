import { istPersonalAdresse } from './personal/adresse.js'
import { istCheckinAdresse, istTerminalAdresse } from './gast/adresse.js'

/**
 * Welche Oberflaeche dieser Aufruf laedt.
 *
 * Rezeption und Personal-App liegen unter derselben Herkunft (ein Cookie,
 * eine Caddy-Regel, ein Bau), sind aber zwei Anwendungen. Das Telefon einer
 * Reinigungskraft soll nicht die ganze Rezeption herunterladen -- Zimmerplan,
 * Preisraster, Kassenbuch --, um darin drei Knoepfe zu benutzen. Deshalb
 * entscheidet dieser kleine Einstieg nur ueber den Pfad und laedt dann genau
 * eine der Anwendungen; der Bau legt sie in getrennte Dateien.
 *
 * Die beiden Gastseiten -- Online-Check-in und Gaesteterminal -- gehen
 * denselben Weg und aus einem staerkeren Grund: davor steht ein Gast, der
 * ein Formular ausfuellt und mit der Rezeption nichts zu tun hat
 * (Performance-Audit 11.10.2026, Befund 10). Sie standen bisher als erste
 * Zweige in `main.tsx` und luden damit alles andere mit.
 */
if (istPersonalAdresse(location.pathname)) {
  void import('./personal/main.tsx')
} else if (istTerminalAdresse(location.pathname)) {
  void import('./gast/terminal.tsx')
} else if (istCheckinAdresse(location.pathname)) {
  void import('./gast/checkin.tsx')
} else {
  void import('./main.tsx')
}
