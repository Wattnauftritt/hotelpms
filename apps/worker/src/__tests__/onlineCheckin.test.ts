import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeCategory,
         makeReservation, makeEmailDomain, openBusinessDay, type Fixture }
  from '@hotelpms/testing'
import { type DbContext, type Pool } from '@hotelpms/db'
import { inviteOnlineCheckins } from '../jobs/onlineCheckin.js'
import { deliverEmails } from '../jobs/emailDelivery.js'
import { createBrevoAdapter } from '../email/brevo.js'

/**
 * Der Link vor Anreise (Dokument 30): genau einmal, nur wo er hingehoert.
 *
 * "Genau einmal" ist hier die eigentliche Zusage. Der Worker tickt alle fuenf
 * Minuten, und ein Gast, der achtundachtzig Mails bekommt, ruft nicht an,
 * sondern bucht woanders.
 */

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext
let catId: number

const HEUTE = '2026-10-01'
const opts = { appUrl: 'https://app.staygrid.test' }

beforeAll(async () => {
  await ensureSchema()
  owner = ownerPool()
  app = appPool(5)
})
afterAll(async () => { await owner.end(); await app.end() })

beforeEach(async () => {
  await truncateAll()
  fx = await makeProperty(owner)
  ctx = { accountIds: [fx.accountId], propertyIds: [fx.propertyId], userId: null }
  catId = await makeCategory(owner, fx.propertyId, { code: 'DZ' })
  await openBusinessDay(owner, fx.propertyId, HEUTE)
  await makeEmailDomain(owner, fx.propertyId, 'seeblick.test')
  await owner.query(
    `INSERT INTO property_email_setting (property_id, from_name, from_email, enabled)
     VALUES ($1,'Hotel Seeblick','post@seeblick.test',true)`, [fx.propertyId])
  await owner.query(
    `INSERT INTO property_checkin_setting (property_id, enabled, days_before)
     VALUES ($1,true,3)`, [fx.propertyId])
})

let n = 0

async function reservierung(o: {
  anreise?: string; status?: 'Confirmed' | 'Optional'; email?: string | null
  sprache?: string
} = {}): Promise<number> {
  const anreise = o.anreise ?? '2026-10-03'
  const g = await owner.query<{ id: number }>(
    `INSERT INTO guest (account_id, last_name, first_name, email, language)
     VALUES ($1,'Petersen','Anna',$2,$3) RETURNING id`,
    [fx.accountId, o.email === undefined ? `gast${++n}@example.test` : o.email,
     o.sprache ?? 'de'])
  const abreise = new Date(Date.parse(`${anreise}T00:00:00Z`) + 3 * 86_400_000)
    .toISOString().slice(0, 10)
  const r = await makeReservation(owner, {
    propertyId: fx.propertyId, categoryId: catId, arrival: anreise, departure: abreise,
    status: o.status ?? 'Confirmed', reserveInventory: false,
    optionExpiresAt: o.status === 'Optional' ? '2026-10-02T12:00:00Z' : null })
  await owner.query(`UPDATE reservation SET primary_guest_id = $2 WHERE id = $1`,
    [r.reservationId, g.rows[0]!.id])
  return r.reservationId
}

async function post(): Promise<Array<{ reservation_id: number; subject: string
                                       body_text: string; status: string }>> {
  const r = await owner.query(
    `SELECT reservation_id, subject, body_text, status FROM outbound_email
      WHERE kind = 'checkin_invitation' ORDER BY id`)
  return r.rows
}

describe('Versand vor Anreise', () => {
  it('schickt genau einmal, auch bei wiederholtem Lauf', async () => {
    const id = await reservierung()
    expect(await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)).toEqual({ invited: 1 })
    expect(await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)).toEqual({ invited: 0 })
    const p = await post()
    expect(p).toHaveLength(1)
    expect(p[0]!.reservation_id).toBe(id)
    expect(p[0]!.body_text).toContain('https://app.staygrid.test/checkin#')
    const t = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM checkin_token WHERE reservation_id = $1`, [id])
    expect(t.rows[0]!.n).toBe(1)
  })

  it('haelt auch zwei gleichzeitige Laeufe bei einer Mail', async () => {
    await reservierung()
    const [a, b] = await Promise.allSettled([
      inviteOnlineCheckins(app, ctx, fx.propertyId, opts),
      inviteOnlineCheckins(app, ctx, fx.propertyId, opts)])
    // Einer schreibt; der andere findet nichts mehr oder scheitert am
    // eindeutigen Index. Beides ist richtig, zwei Mails sind es nicht.
    expect([a.status, b.status]).toContain('fulfilled')
    expect(await post()).toHaveLength(1)
  })

  it('laedt neu ein, wenn der Link wegen einer korrigierten Adresse zurueckgezogen wurde', async () => {
    // Migration 0084: das Umsystem hat die Adresse korrigiert, der erste
    // Link ging an die falsche. Ein Widerruf der Rezeption dagegen bleibt
    // endgueltig.
    const korrigiert = await reservierung()
    const vonHand = await reservierung()
    expect((await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)).invited).toBe(2)
    await owner.query(
      `UPDATE checkin_token SET revoked_at = now(), revoke_reason = 'contact_changed'
        WHERE reservation_id = $1`, [korrigiert])
    await owner.query(
      `UPDATE checkin_token SET revoked_at = now() WHERE reservation_id = $1`, [vonHand])

    expect((await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)).invited).toBe(1)
    expect((await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)).invited).toBe(0)
    const p = await post()
    expect(p.map(x => x.reservation_id)).toEqual([korrigiert, vonHand, korrigiert])
  })

  it('laedt nicht ein, wofuer ein Umsystem schon eingeladen oder erfasst hat', async () => {
    const eingeladen = await reservierung()
    const erfasst = await reservierung()
    const frei = await reservierung()
    await owner.query(
      `INSERT INTO reservation_external_registration
         (reservation_id, property_id, system, invitation_sent_at, completed_at)
       VALUES ($1,$3,'adminpanel','2026-09-30T14:00:00Z',NULL),
              ($2,$3,'adminpanel',NULL,'2026-09-30T18:00:00Z')`,
      [eingeladen, erfasst, fx.propertyId])
    expect((await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)).invited).toBe(1)
    expect((await post()).map(x => x.reservation_id)).toEqual([frei])
  })

  it('schreibt in der Sprache des Gastes', async () => {
    await reservierung({ sprache: 'nl' })
    await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)
    expect((await post())[0]!.subject).toContain('Online inchecken')
  })

  it('rechnet die Frist gegen den Geschaeftstag, nicht gegen die Uhr', async () => {
    // Der offene Tag liegt weit vor heute: ein Haus, dessen Nachtlauf
    // haengt. Gegen now() stuende diese Anreise in der Vergangenheit.
    await owner.query(`DELETE FROM business_day WHERE property_id = $1`, [fx.propertyId])
    await openBusinessDay(owner, fx.propertyId, '2026-03-10')
    await reservierung({ anreise: '2026-03-12' })
    expect((await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)).invited).toBe(1)
  })

  it('laesst aus, was nicht dran ist', async () => {
    await reservierung({ anreise: HEUTE })                 // heute: zu spaet
    await reservierung({ anreise: '2026-10-05' })          // vier Tage: zu frueh
    await reservierung({ status: 'Optional' })             // keine Buchung
    await reservierung({ email: null })                    // keine Adresse
    await reservierung({ email: 'kein-at-zeichen' })       // keine brauchbare
    const mitSchein = await reservierung()
    const g = await owner.query<{ id: number }>(
      `SELECT primary_guest_id AS id FROM reservation WHERE id = $1`, [mitSchein])
    await owner.query(
      `INSERT INTO registration (property_id, reservation_id, guest_id, arrival,
                                 planned_departure, is_foreign, destroy_after)
       VALUES ($1,$2,$3,'2026-10-03','2026-10-06',false,'2027-10-06')`,
      [fx.propertyId, mitSchein, g.rows[0]!.id])
    expect((await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)).invited).toBe(0)
    expect(await post()).toHaveLength(0)
  })

  it('schickt nichts aus einem Uebungshaus', async () => {
    await reservierung()
    await owner.query(`UPDATE property SET is_training = true WHERE id = $1`, [fx.propertyId])
    expect((await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)).invited).toBe(0)
    const t = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM checkin_token`)
    expect(t.rows[0]!.n).toBe(0)
  })

  it('schickt nichts ohne freigeschaltete Absenderdomain', async () => {
    await reservierung()
    await owner.query(`UPDATE property_email_domain SET status = 'dns_pending'
                        WHERE property_id = $1`, [fx.propertyId])
    expect((await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)).invited).toBe(0)
  })

  it('schickt nichts, solange das Haus es nicht eingeschaltet hat', async () => {
    await reservierung()
    await owner.query(`UPDATE property_checkin_setting SET enabled = false`)
    expect((await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)).invited).toBe(0)
  })

  it('schickt nichts, wenn die Rezeption schon einen Link verschickt hat', async () => {
    const id = await reservierung()
    await owner.query(
      `INSERT INTO checkin_token (property_id, reservation_id, token_hash, channel,
                                  expires_on, created_by)
       VALUES ($1,$2,'x','mail','2026-10-06',NULL)`, [fx.propertyId, id])
    expect((await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)).invited).toBe(0)
  })
})

describe('Zustellung', () => {
  let server: Server
  let url: string
  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json' })
          .end(JSON.stringify({ messageId: '<x@brevo>' }))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v3/smtp/email`
  })
  afterAll(async () => { await new Promise<void>(r => { server.close(() => { r() }) }) })

  /*
   * Im Rumpf steht der Link im Klartext, und der Link ist der Zugang zum
   * Meldeschein. In checkin_token steht nur der Hash -- bliebe der Rumpf
   * nach dem Versand stehen, waere das wertlos.
   */
  it('leert den Rumpf der Einladung nach dem Versand, den einer Bestaetigung nicht', async () => {
    const id = await reservierung()
    await inviteOnlineCheckins(app, ctx, fx.propertyId, opts)
    await owner.query(
      `INSERT INTO outbound_email (property_id, kind, to_email, subject, body_text,
                                   reservation_id)
       VALUES ($1,'reservation_confirmation','a@example.test','Bestaetigung','Rumpf',$2)`,
      [fx.propertyId, id])
    const r = await deliverEmails(app, ctx, fx.propertyId,
      createBrevoAdapter('k', { baseUrl: url }))
    expect(r.sent).toBe(2)
    const z = await owner.query<{ kind: string; body_text: string; body_html: string | null
                                  subject: string; status: string }>(
      `SELECT kind, body_text, body_html, subject, status FROM outbound_email ORDER BY kind`)
    expect(z.rows).toEqual([
      expect.objectContaining({ kind: 'checkin_invitation', body_text: '', body_html: null,
                                status: 'sent' }),
      expect.objectContaining({ kind: 'reservation_confirmation', body_text: 'Rumpf' })])
    expect(z.rows[0]!.subject).toContain('Online-Check-in')
  })
})
