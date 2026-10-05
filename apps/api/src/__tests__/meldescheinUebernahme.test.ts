import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, makeGuest, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { istUnterschriftSvg } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { unterschriftAusPng } from '../routes/registrationImport.js'

/**
 * Fertige Meldescheine aus einem Umsystem (Migration 0087).
 *
 * Geprueft wird, dass die Uebernahme denselben Regeln folgt wie der
 * Online-Check-in -- keine Unterschrift ohne Rechtsgrund, kein SVG aus
 * fremder Hand, nie ein zweiter Schein -- und dass sie nichts anlegt, was
 * die Frist schon zu vernichten verlangt.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let katId: number
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })

/** Kopf eines PNG mit IHDR, 600 x 200. Fuer die Erkennung genuegt das. */
function png(breite = 600, hoehe = 200): string {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(breite, 16)
  b.writeUInt32BE(hoehe, 20)
  return `data:image/png;base64,${b.toString('base64')}`
}

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
  katId = await makeCategory(owner, fx.propertyId)
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [admin.userId, fx.accountId])
})

async function maschine(scopes: string[]): Promise<Record<string, string>> {
  const z = await app.inject({
    method: 'POST', url: '/v1/oauth-clients', headers: auth(admin.sessionId),
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

async function reservierung(arrival = '2026-10-10', departure = '2026-10-12') {
  const gast = await makeGuest(owner, fx.accountId, { lastName: 'Petersen' })
  const r = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: katId,
    arrival, departure, reserveInventory: false, withFolio: false })
  const ref = await owner.query<{ public_ref: string }>(
    `UPDATE reservation SET primary_guest_id = $2 WHERE id = $1 RETURNING public_ref`,
    [r.reservationId, gast.id])
  return { ...r, gastId: gast.id, ref: ref.rows[0]!.public_ref }
}

const schein = (gast: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) => ({
  source: { system: 'adminpanel', reference: 'GR-17' },
  completedAt: '2026-10-01T08:15:00Z',
  guest: { lastName: 'Petersen', firstName: 'Anna', birthDate: '1980-05-17',
           nationality: 'DE',
           address: { line1: 'Deichweg 4', postalCode: '24937', city: 'Flensburg' },
           ...gast },
  ...rest
})

const senden = (h: Record<string, string>, ref: string, payload: unknown) =>
  app.inject({ method: 'PUT', url: `/v1/reservations/${ref}/registration`,
               headers: h, payload: payload as Record<string, unknown> })

describe('Meldeschein uebernehmen', () => {
  it('legt Schein, Profil und Mitreisende an wie der Online-Check-in', async () => {
    const m = await maschine(['registration:import'])
    const r = await reservierung()
    const a = await senden(m, r.ref, schein({}, {
      companions: [{ lastName: 'Petersen', firstName: 'Ole', birthDate: '2015-03-02',
                     nationality: 'DE' }],
      avsReportedAt: '2026-10-02T06:00:00Z',
      // Ein deutscher Gast unterschreibt nicht (§ 29 Abs. 2 BMG): verworfen.
      signature: { png: png(), signedAt: '2026-10-01T08:15:00Z' } }))
    expect(a.statusCode, a.body).toBe(201)
    expect(a.json()).toMatchObject({ result: 'imported', signatureStored: false,
                                     signaturePending: false })

    const reg = await owner.query(
      `SELECT source, external_system, external_reference, completed_at::text,
              avs_reported_at IS NOT NULL AS avs, signature_svg IS NULL AS ohne_unterschrift,
              group_registration_id IS NULL AS haupt
         FROM registration WHERE reservation_id = $1 ORDER BY id`, [r.reservationId])
    expect(reg.rows).toHaveLength(2)
    expect(reg.rows[0]).toMatchObject({ source: 'import', external_system: 'adminpanel',
      external_reference: 'GR-17', avs: true, ohne_unterschrift: true, haupt: true })
    expect(reg.rows[1]).toMatchObject({ source: 'import', haupt: false })

    const g = await owner.query(
      `SELECT first_name, birth_date::text, nationality, address_line1, city
         FROM guest WHERE id = $1`, [r.gastId])
    expect(g.rows[0]).toEqual({ first_name: 'Anna', birth_date: '1980-05-17',
      nationality: 'DE', address_line1: 'Deichweg 4', city: 'Flensburg' })
    const o = await owner.query(
      `SELECT count(*)::int AS n FROM reservation_occupant WHERE reservation_id = $1`,
      [r.reservationId])
    expect(o.rows[0]!.n).toBeGreaterThanOrEqual(1)

    // Die Liste "Meldescheine": Herkunft, Zeitpunkt, AVS, ohne Unterschriftsbild.
    const l = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/registrations?from=2026-10-01&to=2026-10-31`,
      headers: auth(admin.sessionId) })
    expect(l.statusCode, l.body).toBe(200)
    const liste = l.json<{ registrations: Array<Record<string, unknown>> }>().registrations
    expect(liste).toHaveLength(2)
    expect(liste.find(x => x.groupRegistrationId === null)).toMatchObject({
      source: 'import', externalSystem: 'adminpanel', signatureRequired: false,
      completedAt: '2026-10-01T08:15:00.000Z', avsReportedAt: '2026-10-02T06:00:00.000Z' })
    expect(l.body).not.toContain('signature_svg')
    expect(l.body).not.toContain('<svg')

    // Die Rezeption sieht, wann und woher.
    const d = await app.inject({ method: 'GET', url: `/v1/reservations/${r.ref}`,
                                 headers: auth(admin.sessionId) })
    expect(d.statusCode, d.body).toBe(200)
    expect(d.json<{ onlineCheckin: unknown }>().onlineCheckin).toMatchObject({
      source: 'import', importedFrom: 'adminpanel',
      completedAt: '2026-10-01T08:15:00.000Z' })
  })

  it('speichert die Unterschrift eines auslaendischen Gastes mit ihrem Zeitpunkt', async () => {
    const m = await maschine(['registration:import'])
    const r = await reservierung()
    const a = await senden(m, r.ref, schein({ nationality: 'NL' }, {
      signature: { png: png(), signedAt: '2026-10-01T08:16:00Z' } }))
    expect(a.statusCode, a.body).toBe(201)
    expect(a.json()).toMatchObject({ signatureStored: true, signaturePending: false })
    const reg = await owner.query<{ signature_svg: string; signed_at: Date }>(
      `SELECT signature_svg, signed_at FROM registration WHERE reservation_id = $1`,
      [r.reservationId])
    expect(istUnterschriftSvg(reg.rows[0]!.signature_svg)).toBe(true)
    expect(reg.rows[0]!.signed_at.toISOString()).toBe('2026-10-01T08:16:00.000Z')
  })

  it('laesst die Unterschrift offen, wenn sie dort noch fehlt', async () => {
    const m = await maschine(['registration:import'])
    const r = await reservierung()
    const a = await senden(m, r.ref, schein({ nationality: 'NL' }))
    expect(a.statusCode, a.body).toBe(201)
    expect(a.json()).toMatchObject({ signatureStored: false, signaturePending: true })
  })

  it('nimmt einen Schein ohne brauchbare Staatsangehoerigkeit und ohne Anschrift an', async () => {
    const m = await maschine(['registration:import'])
    const r = await reservierung()
    await owner.query(`UPDATE guest SET nationality = 'DK' WHERE id = $1`, [r.gastId])
    const a = await senden(m, r.ref, schein({ nationality: null, address: null }, {
      companions: [{ lastName: 'Petersen', firstName: 'Ole', birthDate: '2015-03-02',
                     nationality: null }] }))
    expect(a.statusCode, a.body).toBe(201)
    // Was im Profil stand, bleibt; ein unbrauchbarer Wert ueberschreibt nichts.
    const g = await owner.query(`SELECT nationality FROM guest WHERE id = $1`, [r.gastId])
    expect(g.rows[0]!.nationality).toBe('DK')
    const b = await senden(m, (await reservierung()).ref, schein({ nationality: 'XX' }))
    expect(b.statusCode, b.body).toBe(422)
  })

  it('nimmt einen Mitreisenden ohne Geburtsdatum an, aber kein Jahr 0022', async () => {
    const m = await maschine(['registration:import'])
    const r = await reservierung()
    const a = await senden(m, r.ref, schein({}, {
      companions: [{ lastName: 'Petersen', firstName: 'Ole', birthDate: null,
                     nationality: 'DE' }] }))
    expect(a.statusCode, a.body).toBe(201)
    const b = await senden(m, (await reservierung()).ref, schein({}, {
      companions: [{ lastName: 'Petersen', firstName: 'Ole', birthDate: '0022-05-01',
                     nationality: 'DE' }] }))
    expect(b.statusCode, b.body).toBe(422)
    expect(b.body).toContain('companions.0.birthDate')
  })

  it('ueberschreibt nie einen vorhandenen Schein', async () => {
    const m = await maschine(['registration:import'])
    const r = await reservierung()
    expect((await senden(m, r.ref, schein())).statusCode).toBe(201)
    const b = await senden(m, r.ref, schein({ firstName: 'Berta' }))
    expect(b.statusCode, b.body).toBe(200)
    expect(b.json()).toMatchObject({ result: 'kept_existing', reason: 'registration_exists' })
    const g = await owner.query(`SELECT first_name FROM guest WHERE id = $1`, [r.gastId])
    expect(g.rows[0]!.first_name).toBe('Anna')
    const n = await owner.query(
      `SELECT count(*)::int AS n FROM registration WHERE reservation_id = $1`, [r.reservationId])
    expect(n.rows[0]!.n).toBe(1)
  })

  it('legt nichts an, was die Jahresfrist schon zu vernichten verlangt', async () => {
    const m = await maschine(['registration:import'])
    const r = await reservierung('2024-06-01', '2024-06-05')
    const a = await senden(m, r.ref, schein())
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json()).toMatchObject({ result: 'skipped', reason: 'retention_expired' })
    const n = await owner.query(`SELECT count(*)::int AS n FROM registration`)
    expect(n.rows[0]!.n).toBe(0)
    const g = await owner.query(`SELECT birth_date FROM guest WHERE id = $1`, [r.gastId])
    expect(g.rows[0]!.birth_date).toBeNull()
  })

  it('weist unbekannte Felder und ein SVG als Unterschrift ab', async () => {
    const m = await maschine(['registration:import'])
    const r = await reservierung()
    const a = await senden(m, r.ref, schein({}, { ipAddress: '192.0.2.1', pdf: 'x' }))
    expect(a.statusCode, a.body).toBe(422)
    expect(a.body).toContain('ipAddress')
    const svg = 'data:image/svg+xml;base64,'
      + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')
        .toString('base64')
    const b = await senden(m, r.ref, schein({ nationality: 'NL' },
      { signature: { png: svg, signedAt: null } }))
    expect(b.statusCode, b.body).toBe(422)
    const n = await owner.query(`SELECT count(*)::int AS n FROM registration`)
    expect(n.rows[0]!.n).toBe(0)
  })

  it('verlangt das eigene Recht, Kontaktdaten nachtragen genuegt nicht', async () => {
    const m = await maschine(['guest:contact_write'])
    const r = await reservierung()
    const a = await senden(m, r.ref, schein())
    expect(a.statusCode, a.body).toBe(403)
  })
})

/**
 * Die Hausbedingungen des Adminpanels standen auf dem Meldeschein, und jeder
 * Gast hat sie unterschrieben. Die Unterschrift ist fuer die Bedingung der
 * Nachweis -- auch beim deutschen Gast, dessen Meldeschein ohne sie bleibt.
 */
describe('Hausbedingung aus dem Umsystem', () => {
  const fassung = async (version: string, activeFrom: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/v1/properties/${fx.propertyId}/terms`,
                 headers: auth(admin.sessionId),
                 payload: { code: 'hausregeln', title: `Hausregeln ${version}`,
                            body: `Schluesselkarte 50 Euro (${version})`, activeFrom, ...extra } })

  const zustimmung = (termsVersion = 3, agreedAt: string | null = '2026-10-01T08:14:00Z') =>
    ({ termsCode: 'hausregeln', termsVersion, agreedAt })

  beforeEach(async () => {
    for (const [v, ab] of [['v1', '2026-02-08'], ['v2', '2026-03-04'], ['v3', '2026-05-30']]) {
      const a = await fassung(v!, ab!)
      expect(a.statusCode, a.body).toBe(201)
    }
  })

  it('legt die Fassungen rueckwirkend an, eine schliesst an die andere an', async () => {
    const t = await owner.query(
      `SELECT version, active_from::text AS von, active_to::text AS bis FROM property_terms
        WHERE property_id = $1 ORDER BY version`, [fx.propertyId])
    expect(t.rows).toEqual([
      { version: 1, von: '2026-02-08', bis: '2026-03-04' },
      { version: 2, von: '2026-03-04', bis: '2026-05-30' },
      { version: 3, von: '2026-05-30', bis: null }])
  })

  it('weist eine Fassung ab, die vor ihrer Vorgaengerin beginnt', async () => {
    const a = await fassung('alt', '2026-01-01')
    expect(a.statusCode, a.body).toBe(422)
    expect(a.body).toContain('terms.activeFromBeforePrevious')
    const b = await fassung('x', 'gestern')
    expect(b.statusCode, b.body).toBe(422)
  })

  it('zaehlt nach einer beendeten Fassung weiter', async () => {
    const a = await fassung('v4', '2026-06-01', { activeTo: '2026-06-02' })
    expect(a.statusCode, a.body).toBe(201)
    expect(a.json()).toMatchObject({ version: 4, activeTo: '2026-06-02' })
    const b = await fassung('v5', '2026-07-01')
    expect(b.statusCode, b.body).toBe(201)
    expect(b.json()).toMatchObject({ version: 5 })
    const c = await fassung('falsch', '2026-08-01', { activeTo: '2026-07-01' })
    expect(c.statusCode, c.body).toBe(422)
    expect(c.body).toContain('terms.activeToBeforeFrom')
  })

  it('speichert die Unterschrift des deutschen Gastes fuer die Bedingung, nicht fuer den Schein', async () => {
    const m = await maschine(['registration:import'])
    const r = await reservierung()
    const a = await senden(m, r.ref, schein({}, {
      signature: { png: png(), signedAt: '2026-10-01T08:15:00Z' },
      agreement: zustimmung() }))
    expect(a.statusCode, a.body).toBe(201)
    expect(a.json()).toMatchObject({ result: 'imported', signatureStored: false,
                                     agreement: 'stored' })

    const z = await owner.query(
      `SELECT t.version, a.guest_id, a.agreed_at = '2026-10-01T08:14:00Z'::timestamptz AS zeit,
              a.signature_svg AS svg
         FROM guest_agreement a JOIN property_terms t ON t.id = a.terms_id
        WHERE a.reservation_id = $1`, [r.reservationId])
    expect(z.rows).toHaveLength(1)
    expect(z.rows[0]).toMatchObject({ version: 3, guest_id: r.gastId, zeit: true })
    expect(istUnterschriftSvg(z.rows[0]!.svg)).toBe(true)
    const reg = await owner.query(
      `SELECT signature_svg FROM registration WHERE reservation_id = $1`, [r.reservationId])
    expect(reg.rows[0]!.signature_svg).toBeNull()

    // Die Rezeption sieht sie als unterschrieben, wenn v3 am Anreisetag gilt.
    const g = await app.inject({ method: 'GET', url: `/v1/reservations/${r.ref}/terms`,
                                 headers: auth(admin.sessionId) })
    expect(g.json()).toMatchObject({ terms: [{ version: 3, agreed: true, signed: true }] })
  })

  it('traegt sie zu einem schon uebernommenen Schein nach, und nur einmal', async () => {
    const m = await maschine(['registration:import'])
    const r = await reservierung()
    const unterschrift = { png: png(), signedAt: '2026-10-01T08:15:00Z' }
    expect((await senden(m, r.ref, schein({}, { signature: unterschrift }))).statusCode).toBe(201)

    const a = await senden(m, r.ref, schein({}, { signature: unterschrift,
                                                  agreement: zustimmung(3, null) }))
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json()).toMatchObject({ result: 'kept_existing', agreement: 'stored' })
    const b = await senden(m, r.ref, schein({}, { signature: unterschrift,
                                                  agreement: zustimmung(3, '2026-10-03T10:00:00Z') }))
    expect(b.json()).toMatchObject({ result: 'kept_existing', agreement: 'exists' })

    // Ohne eigenen Zeitpunkt gilt der der Unterschrift; die erste Zustimmung bleibt.
    const z = await owner.query(
      `SELECT agreed_at = '2026-10-01T08:15:00Z'::timestamptz AS zeit FROM guest_agreement
        WHERE reservation_id = $1`, [r.reservationId])
    expect(z.rows).toEqual([{ zeit: true }])
  })

  it('erfindet keine Fassung und nimmt keine Zustimmung ohne Unterschrift', async () => {
    const m = await maschine(['registration:import'])
    const r = await reservierung()
    const a = await senden(m, r.ref, schein({}, { agreement: zustimmung(7) }))
    expect(a.statusCode, a.body).toBe(422)
    expect(a.body).toContain('terms.unknownVersion')
    const b = await senden(m, r.ref, schein({}, { agreement: zustimmung() }))
    expect(b.statusCode, b.body).toBe(422)
    expect(b.body).toContain('terms.signatureRequired')
    const c = await senden(m, r.ref, schein({}, { agreement: { termsCode: 'hausregeln' } }))
    expect(c.statusCode, c.body).toBe(422)
    expect(c.body).toContain('agreement.termsVersion')
    // Alles in einer Transaktion: kein halber Schein.
    const n = await owner.query(`SELECT count(*)::int AS n FROM registration`)
    expect(n.rows[0]!.n).toBe(0)
  })

  it('legt bei einem geloeschten Gast keine Unterschrift an', async () => {
    const m = await maschine(['registration:import'])
    const r = await reservierung()
    const unterschrift = { png: png(), signedAt: '2026-10-01T08:15:00Z' }
    expect((await senden(m, r.ref, schein({}, { signature: unterschrift }))).statusCode).toBe(201)
    await owner.query(`UPDATE guest SET erasure_requested_at = now() WHERE id = $1`, [r.gastId])
    const a = await senden(m, r.ref, schein({}, { signature: unterschrift,
                                                  agreement: zustimmung() }))
    expect(a.json()).toMatchObject({ result: 'kept_existing', agreement: 'skipped' })
    const n = await owner.query(`SELECT count(*)::int AS n FROM guest_agreement`)
    expect(n.rows[0]!.n).toBe(0)
  })
})

describe('Unterschrift aus PNG', () => {
  it('nimmt die Groesse aus dem Kopf des Bildes', () => {
    const svg = unterschriftAusPng(png(720, 240))
    expect(svg).toContain('width="720" height="240"')
    expect(istUnterschriftSvg(svg!)).toBe(true)
  })
  it('weist ab, was kein PNG ist', () => {
    expect(unterschriftAusPng('data:image/png;base64,' + Buffer.from('kein bild').toString('base64')))
      .toBeNull()
    expect(unterschriftAusPng('data:image/jpeg;base64,AAAA')).toBeNull()
  })
})
