import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { registeredRoutes, type RouteSpec } from '../platform/routes.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Daten eines Betriebs, in dem der Aufrufer das Recht **nicht** hat
 * (Sicherheitsaudit 2026-10-19, H1 und M2).
 *
 * Der Fall ist die Aushilfe in zwei Hotels: Direktion bei Kunde A,
 * Reinigungskraft bei Kunde B. Beide Accounts stehen im Kontext, und die
 * Zeilenrichtlinie auf `guest`, `company`, `webhook_subscription` und
 * `oauth_client` filtert nur nach Account. Eine Route ohne `propertyParam`
 * prueft das Recht in `registerRoute` nur "irgendwo" -- also bei A --, und
 * fand den Datensatz von B dann ueber die Richtlinie. So liessen sich Gaeste
 * von B lesen, umschreiben und anonymisieren.
 *
 * Der Test laeuft ueber die Routenliste: jede Route ohne `propertyParam`, die
 * einen Datensatz einer solchen Tabelle ueber seine Referenz im Pfad laedt,
 * muss fuer B 403 oder 404 antworten. **Wer eine weitere account-gebundene
 * Tabelle per Referenz ueber eine Route ohne Haus erreichbar macht, traegt
 * den Pfadparameter in `KONTOGEBUNDEN` ein.** Listen und Suchen stehen als
 * Tabelle in `LISTEN`, weil sie keine Referenz tragen.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let a: Fixture
let b: Fixture
/** Direktion bei A, Reinigung bei B. */
let x: Record<string, string>
/** Inhaber von B -- die Gegenprobe, dass die Routen B ueberhaupt erreichen. */
let y: Record<string, string>
let refs: Record<string, string>
let gastB: number
let firmaB: number

/** Pfadparameter, die einen Datensatz einer nur nach Account gefilterten Tabelle nennen. */
const KONTOGEBUNDEN = ['guestRef', 'companyRef', 'subscriptionRef', 'clientRef'] as const

/** Listen und Suchen ohne Referenz: was dort von B auftaucht, ist durchgesickert. */
const LISTEN: Array<{ url: string; feld: string }> = [
  { url: '/v1/guests?q=Fremdmann', feld: 'guestRef' },
  { url: '/v1/companies?q=Fremd%20B', feld: 'companyRef' },
  { url: '/v1/webhook-subscriptions', feld: 'subscriptionRef' },
  { url: '/v1/oauth-clients', feld: 'clientRef' }
]

const ANGREIFER = 'angreifer@evil.example'

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
  a = await makeProperty(owner, { code: 'A', name: 'Haus A' })
  b = await makeProperty(owner, { code: 'B', name: 'Haus B' })

  const ux = await makeUser(owner,
    { email: 'aushilfe@test.de', propertyId: a.propertyId, roleKey: 'hotel_director' })
  await owner.query(
    `INSERT INTO user_property_role (user_id, property_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'housekeeping_staff' AND account_id IS NULL`,
    [ux.userId, b.propertyId])
  x = { cookie: `hp_session=${ux.sessionId}` }
  const uy = await makeUser(owner,
    { email: 'inhaber-b@test.de', accountId: b.accountId, roleKey: 'owner' })
  y = { cookie: `hp_session=${uy.sessionId}` }

  const g = await makeGuest(owner, b.accountId, { lastName: 'Fremdmann' })
  gastB = g.id
  await owner.query(`UPDATE guest SET email = 'gast@fremd-b.de' WHERE id = $1`, [g.id])
  const c = await owner.query<{ id: number; public_ref: string }>(
    `INSERT INTO company (account_id, name, vat_id, invoice_email)
     VALUES ($1, 'Fremd B GmbH', 'DE123456789', 'buchhaltung@fremd-b.de')
     RETURNING id, public_ref`, [b.accountId])
  firmaB = c.rows[0]!.id
  const s = await owner.query<{ public_ref: string }>(
    `INSERT INTO webhook_subscription (account_id, url, signing_secret, event_types)
     VALUES ($1, 'https://hooks.fremd-b.de/x', 'geheim', '{reservation.created}')
     RETURNING public_ref`, [b.accountId])
  const o = await owner.query<{ public_ref: string }>(
    `INSERT INTO oauth_client (account_id, name, secret_hash, scopes)
     VALUES ($1, 'Kasse B', 'x', '{reservation:read}') RETURNING public_ref`, [b.accountId])
  refs = {
    guestRef: g.publicRef, companyRef: c.rows[0]!.public_ref,
    subscriptionRef: s.rows[0]!.public_ref, clientRef: o.rows[0]!.public_ref
  }
})

function kontogebundeneRouten(): RouteSpec[] {
  return registeredRoutes().filter(r =>
    r.permission !== null && r.propertyParam === undefined
    && KONTOGEBUNDEN.some(p => r.url.includes(`:${p}`)))
}

function url(r: RouteSpec): string {
  return r.url.replace(/:(\w+)/g, (_, name: string) => refs[name] ?? '1')
}

/** Was ein Angreifer schicken wuerde: die eigene Adresse an Gast und Firma. */
function rumpf(r: RouteSpec): Record<string, unknown> | undefined {
  if (r.method === 'GET' || r.method === 'DELETE') return undefined
  return { email: ANGREIFER, invoiceEmail: ANGREIFER }
}

describe('Routen ohne Haus auf account-gebundene Datensaetze', () => {
  it('findet die Routen, die der Befund nennt', () => {
    const urls = kontogebundeneRouten().map(r => `${r.method} ${r.url}`)
    // Gegen einen Filter, der still nichts mehr findet.
    for (const erwartet of [
      'GET /v1/guests/:guestRef', 'PATCH /v1/guests/:guestRef',
      'GET /v1/guests/:guestRef/id-document', 'GET /v1/guests/:guestRef/data-export',
      'POST /v1/guests/:guestRef/anonymize',
      'GET /v1/companies/:companyRef', 'PATCH /v1/companies/:companyRef'
    ]) expect(urls).toContain(erwartet)
  })

  it('geben einem Benutzer, der in B nur putzt, nichts von B', async () => {
    for (const r of kontogebundeneRouten()) {
      const body = rumpf(r)
      const antwort = await app.inject({ method: r.method, url: url(r), headers: x,
        ...(body ? { payload: body } : {}) })
      expect([403, 404], `${r.method} ${r.url} erreichte B: ${antwort.body}`)
        .toContain(antwort.statusCode)
    }
    const gast = await owner.query<{ email: string; status: string; last_name: string }>(
      `SELECT email, status, last_name FROM guest WHERE id = $1`, [gastB])
    expect(gast.rows[0]).toEqual(
      { email: 'gast@fremd-b.de', status: 'active', last_name: 'Fremdmann' })
    const firma = await owner.query<{ invoice_email: string }>(
      `SELECT invoice_email FROM company WHERE id = $1`, [firmaB])
    expect(firma.rows[0]!.invoice_email).toBe('buchhaltung@fremd-b.de')
  })

  it('erreichen B fuer jemanden, der dort das Recht hat (Gegenprobe)', async () => {
    // Loeschendes zuletzt, damit die Routen danach noch etwas finden.
    const routen = [...kontogebundeneRouten()]
      .sort((p, q) => Number(p.method === 'DELETE') - Number(q.method === 'DELETE'))
    for (const r of routen) {
      const antwort = await app.inject({ method: r.method, url: url(r), headers: y,
        ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }) })
      expect([403, 404], `${r.method} ${r.url} fand B auch mit Recht nicht`)
        .not.toContain(antwort.statusCode)
    }
  })

  it('Listen und Suchen zeigen B nur dem, der dort das Recht hat', async () => {
    for (const l of LISTEN) {
      const fremd = await app.inject({ method: 'GET', url: l.url, headers: x })
      expect(fremd.statusCode, l.url).toBe(200)
      expect(fremd.body, `${l.url} zeigt B`).not.toContain(refs[l.feld]!)
      const eigen = await app.inject({ method: 'GET', url: l.url, headers: y })
      expect(eigen.statusCode, l.url).toBe(200)
      expect(eigen.body, `${l.url} zeigt B nicht einmal B`).toContain(refs[l.feld]!)
    }
  })

  it('haengt keine Hausnotiz von A an einen Gast von B', async () => {
    const r = await app.inject({ method: 'POST', url: `/v1/guests/${refs.guestRef}/notes`,
      headers: x, payload: { propertyId: a.propertyId, note: 'ebenerdig' } })
    expect(r.statusCode).toBe(404)
    const n = await owner.query(`SELECT 1 FROM guest_property_note WHERE guest_id = $1`,
      [gastB])
    expect(n.rowCount).toBe(0)
  })
})

describe('Rechnungsempfaenger aus einem anderen Betrieb (M2)', () => {
  async function folioInA(): Promise<{ id: number; ref: string }> {
    const cat = await makeCategory(owner, a.propertyId)
    const res = await makeReservation(owner, {
      propertyId: a.propertyId, categoryId: cat,
      arrival: '2027-08-01', departure: '2027-08-03', reserveInventory: false })
    const f = await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM folio WHERE id = $1`, [res.folioId])
    return { id: res.folioId, ref: f.rows[0]!.public_ref }
  }

  it('nimmt weder Gast noch Firma von B an', async () => {
    const folio = await folioInA()
    for (const payload of [{ guestRef: refs.guestRef }, { companyRef: refs.companyRef }]) {
      const r = await app.inject({ method: 'PATCH', url: `/v1/folios/${folio.ref}/recipient`,
        headers: x, payload })
      expect(r.statusCode, JSON.stringify(payload)).toBe(404)
    }
    const f = await owner.query<{ guest_id: number | null; company_id: number | null }>(
      `SELECT guest_id, company_id FROM folio WHERE id = $1`, [folio.id])
    expect(f.rows[0]).toEqual({ guest_id: null, company_id: null })
  })

  it('nimmt Gast und Firma aus A weiterhin an', async () => {
    const folio = await folioInA()
    const g = await makeGuest(owner, a.accountId, { lastName: 'Eigen' })
    const c = await owner.query<{ public_ref: string }>(
      `INSERT INTO company (account_id, name) VALUES ($1, 'Eigen A GmbH')
       RETURNING public_ref`, [a.accountId])
    const r = await app.inject({ method: 'PATCH', url: `/v1/folios/${folio.ref}/recipient`,
      headers: x, payload: { guestRef: g.publicRef, companyRef: c.rows[0]!.public_ref } })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().recipient.companyRef).toBe(c.rows[0]!.public_ref)
  })
})
