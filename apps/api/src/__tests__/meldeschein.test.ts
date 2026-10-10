import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Der Meldeschein nach §§ 29, 30 BMG.
 *
 * Die Route gibt es seit langem und geprueft hat sie nie jemand -- was
 * unangenehm ist, weil hier drei Regeln zusammenkommen, deren Bruch nicht
 * auffaellt, sondern erst bei einer Pruefung:
 *
 * 1. Seit dem 1.1.2025 unterschreiben nur noch auslaendische Gaeste. Eine
 *    Unterschrift eines inlaendischen Gastes ist eine Erhebung ohne
 *    Rechtsgrund und wird **verworfen**, nicht gespeichert.
 * 2. Bei einer Reisegruppe bekommt jeder Mitreisende einen eigenen
 *    Datensatz, der auf den Hauptschein zeigt.
 * 3. Ein Jahr Aufbewahrung ab **Anreise**, dann Vernichtung.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let zimmer: number[]
let auth: Record<string, string>

const VON = '2026-10-01'
const BIS = '2026-10-04'

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
  zimmer = await makeResources(owner, fx.propertyId, catId, 4)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

let schluessel = 0

async function gast(nachname: string, country: string | null = 'DE'): Promise<string> {
  const g = await owner.query<{ public_ref: string }>(
    `INSERT INTO guest (account_id, last_name, country) VALUES ($1,$2,$3)
     RETURNING public_ref`, [fx.accountId, nachname, country])
  return g.rows[0]!.public_ref
}

async function reservierung(guestRef?: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...auth, 'idempotency-key': `k-${++schluessel}` },
    payload: { propertyId: fx.propertyId, categoryId: catId, arrival: VON,
               departure: BIS, resourceId: zimmer[schluessel % zimmer.length],
               guestRef } })
  expect(r.statusCode, r.body).toBe(201)
  return JSON.parse(r.body).reservationRef as string
}

const formular = (ref: string) =>
  app.inject({ method: 'GET', url: `/v1/reservations/${ref}/registration-form`,
    headers: auth })

const melden = (ref: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/v1/registrations', headers: auth,
    payload: { propertyId: fx.propertyId, reservationRef: ref, ...payload } })

describe('Der vorbefuellte Schein', () => {
  it('nimmt, was das Haus schon weiss, aus dem Hauptgast', async () => {
    const ref = await reservierung(await gast('Petersen'))
    const f = JSON.parse((await formular(ref)).body) as {
      guest: { lastName: string } | null; arrival: string
      signatureRequired: boolean; alreadyRegistered: boolean }
    expect(f.guest?.lastName).toBe('Petersen')
    expect(f.arrival).toBe(VON)
    expect(f.alreadyRegistered).toBe(false)
  })

  it('verlangt vom inlaendischen Gast keine Unterschrift', async () => {
    const ref = await reservierung(await gast('Petersen', 'DE'))
    expect(JSON.parse((await formular(ref)).body).signatureRequired).toBe(false)
  })

  it('verlangt sie vom auslaendischen Gast', async () => {
    const ref = await reservierung(await gast('Jansen', 'NL'))
    expect(JSON.parse((await formular(ref)).body).signatureRequired).toBe(true)
  })
})

describe('Erfassen', () => {
  /**
   * "vom Tag der Abreise der beherbergten Person an ein Jahr"
   * (§ 30 Abs. 4 BMG). Gerechnet wurde hier bis zuletzt ab **Anreise** --
   * bei drei Naechten drei Tage zu frueh vernichtet, bei einem Langzeitgast
   * Wochen. Zu frueh vernichtet heisst: die Meldebehoerde verlangt Einsicht
   * und bekommt sie nicht, obwohl die Frist noch laeuft.
   */
  it('setzt die Frist auf ein Jahr ab Abreise, nicht ab Anreise', async () => {
    const ref = await reservierung(await gast('Petersen'))
    const r = await melden(ref)
    expect(r.statusCode, r.body).toBe(201)

    const reg = await owner.query<{ destroy_after: string; occupant_count: number }>(
      `SELECT destroy_after::text, occupant_count FROM registration
        WHERE property_id = $1`, [fx.propertyId])
    // Anreise 1.10., Abreise 4.10.
    expect(reg.rows[0]!.destroy_after).toBe('2027-10-04')
    expect(reg.rows[0]!.occupant_count).toBe(1)
  })

  /**
   * Die Regel, die am leichtesten still bricht: eine Unterschrift eines
   * inlaendischen Gastes ist seit dem 1.1.2025 eine Erhebung ohne
   * Rechtsgrund. Sie wird verworfen -- nicht gespeichert und spaeter
   * geloescht, sondern gar nicht erst abgelegt.
   */
  it('verwirft eine mitgeschickte Unterschrift eines inlaendischen Gastes', async () => {
    const ref = await reservierung(await gast('Petersen', 'DE'))
    const r = await melden(ref, { signatureSvg: '<svg>unterschrift</svg>' })
    expect(r.statusCode).toBe(201)
    expect(JSON.parse(r.body).signatureStored).toBe(false)

    const reg = await owner.query<{ signature_svg: string | null; signed_at: string | null }>(
      `SELECT signature_svg, signed_at::text FROM registration WHERE property_id = $1`,
      [fx.propertyId])
    expect(reg.rows[0]!.signature_svg).toBeNull()
    expect(reg.rows[0]!.signed_at).toBeNull()
  })

  it('speichert die Unterschrift eines auslaendischen Gastes', async () => {
    const ref = await reservierung(await gast('Jansen', 'NL'))
    const r = await melden(ref, { signatureSvg: '<svg>handtekening</svg>' })
    expect(r.statusCode, r.body).toBe(201)

    const reg = await owner.query<{ signature_svg: string | null; is_foreign: boolean }>(
      `SELECT signature_svg, is_foreign FROM registration WHERE property_id = $1`,
      [fx.propertyId])
    expect(reg.rows[0]!.signature_svg).toBe('<svg>handtekening</svg>')
    expect(reg.rows[0]!.is_foreign).toBe(true)
  })

  it('weist den auslaendischen Gast ohne Unterschrift ab', async () => {
    const ref = await reservierung(await gast('Jansen', 'NL'))
    expect((await melden(ref)).statusCode).toBe(422)
  })

  it('weist eine Reservierung ohne Hauptgast ab', async () => {
    const ref = await reservierung()
    expect((await melden(ref)).statusCode).toBe(422)
  })

  it('legt keinen zweiten Schein zur selben Reservierung an', async () => {
    const ref = await reservierung(await gast('Petersen'))
    expect((await melden(ref)).statusCode).toBe(201)
    expect((await melden(ref)).statusCode).toBe(409)
  })
})

describe('Sammelmeldeschein einer Reisegruppe', () => {
  it('gibt jedem Mitreisenden einen eigenen Datensatz am Hauptschein', async () => {
    const ref = await reservierung(await gast('Petersen'))
    const r = await melden(ref, {
      occupantGuestRefs: [await gast('Nissen'), await gast('Boysen')] })
    expect(r.statusCode, r.body).toBe(201)
    expect(JSON.parse(r.body).groupMembers).toBe(2)

    // Die Meldepflicht gilt je Person; unterschrieben wird einmal.
    const regs = await owner.query<{ last_name: string; ist_mitreisender: boolean
                                     occupant_count: number }>(
      `SELECT g.last_name, reg.group_registration_id IS NOT NULL AS ist_mitreisender,
              reg.occupant_count
         FROM registration reg JOIN guest g ON g.id = reg.guest_id
        WHERE reg.property_id = $1 ORDER BY reg.id`, [fx.propertyId])
    expect(regs.rows).toEqual([
      { last_name: 'Petersen', ist_mitreisender: false, occupant_count: 3 },
      { last_name: 'Nissen',   ist_mitreisender: true,  occupant_count: 1 },
      { last_name: 'Boysen',   ist_mitreisender: true,  occupant_count: 1 }
    ])
  })

  /**
   * Der Befund, der diesen Test ausgeloest hat: der Schein entstand, die
   * Personenliste blieb leer. Die Kurtaxe rechnet aus
   * `reservation_occupant` -- gemeldet waren drei, berechnet wurde einer,
   * und die Rechnung sah dabei richtig aus.
   */
  it('traegt die Mitreisenden auch in die Personenliste ein', async () => {
    const ref = await reservierung(await gast('Petersen'))
    await melden(ref, { occupantGuestRefs: [await gast('Nissen'), await gast('Boysen')] })

    const o = await owner.query<{ last_name: string; is_primary: boolean }>(
      `SELECT g.last_name, o.is_primary FROM reservation_occupant o
         JOIN guest g ON g.id = o.guest_id
         JOIN reservation r ON r.id = o.reservation_id
        WHERE r.public_ref = $1 ORDER BY o.id`, [ref])
    expect(o.rows).toEqual([
      { last_name: 'Petersen', is_primary: true },
      { last_name: 'Nissen',   is_primary: false },
      { last_name: 'Boysen',   is_primary: false }
    ])
  })

  it('zaehlt niemanden doppelt, der schon in der Personenliste steht', async () => {
    const nissen = await gast('Nissen')
    const ref = await reservierung(await gast('Petersen'))
    const n = await owner.query<{ id: number }>(
      `SELECT id FROM guest WHERE public_ref = $1`, [nissen])
    const res = await owner.query<{ id: number }>(
      `SELECT id FROM reservation WHERE public_ref = $1`, [ref])
    await owner.query(
      `INSERT INTO reservation_occupant (property_id, reservation_id, guest_id, is_primary)
       VALUES ($1,$2,$3,false)`, [fx.propertyId, res.rows[0]!.id, n.rows[0]!.id])

    await melden(ref, { occupantGuestRefs: [nissen] })

    const anzahl = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reservation_occupant
        WHERE reservation_id = $1 AND guest_id = $2`,
      [res.rows[0]!.id, n.rows[0]!.id])
    expect(anzahl.rows[0]!.n).toBe(1)
  })

  it('weist einen unbekannten Mitreisenden ab und legt gar nichts an', async () => {
    const ref = await reservierung(await gast('Petersen'))
    expect((await melden(ref, { occupantGuestRefs: ['GIBTESNICHT'] })).statusCode).toBe(404)

    const regs = await owner.query(
      `SELECT 1 FROM registration WHERE property_id = $1`, [fx.propertyId])
    expect(regs.rowCount).toBe(0)
  })
})

/**
 * Der Schein mit Inhalt (Sven, 10.10.2026: "warum kann ich die
 * Meldescheine nicht oeffnen"). Die Liste sagt nur, dass es einen gibt.
 */
describe('Der Schein mit Inhalt', () => {
  const UNTERSCHRIFT = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200">'
    + '<image href="data:image/png;base64,iVBORw0KGgo=" width="600" height="200"/></svg>'

  const ansehen = (id: number, kopf = auth) =>
    app.inject({ method: 'GET', url: `/v1/registrations/${id}`, headers: kopf })

  async function sammelschein(): Promise<{ haupt: number; mit: number }> {
    const petersen = await gast('Petersen')
    await owner.query(
      `UPDATE guest SET first_name = 'Jens', birth_date = '1970-03-04',
              address_line1 = 'Deichstr. 2', postal_code = '27472', city = 'Cuxhaven',
              id_document_type = 'id_card', id_document_number_enc = '\\x00'
        WHERE public_ref = $1`, [petersen])
    const ref = await reservierung(petersen)
    const r = await melden(ref, { occupantGuestRefs: [await gast('Nissen')] })
    expect(r.statusCode, r.body).toBe(201)
    const ids = await owner.query<{ id: string; mit: boolean }>(
      `SELECT id, group_registration_id IS NOT NULL AS mit FROM registration
        WHERE property_id = $1 ORDER BY id`, [fx.propertyId])
    return { haupt: Number(ids.rows.find(x => !x.mit)!.id),
             mit: Number(ids.rows.find(x => x.mit)!.id) }
  }

  it('zeigt Hauptgast und Mitreisende mit Geburtsdatum und Anschrift', async () => {
    const { haupt } = await sammelschein()
    const r = await ansehen(haupt)
    expect(r.statusCode, r.body).toBe(200)
    const d = r.json<{ id: number; occupantCount: number
                       persons: Array<Record<string, unknown>> }>()
    expect(d.id).toBe(haupt)
    expect(d.occupantCount).toBe(2)
    expect(d.persons).toHaveLength(2)
    expect(d.persons[0]).toMatchObject({
      main: true, lastName: 'Petersen', firstName: 'Jens', birthDate: '1970-03-04',
      address: { line1: 'Deichstr. 2', postalCode: '27472', city: 'Cuxhaven', country: 'DE' },
      idDocumentType: 'id_card', hasIdDocumentNumber: true })
    expect(d.persons[1]).toMatchObject({ main: false, lastName: 'Nissen' })
    // Die Ausweisnummer liegt hinter ihrem eigenen Recht und Abruf.
    expect(r.body).not.toContain('id_document_number')
  })

  it('liefert zum Mitreisenden das ganze Blatt', async () => {
    const { haupt, mit } = await sammelschein()
    const r = await ansehen(mit)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json<{ id: number }>().id).toBe(haupt)
  })

  it('gibt die Unterschrift nur in der Form der Gastwege heraus', async () => {
    const ref = await reservierung(await gast('Jansen', 'NL'))
    expect((await melden(ref, { signatureSvg: UNTERSCHRIFT })).statusCode).toBe(201)
    const id = Number((await owner.query<{ id: string }>(
      `SELECT id FROM registration WHERE property_id = $1`, [fx.propertyId])).rows[0]!.id)
    const gut = (await ansehen(id)).json<{ signatureSvg: string | null; signedAt: string }>()
    expect(gut.signatureSvg).toBe(UNTERSCHRIFT)
    expect(gut.signedAt).not.toBeNull()

    // Am Tresen geht jedes SVG durch; angezeigt wird es nicht.
    await owner.query(`UPDATE registration SET signature_svg = '<svg onload="x()"/>'
                        WHERE id = $1`, [id])
    expect((await ansehen(id)).json<{ signatureSvg: string | null }>().signatureSvg).toBeNull()
  })

  it('bleibt der Rolle "Nur lesen" verschlossen, die die Liste sieht', async () => {
    const { haupt } = await sammelschein()
    const u = await makeUser(owner,
      { email: 'lesen@test.de', propertyId: fx.propertyId, roleKey: 'read_only' })
    expect((await ansehen(haupt, { cookie: `hp_session=${u.sessionId}` })).statusCode)
      .toBe(403)
  })

  it('sieht einen Schein aus einem anderen Haus des Accounts nicht', async () => {
    const { haupt } = await sammelschein()
    const b = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name, address_line1, postal_code, city, country)
       VALUES ($1,'B','Haus B','Weg 1','27472','Cuxhaven','DE') RETURNING id`, [fx.accountId])
    const u = await makeUser(owner, { email: 'b@test.de', propertyId: Number(b.rows[0]!.id),
                                      accountId: fx.accountId, roleKey: 'reception' })
    expect((await ansehen(haupt, { cookie: `hp_session=${u.sessionId}` })).statusCode)
      .toBe(404)
  })

  it('kennt keinen Schein, den es nicht gibt', async () => {
    expect((await ansehen(999999)).statusCode).toBe(404)
  })
})
