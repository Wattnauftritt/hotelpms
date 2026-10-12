import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         makeCategory, makeResources, makeReservation, type Fixture } from '@hotelpms/testing'
import { withTransaction, type DbContext, type Pool } from '@hotelpms/db'
import { purgeRetention, purgeExpired, materializeInventory, materializeInventoryTail,
         reconcileInventory } from '../jobs/maintenance.js'
import { propertiesWithDuePushes } from '../jobs/staffPush.js'

/**
 * Pflege des Workers aus dem Performance-Audit vom 11.10.2026: Aufbewahrung
 * der Arbeitstabellen (Befund 13), Materialisierung nur am Ende des
 * Horizonts und Abgleich ohne Vergangenheit (Befund 14).
 */

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(4)
})
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
})

async function zustellung(subscriptionId: number, status: string, tageAlt: number,
                          ref: string): Promise<number> {
  const r = await owner.query<{ id: number }>(
    `INSERT INTO webhook_delivery (subscription_id, account_id, property_id, event_type,
                                   event_ref, payload, status, occurred_at)
     VALUES ($1, $2, $3, 'reservation.created', $4, '{"gross":1}'::jsonb, $5,
             now() - make_interval(days => $6))
     RETURNING id::int`,
    [subscriptionId, fx.accountId, fx.propertyId, ref, status, tageAlt])
  await owner.query(
    `INSERT INTO webhook_delivery_attempt (delivery_id, property_id, attempt, status_code)
     VALUES ($1, $2, 1, 500)`, [r.rows[0]!.id, fx.propertyId])
  return r.rows[0]!.id
}

describe('Aufbewahrung der Arbeitstabellen', () => {
  it('loescht erledigte Zustellungen nach 30 Tagen, offene nie', async () => {
    const s = await owner.query<{ id: number }>(
      `INSERT INTO webhook_subscription (account_id, url, signing_secret)
       VALUES ($1, 'https://empfaenger.example/', 'geheim') RETURNING id::int`,
      [fx.accountId])
    const sub = s.rows[0]!.id
    await zustellung(sub, 'delivered', 40, 'alt-zugestellt')
    await zustellung(sub, 'failed', 40, 'alt-gescheitert')
    await zustellung(sub, 'pending', 40, 'alt-offen')
    await zustellung(sub, 'delivered', 5, 'frisch')

    const r = await purgeRetention(owner)
    expect(r.webhookDeliveries).toBe(2)
    const rest = await owner.query<{ event_ref: string }>(
      `SELECT event_ref FROM webhook_delivery ORDER BY event_ref`)
    expect(rest.rows.map(x => x.event_ref)).toEqual(['alt-offen', 'frisch'])
    // Die Versuche fallen mit.
    const versuche = await owner.query(`SELECT 1 FROM webhook_delivery_attempt`)
    expect(versuche.rowCount).toBe(2)
  })

  it('loescht Versuche der Gastpost nach 90 Tagen und laesst die Nachricht stehen', async () => {
    const m = await owner.query<{ id: number }>(
      `INSERT INTO outbound_email (property_id, kind, to_email, subject, body_text, status)
       VALUES ($1, 'checkin_invitation_test', 'anna@gast.test', 'Test', 'x', 'sent')
       RETURNING id::int`, [fx.propertyId])
    await owner.query(
      `INSERT INTO outbound_email_attempt (email_id, property_id, attempt, error, attempted_at)
       VALUES ($1, $2, 1, 'abgelehnt: anna@gast.test', now() - interval '100 days'),
              ($1, $2, 2, NULL, now() - interval '10 days')`, [m.rows[0]!.id, fx.propertyId])

    expect((await purgeRetention(owner)).emailAttempts).toBe(1)
    const rest = await owner.query<{ attempt: number }>(
      `SELECT attempt FROM outbound_email_attempt`)
    expect(rest.rows).toEqual([{ attempt: 2 }])
    expect((await owner.query(`SELECT 1 FROM outbound_email`)).rowCount).toBe(1)
  })

  it('leert nach sieben Tagen den Rumpf der Zugangspost und gibt Liegengebliebenes auf', async () => {
    const u = await makeUser(owner, { email: 'neu@kunde.de', propertyId: fx.propertyId })
    await owner.query(
      `INSERT INTO platform_email (user_id, kind, to_email, subject, body_text, body_html,
                                   status, created_at)
       VALUES ($1, 'invite', 'neu@kunde.de', 'Einladung', 'Link: https://x/t/abc', '<a>',
               'pending', now() - interval '8 days'),
              ($1, 'invite', 'neu@kunde.de', 'Einladung', 'Link: https://x/t/def', NULL,
               'pending', now() - interval '1 day')`, [u.userId])

    expect((await purgeRetention(owner)).platformEmailBodies).toBe(1)
    const { rows } = await owner.query<{ body_text: string; body_html: string | null
                                         status: string; last_error: string | null }>(
      `SELECT body_text, body_html, status, last_error FROM platform_email ORDER BY created_at`)
    expect(rows).toEqual([
      { body_text: '', body_html: null, status: 'failed', last_error: 'expired' },
      { body_text: 'Link: https://x/t/def', body_html: null, status: 'pending',
        last_error: null }])
  })

  it('raeumt erledigte Uebersetzungsauftraege und Push-Meldungen nach 30 Tagen', async () => {
    const u = await makeUser(owner, { email: 'olga@kunde.de', propertyId: fx.propertyId,
                                      roleKey: 'housekeeping_staff' })
    await owner.query(
      `INSERT INTO staff_text_job (property_id, source_kind, source_id, targets, status,
                                   created_at)
       VALUES ($1, 'work_entry', 1, '{de}', 'done', now() - interval '40 days'),
              ($1, 'work_entry', 2, '{de}', 'pending', now() - interval '40 days'),
              ($1, 'work_entry', 3, '{de}', 'done', now() - interval '2 days')`,
      [fx.propertyId])
    await owner.query(
      `INSERT INTO staff_push (property_id, user_id, kind, dedupe_key, status, created_at)
       VALUES ($1, $2, 'plan', 'a', 'sent', now() - interval '40 days'),
              ($1, $2, 'plan', 'b', 'pending', now() - interval '40 days'),
              ($1, $2, 'plan', 'c', 'sent', now() - interval '2 days')`,
      [fx.propertyId, u.userId])

    const r = await purgeRetention(owner)
    expect(r).toMatchObject({ staffTextJobs: 1, staffPushes: 1 })
    const jobs = await owner.query<{ source_id: number }>(
      `SELECT source_id::int FROM staff_text_job ORDER BY source_id`)
    expect(jobs.rows.map(x => x.source_id)).toEqual([2, 3])
    const pushes = await owner.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM staff_push ORDER BY dedupe_key`)
    expect(pushes.rows.map(x => x.dedupe_key)).toEqual(['b', 'c'])
  })

  it('nennt die Haeuser mit faelliger Push-Meldung, und nur die', async () => {
    const u = await makeUser(owner, { email: 'olga@kunde.de', propertyId: fx.propertyId,
                                      roleKey: 'housekeeping_staff' })
    const zweites = await makeProperty(owner, { code: 'ZWEI' })
    expect(await propertiesWithDuePushes(owner)).toEqual(new Set())
    await owner.query(
      `INSERT INTO staff_push (property_id, user_id, kind, dedupe_key, next_at)
       VALUES ($1, $2, 'plan', 'jetzt', now()),
              ($3, $2, 'plan', 'spaeter', now() + interval '1 hour')`,
      [fx.propertyId, u.userId, zweites.propertyId])
    expect(await propertiesWithDuePushes(owner)).toEqual(new Set([fx.propertyId]))
  })
})

describe('Materialisierung und Abgleich', () => {
  const zeilen = async (categoryId: number): Promise<{ n: number; bis: string }> =>
    (await owner.query<{ n: number; bis: string }>(
      `SELECT count(*)::int AS n, max(date)::text AS bis FROM inventory_day
        WHERE property_id = $1 AND category_id = $2`, [fx.propertyId, categoryId])).rows[0]!

  it('zieht je Tick nur das Ende nach und materialisiert eine neue Gruppe ganz', async () => {
    const dz = await makeCategory(owner, fx.propertyId)
    await makeResources(owner, fx.propertyId, dz, 2)
    await withTransaction(app, ctx, c => materializeInventory(c, fx.propertyId, 2))
    const voll = await zeilen(dz)

    // Nichts zu tun: kein Aufruf, keine Zeile.
    expect(await withTransaction(app, ctx, c =>
      materializeInventoryTail(c, fx.propertyId, 2))).toBe(0)

    // Fehlen die letzten Tage -- so sieht es am naechsten Morgen aus --,
    // kommen genau die nach.
    await owner.query(
      `DELETE FROM inventory_day WHERE property_id = $1
          AND date >= (SELECT max(date) - 2 FROM inventory_day WHERE property_id = $1)`,
      [fx.propertyId])
    expect(await withTransaction(app, ctx, c =>
      materializeInventoryTail(c, fx.propertyId, 2))).toBe(6)  // 3 Tage x (DZ + Summe)
    expect(await zeilen(dz)).toEqual(voll)
    const kap = await owner.query<{ capacity: number }>(
      `SELECT DISTINCT capacity FROM inventory_day WHERE property_id = $1 AND category_id = $2`,
      [fx.propertyId, dz])
    expect(kap.rows).toEqual([{ capacity: 2 }])

    // Eine neue Gruppe hat keinen Tag; sie bekommt den ganzen Horizont,
    // sonst waere sie bis zum naechsten vollen Lauf nicht buchbar.
    const ez = await makeCategory(owner, fx.propertyId, { code: 'EZ', name: 'Einzelzimmer' })
    await withTransaction(app, ctx, c => materializeInventoryTail(c, fx.propertyId, 2))
    expect(await zeilen(ez)).toEqual(voll)
  })

  it('gleicht ab heute ab und meldet Abweichungen weiter', async () => {
    const dz = await makeCategory(owner, fx.propertyId)
    await makeResources(owner, fx.propertyId, dz, 3)
    await withTransaction(app, ctx, c => materializeInventory(c, fx.propertyId, 2))
    const heute = (await owner.query<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]!.d
    const tag = (n: number): string => {
      const d = new Date(`${heute}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() + n)
      return d.toISOString().slice(0, 10)
    }
    // Eine laengst abgereiste und eine kommende Reservierung. Die alte
    // liegt vor dem materialisierten Zeitraum und bindet nichts mehr.
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: tag(-30), departure: tag(-28), status: 'Confirmed', reserveInventory: false })
    await makeReservation(owner, { propertyId: fx.propertyId, categoryId: dz,
      arrival: tag(3), departure: tag(5) })
    expect(await withTransaction(app, ctx, c => reconcileInventory(c, fx.propertyId))).toEqual([])

    await owner.query(
      `SELECT inventory_room_shift_apply(jsonb_build_array(jsonb_build_object(
         'property_id', $1::bigint, 'category_id', $2::bigint, 'date', $3::date, 'n', 1)))`,
      [fx.propertyId, dz, tag(10)])
    const drift = await withTransaction(app, ctx, c => reconcileInventory(c, fx.propertyId))
    expect(drift).toEqual([{ categoryId: dz, date: tag(10), counted: 0, stored: 1 }])
  })
})

describe('Nachrichten aus der Gaestemappe (0153)', () => {
  it('leert den Text 30 Tage nach der Abreise und laesst den Wunsch stehen', async () => {
    const kat = await makeCategory(owner, fx.propertyId)
    const [raum] = await makeResources(owner, fx.propertyId, kat, 1)
    const alt = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kat,
      arrival: '2020-01-01', departure: '2020-01-03', resourceId: raum,
      status: 'CheckedOut', reserveInventory: false })
    const neu = await makeReservation(owner, { propertyId: fx.propertyId, categoryId: kat,
      arrival: '2099-01-01', departure: '2099-01-03', resourceId: raum,
      status: 'Confirmed', reserveInventory: false })
    for (const r of [alt.reservationId, neu.reservationId]) {
      await owner.query(
        `INSERT INTO guest_request (property_id, reservation_id, is_message, message, qty, source)
         VALUES ($1, $2, true, 'Bitte Herrn Meier anrufen', 1, 'folder')`, [fx.propertyId, r])
    }
    const c = await owner.connect()
    try { await purgeExpired(c) } finally { c.release() }
    const rows = await owner.query<{ reservation_id: number; message: string | null }>(
      `SELECT reservation_id::int, message FROM guest_request ORDER BY reservation_id`)
    expect(rows.rows).toEqual([
      { reservation_id: alt.reservationId, message: null },
      { reservation_id: neu.reservationId, message: 'Bitte Herrn Meier anrufen' }])
  })
})
