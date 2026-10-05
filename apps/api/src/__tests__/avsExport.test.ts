import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Meldeschein als Datei fuer AVS (Migration 0091, Anforderung Sven
 * 05.10.2026): eine Datei je Aufenthalt, im Ablauf des Check-ins.
 *
 * Gegen die echte Datenbank, weil die Zusage "gemeldet ist endgueltig" in
 * einem Trigger und einer Zeilensperre steckt, und die Ausweisnummer an
 * einem Recht im Haus der Reservierung.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let chef: Record<string, string>

const ANREISE = '2026-10-03'
const ABREISE = '2026-10-06'

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
  await makeResources(owner, fx.propertyId, catId, 4)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, ANREISE)
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  chef = { cookie: `hp_session=${u.sessionId}` }
})

let nummer = 0

async function gast(opts: { nachname: string; vorname?: string; geburt?: string | null
                            land?: string; email?: string | null }): Promise<{ id: number; ref: string }> {
  const g = await owner.query<{ id: number; public_ref: string }>(
    `INSERT INTO guest (account_id, last_name, first_name, email, language, birth_date,
                        nationality, address_line1, postal_code, city, country)
     VALUES ($1,$2,$3,$4,'de',$5,$6,'Deichweg 4a','27476','Cuxhaven',$6)
     RETURNING id, public_ref`,
    [fx.accountId, opts.nachname, opts.vorname ?? 'Anna',
     opts.email === undefined ? `gast${++nummer}@example.test` : opts.email,
     opts.geburt === undefined ? '1980-12-31' : opts.geburt, opts.land ?? 'DE'])
  return { id: g.rows[0]!.id, ref: g.rows[0]!.public_ref }
}

/** Reservierung mit Hauptgast, optional Mitreisende, Meldeschein erfasst. */
async function aufenthalt(opts: {
  haupt?: Parameters<typeof gast>[0]; mit?: Parameters<typeof gast>[0][]
  unterschriftSpaeter?: boolean; ohneSchein?: boolean
} = {}): Promise<{ ref: string; guestRef: string }> {
  const h = await gast(opts.haupt ?? { nachname: 'Petersen' })
  const r = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: catId, arrival: ANREISE, departure: ABREISE,
    status: 'Confirmed', reserveInventory: false })
  await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
    [r.reservationId, h.id])
  const ref = (await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [r.reservationId])).rows[0]!.public_ref
  const mit = []
  for (const m of opts.mit ?? []) mit.push((await gast(m)).ref)
  if (opts.ohneSchein !== true) {
    const res = await app.inject({ method: 'POST', url: '/v1/registrations', headers: chef,
      payload: { propertyId: fx.propertyId, reservationRef: ref,
                 occupantGuestRefs: mit.length === 0 ? undefined : mit,
                 signatureLater: opts.unterschriftSpaeter } })
    expect(res.statusCode, res.body).toBe(201)
  }
  return { ref, guestRef: h.ref }
}

const einrichten = (payload: Record<string, unknown> = { hotelId: '4711' }) =>
  app.inject({ method: 'PUT', url: `/v1/properties/${fx.propertyId}/avs-settings`,
               headers: chef, payload })

const stand = (ref: string) =>
  app.inject({ method: 'GET', url: `/v1/reservations/${ref}/avs-export`, headers: chef })

const melden = (ref: string, payload: Record<string, unknown> = {},
                headers: Record<string, string> = chef) =>
  app.inject({ method: 'POST', url: `/v1/reservations/${ref}/avs-export`, headers, payload })

interface Datei { fileName: string; xml: string; reportedAt: string; persons: number }

describe('Einstellung je Haus', () => {
  it('nimmt nur eine Objektnummer aus Ziffern und einen kurzen Benutzer', async () => {
    expect((await einrichten({ hotelId: 'abc' })).statusCode).toBe(422)
    expect((await einrichten({ hotelId: '4711', userName: 'viel_zu_langer_name' })).statusCode)
      .toBe(422)
    const ok = await einrichten({ hotelId: '4711', minAge: 14 })
    expect(ok.statusCode, ok.body).toBe(200)
    const g = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/avs-settings`, headers: chef })
    expect(JSON.parse(g.body)).toMatchObject(
      { configured: true, hotelId: '4711', userName: 'StayGrid', minAge: 14, defaultCategory: 1 })
  })
})

describe('Melden', () => {
  it('weist ab, solange das Haus nicht eingerichtet ist', async () => {
    const { ref } = await aufenthalt()
    expect(JSON.parse((await stand(ref)).body)).toMatchObject({ configured: false })
    const r = await melden(ref)
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).code).toBe('avs.notConfigured')
  })

  it('weist ab, solange kein Meldeschein vorliegt', async () => {
    await einrichten()
    const { ref } = await aufenthalt({ ohneSchein: true })
    const r = await melden(ref)
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).code).toBe('avs.noRegistration')
  })

  it('schreibt die Datei in der Reihenfolge des Adminpanels und markiert den Schein',
     async () => {
    await einrichten({ hotelId: '4711' })
    const { ref } = await aufenthalt({
      haupt: { nachname: 'Petersen', vorname: 'Anna' },
      mit: [{ nachname: 'Petersen', vorname: 'Jan', geburt: '1982-01-15' }] })

    const r = await melden(ref)
    expect(r.statusCode, r.body).toBe(201)
    const d = JSON.parse(r.body) as Datei
    expect(d.fileName).toMatch(/^StayGrid_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.xml$/)
    expect(d.persons).toBe(2)
    const x = d.xml
    const reihenfolge = ['<Herkunfts-ID>StayGrid', '<Benutzer>StayGrid', '<hotelid>4711',
      '<name>Petersen', '<vorname>Anna', '<strasse>Deichweg', '<hausnummer>4a',
      '<plz>27476', '<ort>Cuxhaven', `<anreise>${ANREISE}`, `<abreise>${ABREISE}`,
      '<kategorie>1', '<gebdatum>1980-12-31', '<begleitperson>', '<vorname>Jan',
      '<staatsang>deutsch']
    let pos = -1
    for (const teil of reihenfolge) {
      const i = x.indexOf(teil, pos + 1)
      expect(i, teil).toBeGreaterThan(pos)
      pos = i
    }
    // Ohne Einwilligung keine Mailadresse.
    expect(x).not.toContain('<email>')

    const s = JSON.parse((await stand(ref)).body)
    expect(s).toMatchObject({ configured: true, registered: true, exportedHere: true })
    expect(s.reportedAt).not.toBeNull()
  })

  it('meldet denselben Schein nur einmal', async () => {
    await einrichten()
    const { ref } = await aufenthalt()
    expect((await melden(ref)).statusCode).toBe(201)
    const zweiter = await melden(ref)
    expect(zweiter.statusCode).toBe(409)
    expect(JSON.parse(zweiter.body).code).toBe('avs.alreadyReported')
    const n = await owner.query(`SELECT count(*)::int AS n FROM avs_export`)
    expect(n.rows[0].n).toBe(1)
  })

  it('haelt die Meldung in der Datenbank fest, auch gegen ein direktes UPDATE', async () => {
    await einrichten()
    const { ref } = await aufenthalt()
    expect((await melden(ref)).statusCode).toBe(201)
    await expect(owner.query(
      `UPDATE registration SET avs_reported_at = NULL, avs_export_id = NULL`))
      .rejects.toThrow(/gemeldet/)
    await expect(owner.query(`DELETE FROM avs_export`)).rejects.toThrow()
  })

  it('wartet auf die Unterschrift des auslaendischen Gastes', async () => {
    await einrichten()
    const { ref } = await aufenthalt({ haupt: { nachname: 'de Vries', land: 'NL' },
                                       unterschriftSpaeter: true })
    expect(JSON.parse((await stand(ref)).body)).toMatchObject({ signaturePending: true })
    const r = await melden(ref)
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).code).toBe('avs.signaturePending')
  })

  it('verweigert ein Uebungshaus', async () => {
    await einrichten()
    const { ref } = await aufenthalt()
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])
    expect(JSON.parse((await stand(ref)).body)).toMatchObject({ training: true })
    expect((await melden(ref)).statusCode).toBe(422)
    expect((await owner.query(`SELECT count(*)::int AS n FROM avs_export`)).rows[0].n).toBe(0)
  })

  it('laesst Juengere weg und setzt bei einem minderjaehrigen Hauptgast den naechsten an seine Stelle',
     async () => {
    await einrichten()
    const { ref } = await aufenthalt({
      haupt: { nachname: 'Kind', vorname: 'Lena', geburt: '2015-05-01' },
      mit: [{ nachname: 'Kind', vorname: 'Tom', geburt: '2018-01-01' },
            { nachname: 'Mutter', vorname: 'Eva', geburt: '1985-03-03' }] })
    const d = JSON.parse((await melden(ref)).body) as Datei
    expect(d.persons).toBe(1)
    expect(d.xml).toContain('<name>Mutter</name>')
    expect(d.xml).not.toContain('Lena')
    expect(d.xml).not.toContain('Tom')
    expect(d.xml).not.toContain('<begleitperson>')
    // Die Anschrift bleibt die des Scheins.
    expect(d.xml).toContain('<strasse>Deichweg</strasse>')
  })

  it('schickt die Mailadresse nur mit Einwilligung, und die Rezeption kann sie zuruecknehmen',
     async () => {
    await einrichten()
    const a = await aufenthalt({ haupt: { nachname: 'Mit', email: 'mit@example.test' } })
    const mit = JSON.parse((await melden(a.ref, { digitalGuestCard: true })).body) as Datei
    expect(mit.xml).toContain('<email>mit@example.test</email>')
    expect(mit.xml).toContain('<digit_gastkart>true</digit_gastkart>')

    const b = await aufenthalt({ haupt: { nachname: 'Ohne', email: 'ohne@example.test' } })
    await owner.query(
      `UPDATE registration SET digital_guest_card = true
         WHERE reservation_id = (SELECT id FROM reservation WHERE public_ref = $1)`, [b.ref])
    const ohne = JSON.parse((await melden(b.ref, { digitalGuestCard: false })).body) as Datei
    expect(ohne.xml).not.toContain('<email>')
  })

  it('gibt die Ausweisnummer nur mit dem Recht darauf heraus und protokolliert es',
     async () => {
    await einrichten()
    const a = await aufenthalt({ haupt: { nachname: 'Ausweis' } })
    const p = await app.inject({ method: 'PATCH', url: `/v1/guests/${a.guestRef}`,
      headers: chef, payload: { idDocumentType: 'id_card', idDocumentNumber: 'L01X00T47' } })
    expect(p.statusCode, p.body).toBe(200)
    const mit = JSON.parse((await melden(a.ref)).body) as Datei
    expect(mit.xml).toContain('<persausweisnr>L01X00T47</persausweisnr>')
    const log = await owner.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE table_name = 'guest' AND changed->>'id_document_number' = 'an AVS ausgegeben'`)
    expect(log.rows[0].n).toBe(1)

    // Eine Rolle, die einchecken darf, aber keine Ausweisdaten sieht.
    const rolle = await owner.query<{ id: number }>(
      `INSERT INTO role (account_id, level, key, name)
       VALUES ($1, 'property', 'nur_checkin', 'Nur Check-in') RETURNING id`, [fx.accountId])
    await owner.query(
      `INSERT INTO role_permission (role_id, permission_key)
       VALUES ($1,'reservation:read'), ($1,'reservation:checkin')`, [rolle.rows[0]!.id])
    const u = await makeUser(owner, { email: 'checkin@test.de' })
    await owner.query(
      `INSERT INTO user_property_role (user_id, property_id, role_id) VALUES ($1,$2,$3)`,
      [u.userId, fx.propertyId, rolle.rows[0]!.id])
    const b = await aufenthalt({ haupt: { nachname: 'Ausweis2' } })
    await app.inject({ method: 'PATCH', url: `/v1/guests/${b.guestRef}`,
      headers: chef, payload: { idDocumentType: 'id_card', idDocumentNumber: 'T22000129' } })
    const ohne = await melden(b.ref, {}, { cookie: `hp_session=${u.sessionId}` })
    expect(ohne.statusCode, ohne.body).toBe(201)
    expect((JSON.parse(ohne.body) as Datei).xml).not.toContain('persausweisnr')
  })
})

describe('Uebernachtungsentgelt', () => {
  it('zieht den Fruehstuecksanteil je gemeldeter Person und Nacht ab', async () => {
    await einrichten({ hotelId: '4711', breakfastCent: 1000 })
    const { ref } = await aufenthalt({
      mit: [{ nachname: 'Petersen', vorname: 'Jan' },
            { nachname: 'Petersen', vorname: 'Kind', geburt: '2018-01-01' }] })
    await owner.query(
      `UPDATE reservation_night SET price_cent = 10000
        WHERE reservation_id = (SELECT id FROM reservation WHERE public_ref = $1)`, [ref])
    const n = (await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reservation_night
        WHERE reservation_id = (SELECT id FROM reservation WHERE public_ref = $1)`, [ref]))
      .rows[0]!.n
    expect(n).toBe(3)
    // 3 Naechte zu 100 EUR, abzueglich 3 x 2 Erwachsene x 10 EUR; das Kind
    // zaehlt nicht.
    const d = JSON.parse((await melden(ref)).body) as Datei
    expect(d.xml).toContain('<ue-e-gelt>240.00</ue-e-gelt>')
  })
})

describe('Erneut herunterladen', () => {
  it('gibt dieselbe Datei noch einmal, ohne neue Meldung', async () => {
    await einrichten()
    const { ref } = await aufenthalt()
    const erst = JSON.parse((await melden(ref)).body) as Datei
    const r = await app.inject({ method: 'GET', url: `/v1/reservations/${ref}/avs-export/file`,
                                 headers: chef })
    expect(r.statusCode, r.body).toBe(200)
    const d = JSON.parse(r.body) as Datei
    expect(d.fileName).toBe(erst.fileName)
    expect(d.xml).toBe(erst.xml)
    expect((await owner.query(`SELECT count(*)::int AS n FROM avs_export`)).rows[0].n).toBe(1)
  })

  it('nur fuer einen Schein, den StayGrid gemeldet hat', async () => {
    await einrichten()
    const { ref } = await aufenthalt()
    const r = await app.inject({ method: 'GET', url: `/v1/reservations/${ref}/avs-export/file`,
                                 headers: chef })
    expect(r.statusCode).toBe(422)
    expect(JSON.parse(r.body).code).toBe('avs.notExportedHere')
  })
})

describe('Bildschirm Meldescheine', () => {
  it('sagt, ob das Haus meldet und welcher Schein hier gemeldet wurde', async () => {
    const { ref } = await aufenthalt()
    const liste = () => app.inject({ method: 'GET', headers: chef,
      url: `/v1/properties/${fx.propertyId}/registrations?from=2026-10-01&to=2026-10-10` })
    expect(JSON.parse((await liste()).body).avsReporting).toBe(false)
    await einrichten()
    await melden(ref)
    const b = JSON.parse((await liste()).body)
    expect(b.avsReporting).toBe(true)
    expect(b.registrations[0].avsExportedHere).toBe(true)
  })
})
