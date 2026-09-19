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
 * Gastdaten im Protokoll ueber die Abfragezeichenfolge -- Befund B2,
 * Dokument 25, und derselbe Befund als Nummer 3 in Dokument 26.
 *
 * Behoben ist er in `platform/app.ts`: der `req`-Serialisierer laesst die
 * Namen der Parameter stehen und ersetzt jeden Wert. Dieser Test ist der
 * Nachweis dazu, den die Behebung noch nicht hatte.
 *
 * Geprueft wird am **geschriebenen** Protokoll, nicht am Serialisierer
 * allein: die Redaktionsliste war vollstaendig und die Regel trotzdem
 * gebrochen, weil Fastify die Adresse aus einer anderen Quelle nimmt und gar
 * nicht durch die Liste laeuft. Ein Test, der nur die Funktion aufruft,
 * haette genau das nicht gesehen -- er haette bewiesen, dass der
 * Serialisierer richtig rechnet, nicht dass pino ihn benutzt.
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
    // Der Pfad und die Namen der Parameter bleiben: ohne sie ist beim Suchen
    // eines Fehlers nicht mehr ablesbar, wonach ueberhaupt gefragt wurde.
    expect(protokoll).toContain('/v1/guests')
    expect(protokoll).toContain('q=[redigiert]')
  })

  it('redigiert jeden Wert, nicht nur den bekannten Suchbegriff', async () => {
    /*
     * Eine Sperrliste waere hier das naheliegende und das falsche Mittel.
     * Der naechste Endpunkt bringt einen neuen Parameter mit, und niemand
     * traegt ihn nach -- geprueft wird deshalb an einem Parameter, den es im
     * Katalog gar nicht gibt.
     */
    const haus = await makeProperty(owner)
    const nutzer = await makeUser(owner,
      { email: 'rezeption2@test.de', propertyId: haus.propertyId, roleKey: 'reception' })
    await makeGuest(owner, haus.accountId, { lastName: 'Petersen' })

    await app.inject({
      method: 'GET', url: '/v1/guests?q=Meier&erfunden=Petersen',
      headers: auth(nutzer.sessionId) })

    const protokoll = zeilen.join('\n')
    expect(protokoll).not.toContain('Meier')
    expect(protokoll).not.toContain('Petersen')
    expect(protokoll).toContain('erfunden=[redigiert]')
  })
})
