import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ensureSchema, truncateAll, appPool, ownerPool, makeProperty, makeUser,
         type Fixture } from '@hotelpms/testing'
import type { DbContext, Pool } from '@hotelpms/db'
import { PUSH_MAX_ATTEMPTS } from '@hotelpms/domain'
import { sendStaffPushes, buildPushPayload, vapidSchluessel, type PushSender, type PushTarget,
         type PushPayload } from '../jobs/staffPush.js'

/**
 * Der Versand der Push-Meldungen (0113, Baustein 8) mit untergeschobenem
 * Sender: echt ist die Datenbank, nicht der Dienst des Telefonherstellers.
 */

let owner: Pool
let app: Pool
let fx: Fixture
let ctx: DbContext
let olga: { userId: number; sessionId: string }

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
  olga = await makeUser(owner, { email: 'olga@kunde.de', propertyId: fx.propertyId,
    roleKey: 'housekeeping_staff' })
  await owner.query(`UPDATE app_user SET locale = 'uk' WHERE id = $1`, [olga.userId])
})

function sender(status: (t: PushTarget) => number): PushSender & {
  gesendet: Array<{ endpoint: string; payload: PushPayload }>
} {
  const gesendet: Array<{ endpoint: string; payload: PushPayload }> = []
  return {
    gesendet,
    async send(t, payload) {
      gesendet.push({ endpoint: t.endpoint, payload })
      return status(t)
    }
  }
}

async function telefon(sessionId: string, name: string): Promise<string> {
  const endpoint = `https://fcm.googleapis.com/fcm/send/${name}`
  await owner.query(
    `INSERT INTO push_subscription (user_id, session_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, 'BKey', 'auth')`, [olga.userId, sessionId, endpoint])
  return endpoint
}

async function meldung(kind = 'room_free', params: Record<string, string> = { room: '101' }) {
  await owner.query(
    `INSERT INTO staff_push (property_id, user_id, kind, params, dedupe_key)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [fx.propertyId, olga.userId, kind, JSON.stringify(params), randomBytes(4).toString('hex')])
}

const stand = async () => (await owner.query<{ status: string; attempts: number
                                               last_error: string | null }>(
  'SELECT status, attempts, last_error FROM staff_push ORDER BY id')).rows

describe('sendStaffPushes', () => {
  it('schickt in der Sprache der Kraft an jedes gueltige Telefon', async () => {
    const eins = await telefon(olga.sessionId, 'eins')
    // Eine abgemeldete Sitzung bekommt nichts mehr.
    const zweite = await makeUser(owner, { email: 'olga2@kunde.de' })
    await owner.query(
      `UPDATE user_session SET user_id = $1, revoked_at = now() WHERE id = $2`,
      [olga.userId, zweite.sessionId])
    await telefon(zweite.sessionId, 'alt')
    await meldung()
    const s = sender(() => 201)
    expect(await sendStaffPushes(app, ctx, fx.propertyId, s)).toEqual(
      { attempted: 1, sent: 1, retrying: 0, failed: 0 })
    expect(s.gesendet).toEqual([{ endpoint: eins, payload: {
      title: 'Номер 101 вільний', body: 'Гість виїхав. Можна прибирати.',
      url: '/personal', tag: 'room_free-101' } }])
    expect(await stand()).toEqual([{ status: 'sent', attempts: 1, last_error: null }])
  })

  it('entfernt ein Abo, das der Dienst nicht mehr kennt', async () => {
    await telefon(olga.sessionId, 'weg')
    await meldung()
    await sendStaffPushes(app, ctx, fx.propertyId, sender(() => 410))
    expect((await owner.query('SELECT 1 FROM push_subscription')).rowCount).toBe(0)
    expect((await stand())[0]!.status).toBe('sent')
  })

  it('erledigt eine Meldung ohne Telefon, ohne zu senden', async () => {
    await meldung()
    const s = sender(() => 201)
    expect(await sendStaffPushes(app, ctx, fx.propertyId, s)).toMatchObject({ sent: 1 })
    expect(s.gesendet).toEqual([])
  })

  it('versucht es spaeter und gibt nach dem letzten Versuch auf', async () => {
    await telefon(olga.sessionId, 'eins')
    await meldung()
    for (let i = 1; i <= PUSH_MAX_ATTEMPTS; i++) {
      await owner.query('UPDATE staff_push SET next_at = now()')
      const r = await sendStaffPushes(app, ctx, fx.propertyId, sender(() => 503))
      expect(r[i < PUSH_MAX_ATTEMPTS ? 'retrying' : 'failed']).toBe(1)
    }
    expect(await stand()).toEqual([{ status: 'failed', attempts: PUSH_MAX_ATTEMPTS,
                                     last_error: 'http_503' }])
  })

  it('schreibt das Datum eines Plans aus', () => {
    expect(buildPushPayload('plan', { date: '2026-10-08' }, 'de')).toMatchObject({
      body: 'Deine Zimmer für Donnerstag, 8.10. haben sich geändert.', tag: 'plan-2026-10-08' })
  })
})

/*
 * Sven, 08.10.2026: ohne Terminal keine Umgebungsvariablen -- der Worker
 * erzeugt das Paar selbst (0117). Zwei Starts duerfen kein zweites Paar
 * erzeugen, sonst gingen die Abos des ersten ins Leere.
 */
describe('VAPID-Schluessel', () => {
  const ohne = { publicKey: null, privateKey: null }

  it('erzeugt ein Paar, legt es ab und behaelt es beim naechsten Start', async () => {
    await owner.query('DELETE FROM platform_vapid_key')
    const erst = await vapidSchluessel(owner, ohne)
    expect(erst.quelle).toBe('neu')
    expect(erst.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/)
    const dann = await vapidSchluessel(owner, ohne)
    expect(dann).toEqual({ ...erst, quelle: 'datenbank' })
    const gleichzeitig = await Promise.all([vapidSchluessel(owner, ohne),
                                            vapidSchluessel(owner, ohne)])
    expect(gleichzeitig.map(v => v.publicKey)).toEqual([erst.publicKey, erst.publicKey])
  })

  it('nimmt die Umgebung, wenn sie gesetzt ist', async () => {
    expect(await vapidSchluessel(owner, { publicKey: 'Bpub', privateKey: 'priv' }))
      .toEqual({ publicKey: 'Bpub', privateKey: 'priv', quelle: 'umgebung' })
  })

  it('zeigt der Anwendungsrolle nur den oeffentlichen Schluessel', async () => {
    await owner.query('DELETE FROM platform_vapid_key')
    const v = await vapidSchluessel(owner, ohne)
    const { rows } = await app.query<{ k: string }>('SELECT public_key AS k FROM platform_vapid_key')
    expect(rows).toEqual([{ k: v.publicKey }])
    await expect(app.query('SELECT private_key FROM platform_vapid_key'))
      .rejects.toThrow(/permission denied/)
  })
})
