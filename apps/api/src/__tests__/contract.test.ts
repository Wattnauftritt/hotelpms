import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, appPool } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { registeredRoutes } from '../platform/routes.js'
import { toOpenApiPath, operationId } from '@hotelpms/contracts'

let app: FastifyInstance
let pool: Pool
let doc: {
  openapi: string
  paths: Record<string, Record<string, {
    operationId: string; summary: string
    'x-required-permission': string | null
    security: unknown[]
    responses: Record<string, unknown>
  }>>
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> }
}

beforeAll(async () => {
  await ensureSchema()
  const built = await buildServer({ pool: appPool(5) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
  const r = await app.inject({ method: 'GET', url: '/openapi.json' })
  doc = JSON.parse(r.body)
})
afterAll(async () => { await app.close(); await pool.end() })

describe('Schnittstellenbeschreibung', () => {
  it('ist ohne Anmeldung lesbar', async () => {
    const r = await app.inject({ method: 'GET', url: '/openapi.json' })
    expect(r.statusCode).toBe(200)
    expect(doc.openapi).toBe('3.1.0')
  })

  /**
   * Der eigentliche Vertragstest: die Beschreibung entsteht aus der
   * Registrierung, also muss jede registrierte Route darin stehen. Eine neue
   * Route, die vergessen wird zu dokumentieren, kann es damit nicht geben.
   */
  it('enthaelt jede registrierte Route mit ihrer Methode', () => {
    for (const r of registeredRoutes()) {
      const pfad = toOpenApiPath(r.url)
      expect(doc.paths[pfad], `Pfad fehlt: ${pfad}`).toBeDefined()
      expect(doc.paths[pfad]![r.method.toLowerCase()],
        `${r.method} ${pfad} fehlt`).toBeDefined()
    }
  })

  it('nennt an jeder Operation die verlangte Berechtigung', () => {
    for (const r of registeredRoutes()) {
      const op = doc.paths[toOpenApiPath(r.url)]![r.method.toLowerCase()]!
      expect(op['x-required-permission']).toBe(r.permission)
    }
  })

  it('vergibt eindeutige Bezeichner je Operation', () => {
    const ids = Object.values(doc.paths).flatMap(p =>
      Object.values(p).map(o => o.operationId))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(operationId('GET', '/v1/properties/:propertyId/availability'))
  })

  it('beschreibt geschuetzte Operationen mit Sitzung und Fehlerformat', () => {
    const geschuetzt = registeredRoutes().filter(r => r.permission !== null)
    expect(geschuetzt.length).toBeGreaterThan(20)
    for (const r of geschuetzt) {
      const op = doc.paths[toOpenApiPath(r.url)]![r.method.toLowerCase()]!
      expect(op.security).toEqual([{ sessionCookie: [] }])
      expect(op.responses['401']).toBeDefined()
      expect(op.responses['403']).toBeDefined()
    }
    expect(doc.components.schemas.Problem).toBeDefined()
    expect(doc.components.securitySchemes.sessionCookie).toBeDefined()
  })

  it('laesst oeffentliche Operationen ausdruecklich ohne Sitzung', () => {
    const offen = registeredRoutes().filter(r => r.permission === null)
    expect(offen.length).toBeGreaterThan(0)
    for (const r of offen) {
      const op = doc.paths[toOpenApiPath(r.url)]![r.method.toLowerCase()]!
      expect(op.security).toEqual([])
    }
  })

  it('gibt jeder Operation eine Zusammenfassung', () => {
    for (const p of Object.values(doc.paths)) {
      for (const op of Object.values(p)) {
        expect(op.summary.length).toBeGreaterThan(3)
      }
    }
  })

  it('uebersetzt Fastify-Pfadparameter in die OpenAPI-Schreibweise', () => {
    expect(toOpenApiPath('/v1/properties/:propertyId/rate-grid'))
      .toBe('/v1/properties/{propertyId}/rate-grid')
    expect(Object.keys(doc.paths).some(p => p.includes(':'))).toBe(false)
  })
})
