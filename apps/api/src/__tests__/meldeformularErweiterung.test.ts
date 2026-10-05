import { Writable } from 'node:stream'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import { withTransaction, type Pool } from '@hotelpms/db'
import { CHECKIN_TOKEN_HEADER, checkinTokenAusFragment } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Meldeformular mit Hausbedingungen und Kurtaxe-Befreiung (Migration 0089,
 * Anforderung Sven 05.10.2026).
 *
 * Gegen die echte Datenbank: die Zustimmung laeuft ueber
 * `stimmeBedingungZu` mit den Rechten der Gastseite, die Befreiung steht am
 * Meldeschein und muss mit ihm geloescht und aus dem Protokoll gehalten
 * werden.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let zeilen: string[]
let fx: Fixture
let catId: number
let chef: Record<string, string>

const ANREISE = '2026-10-03'
const ABREISE = '2026-10-06'
const HEUTE = '2026-10-01'

/** Genau die Form, die das Zeichenfeld der Oberflaeche erzeugt. */
const UNTERSCHRIFT = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120">'
  + '<image href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" width="360" '
  + 'height="120"/></svg>'

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const senke = new Writable({
    write(chunk: Buffer, _enc, cb) { zeilen.push(chunk.toString('utf8')); cb() }
  })
  const built = await buildServer({ pool: appPool(10), logStream: senke })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

beforeEach(async () => {
  await truncateAll()
  limiters.reset()
  zeilen = []
  fx = await makeProperty(owner)
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  await makeResources(owner, fx.propertyId, catId, 4)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, HEUTE)
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  chef = { cookie: `hp_session=${u.sessionId}` }
})

let nummer = 0

/** Eine bestaetigte Reservierung mit Hauptgast. */
async function reservierung(opts: {
  propertyId?: number; nachname?: string; email?: string | null
  status?: 'Confirmed' | 'Optional'; anreise?: string; abreise?: string
} = {}): Promise<{ id: number; ref: string; guestId: number; guestRef: string }> {
  const propertyId = opts.propertyId ?? fx.propertyId
  const kategorie = propertyId === fx.propertyId ? catId
    : (await owner.query<{ id: number }>(
        `SELECT id FROM resource_category WHERE property_id = $1 LIMIT 1`, [propertyId]))
        .rows[0]!.id
  const konto = (await owner.query<{ account_id: number }>(
    `SELECT account_id FROM property WHERE id = $1`, [propertyId])).rows[0]!.account_id
  const g = await owner.query<{ id: number; public_ref: string }>(
    `INSERT INTO guest (account_id, last_name, first_name, email, language)
     VALUES ($1,$2,'Anna',$3,'de') RETURNING id, public_ref`,
    [konto, opts.nachname ?? `Petersen${++nummer}`,
     opts.email === undefined ? `gast${nummer}@example.test` : opts.email])
  const r = await makeReservation(owner, {
    propertyId, categoryId: kategorie,
    arrival: opts.anreise ?? ANREISE, departure: opts.abreise ?? ABREISE,
    status: opts.status ?? 'Confirmed', reserveInventory: false,
    optionExpiresAt: opts.status === 'Optional' ? '2026-10-02T12:00:00Z' : null })
  await owner.query(
    `UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
    [r.reservationId, g.rows[0]!.id])
  await owner.query(
    `INSERT INTO reservation_occupant (property_id, reservation_id, guest_id, is_primary)
     VALUES ($1,$2,$3,true)`, [propertyId, r.reservationId, g.rows[0]!.id])
  const ref = (await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [r.reservationId])).rows[0]!.public_ref
  return { id: r.reservationId, ref, guestId: g.rows[0]!.id, guestRef: g.rows[0]!.public_ref }
}

/** Der Link, wie die Rezeption ihn kopiert. Zurueck kommt das Token. */
async function mailLink(ref: string): Promise<string> {
  const r = await app.inject({ method: 'POST',
    url: `/v1/reservations/${ref}/online-checkin/link`, headers: chef })
  expect(r.statusCode, r.body).toBe(201)
  const link = (JSON.parse(r.body) as { link: string }).link
  const token = checkinTokenAusFragment(link.slice(link.indexOf('#')))
  expect(token).not.toBeNull()
  return token!
}

const formular = (token: string) =>
  app.inject({ method: 'GET', url: '/v1/checkin/form',
               headers: { [CHECKIN_TOKEN_HEADER]: token } })

const einreichen = (token: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/checkin/form',
               headers: { [CHECKIN_TOKEN_HEADER]: token }, payload })

function inlaendisch(gast: Record<string, unknown> = {},
                     wurzel: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guest: { lastName: 'Petersen', firstName: 'Anna', birthDate: '1980-05-17',
             nationality: 'DE',
             address: { line1: 'Deichweg 4', postalCode: '24937', city: 'Flensburg',
                        country: 'DE' }, ...gast },
    confirmed: true,
    ...wurzel
  }
}

async function grund(code: string, opts: { proof?: boolean; active?: boolean } = {}
): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `INSERT INTO city_tax_exemption_reason (property_id, code, label, needs_proof, active)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [fx.propertyId, code, `Grund ${code}`, opts.proof ?? false, opts.active ?? true])
  return Number(r.rows[0]!.id)
}

async function bedingung(code: string, signatur: boolean): Promise<string> {
  const r = await owner.query<{ public_ref: string }>(
    `INSERT INTO property_terms (property_id, code, title, body, requires_signature,
                                 active_from)
     VALUES ($1,$2,'Schluesselkarte','50 EUR bei Verlust',$3,'2026-01-01')
     RETURNING public_ref`, [fx.propertyId, code, signatur])
  return r.rows[0]!.public_ref
}

async function scheine(reservationId: number): Promise<Array<{
  last_name: string; reason: string | null; proof: string | null }>> {
  const r = await owner.query(
    `SELECT g.last_name, x.code AS reason, reg.tax_exemption_proof AS proof
       FROM registration reg
       JOIN guest g ON g.id = reg.guest_id
       LEFT JOIN city_tax_exemption_reason x ON x.id = reg.tax_exemption_reason_id
      WHERE reg.reservation_id = $1 ORDER BY reg.id`, [reservationId])
  return r.rows
}

// ---------------------------------------------------------------------------

describe('Die Gastseite zeigt', () => {
  it('offene Hausbedingungen vollstaendig und die angebotenen Befreiungsgruende', async () => {
    const ref = await bedingung('karte', true)
    await grund('behinderung', { proof: true })
    await grund('alt', { active: false })
    const r = await reservierung()
    const v = JSON.parse((await formular(await mailLink(r.ref))).body) as {
      terms: Array<{ termsRef: string; body: string; requiresSignature: boolean }>
      exemptionReasons: Array<{ code: string; needsProof: boolean }> }
    expect(v.terms).toEqual([{ termsRef: ref, title: 'Schluesselkarte',
                               body: '50 EUR bei Verlust', requiresSignature: true }])
    // Abgeschaltet heisst: nicht mehr angeboten.
    expect(v.exemptionReasons).toEqual([
      { code: 'behinderung', label: 'Grund behinderung', needsProof: true }])
  })

  it('eine schon zugestimmte Bedingung nicht noch einmal', async () => {
    const ref = await bedingung('karte', false)
    const r = await reservierung()
    await owner.query(
      `INSERT INTO guest_agreement (property_id, reservation_id, terms_id)
       SELECT $1, $2, id FROM property_terms WHERE public_ref = $3`,
      [fx.propertyId, r.id, ref])
    const v = JSON.parse((await formular(await mailLink(r.ref))).body) as { terms: unknown[] }
    expect(v.terms).toEqual([])
  })
})

describe('Hausbedingungen im Meldeformular', () => {
  it('verlangen Zustimmung, sonst entsteht nichts', async () => {
    await bedingung('karte', false)
    const r = await reservierung()
    const res = await einreichen(await mailLink(r.ref), inlaendisch())
    expect(res.statusCode, res.body).toBe(422)
    expect(res.body).toContain('termsAccepted')
    expect(await scheine(r.id)).toEqual([])
  })

  it('verlangen die Unterschrift, wo die Fassung sie verlangt', async () => {
    const ref = await bedingung('karte', true)
    const r = await reservierung()
    const res = await einreichen(await mailLink(r.ref),
      inlaendisch({}, { termsAccepted: [ref] }))
    expect(res.statusCode, res.body).toBe(422)
    expect(res.body).toContain('termsSignatureSvg')
  })

  it('nehmen die Unterschrift von zu Hause an, auch vom inlaendischen Gast', async () => {
    const ref = await bedingung('karte', true)
    const r = await reservierung()
    const res = await einreichen(await mailLink(r.ref),
      inlaendisch({}, { termsAccepted: [ref], termsSignatureSvg: UNTERSCHRIFT }))
    expect(res.statusCode, res.body).toBe(201)

    const a = await owner.query<{ signature_svg: string | null; guest_id: number
                                  created_by: number | null }>(
      `SELECT signature_svg, guest_id, created_by FROM guest_agreement WHERE reservation_id = $1`,
      [r.id])
    expect(a.rows).toHaveLength(1)
    expect(a.rows[0]!.signature_svg).toBe(UNTERSCHRIFT)
    expect(Number(a.rows[0]!.guest_id)).toBe(Number(r.guestId))
    expect(a.rows[0]!.created_by).toBeNull()
    // Der Meldeschein des inlaendischen Gastes bleibt ohne Unterschrift.
    const reg = await owner.query<{ signature_svg: string | null }>(
      `SELECT signature_svg FROM registration WHERE reservation_id = $1`, [r.id])
    expect(reg.rows[0]!.signature_svg).toBeNull()
  })

  it('verwerfen eine Unterschrift, die die Fassung nicht verlangt', async () => {
    const ref = await bedingung('ordnung', false)
    const r = await reservierung()
    const res = await einreichen(await mailLink(r.ref),
      inlaendisch({}, { termsAccepted: [ref], termsSignatureSvg: UNTERSCHRIFT }))
    expect(res.statusCode, res.body).toBe(201)
    const a = await owner.query(
      `SELECT signature_svg FROM guest_agreement WHERE reservation_id = $1`, [r.id])
    expect(a.rows[0]!.signature_svg).toBeNull()
  })

  it('weisen ein beliebiges SVG als Unterschrift ab', async () => {
    const ref = await bedingung('karte', true)
    const r = await reservierung()
    const res = await einreichen(await mailLink(r.ref), inlaendisch({},
      { termsAccepted: [ref], termsSignatureSvg: '<svg><script>alert(1)</script></svg>' }))
    expect(res.statusCode, res.body).toBe(422)
  })
})

describe('Kurtaxe-Befreiung im Meldeformular', () => {
  it('steht je Person am Meldeschein, die Nummer nur, wo der Grund sie verlangt', async () => {
    await grund('behinderung', { proof: true })
    await grund('beruflich')
    const r = await reservierung()
    const res = await einreichen(await mailLink(r.ref), inlaendisch(
      { taxExemption: { reason: 'beruflich', proof: 'soll weg' } },
      { companions: [
          { lastName: 'Petersen', firstName: 'Ole', birthDate: '1978-01-02',
            nationality: 'DE', taxExemption: { reason: 'behinderung', proof: 'SB-123' } },
          { lastName: 'Petersen', firstName: 'Lena', birthDate: '2010-03-04',
            nationality: 'DE' }] }))
    expect(res.statusCode, res.body).toBe(201)
    expect(await scheine(r.id)).toEqual([
      { last_name: 'Petersen', reason: 'beruflich', proof: null },
      { last_name: 'Petersen', reason: 'behinderung', proof: 'SB-123' },
      { last_name: 'Petersen', reason: null, proof: null }])
  })

  it('weist einen Grund ab, den das Haus nicht oder nicht mehr anbietet', async () => {
    await grund('alt', { active: false })
    const r = await reservierung()
    const res = await einreichen(await mailLink(r.ref),
      inlaendisch({ taxExemption: { reason: 'alt' } }))
    expect(res.statusCode, res.body).toBe(422)
    expect(res.body).toContain('guest.taxExemption.reason')
    expect(await scheine(r.id)).toEqual([])
  })

  it('schreibt Grund und Nummer nicht ins Protokoll und geht mit der Loeschung', async () => {
    await grund('behinderung', { proof: true })
    const r = await reservierung()
    const res = await einreichen(await mailLink(r.ref),
      inlaendisch({ taxExemption: { reason: 'behinderung', proof: 'SB-98765' } }))
    expect(res.statusCode, res.body).toBe(201)

    const prot = await owner.query<{ changed: string }>(
      `SELECT changed::text FROM audit_log WHERE table_name = 'registration'`)
    expect(prot.rows.length).toBeGreaterThan(0)
    for (const p of prot.rows) expect(p.changed).not.toContain('SB-98765')

    await withTransaction(pool,
      { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null },
      c => c.query(`SELECT guest_erase_one($1)`, [r.guestId]))
    expect(await scheine(r.id)).toEqual([])
  })
})

describe('Digitale Gaestekarte im Meldeformular (0091)', () => {
  const karte = async (reservationId: number): Promise<boolean> =>
    (await owner.query<{ digital_guest_card: boolean }>(
      `SELECT digital_guest_card FROM registration
        WHERE reservation_id = $1 AND group_registration_id IS NULL`, [reservationId]))
      .rows[0]!.digital_guest_card

  it('wird nur angeboten und gespeichert, wenn das Haus an AVS meldet', async () => {
    const ohne = await reservierung()
    const t1 = await mailLink(ohne.ref)
    expect(JSON.parse((await formular(t1)).body).digitalGuestCardOffered).toBe(false)
    expect((await einreichen(t1, inlaendisch({}, { digitalGuestCard: true }))).statusCode)
      .toBe(201)
    expect(await karte(ohne.id)).toBe(false)

    await owner.query(`INSERT INTO avs_setting (property_id, hotel_id) VALUES ($1,'4711')`,
      [fx.propertyId])
    const mit = await reservierung()
    const t2 = await mailLink(mit.ref)
    expect(JSON.parse((await formular(t2)).body).digitalGuestCardOffered).toBe(true)
    expect((await einreichen(t2, inlaendisch({}, { digitalGuestCard: true }))).statusCode)
      .toBe(201)
    expect(await karte(mit.id)).toBe(true)
  })
})

describe('Befreiungsgruende in den Einstellungen', () => {
  it('lassen sich anlegen, nicht doppelt, und abschalten statt loeschen', async () => {
    const url = `/v1/properties/${fx.propertyId}/city-tax-exemptions`
    const neu = await app.inject({ method: 'POST', url, headers: chef,
      payload: { code: 'jahreskurkarte', label: 'Jahreskurkarte', needsProof: true,
                 avsCategory: 7 } })
    expect(neu.statusCode, neu.body).toBe(201)
    const ref = (JSON.parse(neu.body) as { reasonRef: string }).reasonRef

    const doppelt = await app.inject({ method: 'POST', url, headers: chef,
      payload: { code: 'jahreskurkarte', label: 'Nochmal' } })
    expect(doppelt.statusCode).toBe(409)

    const falsch = await app.inject({ method: 'POST', url, headers: chef,
      payload: { code: 'Mit Leerzeichen', label: 'x', avsCategory: 500 } })
    expect(falsch.statusCode).toBe(422)

    const aus = await app.inject({ method: 'PATCH', url: `${url}/${ref}`, headers: chef,
      payload: { active: false } })
    expect(aus.statusCode, aus.body).toBe(200)
    const liste = JSON.parse((await app.inject({ method: 'GET', url, headers: chef })).body) as
      { reasons: Array<{ code: string; active: boolean; avsCategory: number | null }> }
    expect(liste.reasons).toEqual([expect.objectContaining(
      { code: 'jahreskurkarte', active: false, avsCategory: 7 })])
  })
})
