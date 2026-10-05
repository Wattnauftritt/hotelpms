import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, makeEmailDomain, openBusinessDay,
         type Fixture } from '@hotelpms/testing'
import { withTransaction, SYSTEM_CONTEXT, type Pool } from '@hotelpms/db'
import { createCheckinToken } from '@hotelpms/domain'
import { CHECKIN_TOKEN_HEADER, checkinTokenAusFragment } from '@hotelpms/contracts'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { limiters } from '../platform/rateLimit.js'

/**
 * Online-Check-in (Dokument 30): Link, Gastseite, Rezeption.
 *
 * Geprueft wird gegen die echte Datenbank, weil hier vier Dinge
 * zusammenkommen, die eine Attrappe nicht kennt: die Zeilenrichtlinie, die
 * eine Anfrage ohne Anmeldung leise leer liesse; die SQL-Funktion, die den
 * Kontext aus dem Link setzt; die Spaltenrechte, die einem Link nur den
 * Widerruf erlauben; und die Loeschfunktion, die ihn mitnehmen muss.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let zeilen: string[]
let fx: Fixture
let catId: number
let zimmer: number[]
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
  zimmer = await makeResources(owner, fx.propertyId, catId, 4)
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

/** Ein Link fuer die Station im Haus, ueber die exportierte Funktion. */
async function terminalLink(reservationId: number, expiresOn?: string): Promise<string> {
  const t = await withTransaction(pool,
    { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null },
    c => createCheckinToken(c, { reservationId, channel: 'terminal', expiresOn }))
  return t!.token
}

const formular = (token: string) =>
  app.inject({ method: 'GET', url: '/v1/checkin/form',
               headers: { [CHECKIN_TOKEN_HEADER]: token } })

const einreichen = (token: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/checkin/form',
               headers: { [CHECKIN_TOKEN_HEADER]: token }, payload })

function inlaendisch(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guest: { lastName: 'Petersen', firstName: 'Anna', birthDate: '1980-05-17',
             nationality: 'DE',
             address: { line1: 'Deichweg 4', postalCode: '24937', city: 'Flensburg',
                        country: 'DE' }, ...extra },
    confirmed: true
  }
}

function auslaendisch(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guest: { lastName: 'Jansen', firstName: 'Pieter', birthDate: '1975-02-01',
             nationality: 'NL', idDocumentType: 'passport', idDocumentNumber: 'NX12345P7',
             address: { line1: 'Herengracht 1', postalCode: '1015', city: 'Amsterdam',
                        country: 'NL' }, ...extra },
    confirmed: true
  }
}

async function schein(reservationId: number): Promise<{
  source: string; signature_svg: string | null; signed_at: string | null
  signature_required: boolean; is_foreign: boolean; occupant_count: number } | undefined> {
  const r = await owner.query(
    `SELECT source, signature_svg, signed_at::text, signature_required, is_foreign,
            occupant_count
       FROM registration WHERE reservation_id = $1 AND group_registration_id IS NULL`,
    [reservationId])
  return r.rows[0]
}

// ---------------------------------------------------------------------------

describe('Der Link', () => {
  it('steht nur als Hash in der Datenbank', async () => {
    const r = await reservierung()
    const token = await mailLink(r.ref)

    const z = await owner.query<{ token_hash: string; zeile: string }>(
      `SELECT token_hash, row_to_json(t)::text AS zeile FROM checkin_token t
        WHERE reservation_id = $1`, [r.id])
    expect(z.rows).toHaveLength(1)
    expect(z.rows[0]!.token_hash)
      .toBe(createHash('sha256').update(token, 'utf8').digest('hex'))
    // Nirgends in der Zeile der Klartext -- auch nicht im Protokoll der
    // Aenderungen, wo der Hash redigiert steht.
    expect(z.rows[0]!.zeile).not.toContain(token)
    const prot = await owner.query<{ changed: string }>(
      `SELECT changed::text FROM audit_log WHERE table_name = 'checkin_token'`)
    expect(prot.rows.length).toBeGreaterThan(0)
    for (const p of prot.rows) {
      expect(p.changed).not.toContain(token)
      expect(p.changed).not.toContain(z.rows[0]!.token_hash)
    }
  })

  it('gilt hoechstens bis zum Abreisetag', async () => {
    const r = await reservierung()
    const t = await withTransaction(pool,
      { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null },
      c => createCheckinToken(c, { reservationId: r.id, channel: 'terminal',
                                   expiresOn: '2027-01-01' }))
    expect(t!.expiresOn).toBe(ABREISE)
  })

  it('weist ein falsches, ein verstuemmeltes und ein fehlendes Token ab', async () => {
    const r = await reservierung()
    await mailLink(r.ref)
    expect((await formular('A'.repeat(43))).statusCode).toBe(404)
    expect((await formular('kurz')).statusCode).toBe(404)
    const ohne = await app.inject({ method: 'GET', url: '/v1/checkin/form' })
    expect(ohne.statusCode).toBe(404)
  })

  it('laeuft gegen den Geschaeftstag ab, nicht gegen die Uhr', async () => {
    const r = await reservierung()
    const token = await terminalLink(r.id, HEUTE)
    expect((await formular(token)).statusCode).toBe(200)
    // Der Nachtlauf schliesst den Tag; der Link galt bis gestern.
    await owner.query(`UPDATE business_day SET status = 'closed' WHERE property_id = $1`,
      [fx.propertyId])
    await openBusinessDay(owner, fx.propertyId, '2026-10-02')
    const ab = await formular(token)
    expect(ab.statusCode).toBe(410)
    expect(JSON.parse(ab.body).code).toBe('checkin.linkExpired')
  })

  it('laesst sich zurueckziehen', async () => {
    const r = await reservierung()
    const token = await mailLink(r.ref)
    const w = await app.inject({ method: 'POST',
      url: `/v1/reservations/${r.ref}/online-checkin/revoke`, headers: chef })
    expect(w.statusCode, w.body).toBe(200)
    expect(JSON.parse(w.body).revoked).toBe(1)
    const ab = await formular(token)
    expect(ab.statusCode).toBe(410)
    expect(JSON.parse(ab.body).code).toBe('checkin.linkRevoked')
  })

  it('gilt nicht mehr fuer eine stornierte Reservierung', async () => {
    const r = await reservierung()
    const token = await mailLink(r.ref)
    await owner.query(`UPDATE reservation SET status = 'Canceled', canceled_at = now()
                        WHERE id = $1`, [r.id])
    expect((await formular(token)).statusCode).toBe(410)
  })

  it('kann von der Anwendung weder verlaengert noch geloescht werden', async () => {
    const r = await reservierung()
    await mailLink(r.ref)
    const ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
    await expect(withTransaction(pool, ctx, c =>
      c.query(`UPDATE checkin_token SET expires_on = '2030-01-01'`)))
      .rejects.toThrow(/permission denied/)
    await expect(withTransaction(pool, ctx, c =>
      c.query(`DELETE FROM checkin_token`))).rejects.toThrow(/permission denied/)
  })

  it('steht nicht im Anfrageprotokoll', async () => {
    const r = await reservierung()
    const token = await mailLink(r.ref)
    zeilen = []
    expect((await formular(token)).statusCode).toBe(200)
    expect((await einreichen(token, inlaendisch())).statusCode).toBe(201)
    // Auch wer ihn versehentlich in die Abfragezeichenfolge haengt, findet
    // ihn dort nicht wieder: der Serialisierer ersetzt jeden Wert.
    await app.inject({ method: 'GET', url: `/v1/checkin/form?token=${token}` })
    const protokoll = zeilen.join('\n')
    expect(protokoll).toContain('/v1/checkin/form')
    expect(protokoll).not.toContain(token)
    expect(protokoll).not.toContain(createHash('sha256').update(token).digest('hex'))
    // Und keine Angaben aus dem Formular.
    expect(protokoll).not.toContain('Flensburg')
  })
})

describe('Die Gastseite', () => {
  it('zeigt nur Name, Zeitraum und Haus dieser einen Reservierung', async () => {
    const r = await reservierung({ nachname: 'Petersen' })
    await reservierung({ nachname: 'Fremdmann' })
    const token = await mailLink(r.ref)
    const f = await formular(token)
    expect(f.statusCode, f.body).toBe(200)
    expect(f.headers['cache-control']).toBe('no-store')
    const v = JSON.parse(f.body) as Record<string, unknown>
    // `terms` und `exemptionReasons` legt das Haus an; ueber den Gast sagen
    // sie nichts (Migration 0089).
    expect(Object.keys(v).sort()).toEqual(['arrival', 'channel', 'departure',
      'digitalGuestCardOffered', 'exemptionReasons', 'firstName', 'language', 'lastName', 'maxCompanions',
      'propertyName', 'signatureAllowed', 'state', 'terms'])
    expect(v).toMatchObject({ lastName: 'Petersen', arrival: ANREISE, departure: ABREISE,
                              propertyName: 'Testhotel', state: 'open', channel: 'mail',
                              signatureAllowed: false })
    expect(f.body).not.toContain('Fremdmann')
    expect(f.body).not.toContain('@example.test')
  })

  it('erfasst den inlaendischen Gast ohne Unterschrift und verwirft eine mitgeschickte', async () => {
    const r = await reservierung()
    const token = await mailLink(r.ref)
    const e = await einreichen(token, {
      ...inlaendisch({ idDocumentNumber: 'L01X00T47' }), signatureSvg: UNTERSCHRIFT })
    expect(e.statusCode, e.body).toBe(201)
    expect(JSON.parse(e.body).state).toBe('done')

    const s = await schein(r.id)
    expect(s).toMatchObject({ source: 'online', signature_svg: null, signed_at: null,
                              signature_required: false, is_foreign: false })
    // Die Ausweisnummer verlangt das Gesetz nur von auslaendischen Gaesten.
    const g = await owner.query<{ enc: Buffer | null; city: string; nationality: string }>(
      `SELECT id_document_number_enc AS enc, city, nationality FROM guest WHERE id = $1`,
      [r.guestId])
    expect(g.rows[0]).toMatchObject({ enc: null, city: 'Flensburg', nationality: 'DE' })

    const t = await owner.query<{ completed_at: string | null }>(
      `SELECT completed_at FROM checkin_token WHERE reservation_id = $1`, [r.id])
    expect(t.rows[0]!.completed_at).not.toBeNull()
    expect(JSON.parse((await formular(token)).body).state).toBe('done')
  })

  it('verlangt vom auslaendischen Gast die Passnummer und nimmt ueber den Mail-Link keine Unterschrift', async () => {
    const r = await reservierung()
    const token = await mailLink(r.ref)

    const ohne = await einreichen(token, auslaendisch({ idDocumentNumber: undefined }))
    expect(ohne.statusCode).toBe(422)
    expect(JSON.parse(ohne.body).errorKeys['guest.idDocumentNumber'])
      .toEqual(['checkin.idDocumentRequired'])

    const e = await einreichen(token, { ...auslaendisch(), signatureSvg: UNTERSCHRIFT })
    expect(e.statusCode, e.body).toBe(201)
    // § 29 Abs. 2 BMG: am Tag der Ankunft. Vorab erfasst, Unterschrift offen.
    expect(JSON.parse(e.body).state).toBe('signatureOnly')
    expect(await schein(r.id)).toMatchObject({
      source: 'online', signature_svg: null, signed_at: null,
      signature_required: true, is_foreign: true })

    const g = await owner.query<{ enc: Buffer | null }>(
      `SELECT id_document_number_enc AS enc FROM guest WHERE id = $1`, [r.guestId])
    expect(g.rows[0]!.enc).not.toBeNull()
    expect(g.rows[0]!.enc!.toString('utf8')).not.toContain('NX12345P7')

    // Ueber denselben Link laesst sich auch nicht nachtraeglich unterschreiben.
    const u = await app.inject({ method: 'POST', url: '/v1/checkin/signature',
      headers: { [CHECKIN_TOKEN_HEADER]: token }, payload: { signatureSvg: UNTERSCHRIFT } })
    expect(u.statusCode).toBe(422)
    expect(JSON.parse(u.body).code).toBe('checkin.signatureOnArrival')
  })

  it('verlangt am Terminal am Anreisetag die Unterschrift des auslaendischen Gastes', async () => {
    const r = await reservierung({ anreise: HEUTE })
    const token = await terminalLink(r.id)
    const f = JSON.parse((await formular(token)).body) as { signatureAllowed: boolean }
    expect(f.signatureAllowed).toBe(true)

    expect((await einreichen(token, auslaendisch())).statusCode).toBe(422)
    const falsch = await einreichen(token, { ...auslaendisch(),
      signatureSvg: '<svg><script>alert(1)</script></svg>' })
    expect(falsch.statusCode).toBe(422)

    const e = await einreichen(token, { ...auslaendisch(), signatureSvg: UNTERSCHRIFT })
    expect(e.statusCode, e.body).toBe(201)
    expect(JSON.parse(e.body).state).toBe('done')
    const s = await schein(r.id)
    expect(s).toMatchObject({ source: 'terminal', signature_svg: UNTERSCHRIFT,
                              signature_required: true })
    expect(s!.signed_at).not.toBeNull()
  })

  it('nimmt die Unterschrift am Anreisetag nach, wenn vorab per Link erfasst wurde', async () => {
    const r = await reservierung({ anreise: HEUTE })
    expect((await einreichen(await mailLink(r.ref), auslaendisch())).statusCode).toBe(201)

    const station = await terminalLink(r.id)
    expect(JSON.parse((await formular(station)).body).state).toBe('signatureOnly')
    const u = await app.inject({ method: 'POST', url: '/v1/checkin/signature',
      headers: { [CHECKIN_TOKEN_HEADER]: station }, payload: { signatureSvg: UNTERSCHRIFT } })
    expect(u.statusCode, u.body).toBe(200)
    expect((await schein(r.id))!.signed_at).not.toBeNull()
    expect(JSON.parse((await formular(station)).body).state).toBe('done')
  })

  it('weist ein Feld fuer eine Ausweiskopie ab, statt es still zu verwerfen', async () => {
    const r = await reservierung()
    const token = await mailLink(r.ref)
    const e = await einreichen(token, auslaendisch({
      idDocumentScan: 'data:image/jpeg;base64,/9j/4AAQ' }))
    expect(e.statusCode).toBe(422)
    expect(JSON.parse(e.body).errorKeys['guest.idDocumentScan']).toEqual(['field.unknown'])
    expect(await schein(r.id)).toBeUndefined()
  })

  it('legt Mitreisende als Sammelmeldeschein und in reservation_occupant an', async () => {
    const r = await reservierung()
    const token = await mailLink(r.ref)
    const e = await einreichen(token, {
      ...inlaendisch(),
      companions: [
        { lastName: 'Petersen', firstName: 'Jan', birthDate: '1978-03-03', nationality: 'DE' },
        { lastName: 'Petersen', firstName: 'Mia', birthDate: '2015-08-08', nationality: 'DE' }
      ] })
    expect(e.statusCode, e.body).toBe(201)

    const regs = await owner.query<{ first_name: string; mitreisend: boolean }>(
      `SELECT g.first_name, reg.group_registration_id IS NOT NULL AS mitreisend
         FROM registration reg JOIN guest g ON g.id = reg.guest_id
        WHERE reg.reservation_id = $1 ORDER BY reg.id`, [r.id])
    expect(regs.rows).toEqual([
      { first_name: 'Anna', mitreisend: false },
      { first_name: 'Jan', mitreisend: true },
      { first_name: 'Mia', mitreisend: true }])
    expect((await schein(r.id))!.occupant_count).toBe(3)

    const occ = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reservation_occupant WHERE reservation_id = $1`, [r.id])
    expect(occ.rows[0]!.n).toBe(3)

    // Der Check-in-Dialog zeigt den Schein mit Inhalt, Mitreisende eingeschlossen.
    const f = JSON.parse((await app.inject({ method: 'GET',
      url: `/v1/reservations/${r.ref}/registration-form`, headers: chef })).body) as {
        companions: Array<{ firstName: string; birthDate: string; nationality: string }> }
    expect(f.companions).toEqual([
      { lastName: 'Petersen', firstName: 'Jan', birthDate: '1978-03-03', nationality: 'DE' },
      { lastName: 'Petersen', firstName: 'Mia', birthDate: '2015-08-08', nationality: 'DE' }])
  })

  it('verlangt die Unterschrift auch, wenn nur ein Mitreisender auslaendisch ist', async () => {
    const r = await reservierung({ anreise: HEUTE })
    const token = await terminalLink(r.id)
    const begleiter = [{ lastName: 'Jansen', firstName: 'Pieter',
                         birthDate: '1975-02-01', nationality: 'NL' }]
    expect((await einreichen(token, { ...inlaendisch(), companions: begleiter }))
      .statusCode).toBe(422)
    const e = await einreichen(token,
      { ...inlaendisch(), companions: begleiter, signatureSvg: UNTERSCHRIFT })
    expect(e.statusCode, e.body).toBe(201)
    expect(await schein(r.id)).toMatchObject({ is_foreign: false, signature_required: true,
                                               signature_svg: UNTERSCHRIFT })
  })

  it('nimmt einen zweiten Meldeschein nicht an', async () => {
    const r = await reservierung()
    const token = await mailLink(r.ref)
    expect((await einreichen(token, inlaendisch())).statusCode).toBe(201)
    const zweit = await einreichen(token, inlaendisch())
    expect(zweit.statusCode).toBe(409)
  })
})

describe('Mandantentrennung', () => {
  it('setzt den Kontext auf genau das Haus des Links', async () => {
    const r = await reservierung()
    const token = await mailLink(r.ref)
    const b = await makeProperty(owner, { code: 'ANDERS', name: 'Anderes Haus' })
    await makeCategory(owner, b.propertyId, { code: 'EZ' })
    await reservierung({ propertyId: b.propertyId })

    const sicht = await withTransaction(pool, SYSTEM_CONTEXT, async c => {
      await c.query(`SELECT * FROM checkin_token_open($1)`,
        [createHash('sha256').update(token).digest('hex')])
      const ids = await c.query<{ ids: number[] }>(`SELECT app_property_ids() AS ids`)
      const n = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM reservation`)
      return { ids: ids.rows[0]!.ids, n: n.rows[0]!.n }
    })
    expect(sicht.ids).toEqual([fx.propertyId])
    expect(sicht.n).toBe(1)
  })

  it('laesst sich mit gesetztem Kontext nicht aufrufen', async () => {
    const r = await reservierung()
    const token = await mailLink(r.ref)
    await expect(withTransaction(pool,
      { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null },
      c => c.query(`SELECT * FROM checkin_token_open($1)`,
        [createHash('sha256').update(token).digest('hex')])))
      .rejects.toThrow(/leeren Mandantenkontext/)
  })

  it('gibt fuer eine fremde Reservierung keinen Link aus', async () => {
    const b = await makeProperty(owner, { code: 'ANDERS', name: 'Anderes Haus' })
    await makeCategory(owner, b.propertyId, { code: 'EZ' })
    const fremd = await reservierung({ propertyId: b.propertyId })
    const r = await app.inject({ method: 'POST',
      url: `/v1/reservations/${fremd.ref}/online-checkin/link`, headers: chef })
    expect(r.statusCode).toBe(404)
  })

  it('erlaubt der Haushaltsrolle weder Link noch Versand', async () => {
    const r = await reservierung()
    const hk = await makeUser(owner,
      { email: 'hk@test.de', propertyId: fx.propertyId, roleKey: 'housekeeping' })
    const h = { cookie: `hp_session=${hk.sessionId}` }
    for (const was of ['link', 'send', 'revoke']) {
      const a = await app.inject({ method: 'POST',
        url: `/v1/reservations/${r.ref}/online-checkin/${was}`, headers: h })
      expect(a.statusCode, was).toBe(403)
    }
  })
})

describe('Rezeption', () => {
  async function versandBereit(): Promise<void> {
    await makeEmailDomain(owner, fx.propertyId, 'seeblick.test')
    await owner.query(
      `INSERT INTO property_email_setting (property_id, from_name, from_email, enabled)
       VALUES ($1,'Hotel Seeblick','post@seeblick.test',true)`, [fx.propertyId])
  }

  it('schickt den Link an die Adresse am Gastprofil', async () => {
    await versandBereit()
    const r = await reservierung()
    const s = await app.inject({ method: 'POST',
      url: `/v1/reservations/${r.ref}/online-checkin/send`, headers: chef })
    expect(s.statusCode, s.body).toBe(202)
    const m = await owner.query<{ kind: string; to_email: string; body_text: string }>(
      `SELECT kind, to_email, body_text FROM outbound_email WHERE reservation_id = $1`, [r.id])
    expect(m.rows[0]).toMatchObject({ kind: 'checkin_invitation',
                                      to_email: `gast${nummer}@example.test` })
    expect(m.rows[0]!.body_text).toMatch(/\/checkin#[A-Za-z0-9_-]{43}/)
    // Das Token im Rumpf oeffnet die Seite.
    const token = /\/checkin#([A-Za-z0-9_-]{43})/.exec(m.rows[0]!.body_text)![1]!
    expect((await formular(token)).statusCode).toBe(200)

    // Und das Seitenfenster zeigt es.
    const d = JSON.parse((await app.inject({ method: 'GET',
      url: `/v1/reservations/${r.ref}`, headers: chef })).body) as {
        onlineCheckin: { invitedAt: string | null; activeLinks: number
                         completedAt: string | null } }
    expect(d.onlineCheckin.invitedAt).not.toBeNull()
    expect(d.onlineCheckin.activeLinks).toBe(1)
    expect(d.onlineCheckin.completedAt).toBeNull()
  })

  it('sagt, warum nicht, wenn der Versand aus ist', async () => {
    const r = await reservierung()
    const s = await app.inject({ method: 'POST',
      url: `/v1/reservations/${r.ref}/online-checkin/send`, headers: chef })
    expect(s.statusCode).toBe(422)
    expect(JSON.parse(s.body).code).toBe('checkin.mailNotReady')
  })

  it('zeigt am Seitenfenster und im Tresen-Meldeschein, dass die Unterschrift fehlt', async () => {
    const r = await reservierung({ anreise: HEUTE })
    expect((await einreichen(await mailLink(r.ref), auslaendisch())).statusCode).toBe(201)

    const d = JSON.parse((await app.inject({ method: 'GET',
      url: `/v1/reservations/${r.ref}`, headers: chef })).body) as {
        onlineCheckin: { completedAt: string | null; source: string
                         signaturePending: boolean } }
    expect(d.onlineCheckin).toMatchObject({ source: 'online', signaturePending: true })
    expect(d.onlineCheckin.completedAt).not.toBeNull()

    const f = JSON.parse((await app.inject({ method: 'GET',
      url: `/v1/reservations/${r.ref}/registration-form`, headers: chef })).body) as {
        registrationId: number; signaturePending: boolean; alreadyRegistered: boolean }
    expect(f).toMatchObject({ alreadyRegistered: true, signaturePending: true })
    const u = await app.inject({ method: 'POST',
      url: `/v1/registrations/${f.registrationId}/sign`, headers: chef,
      payload: { signatureSvg: UNTERSCHRIFT } })
    expect(u.statusCode, u.body).toBe(200)
  })

  it('gibt keinen Link aus, wenn der Meldeschein schon vorliegt', async () => {
    const r = await reservierung()
    expect((await einreichen(await mailLink(r.ref), inlaendisch())).statusCode).toBe(201)
    const l = await app.inject({ method: 'POST',
      url: `/v1/reservations/${r.ref}/online-checkin/link`, headers: chef })
    expect(l.statusCode).toBe(409)
  })

  it('haelt die Einstellung je Haus', async () => {
    const vorher = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/online-checkin-settings`, headers: chef })
    expect(JSON.parse(vorher.body)).toEqual({ enabled: false, daysBefore: 3 })
    const put = await app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/online-checkin-settings`, headers: chef,
      payload: { enabled: true, daysBefore: 5 } })
    expect(put.statusCode, put.body).toBe(200)
    const zuviel = await app.inject({ method: 'PUT',
      url: `/v1/properties/${fx.propertyId}/online-checkin-settings`, headers: chef,
      payload: { enabled: true, daysBefore: 60 } })
    expect(zuviel.statusCode).toBe(422)
    const nachher = await app.inject({ method: 'GET',
      url: `/v1/properties/${fx.propertyId}/online-checkin-settings`, headers: chef })
    expect(JSON.parse(nachher.body)).toEqual({ enabled: true, daysBefore: 5 })
  })
})

describe('Loeschung', () => {
  it('nimmt die Links mit, und ein alter Link oeffnet nichts mehr', async () => {
    const r = await reservierung()
    const token = await mailLink(r.ref)
    // Mit offener Reservierung verweigert die Route die Loeschung; der Gast
    // ist abgereist.
    await owner.query(`UPDATE reservation SET status = 'CheckedOut',
                              checked_in_at = now(), checked_out_at = now(),
                              resource_id = $2 WHERE id = $1`, [r.id, zimmer[0]])
    const a = await app.inject({ method: 'POST',
      url: `/v1/guests/${r.guestRef}/anonymize`, headers: chef })
    expect(a.statusCode, a.body).toBe(200)
    const n = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM checkin_token WHERE reservation_id = $1`, [r.id])
    expect(n.rows[0]!.n).toBe(0)
    expect((await formular(token)).statusCode).toBe(404)
  })

  it('nimmt sie auch bei der aufgeschobenen Loeschung mit', async () => {
    const r = await reservierung()
    await mailLink(r.ref)
    await withTransaction(pool,
      { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null },
      c => c.query(`SELECT guest_erase_partial($1)`, [r.guestId]))
    const n = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM checkin_token WHERE reservation_id = $1`, [r.id])
    expect(n.rows[0]!.n).toBe(0)
  })
})
