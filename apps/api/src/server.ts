import { buildServer } from './platform/app.js'
import { registerAllRoutes } from './routes/index.js'

const { app, config } = await buildServer()
registerAllRoutes(app)

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
