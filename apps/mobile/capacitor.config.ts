import type { CapacitorConfig } from '@capacitor/cli'

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
    SystemBars: { insetsHandling: 'css', initialViewportFitValueHint: 'cover' }
  }
}

export default config
