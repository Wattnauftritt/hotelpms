import { createHash } from 'node:crypto'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { serviceWorkerQuelle } from './src/pwa/serviceWorker.ts'

const API = process.env.API_URL ?? 'http://127.0.0.1:3000'

/**
 * Erzeugt `sw.js` aus den Dateien dieses Baus (Dokument 33). Nur beim Bau:
 * im Entwicklungsbetrieb wird kein Worker angemeldet (`lib/pwa.ts`).
 */
function serviceWorker(): Plugin {
  return {
    name: 'staygrid-service-worker',
    apply: 'build',
    generateBundle(_, bundle) {
      const dateien = Object.keys(bundle)
        .filter(d => d.startsWith('assets/') && !d.endsWith('.map'))
        .sort()
      // Die Namen tragen den Hash ihres Inhalts; ihr Hash ist damit der
      // des ganzen Baus.
      const fassung = createHash('sha256').update(dateien.join('\n'))
        .digest('hex').slice(0, 12)
      this.emitFile({ type: 'asset', fileName: 'sw.js',
                      source: serviceWorkerQuelle(dateien, fassung) })
    }
  }
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    // Im Entwicklungsbetrieb laeuft die API daneben. Im Betrieb liefert
    // Caddy beides unter derselben Herkunft aus, damit die Sitzung im
    // Cookie ohne Sonderregeln funktioniert.
    //
    // Ziel und Port kommen aus der Umgebung, damit zwei Arbeitsstaende
    // nebeneinander laufen koennen -- jeder mit eigener API und eigener
    // Datenbank. Fest verdrahtet redete die zweite Oberflaeche still mit der
    // ersten API, und was man pruefte, war nicht der eigene Stand.
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/v1': API, '/openapi.json': API }
  },
  build: { outDir: 'dist', sourcemap: true }
})
