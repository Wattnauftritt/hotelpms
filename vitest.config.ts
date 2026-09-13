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
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
    hookTimeout: 60000
  }
})
