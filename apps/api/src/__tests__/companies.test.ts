import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Firmen (Aufgabe A10): lesen und aendern. Anlegen und Suche gab es schon
 * (POST/GET /v1/companies), nur der Weg zurueck zu einer einzelnen Firma
 * fehlte -- fuer die Oberflaeche unbrauchbar ohne ihn.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(10) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

async function firmaAnlegen(name = 'Nordwind GmbH'): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: '/v1/companies', headers: auth,
    payload: { name, vatId: 'DE123456789', city: 'Flensburg' } })
  expect(r.statusCode, r.body).toBe(201)
  return (JSON.parse(r.body) as { companyRef: string }).companyRef
}

describe('Firmen', () => {
  it('legt eine Firma an und liest sie wieder', async () => {
    const ref = await firmaAnlegen()
    const r = await app.inject({ method: 'GET', url: `/v1/companies/${ref}`, headers: auth })
    expect(r.statusCode, r.body).toBe(200)
    const body = JSON.parse(r.body)
    expect(body).toMatchObject({
      companyRef: ref, name: 'Nordwind GmbH', vatId: 'DE123456789', city: 'Flensburg',
      country: 'DE', paymentTermsDays: 14, active: true
    })
  })

  it('meldet eine unbekannte Firma als nicht gefunden', async () => {
    const r = await app.inject({
      method: 'GET', url: '/v1/companies/comp_gibtesnicht', headers: auth })
    expect(r.statusCode).toBe(404)
  })

  it('aendert einzelne Felder, ohne die anderen anzufassen', async () => {
    const ref = await firmaAnlegen()
    const r = await app.inject({
      method: 'PATCH', url: `/v1/companies/${ref}`, headers: auth,
      payload: { paymentTermsDays: 30, invoiceEmail: 'buchhaltung@nordwind.test' } })
    expect(r.statusCode, r.body).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.paymentTermsDays).toBe(30)
    expect(body.invoiceEmail).toBe('buchhaltung@nordwind.test')
    // Unveraendert gebliebene Felder.
    expect(body.name).toBe('Nordwind GmbH')
    expect(body.vatId).toBe('DE123456789')
  })

  it('legt eine Firma still, statt sie zu loeschen', async () => {
    const ref = await firmaAnlegen()
    const r = await app.inject({
      method: 'PATCH', url: `/v1/companies/${ref}`, headers: auth,
      payload: { active: false } })
    expect(r.statusCode, r.body).toBe(200)
    expect(JSON.parse(r.body).active).toBe(false)

    // Eine stillgelegte Firma faellt aus der Suche, bleibt aber lesbar.
    const suche = await app.inject({
      method: 'GET', url: '/v1/companies?q=Nordwind', headers: auth })
    expect(JSON.parse(suche.body).companies).toEqual([])
    const lesen = await app.inject({
      method: 'GET', url: `/v1/companies/${ref}`, headers: auth })
    expect(lesen.statusCode).toBe(200)
  })

  it('haelt Firmen des einen Mandanten vom anderen fern', async () => {
    const ref = await firmaAnlegen()
    const fremd = await makeProperty(owner, { name: 'Fremdhotel', code: 'FREMD' })
    const fremderNutzer = await makeUser(owner,
      { email: 'fremd@test.de', propertyId: fremd.propertyId, roleKey: 'reception' })
    const r = await app.inject({
      method: 'GET', url: `/v1/companies/${ref}`,
      headers: { cookie: `hp_session=${fremderNutzer.sessionId}` } })
    expect(r.statusCode).toBe(404)
  })
})
