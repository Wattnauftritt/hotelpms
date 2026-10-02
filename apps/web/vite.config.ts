import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API = process.env.API_URL ?? 'http://127.0.0.1:3000'

export default defineConfig({
  plugins: [react()],
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
