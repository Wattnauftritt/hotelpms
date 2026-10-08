import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isPushEndpoint } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { loadConfig } from '../platform/config.js'
import { tx } from '../platform/db.js'
import type { Principal } from '../platform/context.js'

/**
 * Benachrichtigungen der Personal-App (Baustein 8, Migration 0113).
 *
 * Ein Abo gehoert zur Sitzung, aus der es kommt: abmelden beendet es, und
 * der Worker schickt nur an Sitzungen, die noch gelten. Deshalb liest die
 * Route die Sitzung aus dem Cookie und nimmt kein Abo ohne Cookie an --
 * ein Maschinenzugang hat kein Telefon.
 *
 * Unter einem Haus, weil das Recht `staff:app` je Haus vergeben wird; das
 * Abo selbst gilt fuer alle Haeuser der Person.
 */

const COOKIE = 'hp_session'

function sitzung(req: FastifyRequest): { userId: number; sessionId: string } {
  const p = req.principal as Principal
  // Nur der Mensch, der angemeldet ist: kein Geraet, kein Maschinenzugang,
  // und nicht die Person, auf die ein Arbeitsplatz-PIN gewechselt hat --
  // deren Meldungen gehoerten sonst aufs Telefon eines anderen.
  if (p.userId === null || p.terminalDeviceId !== null
      || (p.sessionUserId !== null && p.sessionUserId !== p.userId)) {
    throw Errors.forbidden('staff.personOnly')
  }
  const sessionId = req.cookies[COOKIE]
  if (sessionId === undefined) throw Errors.forbidden('staff.personOnly')
  return { userId: p.userId, sessionId }
}

function endpointAus(req: FastifyRequest): string {
  const e = (req.body as { endpoint?: unknown } | null)?.endpoint
  if (typeof e !== 'string' || !isPushEndpoint(e)) {
    throw Errors.validation({ endpoint: ['push.endpoint'] })
  }
  return e
}

export function pushRoutes(app: FastifyInstance): void {
  const config = loadConfig()
  let gespeichert: string | null = null

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/push',
    permission: 'staff:app',
    propertyParam: 'propertyId',
    summary: 'Schluessel fuer Benachrichtigungen (Personal-App)',
    handler: async (req) => {
      sitzung(req)
      if (config.vapidPublicKey !== null) return { publicKey: config.vapidPublicKey }
      // Ohne Umgebung der Schluessel, den der Worker erzeugt hat (0117).
      // Gemerkt wird erst ein gefundener: vor dem ersten Start des Workers
      // steht noch keiner da, und die App fragt beim naechsten Oeffnen neu.
      gespeichert ??= await tx(req.pool, req, async client => {
        const { rows } = await client.query<{ k: string }>(
          'SELECT public_key AS k FROM platform_vapid_key')
        return rows[0]?.k ?? null
      })
      return { publicKey: gespeichert }
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/push',
    permission: 'staff:app',
    propertyParam: 'propertyId',
    summary: 'Dieses Telefon fuer Benachrichtigungen anmelden (Personal-App)',
    handler: async (req, reply) => {
      const { userId, sessionId } = sitzung(req)
      const endpoint = endpointAus(req)
      const keys = (req.body as { keys?: { p256dh?: unknown; auth?: unknown } }).keys
      const p256dh = keys?.p256dh
      const auth = keys?.auth
      if (typeof p256dh !== 'string' || !/^[A-Za-z0-9_-]{20,200}={0,2}$/.test(p256dh)
          || typeof auth !== 'string' || !/^[A-Za-z0-9_-]{8,100}={0,2}$/.test(auth)) {
        throw Errors.validation({ keys: ['push.keys'] })
      }
      /*
       * Ohne Mandantenkontext, denn die Tabelle kennt keinen: das Abo
       * gehoert einer Person, nicht einem Haus. Ein Telefon, das schon unter
       * jemand anderem angemeldet war, wechselt hier den Besitzer -- dasselbe
       * Telefon soll nie zwei Personen gemeldet bekommen.
       */
      await req.pool.query(
        `INSERT INTO push_subscription (user_id, session_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint) DO UPDATE
           SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id,
               p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, created_at = now()`,
        [userId, sessionId, endpoint, p256dh, auth])
      reply.code(201)
      return { ok: true }
    }
  })

  /**
   * Abmelden eines Telefons. POST mit Rumpf statt DELETE: die Adresse ist
   * lang und gehoert nicht in die Abfragezeichenfolge.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/push/off',
    permission: 'staff:app',
    propertyParam: 'propertyId',
    summary: 'Benachrichtigungen fuer dieses Telefon abschalten (Personal-App)',
    handler: async (req) => {
      const { userId } = sitzung(req)
      const endpoint = endpointAus(req)
      await req.pool.query(
        'DELETE FROM push_subscription WHERE endpoint = $1 AND user_id = $2', [endpoint, userId])
      return { ok: true }
    }
  })
}
