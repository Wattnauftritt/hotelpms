import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    // Tests laufen gegen die Quellen, nicht gegen dist. Kein Build noetig.
    alias: {
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
     * Pool-Optionen nach oben gezogen (H5, Dokument 24).
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
