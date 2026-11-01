import { buildServer } from './platform/app.js'
import { konfigurationMelden } from '@hotelpms/db'
import { registerAllRoutes } from './routes/index.js'

const { app, pool, config } = await buildServer()
registerAllRoutes(app)

/*
 * Fuer den Claude-Zugang (Dokument 38): welche Einstellungen gesetzt sind,
 * und wohin eine Klartext-Anfrage gemeldet wird. Scheitert das, startet die
 * API trotzdem -- es ist eine Hilfe, kein Betrieb.
 */
try {
  await konfigurationMelden(pool, 'api')
  await pool.query('SELECT mcp_alarm_email_set($1)', [config.platformNoticeEmail])
} catch (e) {
  app.log.warn({ err: e }, 'Konfiguration fuer den Claude-Zugang nicht gemeldet')
}

const address = config.listenSocket
  ? await app.listen({ path: config.listenSocket })
  : await app.listen({ port: config.port, host: '127.0.0.1' })

app.log.info(`hotelpms API laeuft auf ${address}`)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.log.info('Sanftes Herunterfahren')
    void app.close().then(() => process.exit(0))
  })
}
