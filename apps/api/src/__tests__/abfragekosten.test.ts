import { Writable } from 'node:stream'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser } from '@hotelpms/testing'
import { createPool, ANFRAGE_TIMEOUT_MS, STAPEL_TIMEOUT_MS, type Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Was eine Anfrage die Datenbank kostet -- im Betrieb, nicht nur im Test.
 *
 * Der Abfragezaehler aus `@hotelpms/testing` faengt jedes N+1 in dem Moment
 * ab, in dem es entsteht; aber nur an den Stellen, an denen ein Test ihn
 * aufruft. Im Betrieb gab es dafuer nichts (Befund P9, Dokument 29): eine
 * Antwort in 300 ms sah gleich aus, ob sie aus einer Abfrage kam oder aus
 * vierhundert.
 */

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
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })
beforeEach(async () => { await truncateAll(); limiters.reset(); zeilen = [] })

describe('Abfragekosten einer Anfrage', () => {
  it('schweigt bei einer gewoehnlichen Anfrage', async () => {
    /*
     * Ein Protokoll, in dem alles steht, liest niemand. Unterhalb der
     * Schwelle ist die Zahl uninteressant -- und die Endpunkte sind
     * Aggregate, eine Anfrage kommt mit einer Handvoll Anweisungen aus.
     */
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
    expect(zeilen.join('\n')).not.toContain('Viele Datenbankanweisungen')
  })

  it('zaehlt die Anweisungen einer Anfrage und nicht den Transaktionsrahmen', async () => {
    /*
     * `BEGIN`, `COMMIT` und das Setzen des Mandantenkontexts sind je
     * Anfrage dieselben drei Anweisungen. Mitgezaehlt verschoeben sie jede
     * Schwelle um denselben Betrag und machten die Zahl unbrauchbar fuer
     * den Vergleich zweier Endpunkte.
     */
    const { withTransaction, SYSTEM_CONTEXT } = await import('@hotelpms/db')
    let bericht = { anweisungen: -1, dauerMs: -1 }
    await withTransaction(pool, SYSTEM_CONTEXT, async client => {
      await client.query('SELECT 1')
      await client.query('SELECT 2')
    }, b => { bericht = b })

    expect(bericht.anweisungen).toBe(2)
    expect(bericht.dauerMs).toBeGreaterThan(0)
  })

  it('warnt, wenn eine Anfrage auffaellig viele Anweisungen braucht', async () => {
    /*
     * Nachgestellt ueber die Schwelle selbst statt ueber einen Endpunkt mit
     * N+1: einen solchen gibt es nicht, und ihn zu bauen, nur damit der
     * Test ihn findet, hiesse, den Fehler einzubauen, vor dem gewarnt
     * werden soll.
     */
    const { withTransaction, SYSTEM_CONTEXT } = await import('@hotelpms/db')
    let bericht = { anweisungen: 0, dauerMs: 0 }
    await withTransaction(pool, SYSTEM_CONTEXT, async client => {
      for (let i = 0; i < 60; i++) await client.query('SELECT 1')
    }, b => { bericht = b })
    expect(bericht.anweisungen).toBe(60)
    expect(bericht.anweisungen).toBeGreaterThanOrEqual(50)
  })

  it('misst nichts, solange niemand zusieht', async () => {
    // Ohne Rueckruf wird der Client nicht umhuellt: der Worker zahlt nichts
    // fuer eine Zahl, auf die dort niemand wartet.
    const { withTransaction, SYSTEM_CONTEXT } = await import('@hotelpms/db')
    const ergebnis = await withTransaction(pool, SYSTEM_CONTEXT, async client => {
      const r = await client.query<{ n: number }>('SELECT 1::int AS n')
      return r.rows[0]!.n
    })
    expect(ergebnis).toBe(1)
  })
})

describe('Zeitgrenzen je Anweisung', () => {
  it('gibt Stapelarbeit mehr Zeit als einer Anfrage', async () => {
    /*
     * Dieselben dreissig Sekunden fuer beides waren falsch (Befund P8,
     * Dokument 29): fuer eine Rezeption richtig -- was laenger braucht, ist
     * kaputt --, fuer den Nachtlauf eines Hauses mit 250 Zimmern oder einen
     * Jahresexport nicht. Der stuerbe mitten im Lauf.
     */
    expect(STAPEL_TIMEOUT_MS).toBeGreaterThan(ANFRAGE_TIMEOUT_MS)

    const stapel = createPool({ kind: 'owner', max: 1, applicationName: 'test-stapel',
                                statementTimeoutMs: STAPEL_TIMEOUT_MS })
    try {
      const r = await stapel.query<{ statement_timeout: string }>(
        `SHOW statement_timeout`)
      expect(r.rows[0]!.statement_timeout).toBe('5min')
    } finally {
      await stapel.end()
    }
  })

  it('laesst eine Anfrage nicht ewig laufen', async () => {
    // Eine haengende Anweisung haelt eine Verbindung des Pools fest, und
    // der Pool ist das Knappe.
    const anfrage = createPool({ kind: 'owner', max: 1, applicationName: 'test-anfrage' })
    try {
      const r = await anfrage.query<{ statement_timeout: string }>(
        `SHOW statement_timeout`)
      expect(r.rows[0]!.statement_timeout).toBe('30s')
    } finally {
      await anfrage.end()
    }
  })
})
