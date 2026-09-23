import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    // Tests laufen gegen die Quellen, nicht gegen dist. Kein Build noetig.
    alias: {
      /*
       * Der Unterpfad steht **vor** dem Paket: die Liste wird der Reihe
       * nach abgearbeitet, und `@hotelpms/domain` passt auch auf
       * `@hotelpms/domain/groupPrice`. Stuende er hinten, landete der
       * Import bei `packages/domain/src/index.ts/groupPrice`.
       *
       * Den Unterpfad gibt es, weil die Oberflaeche die Aufteilung eines
       * Gruppenpreises zeigt und dafuer dieselbe Funktion benutzt wie die
       * Route. Ueber `index.ts` ginge das nicht: der Sammelpunkt zieht
       * `node:crypto` und `node:net` mit, und die gibt es im Browser nicht.
       */
      '@hotelpms/domain/groupPrice': fileURLToPath(
        new URL('./packages/domain/src/groupPrice.ts', import.meta.url)),
      '@hotelpms/db': src('db'),
      '@hotelpms/testing': src('testing'),
      '@hotelpms/domain': src('domain'),
      '@hotelpms/contracts': src('contracts')
    }
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['{apps,packages}/**/*.test.ts'],
    // dist der Weboberflaeche enthaelt gebaute Dateien, keine Tests.
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./packages/testing/src/setup.ts'],
    /*
     * Ein Prozess, eine Datenbank, Dateien nacheinander. Die Tests laufen
     * gegen **ein** PostgreSQL und raeumen ueber `truncateAll()` auf; liefen
     * zwei Dateien gleichzeitig, raeumte die eine der anderen die Tabellen
     * unter den Fuessen weg.
     *
     * `fileParallelism: false` setzt `maxWorkers` selbst auf 1. In Vitest 3
     * stand hier `poolOptions.forks.singleFork`; Vitest 4 hat die
     * Pool-Optionen nach oben gezogen (H5, Dokument 25).
     *
     * `isolate` bleibt beim Standard `true`, und das ist keine Kleinigkeit:
     * ohne die Isolation teilen alle Dateien den Modulzustand, und die
     * Ratenbegrenzung -- ein Zaehler im Speicher -- zaehlt dann ueber
     * Dateigrenzen weiter. Der Befund sieht dann aus wie ein Rechtefehler:
     * eine Route antwortet 429, wo der Test 401 erwartet.
     */
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000
  }
})
