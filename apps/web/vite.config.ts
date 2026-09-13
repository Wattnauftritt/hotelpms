import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Im Entwicklungsbetrieb laeuft die API daneben. Im Betrieb liefert
    // Caddy beides unter derselben Herkunft aus, damit die Sitzung im
    // Cookie ohne Sonderregeln funktioniert.
    proxy: { '/v1': 'http://127.0.0.1:3000', '/openapi.json': 'http://127.0.0.1:3000' }
  },
  build: { outDir: 'dist', sourcemap: true }
})
