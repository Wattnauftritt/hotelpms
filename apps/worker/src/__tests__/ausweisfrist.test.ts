import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeResources, makeReservation, type Fixture } from '@hotelpms/testing'
import { withTransaction, type DbContext, type Pool } from '@hotelpms/db'
import { purgeGuestDocuments } from '../jobs/maintenance.js'

/**
 * Die Frist der Ausweisnummer (§ 30 Abs. 2 und 4 BMG).
 *
 * **Der Befund, den diese Datei festhaelt.** Die Nummer stand nie auf dem
 * Meldeschein, sondern am Gastprofil -- `purgeRegistrations` loeschte
 * `registration` und liess sie unberuehrt liegen, unbegrenzt. Aufgefallen
 * ist das erst, als die Abgabenfrist des Hauses (Migration 0036) sich vor
 * die Anonymisierung stellte: damit stand der einzige verbliebene Loeschweg
 * bis zu sieben Jahre lang zu, und eine kommunale Abgabenfrist haette eine
 * bundesrechtliche Vernichtungspflicht ausgehebelt.
 *
 * Die beiden Fristen widersprechen sich nicht, sobald jede das tut, wofuer
 * sie da ist: das Gaesteverzeichnis braucht die Ausweisnummer nicht.
 */

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext
let catId: number
let rooms: number[]

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(10)
})
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  rooms = await makeResources(owner, fx.propertyId, catId, 5)
  await owner.query(`SELECT inventory_materialize($1,'2023-01-01'::date,'2028-12-01'::date)`,
    [fx.propertyId])
})

/** Ein Gast mit hinterlegter Ausweisnummer. Der Inhalt ist hier egal. */
async function gastMitAusweis(nachname = 'Petersen'): Promise<number> {
  const g = await owner.query<{ id: number }>(
    `INSERT INTO guest (account_id, last_name, id_document_type,
                        id_document_number_enc, id_document_key_version)
     VALUES ($1,$2,'passport','\\x0102030405'::bytea,1) RETURNING id`,
    [fx.accountId, nachname])
  return g.rows[0]!.id
}

async function aufenthalt(guestId: number, von: string, bis: string,
                          opts: { propertyId?: number; checkedOut?: string } = {}
): Promise<void> {
  const res = await makeReservation(owner, {
    propertyId: opts.propertyId ?? fx.propertyId, categoryId: catId,
    arrival: von, departure: bis, status: 'CheckedOut', resourceId: rooms[0]! })
  await owner.query(
    `UPDATE reservation SET primary_guest_id = $2, checked_out_at = $3
      WHERE id = $1`, [res.reservationId, guestId, opts.checkedOut ?? null])
}

async function hatAusweis(guestId: number): Promise<boolean> {
  const r = await owner.query<{ da: boolean }>(
    `SELECT id_document_number_enc IS NOT NULL AS da FROM guest WHERE id = $1`,
    [guestId])
  return r.rows[0]!.da
}

const laufen = () => withTransaction(app, ctx, c => purgeGuestDocuments(c))

describe('Ausweisnummer nach der Jahresfrist', () => {
  it('entfernt sie ein Jahr nach der Abreise', async () => {
    const g = await gastMitAusweis()
    await aufenthalt(g, '2024-05-01', '2024-05-04')

    expect(await laufen()).toBe(1)
    expect(await hatAusweis(g)).toBe(false)
  })

  it('laesst sie liegen, solange die Frist laeuft', async () => {
    const g = await gastMitAusweis()
    // Abreise vor wenigen Tagen: die Meldebehoerde darf noch Einsicht
    // verlangen, und der Beherbergungsbetrieb muss sie geben koennen.
    const heute = new Date()
    const vor = new Date(heute.getTime() - 5 * 86400_000).toISOString().slice(0, 10)
    const ab = new Date(heute.getTime() - 2 * 86400_000).toISOString().slice(0, 10)
    await aufenthalt(g, vor, ab)

    expect(await laufen()).toBe(0)
    expect(await hatAusweis(g)).toBe(true)
  })

  it('rechnet ab dem tatsaechlichen Abreisetag, wenn es einen gibt', async () => {
    const g = await gastMitAusweis()
    // Geplant bis 2024-05-04, tatsaechlich bis kurz vor heute geblieben.
    const spaet = new Date(Date.now() - 10 * 86400_000).toISOString()
    await aufenthalt(g, '2024-05-01', '2024-05-04', { checkedOut: spaet })

    expect(await laufen()).toBe(0)
    expect(await hatAusweis(g)).toBe(true)
  })

  /**
   * Der Grund, warum die Funktion SECURITY DEFINER ist: der Worker laeuft im
   * Kontext **einer** Property, und `reservation` traegt eine
   * Zeilenrichtlinie darueber. Ohne das faende der Lauf den Aufenthalt im
   * Schwesterhaus nicht -- und die Nummer fiele, waehrend die Frist dort
   * noch laeuft.
   */
  it('sieht auch den Aufenthalt im Schwesterhaus desselben Accounts', async () => {
    const zweites = await owner.query<{ id: number }>(
      `INSERT INTO property (account_id, code, name) VALUES ($1,'ZWEI','Schwester')
       RETURNING id`, [fx.accountId])
    const zweiteKat = await makeCategory(owner, zweites.rows[0]!.id, { code: 'DZ' })
    const zweiteZimmer = await makeResources(owner, zweites.rows[0]!.id, zweiteKat, 2)
    await owner.query(
      `SELECT inventory_materialize($1,'2023-01-01'::date,'2028-12-01'::date)`,
      [zweites.rows[0]!.id])

    const g = await gastMitAusweis()
    await aufenthalt(g, '2024-05-01', '2024-05-04')          // lange her
    const neu = await makeReservation(owner, {
      propertyId: zweites.rows[0]!.id, categoryId: zweiteKat,
      arrival: '2026-09-01', departure: '2026-09-04', status: 'CheckedOut',
      resourceId: zweiteZimmer[0]! })
    await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
      [neu.reservationId, g])

    // Der Lauf haengt am ersten Haus, die Frist am juengsten Aufenthalt.
    expect(await laufen()).toBe(0)
    expect(await hatAusweis(g)).toBe(true)
  })

  it('faellt ohne jeden Aufenthalt auf das Anlagedatum des Profils zurueck', async () => {
    const g = await gastMitAusweis()
    expect(await laufen()).toBe(0)          // gerade angelegt

    await owner.query(
      `UPDATE guest SET created_at = now() - INTERVAL '2 years' WHERE id = $1`, [g])
    expect(await laufen()).toBe(1)
    expect(await hatAusweis(g)).toBe(false)
  })

  /**
   * Die Funktion ist SECURITY DEFINER und nimmt deshalb bewusst **keinen**
   * Account entgegen: eine solche Funktion, der man eine fremde Kennung
   * nennen kann, waere ein Werkzeug, mit dem sich die Daten eines anderen
   * Mandanten zerstoeren lassen.
   */
  it('ruehrt einen fremden Account nicht an', async () => {
    const fremd = await makeProperty(owner, { name: 'Fremder', code: 'FRD' })
    const fremderGast = await owner.query<{ id: number }>(
      `INSERT INTO guest (account_id, last_name, id_document_type,
                          id_document_number_enc, id_document_key_version)
       VALUES ($1,'Fremd','passport','\\x0102030405'::bytea,1) RETURNING id`,
      [fremd.accountId])
    await owner.query(
      `UPDATE guest SET created_at = now() - INTERVAL '5 years' WHERE id = $1`,
      [fremderGast.rows[0]!.id])

    expect(await laufen()).toBe(0)
    expect(await hatAusweis(fremderGast.rows[0]!.id)).toBe(true)
  })

  it('tut bei leerem Kontext nichts', async () => {
    const g = await gastMitAusweis()
    await owner.query(
      `UPDATE guest SET created_at = now() - INTERVAL '5 years' WHERE id = $1`, [g])

    const leer: DbContext = { accountIds: [], propertyIds: [], userId: null }
    expect(await withTransaction(app, leer, c => purgeGuestDocuments(c))).toBe(0)
    expect(await hatAusweis(g)).toBe(true)
  })

  it('laeuft ein zweites Mal ohne Wirkung', async () => {
    const g = await gastMitAusweis()
    await aufenthalt(g, '2024-05-01', '2024-05-04')
    expect(await laufen()).toBe(1)
    expect(await laufen()).toBe(0)
  })
})
