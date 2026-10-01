import { Writable } from 'node:stream'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Dass die Warnung wirklich geschrieben wird -- in einer eigenen Datei.
 *
 * Die Schwelle wird beim Laden des Moduls gelesen, nicht je Anfrage: eine
 * Umgebungsvariable bei jedem Aufruf nachzuschlagen waere Arbeit fuer eine
 * Zahl, die sich nie aendert. Damit laesst sie sich nur **vor** dem Import
 * setzen, und `vi.hoisted` ist die Stelle dafuer -- in der Nachbardatei
 * stuende sonst jede gewoehnliche Anfrage unter der eins.
 */
vi.hoisted(() => { process.env.DB_QUERY_WARN = '1' })

let owner: Pool
let app: FastifyInstance
let pool: Pool
let zeilen: string[]

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
afterAll(async () => {
  await app.close(); await owner.end(); await pool.end()
  delete process.env.DB_QUERY_WARN
})
beforeEach(async () => { await truncateAll(); limiters.reset(); zeilen = [] })

describe('Die Warnung ueber viele Anweisungen', () => {
  it('steht im Protokoll, sobald die Schwelle ueberschritten ist', async () => {
    const haus = await makeProperty(owner)
    const kategorie = await makeCategory(owner, haus.propertyId)
    await makeResources(owner, haus.propertyId, kategorie, 2)
    const nutzer = await makeUser(owner,
      { email: 'rezeption@test.de', propertyId: haus.propertyId, roleKey: 'reception' })

    const r = await app.inject({
      method: 'GET',
      url: `/v1/properties/${haus.propertyId}/tape-chart?from=2026-10-01&to=2026-10-08`,
      headers: { cookie: `hp_session=${nutzer.sessionId}` } })
    expect(r.statusCode).toBe(200)

    const protokoll = zeilen.join('\n')
    expect(protokoll).toContain('Viele Datenbankanweisungen')
    /*
     * Beide Zahlen gehoeren hinein. Die Anweisungen allein sagen nicht, ob
     * es weh tut; die Zeit allein nicht, woran es liegt. Erst zusammen
     * unterscheiden sie "eine langsame Abfrage" von "vierhundert schnelle"
     * -- und das sind zwei verschiedene Fehler mit zwei verschiedenen
     * Behebungen.
     */
    expect(protokoll).toMatch(/"anweisungen":\d+/)
    expect(protokoll).toMatch(/"dbMs":\d+/)
  })

  it('schreibt keine zweite Zeile je Anfrage', async () => {
    // Zwei Zeilen je Anfrage verdoppeln das Protokoll und muessen beim
    // Lesen wieder zusammengesucht werden; die Warnung traegt deshalb
    // dieselbe Anfragekennung wie die Antwortzeile.
    const haus = await makeProperty(owner)
    const nutzer = await makeUser(owner,
      { email: 'rez2@test.de', propertyId: haus.propertyId, roleKey: 'reception' })
    await app.inject({
      method: 'GET', url: `/v1/properties/${haus.propertyId}/rooms`,
      headers: { cookie: `hp_session=${nutzer.sessionId}` } })

    const warnungen = zeilen.filter(z => z.includes('Viele Datenbankanweisungen'))
    expect(warnungen).toHaveLength(1)
    expect(warnungen[0]).toContain('reqId')
  })
})
