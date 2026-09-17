import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, type Fixture } from '@hotelpms/testing'
import { withTransaction, type Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Hausbedingungen und Fristen.
 *
 * Der Anlass war die Frage, ob Laender und Gemeinden laengere Aufbewahrung
 * vorschreiben. Die Antwort ist zweigeteilt, und die Trennung ist der ganze
 * Punkt dieser Datei:
 *
 * - Der **Meldeschein** wird ein Jahr **nach Abreise** aufbewahrt und dann
 *   vernichtet (§ 30 Abs. 4 BMG). Das ist Bundesrecht und nicht verhandelbar.
 * - Der **Gaestebeitragsnachweis** ist ein anderer Nachweis und wird laenger
 *   aufbewahrt -- kommunal geregelt, in Cuxhaven sechs Jahre.
 * - Was ein Haus darueber hinaus unterschreiben laesst, ist
 *   **privatrechtlich** und gehoert in keine der beiden Tabellen.
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

async function reservierung(guestRef?: string, bis = BIS): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...auth, 'idempotency-key': `k-${++schluessel}` },
    payload: { propertyId: fx.propertyId, categoryId: catId, arrival: VON,
               departure: bis, resourceId: zimmer[schluessel % zimmer.length], guestRef } })
  expect(r.statusCode, r.body).toBe(201)
  return JSON.parse(r.body).reservationRef as string
}

const anlegen = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/v1/properties/${fx.propertyId}/terms`,
    headers: auth, payload: { propertyId: fx.propertyId, ...payload } })

const geltend = (ref: string) =>
  app.inject({ method: 'GET', url: `/v1/reservations/${ref}/terms`, headers: auth })

const zustimmen = (ref: string, termsRef: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', headers: auth,
    url: `/v1/reservations/${ref}/terms/${termsRef}/agree`, payload })

const SCHLUESSEL = {
  code: 'key_deposit',
  title: 'Verlust der Zimmerkarte',
  body: 'Bei Verlust der Zimmerkarte wird eine Pauschale von 50,00 EUR berechnet.'
}

describe('Fassungen einer Hausbedingung', () => {
  it('legt die erste Fassung an und gibt sie dem Aufenthalt vor', async () => {
    const t = await anlegen(SCHLUESSEL)
    expect(t.statusCode, t.body).toBe(201)
    expect(JSON.parse(t.body).version).toBe(1)

    const ref = await reservierung(await gast('Petersen'))
    const g = JSON.parse((await geltend(ref)).body) as {
      terms: Array<{ code: string; version: number; agreed: boolean
                     requiresSignature: boolean; body: string }> }
    expect(g.terms).toHaveLength(1)
    expect(g.terms[0]).toMatchObject({ code: 'key_deposit', version: 1, agreed: false })
    expect(g.terms[0]!.body).toMatch(/50,00/)
  })

  /**
   * Wer die Pauschale von 50 auf 60 setzt, legt eine neue Fassung an. Ein
   * geaenderter Text unter einer alten Unterschrift waere als Nachweis
   * wertlos -- dieselbe Ueberlegung wie bei `invoice.issuer_snapshot`.
   */
  it('legt eine zweite Fassung an und beendet die erste', async () => {
    await anlegen(SCHLUESSEL)
    const zweite = await anlegen({ ...SCHLUESSEL,
      body: 'Bei Verlust der Zimmerkarte wird eine Pauschale von 60,00 EUR berechnet.' })
    expect(zweite.statusCode, zweite.body).toBe(201)
    expect(JSON.parse(zweite.body).version).toBe(2)

    const alle = await owner.query<{ version: number; active_to: string | null }>(
      `SELECT version, active_to::text FROM property_terms
        WHERE property_id = $1 ORDER BY version`, [fx.propertyId])
    expect(alle.rows[0]!.active_to).not.toBeNull()
    expect(alle.rows[1]!.active_to).toBeNull()
  })

  /**
   * Massgeblich ist die Fassung, die am **Anreisetag** gilt, nicht die
   * neueste: der Gast hat bei der Ankunft den Text vor sich, der dann haengt.
   */
  it('legt die am Anreisetag geltende Fassung vor, nicht die neueste', async () => {
    await anlegen({ ...SCHLUESSEL, activeFrom: '2026-01-01' })
    await anlegen({ ...SCHLUESSEL, body: 'Neue Fassung, 60,00 EUR',
                    activeFrom: '2026-12-01' })

    const ref = await reservierung(await gast('Petersen'))  // Anreise 1.10.
    const g = JSON.parse((await geltend(ref)).body) as {
      terms: Array<{ version: number; body: string }> }
    expect(g.terms).toHaveLength(1)
    expect(g.terms[0]!.version).toBe(1)
    expect(g.terms[0]!.body).toMatch(/50,00/)
  })
})

describe('Zustimmung des Gastes', () => {
  async function bedingung(extra: Record<string, unknown> = {}): Promise<string> {
    const t = await anlegen({ ...SCHLUESSEL, ...extra })
    expect(t.statusCode, t.body).toBe(201)
    return JSON.parse(t.body).termsRef as string
  }

  it('nimmt Zustimmung mit Unterschrift an und haelt sie am Aufenthalt fest', async () => {
    const termsRef = await bedingung()
    const ref = await reservierung(await gast('Petersen'))

    const r = await zustimmen(ref, termsRef, { signatureSvg: '<svg>unterschrift</svg>' })
    expect(r.statusCode, r.body).toBe(201)
    expect(JSON.parse(r.body).signed).toBe(true)

    const g = JSON.parse((await geltend(ref)).body) as {
      terms: Array<{ agreed: boolean; signed: boolean }> }
    expect(g.terms[0]).toMatchObject({ agreed: true, signed: true })
  })

  /**
   * Der Kern der Sache: ein **inlaendischer** Gast unterschreibt seit dem
   * 1.1.2025 keinen Meldeschein mehr -- die Hausbedingung sehr wohl. Beides
   * am selben Tresen, in getrennten Nachweisen.
   */
  it('laesst den inlaendischen Gast unterschreiben, den Meldeschein aber nicht', async () => {
    const termsRef = await bedingung()
    const guestRef = await gast('Petersen', 'DE')
    const ref = await reservierung(guestRef)

    await zustimmen(ref, termsRef, { signatureSvg: '<svg>unterschrift</svg>' })
    const meldung = await app.inject({ method: 'POST', url: '/v1/registrations',
      headers: auth,
      payload: { propertyId: fx.propertyId, reservationRef: ref,
                 signatureSvg: '<svg>unterschrift</svg>' } })
    expect(meldung.statusCode).toBe(201)

    const m = await owner.query<{ signature_svg: string | null }>(
      `SELECT signature_svg FROM registration WHERE property_id = $1`, [fx.propertyId])
    const v = await owner.query<{ signature_svg: string | null }>(
      `SELECT signature_svg FROM guest_agreement WHERE property_id = $1`, [fx.propertyId])
    expect(m.rows[0]!.signature_svg).toBeNull()      // ohne Rechtsgrund
    expect(v.rows[0]!.signature_svg).toBe('<svg>unterschrift</svg>')
  })

  it('weist eine unterschriftspflichtige Bedingung ohne Unterschrift ab', async () => {
    const termsRef = await bedingung()
    const ref = await reservierung(await gast('Petersen'))
    expect((await zustimmen(ref, termsRef)).statusCode).toBe(422)
  })

  it('speichert keine Unterschrift, wo die Fassung keine verlangt', async () => {
    const termsRef = await bedingung({ code: 'house_rules', title: 'Hausordnung',
                                       requiresSignature: false })
    const ref = await reservierung(await gast('Petersen'))
    const r = await zustimmen(ref, termsRef, { signatureSvg: '<svg>ohne Anlass</svg>' })
    expect(r.statusCode, r.body).toBe(201)
    expect(JSON.parse(r.body).signed).toBe(false)

    const v = await owner.query<{ signature_svg: string | null }>(
      `SELECT signature_svg FROM guest_agreement WHERE property_id = $1`, [fx.propertyId])
    expect(v.rows[0]!.signature_svg).toBeNull()
  })

  it('nimmt dieselbe Bedingung nicht zweimal an', async () => {
    const termsRef = await bedingung()
    const ref = await reservierung(await gast('Petersen'))
    await zustimmen(ref, termsRef, { signatureSvg: '<svg>x</svg>' })
    expect((await zustimmen(ref, termsRef, { signatureSvg: '<svg>x</svg>' })).statusCode)
      .toBe(409)
  })

  it('weist eine Bedingung aus einem fremden Haus ab', async () => {
    const fremd = await makeProperty(owner, { name: 'Fremdes Haus', code: 'FRD' })
    const t = await owner.query<{ public_ref: string }>(
      `INSERT INTO property_terms (property_id, code, title, body)
       VALUES ($1,'key_deposit','Fremd','Text') RETURNING public_ref`,
      [fremd.propertyId])
    const ref = await reservierung(await gast('Petersen'))
    // Die Zeilenrichtlinie filtert nach Mandant, nicht nach Haus.
    expect((await zustimmen(ref, t.rows[0]!.public_ref,
      { signatureSvg: '<svg>x</svg>' })).statusCode).toBe(404)
  })

  /**
   * Die Vereinbarung ueberlebt den Meldeschein. Sie ist privatrechtlich und
   * muss ueber die Verjaehrung hinaus nachweisbar bleiben; der Meldeschein
   * wird nach einem Jahr vernichtet.
   */
  it('haengt nicht am Meldeschein und geht mit dessen Vernichtung nicht mit', async () => {
    const termsRef = await bedingung()
    const ref = await reservierung(await gast('Petersen'))
    await zustimmen(ref, termsRef, { signatureSvg: '<svg>x</svg>' })
    await app.inject({ method: 'POST', url: '/v1/registrations', headers: auth,
      payload: { propertyId: fx.propertyId, reservationRef: ref } })

    await owner.query(`DELETE FROM registration WHERE property_id = $1`, [fx.propertyId])
    const v = await owner.query(
      `SELECT 1 FROM guest_agreement WHERE property_id = $1`, [fx.propertyId])
    expect(v.rowCount).toBe(1)
  })
})

describe('Die Meldescheinfrist folgt dem tatsaechlichen Aufenthalt', () => {
  async function frist(): Promise<string> {
    const r = await owner.query<{ destroy_after: string }>(
      `SELECT destroy_after::text FROM registration WHERE property_id = $1`,
      [fx.propertyId])
    return r.rows[0]!.destroy_after
  }

  it('schiebt sich, wenn der Gast verlaengert', async () => {
    const ref = await reservierung(await gast('Petersen'))
    await app.inject({ method: 'POST', url: '/v1/registrations', headers: auth,
      payload: { propertyId: fx.propertyId, reservationRef: ref } })
    expect(await frist()).toBe('2027-10-04')

    const v = await app.inject({ method: 'POST', headers: auth,
      url: `/v1/reservations/${ref}/change-stay`,
      payload: { departure: '2026-10-08' } })
    expect(v.statusCode, v.body).toBe(200)

    // Sonst bliebe die Frist auf dem Wert vom Erfassungstag stehen, und der
    // Schein waere vier Tage zu frueh vernichtet.
    expect(await frist()).toBe('2027-10-08')
  })

  it('richtet sich nach dem tatsaechlichen Abreisetag, wenn es einen gibt', async () => {
    const ref = await reservierung(await gast('Petersen'))
    await app.inject({ method: 'POST', url: '/v1/registrations', headers: auth,
      payload: { propertyId: fx.propertyId, reservationRef: ref } })

    await app.inject({ method: 'POST', headers: auth,
      url: `/v1/reservations/${ref}/check-in` })
    const res = await owner.query<{ id: number }>(
      `SELECT id FROM reservation WHERE public_ref = $1`, [ref])
    // Frueher abgereist als geplant.
    await owner.query(
      `UPDATE reservation SET checked_out_at = '2026-10-02T09:00:00Z', status = 'CheckedOut'
        WHERE id = $1`, [res.rows[0]!.id])

    expect(await frist()).toBe('2027-10-02')
  })
})

describe('Gaestebeitragsnachweis vor Anonymisierung', () => {
  /** Eine Kurtaxe-Position an der Reservierung, wie der Nachtlauf sie bucht. */
  async function kurtaxe(reservationRef: string): Promise<void> {
    const regel = await owner.query<{ id: number }>(
      `INSERT INTO tax_rule (property_id, code, name, kind, basis, amount_cent, rate_bp)
       VALUES ($1,'KUR','Kurtaxe','city_tax','per_person_night',250,0) RETURNING id`,
      [fx.propertyId])
    const res = await owner.query<{ id: number; folio_id: number }>(
      `SELECT r.id, f.id AS folio_id FROM reservation r
         JOIN folio f ON f.reservation_id = r.id AND f.kind = 'guest'
        WHERE r.public_ref = $1`, [reservationRef])
    await owner.query(
      `INSERT INTO charge (property_id, folio_id, business_date, description,
                           net_cent, tax_cent, gross_cent, tax_rate_bp,
                           revenue_account, reservation_id, tax_rule_id)
       VALUES ($1,$2,current_date,'Kurtaxe',750,0,750,0,'8300',$3,$4)`,
      [fx.propertyId, res.rows[0]!.folio_id, res.rows[0]!.id, regel.rows[0]!.id])
  }

  const anonymisieren = (guestRef: string) =>
    app.inject({ method: 'POST', url: `/v1/guests/${guestRef}/anonymize`, headers: auth })

  async function abgereist(reservationRef: string): Promise<void> {
    await owner.query(
      `UPDATE reservation SET status = 'CheckedOut', checked_out_at = now()
        WHERE public_ref = $1`, [reservationRef])
  }

  /**
   * Hier stand zuerst ein glattes 409. Das war zu viel: das
   * Gaesteverzeichnis fuehrt Name, Anschrift, Zeitraum, Naechte, Satz und
   * Betrag -- E-Mail, Telefon, Geburtsdatum und Ausweisnummer braucht es
   * nicht, und Art. 17 Abs. 3 lit. b DSGVO nimmt nur aus, was die Pflicht
   * wirklich fordert.
   */
  it('loescht sofort, was der Nachweis nicht braucht, und schiebt den Rest', async () => {
    const guestRef = await gast('Petersen')
    await owner.query(
      `UPDATE guest SET email = 'gast@example.invalid', phone = '0123',
                        birth_date = '1980-01-01', nationality = 'DE',
                        id_document_type = 'passport',
                        id_document_number_enc = '\\x01'::bytea,
                        id_document_key_version = 1
        WHERE public_ref = $1`, [guestRef])
    const ref = await reservierung(guestRef)
    await kurtaxe(ref)
    await abgereist(ref)

    const r = await anonymisieren(guestRef)
    expect(r.statusCode, r.body).toBe(200)
    const body = JSON.parse(r.body) as { status: string; completesAfter: string }
    expect(body.status).toBe('partial')
    // Sechs Jahre ab Beginn des Folgejahres: Aufenthalt 2026, also bis 2033.
    expect(body.completesAfter).toBe('2033-01-01')

    const g = await owner.query<{ last_name: string; email: string | null
                                  phone: string | null; birth_date: string | null
                                  ausweis: boolean; erasure: string | null
                                  status: string }>(
      `SELECT last_name, email, phone, birth_date::text,
              id_document_number_enc IS NOT NULL AS ausweis,
              erasure_requested_at::text AS erasure, status
         FROM guest WHERE public_ref = $1`, [guestRef])
    // Der Nachweis braucht den Namen -- alles andere nicht.
    expect(g.rows[0]).toMatchObject({
      last_name: 'Petersen', email: null, phone: null, birth_date: null,
      ausweis: false, status: 'active' })
    expect(g.rows[0]!.erasure).not.toBeNull()
  })

  it('vollendet die Loeschung, sobald die Frist abgelaufen ist', async () => {
    const guestRef = await gast('Petersen')
    const ref = await reservierung(guestRef)
    await kurtaxe(ref)
    await abgereist(ref)
    expect((await anonymisieren(guestRef)).statusCode).toBe(200)

    /*
     * Der Nachtlauf im Mandantenkontext -- ohne ihn ist `app_account_ids()`
     * leer, und die Funktion tut zu Recht nichts.
     */
    const ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
    const lauf = (): Promise<number> => withTransaction(pool, ctx, async c => {
      const r = await c.query<{ n: number }>(`SELECT guest_erasure_complete() AS n`)
      return r.rows[0]!.n
    })

    // Solange die Frist laeuft, bleibt der Name stehen.
    expect(await lauf()).toBe(0)

    // Dasselbe, was der Ablauf der Frist bewirkt.
    await owner.query(
      `UPDATE property SET guest_levy_retention_years = 0 WHERE id = $1`,
      [fx.propertyId])
    expect(await lauf()).toBe(1)

    const g = await owner.query<{ last_name: string; status: string }>(
      `SELECT last_name, status FROM guest WHERE public_ref = $1`, [guestRef])
    expect(g.rows[0]).toMatchObject({ last_name: 'Anonymisiert', status: 'anonymized' })

    // Ein zweiter Lauf findet nichts mehr.
    expect(await lauf()).toBe(0)
  })

  it('laesst sie zu, sobald die Frist des Hauses abgelaufen waere', async () => {
    const guestRef = await gast('Petersen')
    const ref = await reservierung(guestRef)
    await kurtaxe(ref)
    await abgereist(ref)
    // Ein Haus ohne Abgabe fuehrt keinen Nachweis -- dann waere die Sperre
    // eine erfundene Frist.
    await owner.query(
      `UPDATE property SET guest_levy_retention_years = 0 WHERE id = $1`,
      [fx.propertyId])

    expect((await anonymisieren(guestRef)).statusCode).toBe(200)
  })

  it('sperrt nicht, wo gar keine Abgabe gebucht wurde', async () => {
    const guestRef = await gast('Petersen')
    const ref = await reservierung(guestRef)
    await abgereist(ref)
    expect((await anonymisieren(guestRef)).statusCode).toBe(200)
  })
})
