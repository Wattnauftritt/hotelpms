import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { derivePrice } from '@hotelpms/domain'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let catId: number
let rooms: number[]
let admin: { userId: number; sessionId: string }

const auth = (sessionId: string) => ({ cookie: `hp_session=${sessionId}` })
const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, never>

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  const built = await buildServer({ pool: appPool(15) })
  app = built.app
  pool = built.pool
  registerAllRoutes(app)
  await app.ready()
})
afterAll(async () => { await app.close(); await owner.end(); await pool.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  catId = await makeCategory(owner, fx.propertyId)
  rooms = await makeResources(owner, fx.propertyId, catId, 5)
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2027-03-01'::date)`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, '2026-10-01')
  // hotel_director deckt Rezeption, Raten, Housekeeping und Berichte ab.
  admin = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director',
      accountId: fx.accountId })
  await owner.query(
    `INSERT INTO user_account_role (user_id, account_id, role_id)
     SELECT $1, $2, id FROM role WHERE key = 'hotel_director' AND account_id IS NULL
     ON CONFLICT DO NOTHING`, [admin.userId, fx.accountId])
})

describe('Gaeste', () => {
  const anlegen = (body: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/v1/guests', headers: auth(admin.sessionId), payload: body })

  it('legt einen Gast an und findet ihn ueber einen Namensteil', async () => {
    const r = await anlegen({ lastName: 'Sonnenschein', firstName: 'Anke',
                              email: 'anke@example.de', country: 'DE' })
    expect(r.statusCode).toBe(201)
    const g = json(r) as unknown as { guestRef: string; possibleDuplicates: unknown[] }
    expect(g.possibleDuplicates).toHaveLength(0)

    const such = await app.inject({
      method: 'GET', url: '/v1/guests?q=Sonnensch', headers: auth(admin.sessionId) })
    expect(such.statusCode).toBe(200)
    const treffer = (json(such) as unknown as { guests: Array<{ guestRef: string }> }).guests
    expect(treffer.map(t => t.guestRef)).toContain(g.guestRef)
  })

  it('warnt vor einer Dublette, blockiert aber nicht', async () => {
    await anlegen({ lastName: 'Petersen', firstName: 'Jan', email: 'jan@example.de' })
    const zweiter = await anlegen({ lastName: 'Petersen', firstName: 'Jan',
                                    email: 'jan@example.de' })
    // Das Anlegen gelingt: die Rezeption entscheidet, nicht das System.
    expect(zweiter.statusCode).toBe(201)
    const d = (json(zweiter) as unknown as
      { possibleDuplicates: Array<{ reason: string; score: number }> }).possibleDuplicates
    expect(d.length).toBeGreaterThan(0)
    expect(d[0]!.reason).toBe('gleiche E-Mail')
    expect(d[0]!.score).toBe(1)
  })

  it('verschluesselt die Ausweisnummer und zeigt sie nur maskiert', async () => {
    const r = await anlegen({ lastName: 'Jansen', idDocumentType: 'passport',
                              idDocumentNumber: 'C01X00T47' })
    const ref = (json(r) as unknown as { guestRef: string; hasIdDocumentNumber: boolean })
    expect(ref.hasIdDocumentNumber).toBe(true)
    // Im Profil selbst steht die Nummer nicht.
    expect(r.body).not.toContain('C01X00T47')

    // In der Datenbank liegt Chiffrat, kein Klartext.
    const roh = await owner.query<{ enc: Buffer }>(
      `SELECT id_document_number_enc AS enc FROM guest WHERE public_ref = $1`, [ref.guestRef])
    expect(roh.rows[0]!.enc.toString('utf8')).not.toContain('C01X00T47')

    const maskiert = await app.inject({
      method: 'GET', url: `/v1/guests/${ref.guestRef}/id-document`,
      headers: auth(admin.sessionId) })
    expect((json(maskiert) as unknown as { number: string }).number).toBe('*****0T47')

    const voll = await app.inject({
      method: 'GET', url: `/v1/guests/${ref.guestRef}/id-document?full=true`,
      headers: auth(admin.sessionId) })
    expect((json(voll) as unknown as { number: string }).number).toBe('C01X00T47')
  })

  it('anonymisiert statt zu loeschen und laesst Rechnungsbelege unberuehrt', async () => {
    const r = await anlegen({ lastName: 'Vergessen', firstName: 'Willi',
                              email: 'willi@example.de', idDocumentNumber: 'X1234' })
    const ref = (json(r) as unknown as { guestRef: string }).guestRef

    const weg = await app.inject({
      method: 'POST', url: `/v1/guests/${ref}/anonymize`, headers: auth(admin.sessionId) })
    expect(weg.statusCode).toBe(200)

    const danach = await owner.query<{ last_name: string; email: string | null
                                       status: string; enc: Buffer | null }>(
      `SELECT last_name, email, status, id_document_number_enc AS enc
         FROM guest WHERE public_ref = $1`, [ref])
    expect(danach.rows[0]!.status).toBe('anonymized')
    expect(danach.rows[0]!.last_name).toBe('Anonymisiert')
    expect(danach.rows[0]!.email).toBeNull()
    expect(danach.rows[0]!.enc).toBeNull()
    // Die Zeile bleibt: Fremdschluessel aus Rechnungen duerfen nicht brechen.
    expect(danach.rowCount).toBe(1)
  })

  it('verweigert die Anonymisierung bei laufendem Aufenthalt', async () => {
    const r = await anlegen({ lastName: 'ImHaus' })
    const ref = (json(r) as unknown as { guestRef: string }).guestRef
    const gid = await owner.query<{ id: number }>(
      `SELECT id FROM guest WHERE public_ref = $1`, [ref])
    const res = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-10-01',
      departure: '2026-10-03', status: 'InHouse', resourceId: rooms[0]! })
    await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
      [res.reservationId, gid.rows[0]!.id])

    const weg = await app.inject({
      method: 'POST', url: `/v1/guests/${ref}/anonymize`, headers: auth(admin.sessionId) })
    expect(weg.statusCode).toBe(409)
  })

  it('liefert die Auskunft nach Art. 15 DSGVO in einer Anfrage', async () => {
    const r = await anlegen({ lastName: 'Auskunft', email: 'a@example.de' })
    const ref = (json(r) as unknown as { guestRef: string }).guestRef
    const gid = await owner.query<{ id: number }>(
      `SELECT id FROM guest WHERE public_ref = $1`, [ref])
    const res = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-10-05',
      departure: '2026-10-07' })
    await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
      [res.reservationId, gid.rows[0]!.id])

    const e = await app.inject({
      method: 'GET', url: `/v1/guests/${ref}/data-export`, headers: auth(admin.sessionId) })
    expect(e.statusCode).toBe(200)
    const daten = json(e) as unknown as { stays: unknown[]; invoices: unknown[] }
    expect(daten.stays).toHaveLength(1)
    expect(daten.invoices).toHaveLength(0)
  })
})

describe('Raten', () => {
  async function ratePlan(code: string, extra: Record<string, unknown> = {}) {
    const r = await app.inject({
      method: 'POST', url: `/v1/properties/${fx.propertyId}/rate-plans`,
      headers: auth(admin.sessionId),
      payload: { code, name: code, categoryId: catId, ...extra } })
    expect(r.statusCode).toBe(201)
    return (json(r) as unknown as { ratePlanId: number }).ratePlanId
  }

  it('setzt ein Jahr Preise in einer Anfrage', async () => {
    const plan = await ratePlan('BAR')
    const r = await app.inject({
      method: 'PUT', url: '/v1/rates/bulk', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: plan,
                 from: '2026-10-01', to: '2027-09-30', priceCent: [9000, 12000] } })
    expect(r.statusCode).toBe(200)
    expect((json(r) as unknown as { days: number }).days).toBe(365)

    const zaehl = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM rate_day WHERE rate_plan_id = $1`, [plan])
    expect(Number(zaehl.rows[0]!.n)).toBe(365)
  })

  it('beschraenkt die Pflege auf ausgewaehlte Wochentage', async () => {
    const plan = await ratePlan('WE')
    // Freitag und Samstag im Oktober 2026: je fuenf Tage.
    await app.inject({
      method: 'PUT', url: '/v1/rates/bulk', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: plan,
                 from: '2026-10-01', to: '2026-10-31', priceCent: [15000],
                 weekdays: [4, 5] } })
    const tage = await owner.query<{ date: string }>(
      `SELECT date::text FROM rate_day WHERE rate_plan_id = $1 ORDER BY date`, [plan])
    expect(tage.rowCount).toBe(10)
    for (const t of tage.rows) {
      const wd = new Date(`${t.date}T00:00:00Z`).getUTCDay()   // 5 = Fr, 6 = Sa
      expect([5, 6]).toContain(wd)
    }
  })

  it('rechnet abgeleitete Raten wie der Domaenenkern', async () => {
    const basis = await ratePlan('BAR2')
    await app.inject({
      method: 'PUT', url: '/v1/rates/bulk', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: basis,
                 from: '2026-10-01', to: '2026-10-10', priceCent: [9999, 11111] } })
    const abgeleitet = await ratePlan('NONREF',
      { baseRatePlanId: basis, deriveKind: 'percent', deriveValue: -15 })

    const r = await app.inject({
      method: 'POST', url: '/v1/rates/rebuild-derived', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, from: '2026-10-01', to: '2026-10-10' } })
    expect(r.statusCode).toBe(200)

    const p = await owner.query<{ price_cent: number[] }>(
      `SELECT price_cent FROM rate_day WHERE rate_plan_id = $1 AND date = '2026-10-01'`,
      [abgeleitet])
    // Dieselbe Regel in SQL und in TypeScript, Cent fuer Cent.
    expect(p.rows[0]!.price_cent).toEqual([
      derivePrice(9999, { kind: 'percent', value: -15 }),
      derivePrice(11111, { kind: 'percent', value: -15 })])
  })

  it('loest eine mehrstufige Ableitungskette in der richtigen Reihenfolge auf', async () => {
    const basis = await ratePlan('STUFE0')
    await app.inject({
      method: 'PUT', url: '/v1/rates/bulk', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: basis,
                 from: '2026-10-01', to: '2026-10-02', priceCent: [10000] } })
    const stufe1 = await ratePlan('STUFE1',
      { baseRatePlanId: basis, deriveKind: 'amount', deriveValue: -1000 })
    const stufe2 = await ratePlan('STUFE2',
      { baseRatePlanId: stufe1, deriveKind: 'amount', deriveValue: -1000 })

    await app.inject({
      method: 'POST', url: '/v1/rates/rebuild-derived', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, from: '2026-10-01', to: '2026-10-02' } })

    const p = await owner.query<{ rate_plan_id: number; price_cent: number[] }>(
      `SELECT rate_plan_id, price_cent FROM rate_day
        WHERE date = '2026-10-01' AND rate_plan_id = ANY($1::bigint[])
        ORDER BY rate_plan_id`, [[stufe1, stufe2]])
    expect(p.rows.find(x => x.rate_plan_id === stufe1)!.price_cent).toEqual([9000])
    expect(p.rows.find(x => x.rate_plan_id === stufe2)!.price_cent).toEqual([8000])
  })

  it('weist einen Ratenplan einer fremden Property ab', async () => {
    const andere = await makeProperty(owner, { code: 'ZWEI' })
    const cat2 = await makeCategory(owner, andere.propertyId)
    const fremd = await owner.query<{ id: number }>(
      `INSERT INTO rate_plan (property_id, category_id, code, name)
       VALUES ($1,$2,'FREMD','Fremd') RETURNING id`, [andere.propertyId, cat2])

    const r = await app.inject({
      method: 'PUT', url: '/v1/rates/bulk', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: fremd.rows[0]!.id,
                 from: '2026-10-01', to: '2026-10-05', priceCent: [1000] } })
    expect(r.statusCode).toBe(404)
  })

  it('begrenzt den Zeitraum der Massenpflege', async () => {
    const plan = await ratePlan('LANG')
    const r = await app.inject({
      method: 'PUT', url: '/v1/rates/bulk', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, ratePlanId: plan,
                 from: '2026-01-01', to: '2030-01-01', priceCent: [1000] } })
    expect(r.statusCode).toBe(422)
  })
})

describe('Housekeeping', () => {
  it('liefert den Zimmerplan des Tages in einer Anfrage', async () => {
    await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-09-29',
      departure: '2026-10-01', status: 'InHouse', resourceId: rooms[0]! })

    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/housekeeping?date=2026-10-01`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    const plan = json(r) as unknown as
      { rooms: Array<{ code: string; status: string; departureRef: string | null }> }
    expect(plan.rooms).toHaveLength(5)
    const abreise = plan.rooms.filter(z => z.departureRef !== null)
    expect(abreise).toHaveLength(1)
  })

  it('setzt mehrere Zimmer in einem Aufruf und lehnt fremde ab', async () => {
    const r = await app.inject({
      method: 'PUT', url: '/v1/housekeeping/status', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, resourceIds: rooms.slice(0, 3),
                 status: 'clean' } })
    expect(r.statusCode).toBe(200)
    expect((json(r) as unknown as { updated: number }).updated).toBe(3)

    const andere = await makeProperty(owner, { code: 'FREMD' })
    const cat2 = await makeCategory(owner, andere.propertyId)
    const fremdeZimmer = await makeResources(owner, andere.propertyId, cat2, 1, 'F')
    const abgelehnt = await app.inject({
      method: 'PUT', url: '/v1/housekeeping/status', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, resourceIds: [rooms[0]!, fremdeZimmer[0]!],
                 status: 'dirty' } })
    expect(abgelehnt.statusCode).toBe(404)
  })

  it('erzeugt die Aufgaben des Tages und wiederholt sie nicht', async () => {
    await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-09-30',
      departure: '2026-10-01', status: 'InHouse', resourceId: rooms[0]! })
    await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-09-30',
      departure: '2026-10-05', status: 'InHouse', resourceId: rooms[1]! })

    const erste = await app.inject({
      method: 'POST', url: '/v1/housekeeping/tasks/generate', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, date: '2026-10-01' } })
    expect((json(erste) as unknown as { created: number }).created).toBe(2)

    const zweite = await app.inject({
      method: 'POST', url: '/v1/housekeeping/tasks/generate', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, date: '2026-10-01' } })
    expect((json(zweite) as unknown as { created: number }).created).toBe(0)

    const arten = await owner.query<{ kind: string }>(
      `SELECT kind FROM housekeeping_task WHERE property_id = $1 ORDER BY kind`,
      [fx.propertyId])
    expect(arten.rows.map(a => a.kind)).toEqual(['departure', 'stayover'])
  })

  it('setzt das Zimmer mit der erledigten Aufgabe auf sauber', async () => {
    await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-09-30',
      departure: '2026-10-01', status: 'InHouse', resourceId: rooms[0]! })
    await app.inject({
      method: 'POST', url: '/v1/housekeeping/tasks/generate', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, date: '2026-10-01' } })
    const t = await owner.query<{ id: number }>(
      `SELECT id FROM housekeeping_task WHERE property_id = $1`, [fx.propertyId])

    const r = await app.inject({
      method: 'POST', url: `/v1/housekeeping/tasks/${t.rows[0]!.id}/done`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)

    const status = await owner.query<{ status: string }>(
      `SELECT status FROM housekeeping_status WHERE resource_id = $1`, [rooms[0]!])
    expect(status.rows[0]!.status).toBe('clean')
  })

  it('senkt die Kapazitaet, wenn eine Meldung das Zimmer ausser Betrieb setzt', async () => {
    const vorher = await owner.query<{ capacity: number }>(
      `SELECT capacity FROM inventory_day
        WHERE property_id=$1 AND category_id=$2 AND date='2026-10-02'`, [fx.propertyId, catId])
    expect(vorher.rows[0]!.capacity).toBe(5)

    const r = await app.inject({
      method: 'POST', url: '/v1/maintenance-tickets', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, resourceId: rooms[0]!, title: 'Wasserschaden',
                 priority: 'high', outOfOrder: { from: '2026-10-02', to: '2026-10-05' } } })
    expect(r.statusCode).toBe(201)

    const nachher = await owner.query<{ capacity: number }>(
      `SELECT capacity FROM inventory_day
        WHERE property_id=$1 AND category_id=$2 AND date='2026-10-02'`, [fx.propertyId, catId])
    expect(nachher.rows[0]!.capacity).toBe(4)
  })
})

describe('Meldeschein', () => {
  async function gastMitReservierung(country: string | null) {
    const g = await owner.query<{ id: number; public_ref: string }>(
      `INSERT INTO guest (account_id, last_name, first_name, country)
       VALUES ($1,'Reisender','Rita',$2) RETURNING id, public_ref`, [fx.accountId, country])
    const res = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-10-01',
      departure: '2026-10-04', status: 'InHouse', resourceId: rooms[0]! })
    await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
      [res.reservationId, g.rows[0]!.id])
    const ref = await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM reservation WHERE id = $1`, [res.reservationId])
    return { guestRef: g.rows[0]!.public_ref, reservationRef: ref.rows[0]!.public_ref }
  }

  it('verlangt fuer inlaendische Gaeste keine Unterschrift', async () => {
    const { reservationRef } = await gastMitReservierung('DE')

    const form = await app.inject({
      method: 'GET', url: `/v1/reservations/${reservationRef}/registration-form`,
      headers: auth(admin.sessionId) })
    expect((json(form) as unknown as { signatureRequired: boolean }).signatureRequired)
      .toBe(false)

    const r = await app.inject({
      method: 'POST', url: '/v1/registrations', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, reservationRef } })
    expect(r.statusCode).toBe(201)
    expect((json(r) as unknown as { signatureStored: boolean }).signatureStored).toBe(false)
  })

  it('verlangt fuer auslaendische Gaeste eine Unterschrift', async () => {
    const { reservationRef } = await gastMitReservierung('NL')

    const ohne = await app.inject({
      method: 'POST', url: '/v1/registrations', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, reservationRef } })
    expect(ohne.statusCode).toBe(422)

    const mit = await app.inject({
      method: 'POST', url: '/v1/registrations', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, reservationRef,
                 signatureSvg: '<svg><path d="M0 0"/></svg>' } })
    expect(mit.statusCode).toBe(201)
    expect((json(mit) as unknown as { signatureStored: boolean }).signatureStored).toBe(true)
  })

  it('speichert fuer inlaendische Gaeste auch eine mitgeschickte Unterschrift nicht', async () => {
    const { reservationRef } = await gastMitReservierung('DE')
    await app.inject({
      method: 'POST', url: '/v1/registrations', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, reservationRef,
                 signatureSvg: '<svg>unnoetig</svg>' } })
    const gespeichert = await owner.query<{ signature_svg: string | null }>(
      `SELECT signature_svg FROM registration WHERE property_id = $1`, [fx.propertyId])
    // Keine Erhebung ohne Rechtsgrund, auch wenn die Oberflaeche etwas schickt.
    expect(gespeichert.rows[0]!.signature_svg).toBeNull()
  })

  it('setzt die Vernichtungsfrist auf ein Jahr nach Abreise', async () => {
    const { reservationRef } = await gastMitReservierung('DE')
    await app.inject({
      method: 'POST', url: '/v1/registrations', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, reservationRef } })
    const d = await owner.query<{ destroy_after: string }>(
      `SELECT destroy_after::text FROM registration WHERE property_id = $1`, [fx.propertyId])
    // Anreise 1.10., Abreise 4.10. -- § 30 Abs. 4 BMG zaehlt ab Abreise.
    expect(d.rows[0]!.destroy_after).toBe('2027-10-04')
  })

  it('nimmt denselben Meldeschein nicht zweimal an', async () => {
    const { reservationRef } = await gastMitReservierung('DE')
    await app.inject({
      method: 'POST', url: '/v1/registrations', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, reservationRef } })
    const zweite = await app.inject({
      method: 'POST', url: '/v1/registrations', headers: auth(admin.sessionId),
      payload: { propertyId: fx.propertyId, reservationRef } })
    expect(zweite.statusCode).toBe(409)
  })
})

describe('Berichte', () => {
  it('liefert Anreisen, Abreisen und Hausliste eines Tages', async () => {
    await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-10-01',
      departure: '2026-10-04', status: 'Confirmed' })
    await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-09-28',
      departure: '2026-10-01', status: 'InHouse', resourceId: rooms[1]! })
    await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-09-30',
      departure: '2026-10-05', status: 'InHouse', resourceId: rooms[2]! })

    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/daily-sheet?date=2026-10-01`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    const s = json(r) as unknown as
      { arrivals: unknown[]; departures: unknown[]; inHouse: unknown[] }
    expect(s.arrivals).toHaveLength(1)
    expect(s.departures).toHaveLength(1)
    expect(s.inHouse).toHaveLength(1)
  })

  it('rechnet Belegung, ADR und RevPAR aus den gebuchten Logiserloesen', async () => {
    // Zwei von fuenf Zimmern verkauft, 220 Euro netto Logis an dem Tag.
    await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-10-01',
      departure: '2026-10-02', status: 'InHouse', resourceId: rooms[0]! })
    await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-10-01',
      departure: '2026-10-02', status: 'InHouse', resourceId: rooms[1]! })
    const folios = await owner.query<{ id: number }>(
      `SELECT id FROM folio WHERE property_id = $1 ORDER BY id`, [fx.propertyId])
    for (const f of folios.rows) {
      await owner.query(
        `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                             net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account)
         VALUES ($1,$2,'2026-10-01','Uebernachtung',1,11000,770,11770,700,'8300')`,
        [fx.propertyId, f.id])
    }

    const r = await app.inject({
      method: 'GET',
      url: `/v1/properties/${fx.propertyId}/kpi?from=2026-10-01&to=2026-10-01`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    const k = (json(r) as unknown as { days: Array<{ sold: number; adrCent: number
      revparCent: number; occupancyPercent: number; source: string }> }).days[0]!
    expect(k.sold).toBe(2)
    expect(k.occupancyPercent).toBe(40)
    expect(k.adrCent).toBe(11000)        // 22000 Cent auf 2 verkaufte Zimmer
    expect(k.revparCent).toBe(4400)      // 22000 Cent auf 5 verfuegbare Zimmer
    expect(k.source).toBe('auf den Buechern')
  })

  /**
   * Der Kern des Befunds aus dem Saatlauf: `inventory_day.sold` ist ein
   * laufender Zaehler und faellt nach der Abreise auf null. Die Auslastung
   * der Vergangenheit muss aus der Aufzeichnung des Nachtlaufs kommen,
   * sonst meldet jede Jahresauswertung nahezu null.
   */
  it('nimmt die Auslastung der Vergangenheit aus der Aufzeichnung', async () => {
    const r = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-09-28',
      departure: '2026-09-30', status: 'InHouse', resourceId: rooms[0]! })
    const f = await owner.query<{ id: number }>(
      `SELECT id FROM folio WHERE reservation_id = $1`, [r.reservationId])
    await owner.query(
      `INSERT INTO charge (property_id, folio_id, business_date, description, quantity,
                           net_cent, tax_cent, gross_cent, tax_rate_bp, revenue_account)
       VALUES ($1,$2,'2026-09-28','Uebernachtung',1,10000,700,10700,700,'8300')`,
      [fx.propertyId, f.rows[0]!.id])
    await owner.query(
      `UPDATE reservation SET status = 'CheckedOut', checked_out_at = now() WHERE id = $1`,
      [r.reservationId])
    // Der Zaehler ist fuer diesen Tag jetzt wieder null.
    await owner.query(`SELECT inventory_release($1,$2,'2026-09-28','2026-09-30',1)`,
      [fx.propertyId, catId])
    await owner.query(`SELECT record_day_statistics($1, '2026-09-28')`, [fx.propertyId])

    const kpi = await app.inject({
      method: 'GET',
      url: `/v1/properties/${fx.propertyId}/kpi?from=2026-09-28&to=2026-09-28`,
      headers: auth(admin.sessionId) })
    const tag = (JSON.parse(kpi.body) as { days: Array<{ sold: number; source: string
      occupancyPercent: number; adrCent: number }> }).days[0]!
    expect(tag.source).toBe('aufgezeichnet')
    expect(tag.sold).toBe(1)
    expect(tag.occupancyPercent).toBe(20)
    expect(tag.adrCent).toBe(10_000)

    // Gegenprobe: der laufende Zaehler weiss von diesem Tag nichts mehr.
    const zaehler = await owner.query<{ sold: number }>(
      `SELECT sold FROM inventory_day WHERE property_id=$1 AND category_id=0
         AND date='2026-09-28'`, [fx.propertyId])
    expect(zaehler.rows[0]!.sold).toBe(0)
  })

  it('zaehlt Ankuenfte und Uebernachtungen je Wohnsitzland', async () => {
    const g = await owner.query<{ id: number }>(
      `INSERT INTO guest (account_id, last_name, country) VALUES ($1,'Vandenberg','NL')
       RETURNING id`, [fx.accountId])
    const res = await makeReservation(owner, {
      propertyId: fx.propertyId, categoryId: catId, arrival: '2026-10-03',
      departure: '2026-10-06', status: 'CheckedOut' as never, resourceId: rooms[0]!,
      reserveInventory: false })
    await owner.query(
      `UPDATE reservation SET primary_guest_id = $2, status = 'CheckedOut' WHERE id = $1`,
      [res.reservationId, g.rows[0]!.id])

    const r = await app.inject({
      method: 'GET',
      url: `/v1/properties/${fx.propertyId}/accommodation-statistics?month=2026-10`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    const s = json(r) as unknown as
      { byCountry: Array<{ country: string; arrivals: number; nights: number }>
        totals: { arrivals: number; nights: number }; reportingRequired: boolean }
    expect(s.byCountry).toEqual([{ country: 'NL', arrivals: 1, nights: 3 }])
    expect(s.totals).toEqual({ arrivals: 1, nights: 3 })
    // Fuenf Zimmer zu zwei Personen sind zehn Schlafgelegenheiten.
    expect(s.reportingRequired).toBe(true)
  })

  it('liefert den DATEV-Stapel als CSV mit Kopf- und Spaltenzeile', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/v1/properties/${fx.propertyId}/exports/datev?from=2026-10-01&to=2026-10-31`
         + '&consultantNumber=12345&clientNumber=67890',
      headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toContain('text/csv')
    const zeilen = r.body.split('\r\n')
    expect(zeilen[0]).toContain('EXTF;700;21;Buchungsstapel')
    expect(zeilen[0]).toContain('12345;67890')
    expect(zeilen[1]).toContain('Soll/Haben-Kennzeichen')
  })

  it('legt dem GoBD-Export die Feldbeschreibung bei', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/v1/properties/${fx.propertyId}/exports/gobd?from=2026-10-01&to=2026-10-31`,
      headers: auth(admin.sessionId) })
    expect(r.statusCode).toBe(200)
    const e = json(r) as unknown as
      { beschreibung: Record<string, string>; charges: unknown[] }
    expect(Object.keys(e.beschreibung)).toContain('charge')
    expect(e.beschreibung.charge).toContain('Korrektur')
  })
})
