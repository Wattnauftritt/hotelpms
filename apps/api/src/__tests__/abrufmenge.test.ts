import { Writable } from 'node:stream'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeGuest,
         makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'
import { GEZAEHLT } from '../platform/abrufmenge.js'
import { registeredRoutes } from '../platform/routes.js'

/**
 * Wer fragt und wie viel (Migration 0210, Bedrohungsanalyse 23.10.2026, E1
 * und E2): die Protokollzeile nennt Aufrufer und volle Adresse, und die
 * Routen, die Gaeste in Mengen liefern, zaehlen je Aufrufer und Stunde mit.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
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
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })
beforeEach(async () => {
  await truncateAll(); limiters.reset(); zeilen = []
  fx = await makeProperty(owner, { name: 'Wattenblick' })
})

async function abgeschlossen(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const z = zeilen.map(x => JSON.parse(x) as Record<string, unknown>)
      .find(x => x.msg === 'request completed')
    if (z !== undefined) return z
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('keine Zeile "request completed"')
}

describe('Abrufmenge', () => {
  it('nennt Aufrufer und Adresse in der Protokollzeile und zaehlt die Gaeste', async () => {
    const r = await makeUser(owner, { email: 'rezeption@kunde.de',
      propertyId: fx.propertyId, roleKey: 'reception' })
    for (const n of ['Petersen', 'Hansen', 'Jensen']) {
      await makeGuest(owner, fx.accountId, { lastName: n })
    }
    const res = await app.inject({ method: 'GET', url: '/v1/guests?q=sen',
      headers: { cookie: `hp_session=${r.sessionId}` } })
    expect(res.statusCode).toBe(200)

    // Die Zeile "request completed" schreibt Fastify erst nach den
    // onResponse-Haken, und der Zaehler darin wartet auf die Datenbank.
    const fertig = await abgeschlossen()
    expect(fertig.wer).toBe(`user:${r.userId}`)
    expect(fertig.ip).toBe('127.0.0.1')
    // Der Suchbegriff bleibt draussen, wie bisher (Befund B2).
    expect(JSON.stringify(zeilen)).not.toContain('sen&')

    const v = await owner.query<{ principal_key: string; requests: number
                                  rows_returned: number; origin: string }>(
      'SELECT principal_key, requests, rows_returned, host(origin) AS origin FROM access_volume')
    expect(v.rows).toEqual([{ principal_key: `user:${r.userId}`, requests: 1,
                              rows_returned: 3, origin: '127.0.0.1' }])

    // Eine Route ohne Gastdaten zaehlt nicht.
    await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: `hp_session=${r.sessionId}` } })
    const n = await owner.query<{ requests: number }>('SELECT requests FROM access_volume')
    expect(n.rows[0]!.requests).toBe(1)
  })

  it('zaehlt dieselbe Liste und denselben Gast in einer Stunde nur einmal', async () => {
    // Fehlalarm 01.11.2026: die Meldescheinliste, bei jedem Fensterwechsel
    // neu geladen, zaehlte jedes Mal alle Zeilen (Migration 0221).
    const r = await makeUser(owner, { email: 'rezeption@kunde.de',
      propertyId: fx.propertyId, roleKey: 'reception' })
    const cookie = `hp_session=${r.sessionId}`
    const refs: string[] = []
    for (const n of ['Petersen', 'Hansen', 'Jensen']) {
      refs.push((await makeGuest(owner, fx.accountId, { lastName: n })).publicRef)
    }
    const zaehler = async () => (await owner.query<{ requests: number; rows_returned: number }>(
      'SELECT requests, rows_returned FROM access_volume')).rows[0]
    const zaehlerNach = async (anfragen: number) => {
      for (let i = 0; i < 100; i++) {
        const z = await zaehler()
        if (z !== undefined && z.requests >= anfragen) return z
        await new Promise(res => setTimeout(res, 10))
      }
      throw new Error('Zaehler nicht geschrieben')
    }

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/v1/guests?q=sen', headers: { cookie } })
      expect(res.statusCode).toBe(200)
    }
    expect(await zaehlerNach(5)).toEqual({ requests: 5, rows_returned: 3 })

    // Ein Einzelabruf zaehlt je Adresse einmal; ein anderer Gast ist neu.
    await app.inject({ method: 'GET', url: `/v1/guests/${refs[0]}`, headers: { cookie } })
    await app.inject({ method: 'GET', url: `/v1/guests/${refs[0]}`, headers: { cookie } })
    await app.inject({ method: 'GET', url: `/v1/guests/${refs[1]}`, headers: { cookie } })
    expect(await zaehlerNach(8)).toEqual({ requests: 8, rows_returned: 5 })
  })

  it('ist fuer die Anwendung weder lesbar noch beschreibbar', async () => {
    const c = await pool.connect()
    try {
      await expect(c.query('SELECT * FROM access_volume')).rejects.toThrow(/permission denied/)
      await expect(c.query('SELECT * FROM access_volume_seen')).rejects.toThrow(/permission denied/)
      await expect(c.query(
        `INSERT INTO access_volume (principal_key, hour) VALUES ('user:1', now())`))
        .rejects.toThrow(/permission denied/)
    } finally { c.release() }
  })

  it('zaehlt nur Routen, die es gibt und die lesen', () => {
    const get = new Set(registeredRoutes().filter(r => r.method === 'GET').map(r => r.url))
    for (const url of GEZAEHLT) expect(get.has(url), url).toBe(true)
  })
})
