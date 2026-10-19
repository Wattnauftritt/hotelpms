import { defineConfig } from 'vite'

/**
 * Baut nur die Bruecke (`src/bruecke.ts`) als ein Modul, samt dem Teil von
 * Capacitor, den sie braucht. Die Oberflaeche selbst baut `apps/web` mit
 * `--mode app`; zusammengesetzt wird beides in `scripts/www.mjs`.
 */
export default defineConfig({
  build: {
    outDir: 'dist-bruecke',
    emptyOutDir: true,
    lib: { entry: 'src/bruecke.ts', formats: ['es'], fileName: () => 'bruecke.js' },
    // Eine Datei: `www.mjs` setzt genau sie vor die Oberflaeche.
    rollupOptions: { output: { inlineDynamicImports: true } }
  }
})
