import { buildMcp } from './app.js'
import { poolAnlegen } from './db.js'

/*
 * Ohne MCP_ENABLED=1 beendet sich der Dienst sofort und ohne Fehler. So
 * kann die Unit auf der Maschine liegen und aktiviert sein, ohne dass der
 * Zugang offen ist: Abschalten heisst eine Zeile in mcp.env und ein
 * Neustart, nicht eine Unit loeschen (Dokument 38).
 */
if (process.env.MCP_ENABLED !== '1') {
  console.log('Claude-Zugang ist abgeschaltet (MCP_ENABLED ist nicht 1).')
  process.exit(0)
}

function pflicht(name: string): string {
  const w = (process.env[name] ?? '').trim()
  if (w === '') {
    console.error(`${name} fehlt.`)
    process.exit(1)
  }
  return w
}

const pool = poolAnlegen(pflicht('MCP_DATABASE_URL'))
const app = buildMcp({
  pool,
  oeffentlicheAdresse: pflicht('PUBLIC_APP_URL'),
  protokollStufe: process.env.LOG_LEVEL ?? 'info'
})
const port = Number(process.env.MCP_PORT ?? 3100)
// Nur lokal: von aussen erreichbar ist der Dienst ausschliesslich ueber Caddy.
await app.listen({ port, host: '127.0.0.1' })

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void app.close().then(() => pool.end()).then(() => process.exit(0))
  })
}
