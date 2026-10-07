import { istPersonalAdresse } from './personal/adresse.js'

/**
 * Welche Oberflaeche dieser Aufruf laedt.
 *
 * Rezeption und Personal-App liegen unter derselben Herkunft (ein Cookie,
 * eine Caddy-Regel, ein Bau), sind aber zwei Anwendungen. Das Telefon einer
 * Reinigungskraft soll nicht die ganze Rezeption herunterladen -- Zimmerplan,
 * Preisraster, Kassenbuch --, um darin drei Knoepfe zu benutzen. Deshalb
 * entscheidet dieser kleine Einstieg nur ueber den Pfad und laedt dann genau
 * eine der beiden; der Bau legt sie in getrennte Dateien.
 */
if (istPersonalAdresse(location.pathname)) {
  void import('./personal/main.tsx')
} else {
  void import('./main.tsx')
}
