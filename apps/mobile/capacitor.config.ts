import type { CapacitorConfig } from '@capacitor/cli'
import { existsSync, readFileSync } from 'node:fs'

/**
 * Der oeffentliche Schluessel fuer Pakete vom Server (Plan §4). Den
 * privaten erzeugt `deploy.sh app-schluessel` auf der Maschine, und er
 * verlaesst sie nicht; hier steht nur die Haelfte, mit der die App prueft.
 *
 * Ohne Datei bleibt die Aktualisierung aus, statt ungeprueft zu laufen: das
 * Werkzeug nimmt ohne `publicKey` jedes Paket an, das eine Pruefsumme hat.
 * Die Bruecke fragt dann gar nicht erst (`VITE_STAYGRID_PAKET` in
 * scripts/www.mjs), und der Freigabelauf verweigert den Bau.
 */
// Relativ zum Arbeitsverzeichnis: die Befehle von Capacitor laufen in
// apps/mobile, und die Datei wird dort als CommonJS ausgewertet, wo es
// `import.meta` nicht gibt.
const PAKET_SCHLUESSEL = 'paket-schluessel.pem'
const publicKey = existsSync(PAKET_SCHLUESSEL) ? readFileSync(PAKET_SCHLUESSEL, 'utf8').replace(/\r/g, '').trim() : undefined

/**
 * Die Huelle der StayGrid-App (Plan app/plan.md, Baustein 3).
 *
 * `webDir` ist `www`, nicht `../web/dist-app`: `scripts/www.mjs` legt dort
 * den Bau der Oberflaeche ab und setzt die Bruecke davor. Capacitor kopiert
 * nur dieses Verzeichnis in die App, und es soll nichts anderes sehen als
 * das, was ausgeliefert wird.
 */
const config: CapacitorConfig = {
  appId: 'cloud.staygrid.app',
  appName: 'StayGrid',
  webDir: 'www',
  server: {
    // Die Herkuenfte, die die API fuer CORS kennt (APP_ORIGINS in
    // apps/api/src/platform/auth.ts). Wer sie hier aendert, aendert sie dort.
    hostname: 'localhost',
    androidScheme: 'https',
    iosScheme: 'capacitor'
  },
  ios: {
    // Die Oberflaeche rechnet die Raender selbst (`env(safe-area-inset-*)`,
    // mit `viewport-fit=cover` im Bau fuer die App). Ein Einzug der WebView
    // kaeme sonst noch dazu.
    contentInset: 'never'
  },
  plugins: {
    SystemBars: { insetsHandling: 'css', initialViewportFitValueHint: 'cover' },
    LiveUpdate: {
      publicKey,
      // Laedt und wechselt nur, wenn die Bruecke es sagt: sie kennt die
      // Fassung der Huelle, die ein Paket braucht, das Werkzeug nicht.
      autoUpdateStrategy: 'none',
      // Meldet sich ein neues Paket nicht binnen zehn Sekunden mit ready(),
      // geht die App auf den mitgelieferten Stand zurueck und nimmt dieses
      // Paket nie wieder. Eine Oberflaeche, die nicht startet, laesst sich
      // sonst nur durch Neuinstallieren beheben.
      readyTimeout: 10000,
      autoBlockRolledBackBundles: true,
      autoDeleteBundles: true
    }
  }
}

export default config
