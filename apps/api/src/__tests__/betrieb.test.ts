import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeUser, makeGuest, openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'
import { RateLimiter, limiters } from '../platform/rateLimit.js'
import { encryptIdDocument, decryptIdDocument } from '../platform/crypto.js'
import { LOGIN_LIMIT, ANON_LIMIT } from '../platform/rateLimit.js'

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let lauf = 0

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
  await makeCategory(owner, fx.propertyId)
  await openBusinessDay(owner, fx.propertyId)
  const u = await makeUser(owner,
    { email: 'chef@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

describe('Ratenbegrenzung', () => {
  /**
   * Der Angriff, den die Kontosperre nicht abfängt: ein bekanntes Kennwort
   * gegen viele Adressen. Jede Adresse bleibt unter ihrer eigenen Grenze,
   * und die Sperre greift nie.
   */
  it('begrenzt je Herkunft, nicht je Konto', () => {
    const l = new RateLimiter({ limit: 3, windowMs: 60_000 })
    expect(l.check('1.2.3.4')).toBe(2)
    expect(l.check('1.2.3.4')).toBe(1)
    expect(l.check('1.2.3.4')).toBe(0)
    expect(l.check('1.2.3.4')).toBeNull()
    // Eine andere Herkunft ist unberuehrt.
    expect(l.check('5.6.7.8')).toBe(2)
  })

  it('gibt nach Ablauf des Fensters wieder frei', () => {
    const l = new RateLimiter({ limit: 2, windowMs: 1000 })
    const t = 1_000_000
    l.check('a', t); l.check('a', t)
    expect(l.check('a', t + 500)).toBeNull()
    expect(l.check('a', t + 1001)).toBe(1)
  })

  /**
   * Ohne Aufräumen wüchse die Karte mit jeder je gesehenen Adresse. Ein
   * Angreifer mit vielen Adressen bräuchte dann gar keine erfolgreichen
   * Anfragen, um Schaden anzurichten: er füllte den Speicher.
   */
  it('haelt die Zahl beobachteter Herkuenfte begrenzt', () => {
    const l = new RateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 256 })
    for (let i = 0; i < 2000; i++) l.check(`10.0.${i >> 8}.${i & 255}`)
    expect(l.size).toBeLessThanOrEqual(256)
  })

  it('weist zu viele Anmeldeversuche mit 429 ab', async () => {
    let letzte = 0
    for (let i = 0; i < LOGIN_LIMIT.limit + 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/v1/auth/login',
        payload: { email: `spray${i}@test.de`, password: 'egal' },
        remoteAddress: '203.0.113.7' })
      letzte = r.statusCode
      if (letzte === 429) break
    }
    expect(letzte).toBe(429)
  })

  it('laesst angemeldete Anfragen unbegrenzt durch', async () => {
    for (let i = 0; i < 40; i++) {
      const r = await app.inject({
        method: 'GET', url: `/v1/properties/${fx.propertyId}/setup-status`,
        headers: auth, remoteAddress: '203.0.113.9' })
      // Eine Rezeption, die im Andrang gebremst wird, ist ein Schaden ohne
      // Gegenwert. Missbrauch durch Angemeldete ist ein Rollenproblem.
      expect(r.statusCode).toBe(200)
    }
  })

  /**
   * Der Fehler, den dieser Test festhaelt: die Ausnahme fuer Angemeldete
   * pruefte nur, **ob** ein Sitzungscookie da war, nie **was** darin stand.
   * `hp_session=x` hob die Begrenzung damit vollstaendig auf -- sieben
   * Zeichen, die ein Angreifer als Erstes probiert.
   */
  it('laesst sich nicht mit einem erfundenen Sitzungscookie umgehen', async () => {
    let letzte = 0
    for (let i = 0; i < ANON_LIMIT.limit + 5; i++) {
      const r = await app.inject({
        method: 'GET', url: `/v1/properties/${fx.propertyId}/setup-status`,
        headers: { cookie: 'hp_session=erfunden' }, remoteAddress: '203.0.113.11' })
      letzte = r.statusCode
      if (letzte === 429) break
      // Solange die Grenze nicht greift, bleibt es bei "nicht angemeldet".
      expect(r.statusCode).toBe(401)
    }
    expect(letzte).toBe(429)
  })

  it('laesst sich auch nicht mit einem erfundenen Bearer-Token umgehen', async () => {
    let letzte = 0
    for (let i = 0; i < ANON_LIMIT.limit + 5; i++) {
      const r = await app.inject({
        method: 'GET', url: `/v1/properties/${fx.propertyId}/setup-status`,
        headers: { authorization: 'Bearer erfunden' }, remoteAddress: '203.0.113.12' })
      letzte = r.statusCode
      if (letzte === 429) break
      expect(r.statusCode).toBe(401)
    }
    expect(letzte).toBe(429)
  })
})

describe('Schulungsbetrieb', () => {
  const alsSchulung = () =>
    owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])

  it('nennt das Kennzeichen in der Selbstauskunft', async () => {
    await alsSchulung()
    const r = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth })
    const me = JSON.parse(r.body) as { properties: Array<{ isTraining: boolean }> }
    // Wer nicht sieht, dass er uebt, uebt irgendwann versehentlich am
    // echten Haus.
    expect(me.properties[0]!.isTraining).toBe(true)
  })

  /**
   * Ein DATEV-Stapel aus Übungsdaten landet in der echten Buchhaltung, und
   * eine Beherbergungsstatistik aus Übungsdaten ist eine falsche Meldung an
   * eine Behörde. Beides ist schwerer zu korrigieren als zu verhindern.
   */
  it('verweigert Buchhaltungs- und Behoerdenexporte', async () => {
    await alsSchulung()
    const pfade = [
      `/v1/properties/${fx.propertyId}/exports/datev?from=2026-10-01&to=2026-10-31`,
      `/v1/properties/${fx.propertyId}/exports/gobd?from=2026-10-01&to=2026-10-31`,
      `/v1/properties/${fx.propertyId}/accommodation-statistics?month=2026-10`
    ]
    for (const p of pfade) {
      const r = await app.inject({ method: 'GET', url: p, headers: auth })
      expect(r.statusCode, p).toBe(422)
      expect(JSON.parse(r.body).detail).toContain('Schulungshaus')
    }
  })

  it('laesst dieselben Exporte im echten Haus zu', async () => {
    const r = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/exports/gobd?from=2026-10-01&to=2026-10-31` })
    expect(r.statusCode).toBe(200)
  })

  it('setzt ein sichtbares Kuerzel vor die Rechnungsnummer', async () => {
    await alsSchulung()
    const gast = await makeGuest(owner, fx.accountId)
    const f = await owner.query<{ public_ref: string }>(
      `INSERT INTO folio (property_id, kind, guest_id) VALUES ($1,'guest',$2)
       RETURNING public_ref`, [fx.propertyId, gast.id])
    await app.inject({ method: 'POST', url: `/v1/folios/${f.rows[0]!.public_ref}/charges`,
      headers: { ...auth, 'idempotency-key': `c${++lauf}` },
      payload: { description: 'Uebung', netCent: 30_000, taxRateBp: 700 } })

    const r = await app.inject({ method: 'POST',
      url: `/v1/folios/${f.rows[0]!.public_ref}/invoice`,
      headers: { ...auth, 'idempotency-key': `i${++lauf}` }, payload: {} })
    expect(r.statusCode, r.body).toBe(201)
    // Eine Uebungsrechnung muss man auch dann erkennen, wenn sie
    // ausgedruckt auf dem Tresen liegt.
    expect((JSON.parse(r.body) as { number: string }).number).toMatch(/^UEBUNG-/)
  })

  it('laesst die Nummer im echten Haus unveraendert', async () => {
    const gast = await makeGuest(owner, fx.accountId)
    const f = await owner.query<{ public_ref: string }>(
      `INSERT INTO folio (property_id, kind, guest_id) VALUES ($1,'guest',$2)
       RETURNING public_ref`, [fx.propertyId, gast.id])
    await app.inject({ method: 'POST', url: `/v1/folios/${f.rows[0]!.public_ref}/charges`,
      headers: { ...auth, 'idempotency-key': `c${++lauf}` },
      payload: { description: 'Echt', netCent: 30_000, taxRateBp: 700 } })
    const r = await app.inject({ method: 'POST',
      url: `/v1/folios/${f.rows[0]!.public_ref}/invoice`,
      headers: { ...auth, 'idempotency-key': `i${++lauf}` }, payload: {} })
    expect((JSON.parse(r.body) as { number: string }).number).toMatch(/^\d{4}-\d{5}$/)
  })
})

describe('Mandantenexport', () => {
  /**
   * Ein Anbieter, der Daten als Geisel hält, wird genau einmal empfohlen.
   * Der Export ist deshalb vollständig und in offenem Format.
   */
  it('liefert alle Fachdaten der Property', async () => {
    const kontoChef = await makeUser(owner,
      { email: 'inhaber@test.de', accountId: fx.accountId, roleKey: 'owner' })
    const gast = await makeGuest(owner, fx.accountId)
    const cat = await owner.query<{ id: number }>(
      `SELECT id FROM resource_category WHERE property_id = $1 LIMIT 1`, [fx.propertyId])
    const b = await owner.query<{ id: number }>(
      `INSERT INTO booking (property_id, source) VALUES ($1,'direct') RETURNING id`,
      [fx.propertyId])
    await owner.query(
      `INSERT INTO reservation (property_id, booking_id, category_id, arrival, departure,
                                primary_guest_id)
       VALUES ($1,$2,$3,'2026-10-01','2026-10-03',$4)`,
      [fx.propertyId, b.rows[0]!.id, cat.rows[0]!.id, gast.id])

    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/exports/tenant`,
      headers: { cookie: `hp_session=${kontoChef.sessionId}` } })
    expect(r.statusCode, r.body).toBe(200)

    const e = JSON.parse(r.body) as {
      property: { code: string }
      reservations: unknown[]; guests: unknown[]
      zeilenzahl: Record<string, number>; hinweise: string[] }
    expect(e.property.code).toBe('TEST')
    expect(e.reservations).toHaveLength(1)
    expect(e.guests).toHaveLength(1)
    expect(e.zeilenzahl.reservations).toBe(1)
    expect(e.hinweise.join(' ')).toContain('acht Jahre')
  })

  /**
   * Die Ausweisnummer ohne den Schlüssel zu exportieren wäre nutzlos, mit
   * dem Schlüssel wäre es eine Weitergabe des Schlüssels.
   */
  it('gibt die Ausweisnummer nicht mit, wohl aber ihre Schluesselversion', async () => {
    const kontoChef = await makeUser(owner,
      { email: 'inhaber@test.de', accountId: fx.accountId, roleKey: 'owner' })
    const gast = await makeGuest(owner, fx.accountId)
    await owner.query(
      `UPDATE guest SET id_document_number_enc = $2, id_document_key_version = 1
        WHERE id = $1`, [gast.id, Buffer.from('geheim')])
    const cat = await owner.query<{ id: number }>(
      `SELECT id FROM resource_category WHERE property_id = $1 LIMIT 1`, [fx.propertyId])
    const b = await owner.query<{ id: number }>(
      `INSERT INTO booking (property_id, source) VALUES ($1,'direct') RETURNING id`,
      [fx.propertyId])
    await owner.query(
      `INSERT INTO reservation (property_id, booking_id, category_id, arrival, departure,
                                primary_guest_id)
       VALUES ($1,$2,$3,'2026-10-01','2026-10-03',$4)`,
      [fx.propertyId, b.rows[0]!.id, cat.rows[0]!.id, gast.id])

    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/exports/tenant`,
      headers: { cookie: `hp_session=${kontoChef.sessionId}` } })
    expect(r.body).not.toContain('id_document_number_enc')
    const e = JSON.parse(r.body) as {
      guests: Array<{ id_document_key_version: number }> }
    expect(e.guests[0]!.id_document_key_version).toBe(1)
  })

  it('bleibt der Rezeption verwehrt', async () => {
    const rez = await makeUser(owner,
      { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
    const r = await app.inject({
      method: 'GET', url: `/v1/properties/${fx.propertyId}/exports/tenant`,
      headers: { cookie: `hp_session=${rez.sessionId}` } })
    // Wer das ganze Haus exportiert, beendet in der Regel den Vertrag.
    // Das ist keine Entscheidung der Rezeption.
    expect(r.statusCode).toBe(403)
  })
})

describe('Schluesselrotation', () => {
  /**
   * Der Grund, warum die Version an jedem einzelnen Datensatz steht und
   * nicht an einer Stelle für alle: während einer Rotation ist der Bestand
   * gemischt, und gemischt muss ein gültiger Zustand sein, kein kaputter.
   */
  it('liest einen Datensatz mit der Version, mit der er geschrieben wurde', () => {
    const alt = 'schluessel-eins-mindestens-zweiunddreissig'
    const neu = 'schluessel-zwei-mindestens-zweiunddreissig'

    const a = encryptIdDocument('C01X00T47', alt, 1)
    const b = encryptIdDocument('C01X00T47', neu, 2)

    expect(decryptIdDocument(a.ciphertext, alt, a.keyVersion)).toBe('C01X00T47')
    expect(decryptIdDocument(b.ciphertext, neu, b.keyVersion)).toBe('C01X00T47')
    // Gleicher Klartext, verschiedene Chiffrate: sonst waere aus dem
    // Chiffrat ablesbar, dass zwei Gaeste denselben Ausweis haben.
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
  })

  it('faellt beim falschen Schluessel auf, statt Unsinn zu liefern', () => {
    const a = encryptIdDocument('C01X00T47', 'schluessel-eins-mindestens-zweiunddreissig', 1)
    // AES-GCM ist authentifiziert: ein falscher Schluessel wirft, er
    // entschluesselt nicht zu zufaelligen Zeichen.
    expect(() => decryptIdDocument(
      a.ciphertext, 'schluessel-zwei-mindestens-zweiunddreissig', 1)).toThrow()
  })

  it('merkt eine Veraenderung am Chiffrat', () => {
    const a = encryptIdDocument('C01X00T47', 'schluessel-eins-mindestens-zweiunddreissig', 1)
    const verbogen = Buffer.from(a.ciphertext)
    verbogen[verbogen.length - 1] ^= 0xff
    expect(() => decryptIdDocument(
      verbogen, 'schluessel-eins-mindestens-zweiunddreissig', 1)).toThrow()
  })
})
