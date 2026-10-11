import { createHash } from 'node:crypto'
import { defineConfig, type Plugin, type Rollup } from 'vite'
import react from '@vitejs/plugin-react'
import { serviceWorkerQuelle, type Huelle } from './src/pwa/serviceWorker.ts'

const API = process.env.API_URL ?? 'http://127.0.0.1:3000'

/**
 * Die Anwendungen, die einen Service Worker anmelden, und ihr Einstieg.
 *
 * Die Gastseiten (`gast/`) fehlen mit Absicht: sie melden keinen Worker an,
 * und auf keinem Geraet soll ihretwegen etwas vorgeladen werden.
 */
const APPS: Record<string, string> = {
  rezeption: '/src/main.tsx',
  personal: '/src/personal/main.tsx'
}

/**
 * Welche Dateien zu welcher Anwendung gehoeren (Dokument 33).
 *
 * Bisher lud der Worker beim Installieren **jede** Datei des Baus. Das
 * Telefon einer Reinigungskraft holte damit im Hintergrund die ganze
 * Rezeption, und ein Gast mit Check-in-Link ebenso (Performance-Audit
 * 11.10.2026, Befund 11). Jetzt:
 *
 * - `grund`: die Seite und der kleine Einstieg (`boot.ts`) -- was jedes
 *   Fenster braucht, um ohne Netz ueberhaupt aufzugehen.
 * - `apps`: je Anwendung ihr Einstieg mit allem, was er statisch **und**
 *   nachgeladen braucht. Nachgeladen gehoert dazu, weil die Rezeption auch
 *   ohne Netz von einem Bildschirm zum naechsten gehen koennen soll, waehrend
 *   `lib/offline.ts` die Daten haelt; ein Bildschirm, dessen Datei fehlt,
 *   ginge dann nicht auf.
 */
function huelleAusBau(bundle: Rollup.OutputBundle): Huelle {
  const chunks = Object.values(bundle).filter((c): c is Rollup.OutputChunk => c.type === 'chunk')
  const nachName = new Map(chunks.map(c => [c.fileName, c]))
  const sammeln = (start: Rollup.OutputChunk[], nachgeladen: boolean): string[] => {
    const gesehen = new Set<string>()
    const offen = [...start]
    const css = new Set<string>()
    while (offen.length > 0) {
      const c = offen.pop()!
      if (gesehen.has(c.fileName)) continue
      gesehen.add(c.fileName)
      c.viteMetadata?.importedCss.forEach(d => css.add(d))
      for (const d of [...c.imports, ...(nachgeladen ? c.dynamicImports : [])]) {
        const n = nachName.get(d)
        // Nicht zurueck in den Einstieg: `boot.ts` laedt jede Anwendung
        // nach, und ueber ihn stuende jede in jeder Liste. Er selbst liegt
        // ohnehin im Grund.
        if (n !== undefined && (!nachgeladen || !n.isEntry)) offen.push(n)
      }
    }
    return ['/', ...[...gesehen, ...css].sort().map(d => '/' + d)]
  }
  const einstieg = chunks.filter(c => c.isEntry)
  const apps: Record<string, string[]> = {}
  for (const [app, modul] of Object.entries(APPS)) {
    // Ueber die enthaltenen Module und nicht `facadeModuleId`: legt Rollup
    // den Einstieg mit geteiltem Code zusammen, hat sein Teil keine Fassade.
    const c = chunks.find(k => k.moduleIds.some(m => m.endsWith(modul)))
    if (c === undefined) throw new Error(`Einstieg ${modul} fehlt im Bau`)
    apps[app] = sammeln([c], true)
  }
  return { grund: sammeln(einstieg, false), apps }
}

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
                      source: serviceWorkerQuelle(huelleAusBau(bundle), fassung) })
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
  build: {
    outDir: 'dist',
    /*
     * Quellkarten entstehen weiter, aber ohne Verweis in den ausgelieferten
     * Dateien (`hidden`). Mit `true` lagen 4,4 MB lesbarer Quelltext unter
     * jeder Adresse offen, und jeder Browser holte sie beim Oeffnen der
     * Entwicklerwerkzeuge (Performance-Audit 11.10.2026, Befund 14). Wer
     * einen Fehler aus dem Betrieb aufloesen will, legt die Karte aus dem
     * Bau daneben.
     */
    sourcemap: 'hidden',
    rollupOptions: {
      treeshake: {
        /*
         * TypeBox aus dem Browser heraushalten (Befund 10). Die Oberflaeche
         * holt aus `@hotelpms/contracts` Konstanten und Typen, keine
         * Schemata; die Schemata stehen aber in denselben Dateien als
         * `Type.Object(...)` auf oberster Ebene. Ohne diese Angabe haelt
         * Rollup jeden solchen Aufruf fuer moeglicherweise wirksam und
         * behaelt ihn -- und mit ihm TypeBox, rund 70 KB je Einstieg, auch in der
         * Personal-App. `Type.*` baut nur ein Objekt und aendert nichts
         * ausserhalb; dazu gehoert `"sideEffects": false` im Paket.
         */
        manualPureFunctions: ['Type']
      }
    }
  }
})
