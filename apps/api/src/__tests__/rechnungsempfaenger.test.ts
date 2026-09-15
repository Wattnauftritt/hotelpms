import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeGuest, makeCategory, makeResources, makeReservation, makePaymentMethod,
         openBusinessDay, type Fixture } from '@hotelpms/testing'
import type { Pool } from '@hotelpms/db'
import { buildServer } from '../platform/app.js'
import { registerAllRoutes } from '../routes/index.js'

/**
 * Wer die Rechnung bekommt.
 *
 * Die Rechnung geht nicht immer an den, der im Zimmer schläft: die Firma
 * zahlt, der Ehepartner zahlt, die Reisestelle zahlt. Bisher stand der
 * Empfänger nur da, wo ihn die Buchung hingeschrieben hatte, und eine
 * Korrektur war an der Oberfläche nicht möglich — wer sich vertippt hatte,
 * bekam die Rechnung an den Falschen und musste sie stornieren.
 *
 * Zwei Dinge sind hier die Prüfung wert: dass die **Firma vorgeht**, und
 * dass eine **festgeschriebene** Rechnung sich nicht mehr umadressieren
 * lässt — ihr Empfänger ist eine Momentaufnahme.
 */

let owner: Pool
let app: FastifyInstance
let pool: Pool
let fx: Fixture
let auth: Record<string, string>
let categoryId: number

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

let lauf = 0
const key = (): string => `re-${++lauf}-${Date.now()}`

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  await owner.query(`UPDATE property SET tax_number = '21/815/09876' WHERE id = $1`,
    [fx.propertyId])
  await openBusinessDay(owner, fx.propertyId, new Date().toISOString().slice(0, 10))
  await makePaymentMethod(owner, fx.propertyId, 'BAR')
  const u = await makeUser(owner,
    { email: 'rez@test.de', propertyId: fx.propertyId, roleKey: 'hotel_director' })
  auth = { cookie: `hp_session=${u.sessionId}` }
  categoryId = await makeCategory(owner, fx.propertyId)
  await makeResources(owner, fx.propertyId, categoryId, 1)
})

interface Empfaenger {
  kind: 'company' | 'guest' | 'none'
  name: string
  guestRef: string | null
  companyRef: string | null
  hasAddress: boolean
}

async function folioMitGast(): Promise<{ folioRef: string; guestRef: string }> {
  const gast = await makeGuest(owner, fx.accountId)
  const res = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId,
    arrival: '2027-08-01', departure: '2027-08-03',
    priceCent: 10_000, reserveInventory: false })
  const f = await owner.query<{ public_ref: string }>(
    `UPDATE folio SET guest_id = $2 WHERE id = $1 RETURNING public_ref`,
    [res.folioId, gast.id])
  const g = await owner.query<{ public_ref: string }>(
    `SELECT public_ref FROM guest WHERE id = $1`, [gast.id])
  return { folioRef: f.rows[0]!.public_ref, guestRef: g.rows[0]!.public_ref }
}

async function firma(name = 'Werft Nord GmbH', mitAnschrift = true): Promise<string> {
  const r = await app.inject({
    method: 'POST', url: '/v1/companies', headers: auth,
    payload: { name, ...(mitAnschrift
      ? { addressLine1: 'Hafenstrasse 1', postalCode: '24937', city: 'Flensburg' }
      : {}) } })
  expect(r.statusCode).toBe(201)
  return (r.json() as { companyRef: string }).companyRef
}

const setzen = (folioRef: string, payload: unknown, wer = auth) => app.inject({
  method: 'PATCH', url: `/v1/folios/${folioRef}/recipient`, headers: wer, payload })

const lesen = async (folioRef: string): Promise<Empfaenger> =>
  ((await app.inject({ method: 'GET', url: `/v1/folios/${folioRef}`, headers: auth })
    .then(r => r.json())) as { recipient: Empfaenger }).recipient

const fakturieren = (folioRef: string) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/invoice`,
  headers: { ...auth, 'idempotency-key': key() }, payload: {} })

const buchen = (folioRef: string, netCent = 20_000) => app.inject({
  method: 'POST', url: `/v1/folios/${folioRef}/charges`,
  headers: { ...auth, 'idempotency-key': key() },
  payload: { description: 'Uebernachtung', netCent, taxRateBp: 700 } })

describe('Rechnungsempfaenger', () => {
  it('nennt den Gast des Folios, solange keine Firma gesetzt ist', async () => {
    const { folioRef, guestRef } = await folioMitGast()
    const e = await lesen(folioRef)
    expect(e.kind).toBe('guest')
    expect(e.guestRef).toBe(guestRef)
    expect(e.companyRef).toBeNull()
  })

  it('laesst die Firma vorgehen, ohne den Gast zu entfernen', async () => {
    const { folioRef, guestRef } = await folioMitGast()
    const companyRef = await firma()

    const r = await setzen(folioRef, { companyRef })
    expect(r.statusCode).toBe(200)
    const e = (r.json() as { recipient: Empfaenger }).recipient
    expect(e.kind).toBe('company')
    expect(e.name).toBe('Werft Nord GmbH')

    // Der Gast bleibt am Folio stehen: entfernt man die Firma wieder, ist
    // er wieder der Empfaenger. Ihn beim Setzen zu loeschen waere ein
    // stiller Datenverlust.
    const zurueck = await setzen(folioRef, { companyRef: null })
    const danach = (zurueck.json() as { recipient: Empfaenger }).recipient
    expect(danach.kind).toBe('guest')
    expect(danach.guestRef).toBe(guestRef)
  })

  it('schreibt den Empfaenger auf die Rechnung, die danach entsteht', async () => {
    const { folioRef } = await folioMitGast()
    const companyRef = await firma()
    await setzen(folioRef, { companyRef })
    await buchen(folioRef)

    const r = await fakturieren(folioRef)
    expect(r.statusCode).toBe(201)
    const snapshot = await owner.query<{ recipient_snapshot: { name: string } }>(
      `SELECT recipient_snapshot FROM invoice WHERE folio_id =
         (SELECT id FROM folio WHERE public_ref = $1)`, [folioRef])
    expect(snapshot.rows[0]!.recipient_snapshot.name).toBe('Werft Nord GmbH')
  })

  it('aendert eine festgeschriebene Rechnung nicht mehr', async () => {
    const { folioRef } = await folioMitGast()
    await buchen(folioRef)
    await fakturieren(folioRef)

    const companyRef = await firma('Spaetes Kontor GmbH')
    const r = await setzen(folioRef, { companyRef })
    expect(r.statusCode).toBe(200)

    /*
     * Der Kern: die Momentaufnahme der Rechnung bleibt, wie sie war. Waere
     * sie nachtraeglich aenderbar, waere jeder gedruckte Beleg beim Gast
     * eine andere Rechnung als die im Haus.
     */
    const snapshot = await owner.query<{ recipient_snapshot: { name: string } }>(
      `SELECT recipient_snapshot FROM invoice WHERE folio_id =
         (SELECT id FROM folio WHERE public_ref = $1)`, [folioRef])
    expect(snapshot.rows[0]!.recipient_snapshot.name).not.toBe('Spaetes Kontor GmbH')
  })

  it('sagt vorher, dass die Anschrift fehlt', async () => {
    const { folioRef } = await folioMitGast()
    const ohne = await firma('Kontor ohne Anschrift', false)
    const r = await setzen(folioRef, { companyRef: ohne })

    // § 14 Abs. 4 Nr. 1 UStG: ohne Anschrift keine Rechnung. Die Maske soll
    // das sagen, bevor jemand auf "Rechnung erstellen" drueckt.
    expect((r.json() as { recipient: Empfaenger }).recipient.hasAddress).toBe(false)

    /*
     * Geprueft wird mit einem Betrag **ueber** der Kleinbetragsgrenze. Eine
     * Rechnung bis 250 Euro ist nach § 33 UStDV auch ohne Empfaengerangaben
     * gueltig -- der erste Anlauf dieses Tests buchte 214 Euro und ging
     * durch, zu Recht. `hasAddress` ist deshalb ein Hinweis und kein
     * Verbot; welcher von beiden gilt, entscheidet die Summe.
     */
    await buchen(folioRef, 30_000)
    const inv = await fakturieren(folioRef)
    expect(inv.statusCode).toBe(422)
  })

  it('laesst eine Kleinbetragsrechnung ohne Empfaengeranschrift zu', async () => {
    const { folioRef } = await folioMitGast()
    await setzen(folioRef, { companyRef: await firma('Kleines Kontor', false) })
    await buchen(folioRef, 10_000)   // 107 Euro, unter der Grenze

    // § 33 UStDV. Das ist keine Luecke, sondern der Bon an der Bar.
    expect((await fakturieren(folioRef)).statusCode).toBe(201)
  })

  it('verlangt das Recht, Rechnungen auszustellen', async () => {
    const { folioRef } = await folioMitGast()
    const companyRef = await firma()
    // Wer eine Minibar bucht, soll keine Rechnung umleiten koennen.
    const hk = await makeUser(owner,
      { email: 'hk@test.de', propertyId: fx.propertyId, roleKey: 'housekeeping' })
    const r = await setzen(folioRef, { companyRef },
      { cookie: `hp_session=${hk.sessionId}` })
    expect(r.statusCode).toBe(403)
  })

  it('weist ein geschlossenes Folio und einen erfundenen Verweis ab', async () => {
    const { folioRef } = await folioMitGast()
    expect((await setzen(folioRef, { companyRef: 'GIBTESNICHT' })).statusCode).toBe(404)
    expect((await setzen(folioRef, {})).statusCode).toBe(422)

    await owner.query(`UPDATE folio SET status = 'closed' WHERE public_ref = $1`,
      [folioRef])
    expect((await setzen(folioRef, { guestRef: null })).statusCode).toBe(409)
  })
})
