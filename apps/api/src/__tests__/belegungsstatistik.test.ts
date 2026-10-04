import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Die Belegungsstatistik fuer angebundene Systeme (API-Entwurf, Abschnitt
 * 3.4): Personennaechte je Tag und Monat, getrennt nach dem, was ueber die
 * Personen bekannt ist.
 *
 * Gerechnet wird an Zahlen, die ein Mensch nachpruefen kann: drei
 * Reservierungen ueber fuenf Tage, jede mit einer anderen Art von
 * Personenangabe.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let auth: Record<string, string>
let directorId: number

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
  limiters.reset()
  fx = await makeProperty(owner)
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  await makeResources(owner, fx.propertyId, catId, 6)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-01-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner, { email: 'chef@test.de', propertyId: fx.propertyId,
                                    roleKey: 'hotel_director', accountId: fx.accountId })
  directorId = u.userId
  auth = { cookie: `hp_session=${u.sessionId}` }
})

let schluessel = 0
const buchen = async (arrival: string, departure: string,
                      extra: Record<string, unknown> = {}): Promise<string> => {
  const r = await app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...auth, 'idempotency-key': `b-${++schluessel}` },
    payload: { propertyId: fx.propertyId, categoryId: catId, arrival, departure, ...extra } })
  expect(r.statusCode, r.body).toBe(201)
  return (JSON.parse(r.body) as { reservationRef: string }).reservationRef
}

interface Zeitraum {
  period: string; reservations: number; roomNights: number; personNights: number
  adultNights: number; childNights: number; unsplitPersonNights: number
  assumedPersonNights: number
}
interface Statistik {
  from: string; to: string; granularity: string
  periods: Zeitraum[]; totals: Omit<Zeitraum, 'period' | 'reservations'>
}

const abrufen = (query: string, headers = auth) => app.inject({ method: 'GET',
  url: `/v1/properties/${fx.propertyId}/stats/occupancy${query}`, headers })
const statistik = async (query: string, headers = auth): Promise<Statistik> => {
  const r = await abrufen(query, headers)
  expect(r.statusCode, r.body).toBe(200)
  return JSON.parse(r.body) as Statistik
}

const leer = { reservations: 0, roomNights: 0, personNights: 0, adultNights: 0,
               childNights: 0, unsplitPersonNights: 0, assumedPersonNights: 0 }

describe('je Tag', () => {
  it('zaehlt Personennaechte getrennt nach Aufteilung, Gesamtzahl und Annahme', async () => {
    // A: 2 Erwachsene, 1 Kind, drei Naechte
    await buchen('2026-10-01', '2026-10-04', { adults: 2, children: 1 })
    // B: nur die Gesamtzahl, eine Nacht
    await buchen('2026-10-02', '2026-10-03', { guestCount: 2 })
    // C: keine Personenzahl -- es zaehlt die Hoechstbelegung der Kategorie (2)
    await buchen('2026-10-03', '2026-10-05')
    // D: storniert, zaehlt nicht; E: No-Show, zaehlt nicht; F: Anfrage, zaehlt nicht
    for (const status of ['Canceled', 'NoShow', 'Inquired']) {
      const ref = await buchen('2026-10-01', '2026-10-05', { adults: 4 })
      await owner.query(`UPDATE reservation SET status = $2 WHERE public_ref = $1`,
        [ref, status])
    }

    const s = await statistik('?from=2026-09-30&to=2026-10-05&granularity=day')
    expect(s.granularity).toBe('day')
    expect(s.periods).toEqual([
      { period: '2026-09-30', ...leer },
      { period: '2026-10-01', ...leer, reservations: 1, roomNights: 1, personNights: 3,
        adultNights: 2, childNights: 1 },
      { period: '2026-10-02', ...leer, reservations: 2, roomNights: 2, personNights: 5,
        adultNights: 2, childNights: 1, unsplitPersonNights: 2 },
      { period: '2026-10-03', ...leer, reservations: 2, roomNights: 2, personNights: 5,
        adultNights: 2, childNights: 1, assumedPersonNights: 2 },
      { period: '2026-10-04', ...leer, reservations: 1, roomNights: 1, personNights: 2,
        assumedPersonNights: 2 },
      // Abreisetag: keine Nacht mehr, die Zeile steht trotzdem da
      { period: '2026-10-05', ...leer }
    ])
    expect(s.totals).toEqual({ roomNights: 6, personNights: 15, adultNights: 6,
      childNights: 3, unsplitPersonNights: 2, assumedPersonNights: 4 })
  })

  it('zaehlt Erwachsene ohne Kinderangabe als Erwachsene allein', async () => {
    await buchen('2026-10-01', '2026-10-02', { adults: 3 })
    const s = await statistik('?from=2026-10-01&to=2026-10-01')
    expect(s.periods).toEqual([{ period: '2026-10-01', ...leer, reservations: 1,
      roomNights: 1, personNights: 3, adultNights: 3 }])
  })
})

describe('je Monat', () => {
  it('teilt einen Aufenthalt ueber den Monatswechsel nach seinen Naechten', async () => {
    await buchen('2026-10-30', '2026-11-02', { adults: 2 })
    await buchen('2026-11-10', '2026-11-12', { adults: 1, children: 1 })

    const s = await statistik('?from=2026-09-01&to=2026-12-31&granularity=month')
    expect(s.periods).toEqual([
      { period: '2026-09', ...leer },
      { period: '2026-10', ...leer, reservations: 1, roomNights: 2, personNights: 4,
        adultNights: 4 },
      { period: '2026-11', ...leer, reservations: 2, roomNights: 3, personNights: 6,
        adultNights: 4, childNights: 2 },
      { period: '2026-12', ...leer }
    ])
  })

  it('zaehlt in angeschnittenen Monaten nur die Naechte im Zeitraum', async () => {
    await buchen('2026-10-30', '2026-11-02', { adults: 2 })
    const s = await statistik('?from=2026-10-31&to=2026-11-30&granularity=month')
    expect(s.periods.map(p => [p.period, p.roomNights])).toEqual(
      [['2026-10', 1], ['2026-11', 1]])
  })
})

describe('Grenzen', () => {
  it('weist zu lange Zeitraeume und unbekannte Werte ab', async () => {
    const fall = async (query: string, status: number, type?: string) => {
      const r = await abrufen(query)
      expect(r.statusCode, `${query}: ${r.body}`).toBe(status)
      if (type !== undefined) expect(r.json<{ type: string }>().type).toBe(type)
    }
    await fall('?from=2025-01-01&to=2026-01-01', 200)
    await fall('?from=2025-01-01&to=2026-01-02', 422, 'urn:staygrid:range_too_large')
    await fall('?from=2022-01-01&to=2026-12-31&granularity=month', 200)
    await fall('?from=2022-01-01&to=2027-01-01&granularity=month',
      422, 'urn:staygrid:range_too_large')
    await fall('?from=2026-10-01&to=2026-10-02&granularity=week', 422, 'urn:staygrid:validation')
    await fall('?from=2026-10-02&to=2026-10-01', 422, 'urn:staygrid:validation')
    await fall('?from=2026-10-01', 422, 'urn:staygrid:validation')
  })
})

describe('Maschinenzugang', () => {
  async function maschine(scopes: string[]): Promise<Record<string, string>> {
    await owner.query(
      `INSERT INTO user_account_role (user_id, account_id, role_id)
       SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
       ON CONFLICT DO NOTHING`, [directorId, fx.accountId])
    const z = await app.inject({
      method: 'POST', url: '/v1/oauth-clients', headers: auth,
      payload: { name: 'Adminpanel', scopes, propertyIds: [fx.propertyId] } })
    expect(z.statusCode, z.body).toBe(201)
    const { clientId, clientSecret } = z.json<{ clientId: string; clientSecret: string }>()
    const t = await app.inject({
      method: 'POST', url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'client_credentials',
                                     client_id: clientId, client_secret: clientSecret })
        .toString() })
    expect(t.statusCode, t.body).toBe(200)
    return { authorization: `Bearer ${t.json<{ access_token: string }>().access_token}` }
  }

  it('liest mit report:operational und nicht ohne', async () => {
    await buchen('2026-10-01', '2026-10-02', { adults: 2 })
    const mit = await maschine(['report:operational'])
    const s = await statistik('?from=2026-10-01&to=2026-10-01', mit)
    expect(s.totals.personNights).toBe(2)

    const ohne = await maschine(['reservation:read'])
    expect((await abrufen('?from=2026-10-01&to=2026-10-01', ohne)).statusCode).toBe(403)
  })
})

describe('Fruehstueck', () => {
  interface Tag { date: string; breakfasts: number; adults: number; children: number
                  unsplit: number; assumed: number }
  const fruehstueck = async (query: string, headers = auth) => {
    const r = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/breakfast${query}`, headers })
    expect(r.statusCode, r.body).toBe(200)
    return r.json<{ from: string; to: string; days: Tag[]; totals: Omit<Tag, 'date'> }>()
  }
  const nichts = { breakfasts: 0, adults: 0, children: 0, unsplit: 0, assumed: 0 }

  it('keins am Anreisetag, eins am Abreisetag, Kinder voll und getrennt', async () => {
    // A: 2 Erwachsene, 1 Kind, Naechte 1.-3.10., Fruehstueck 2.-4.10.
    await buchen('2026-10-01', '2026-10-04', { adults: 2, children: 1 })
    // B: nur Gesamtzahl, Nacht 2.10., Fruehstueck 3.10.
    await buchen('2026-10-02', '2026-10-03', { guestCount: 2 })
    // C: storniert, zaehlt nicht
    const ref = await buchen('2026-10-01', '2026-10-03', { adults: 4 })
    await owner.query(`UPDATE reservation SET status = 'Canceled' WHERE public_ref = $1`, [ref])

    const f = await fruehstueck('?from=2026-10-01&to=2026-10-05')
    expect(f.days).toEqual([
      { date: '2026-10-01', ...nichts },
      { date: '2026-10-02', ...nichts, breakfasts: 3, adults: 2, children: 1 },
      { date: '2026-10-03', ...nichts, breakfasts: 5, adults: 2, children: 1, unsplit: 2 },
      { date: '2026-10-04', ...nichts, breakfasts: 3, adults: 2, children: 1 },
      { date: '2026-10-05', ...nichts }
    ])
    expect(f.totals).toEqual({ breakfasts: 11, adults: 6, children: 3, unsplit: 2,
                               assumed: 0 })
  })

  it('weist zu lange Zeitraeume ab und verlangt report:operational', async () => {
    const r = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/breakfast?from=2025-01-01&to=2026-01-02`,
      headers: auth })
    expect(r.statusCode).toBe(422)
    expect(r.json<{ type: string }>().type).toBe('urn:staygrid:range_too_large')
    const ok = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/breakfast?from=2025-01-01&to=2026-01-01`,
      headers: auth })
    expect(ok.statusCode, ok.body).toBe(200)
  })
})
