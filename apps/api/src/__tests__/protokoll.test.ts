import { Writable } from 'node:stream'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Befund B2, Dokument 25: Gastdaten im Protokoll ueber die
 * Abfragezeichenfolge.
 *
 * Geprueft wird am **geschriebenen** Protokoll, nicht am Serialisierer
 * allein: die Redaktionsliste war vollstaendig und die Regel trotzdem
 * gebrochen, weil Fastify die Adresse aus einer anderen Quelle nimmt. Ein
 * Test, der nur die Funktion aufruft, haette genau das nicht gesehen.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let zeilen: string[]

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const senke = new Writable({
    write(chunk: Buffer, _enc, cb) { zeilen.push(chunk.toString('utf8')); cb() }
  })
  const built = await buildServer({ pool: appPool(5), logStream: senke })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })
beforeEach(async () => { await truncateAll(); limiters.reset(); zeilen = [] })

describe('Anfrageprotokoll', () => {
  it('schreibt den Suchbegriff einer Gastsuche nicht ins Protokoll', async () => {
    const haus = await makeProperty(owner)
    const nutzer = await makeUser(owner,
      { email: 'rezeption@test.de', propertyId: haus.propertyId, roleKey: 'reception' })
    await makeGuest(owner, haus.accountId, { lastName: 'Petersen' })

    const r = await app.inject({
      method: 'GET', url: '/v1/guests?q=Petersen&limit=10',
      headers: auth(nutzer.sessionId) })
    expect(r.statusCode).toBe(200)

    const protokoll = zeilen.join('\n')
    // Der Kern: der Nachname steht nirgends. Das Protokoll wird eingesammelt,
    // weitergeleitet und laenger aufbewahrt als die Suche, und die
    // Anonymisierung eines Gastes erreicht es nicht.
    expect(protokoll).not.toContain('Petersen')
    // Der Zeitraum und die Grenze bleiben, sonst ist eine Fehlersuche blind.
    expect(protokoll).toContain('limit=10')
    // Und dass etwas entfernt wurde, ist erkennbar.
    expect(protokoll).toContain('entfernt')
    expect(protokoll).toContain('/v1/guests')
  })

  it('protokolliert das Routenmuster statt der ausgefuellten Kennung', async () => {
    const haus = await makeProperty(owner)
    const nutzer = await makeUser(owner,
      { email: 'rezeption2@test.de', propertyId: haus.propertyId, roleKey: 'reception' })
    const gast = await makeGuest(owner, haus.accountId, { lastName: 'Petersen' })

    await app.inject({
      method: 'GET', url: `/v1/guests/${gast.publicRef}`, headers: auth(nutzer.sessionId) })

    const protokoll = zeilen.join('\n')
    expect(protokoll).toContain('/v1/guests/:guestRef')
  })
})
