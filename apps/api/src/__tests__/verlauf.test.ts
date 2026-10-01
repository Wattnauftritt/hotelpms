import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeUser, makeReservation, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Der Aenderungsverlauf.
 *
 * Geprueft wird, was ihn brauchbar oder unbrauchbar macht: dass eine
 * Verlegung mit beiden Werten darin steht, dass `updated_at` **nicht** darin
 * steht, dass eine Gruppe ihre Eintraege nicht achtmal zeigt -- und dass das
 * fremde Haus unsichtbar bleibt. Das Letzte ist der Grund, warum diese Route
 * ueberhaupt eine eigene Datei bekommt: `audit_log` traegt die Daten **aller**
 * Mandanten, und sie ist die erste Route, die daraus liest.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let dz: number
let ez: number
let zimmer: number[]
let auth: Record<string, string>

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
  dz = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  ez = await makeCategory(owner, fx.propertyId, { code: 'EZ' })
  zimmer = await makeResources(owner, fx.propertyId, dz, 2)
  await makeResources(owner, fx.propertyId, ez, 1, 'E')
  await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
    [fx.propertyId])
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'reception' })
  auth = { cookie: `hp_session=${u.sessionId}` }
})

/** Eine Buchung mit zwei Zimmern. Der Idempotenzschluessel ist Pflicht. */
const gruppe = (schluessel: string) =>
  app.inject({ method: 'POST', url: '/v1/bookings',
    headers: { ...auth, 'idempotency-key': schluessel },
    payload: { propertyId: fx.propertyId, arrival: '2026-10-10',
               departure: '2026-10-12',
               rooms: [{ categoryId: dz, totalCent: 20_000 },
                       { categoryId: ez, totalCent: 10_000 }] } })

async function reservierung(): Promise<string> {
  const r = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: dz,
    arrival: '2026-10-01', departure: '2026-10-04', priceCent: 9_000 })
  const q = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM reservation WHERE id = $1`, [r.reservationId])
  return q.rows[0]!.public_ref
}

describe('Aenderungsverlauf am Zimmerplan', () => {
  it('zeigt eine Verlegung mit beiden Werten und dem Benutzer', async () => {
    const ref = await reservierung()
    const r = await app.inject({ method: 'POST', headers: auth,
      url: `/v1/reservations/${ref}/change-stay`,
      payload: { arrival: '2026-10-05', departure: '2026-10-08',
                 resourceId: zimmer[0] } })
    expect(r.statusCode).toBe(200)

    const v = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/changes` })
    expect(v.statusCode).toBe(200)
    const { changes, rooms } = v.json()

    const verlegt = changes.find((c: { table: string; fields: Record<string, unknown> }) =>
      c.table === 'reservation' && 'arrival' in c.fields)
    expect(verlegt).toBeDefined()
    expect(verlegt.fields.arrival).toEqual({ von: '2026-10-01', nach: '2026-10-05' })
    expect(verlegt.fields.departure).toEqual({ von: '2026-10-04', nach: '2026-10-08' })
    expect(verlegt.fields.resource_id).toEqual({ von: null, nach: zimmer[0] })
    // Wer. Ohne das beantwortet der Verlauf die halbe Frage.
    expect(verlegt.user).toBe('rez@test.de')
    expect(verlegt.reservationRef).toBe(ref)

    // Die Zimmernummer steht nicht im Protokoll -- dort steht eine Kennung.
    // Ohne die Namen daneben zeigt die Oberflaeche "7 → 9".
    expect(rooms[String(zimmer[0])]).toBeDefined()
  })

  it('laesst Zeilen weg, in denen nur die Zeitstempel gewandert sind', async () => {
    /*
     * `updated_at` aendert sich bei jedem Schreiben. Eine Liste, in der
     * neunzig Prozent "aktualisiert am" ist, liest niemand zweimal -- und
     * die eine Zeile, die zaehlt, steht dann auf Seite drei.
     */
    const ref = await reservierung()
    await owner.query(
      `UPDATE reservation SET updated_at = now() WHERE public_ref = $1`, [ref])
    const v = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/changes` })
    const changes = v.json().changes as Array<{ action: string; fields: object }>
    for (const c of changes) {
      if (c.action === 'UPDATE') expect(Object.keys(c.fields).length).toBeGreaterThan(0)
    }
  })

  it('zeigt den Verlauf einer Buchung mit allen ihren Zimmern', async () => {
    const r = await gruppe('k-1')
    expect(r.statusCode).toBe(201)
    const bookingRef = r.json().bookingRef

    const v = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/bookings/${bookingRef}/history` })
    expect(v.statusCode).toBe(200)
    const changes = v.json().changes as Array<{ table: string; bookingRef: string }>

    // Beide Zimmer, die Buchung und die Preise -- in einer Liste.
    expect(changes.filter(c => c.table === 'reservation').length).toBe(2)
    expect(changes.some(c => c.table === 'booking')).toBe(true)
    /*
     * Der Preis steht in `reservation_night`, nicht in `charge`: eine
     * Position entsteht erst, wenn der Nachtlauf die Nacht bucht. Fuer eine
     * Buchung in der Zukunft -- also fuer jede, die noch jemand aendert --
     * waere ein Verlauf, der nur `charge` kennt, bei der Frage nach dem
     * Preis stumm. Genau dafuer haengt die Tabelle seit Migration 0056 am
     * Audit-Trigger.
     */
    expect(changes.some(c => c.table === 'reservation_night')).toBe(true)

    /*
     * Die Buchungszeile genau **einmal**. Sie haengt an zwei Reservierungen,
     * und ein `UNION ALL` ueber die Zimmer zeigte jeden Eintrag der Buchung
     * doppelt -- bei acht Zimmern achtmal.
     */
    expect(changes.filter(c => c.table === 'booking').length).toBe(1)
  })

  it('zeigt bei einer Reservierung nur deren eigenen Verlauf', async () => {
    const r = await gruppe('k-2')
    const ref = r.json().reservations[0].reservationRef

    const v = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/reservations/${ref}/history` })
    const changes = v.json().changes as Array<{ table: string; reservationRef: string }>
    for (const c of changes) {
      if (c.table === 'reservation') expect(c.reservationRef).toBe(ref)
    }
    expect(changes.filter(c => c.table === 'reservation').length).toBe(1)
  })

  /**
   * Der Grund fuer Migration 0045: `audit_log` traegt die geaenderten Daten
   * **aller** Mandanten, und bis hierher hat niemand daraus gelesen. Die
   * Richtlinie wurde gesetzt, bevor es eine Route gab -- diese Pruefung
   * stellt sicher, dass sie auch greift, wenn es eine gibt.
   */
  it('zeigt kein fremdes Haus, auch nicht im selben Account', async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name, address_line1, postal_code,
                             city, country, tax_number)
       VALUES ($1,'ZWEI','Zweites Haus','Hafenstr. 2','25813','Husum','DE','21/815/00124')
       RETURNING id`, [fx.accountId])
    const p2 = zweites.rows[0]!.id
    const k2 = await makeCategory(owner, p2)
    await makeResources(owner, p2, k2, 1)
    await owner.query(`SELECT inventory_materialize($1,'2026-09-01'::date,'2026-12-01'::date)`,
      [p2])
    await makeReservation(owner, { propertyId: p2, categoryId: k2,
      arrival: '2026-10-01', departure: '2026-10-03', priceCent: 5_000 })

    // Der Benutzer hat nur das erste Haus.
    const v = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${p2}/changes` })
    expect(v.statusCode).toBe(403)

    // Und im eigenen Haus taucht nichts aus dem fremden auf.
    const eigen = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/changes` })
    const changes = eigen.json().changes as Array<{ reservationRef: string | null }>
    const fremd = await owner.query<{ public_ref: string }>(
      `SELECT public_ref FROM reservation WHERE property_id = $1`, [p2])
    const fremdeRefs = new Set(fremd.rows.map(x => x.public_ref))
    for (const c of changes) expect(fremdeRefs.has(c.reservationRef ?? '')).toBe(false)
  })

  it('haelt sich an die Obergrenze und blaettert rueckwaerts', async () => {
    const ref = await reservierung()
    for (const tag of ['2026-10-05', '2026-10-06', '2026-10-07']) {
      await app.inject({ method: 'POST', headers: auth,
        url: `/v1/reservations/${ref}/change-stay`,
        payload: { arrival: tag, departure: '2026-10-09' } })
    }
    const erste = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/changes?limit=2` })
    const a = erste.json().changes as Array<{ id: string }>
    expect(a).toHaveLength(2)

    const zweite = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/properties/${fx.propertyId}/changes?limit=2&before=${a[1]!.id}` })
    const b = zweite.json().changes as Array<{ id: string }>
    // Keine Zeile zweimal: der Cursor laeuft ueber die Kennung, nicht ueber
    // die Zeit -- zwei Aenderungen derselben Transaktion tragen dieselbe.
    expect(b.every(x => !a.some(y => y.id === x.id))).toBe(true)
  })

  it('verschweigt den Inhalt redigierter Felder, nennt aber das Feld', async () => {
    /*
     * Die Notiz steht in `audit_redaction` (Befund 1, Dokument 26): der
     * Schluessel bleibt, der Wert faellt. Der Verlauf beantwortet damit
     * "wer hat die Notiz geaendert" und nicht "was stand darin" -- und das
     * ist genau die Grenze, die die Loeschung nach Art. 17 braucht.
     */
    const ref = await reservierung()
    const r = await app.inject({ method: 'PATCH', headers: auth,
      url: `/v1/reservations/${ref}`, payload: { notes: 'Allergie gegen Nuesse' } })
    expect(r.statusCode).toBe(200)

    const v = await app.inject({ method: 'GET', headers: auth,
      url: `/v1/reservations/${ref}/history` })
    const changes = v.json().changes as Array<{ fields: Record<string, unknown> }>
    const notiz = changes.find(c => 'notes' in c.fields)
    expect(notiz).toBeDefined()
    /*
     * `[redigiert]` und nicht der Text: so schreibt der Trigger es seit
     * Migration 0044 ins Protokoll. Die Oberflaeche macht daraus "Notiz
     * geaendert" -- gezeigt wird, **dass** jemand sie angefasst hat.
     */
    expect(notiz!.fields.notes).toEqual({ von: '[redigiert]', nach: '[redigiert]' })
    expect(JSON.stringify(changes)).not.toContain('Nuesse')
  })
})
