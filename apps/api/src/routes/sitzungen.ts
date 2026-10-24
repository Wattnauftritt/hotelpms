import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { tx } from '../platform/db.js'
import { accountRight, type Principal } from '../platform/context.js'
import { personenwechselBeenden } from './auth.js'

/**
 * Laufende Anmeldungen sehen und beenden (Bedrohungsanalyse 23.10.2026, A5).
 *
 * Wer eine Sitzung gestohlen hat -- mit einem Infostealer vom
 * Rezeptionsrechner, ueber eine nachgebaute Anmeldeseite, die das Cookie
 * weiterreicht --, arbeitet damit, bis sie ablaeuft. Bisher sah das niemand,
 * und beenden liess sie sich nur ueber einen Kennwortwechsel, der alle
 * anderen mit hinauswirft. Jetzt sieht jeder seine eigenen Anmeldungen mit
 * Adresse und Geraet und beendet einzelne; die Hausleitung beendet alle
 * eines Mitarbeiters, ohne dessen Kennwort zu kennen.
 *
 * **Die Kennung einer Sitzung ist ihr Geheimnis** -- sie steht im Cookie.
 * Nach aussen geht deshalb nur ein Abdruck davon (`ref`), aus dem sich die
 * Sitzung nicht zurueckgewinnen laesst.
 */

/** Die ersten 16 Hexzeichen des SHA-256 der Kennung. */
const REF_SQL = `left(encode(sha256(convert_to(us.id, 'UTF8')), 'hex'), 16)`

/**
 * Die eigene Person, nicht die gerade per Arbeitsplatz-PIN handelnde: wer am
 * Tresen kurz als Kollegin arbeitet, soll nicht deren Anmeldungen sehen und
 * beenden, und auch nicht die des Inhabers dieser Sitzung.
 */
function selbst(req: FastifyRequest): { userId: number; sessionId: string } {
  const p = req.principal as Principal
  if (p.userId === null || req.sitzung === null) throw Errors.unauthorized()
  if (p.sessionUserId !== null && p.sessionUserId !== p.userId) {
    throw Errors.forbidden('access.notWhileSwitched')
  }
  return { userId: p.userId, sessionId: req.sitzung.id }
}

async function beenden(
  client: Pick<PoolClient, 'query'>, userId: number, bedingung: string, werte: unknown[]
): Promise<string[]> {
  const r = await client.query<{ id: string }>(
    `UPDATE user_session us SET revoked_at = now()
      WHERE us.user_id = $1 AND us.revoked_at IS NULL AND ${bedingung}
     RETURNING us.id`, [userId, ...werte])
  const ids = r.rows.map(x => x.id)
  // Wie beim Abmelden: das Telefon einer beendeten Sitzung bekommt nichts mehr.
  if (ids.length > 0) {
    await client.query('DELETE FROM push_subscription WHERE session_id = ANY($1::text[])', [ids])
  }
  return ids
}

export function sitzungRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/auth/sessions',
    // Jeder Angemeldete, fuer sich selbst.
    permission: null,
    summary: 'Eigene Anmeldungen',
    handler: async (req) => {
      const { userId, sessionId } = selbst(req)
      const { rows } = await req.pool.query(
        `SELECT ${REF_SQL} AS ref, us.client, us.created_at AS "createdAt",
                us.last_seen_at AS "lastSeenAt", host(us.ip) AS ip,
                us.user_agent AS "userAgent", us.via_passkey AS "viaPasskey",
                us.id = $2 AS current
           FROM user_session us
          WHERE us.user_id = $1 AND us.revoked_at IS NULL
            AND us.expires_at > now() AND us.absolute_expires_at > now()
          ORDER BY us.last_seen_at DESC
          LIMIT 50`, [userId, sessionId])
      return { sessions: rows }
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/sessions/:ref/revoke',
    permission: null,
    summary: 'Eine eigene Anmeldung beenden',
    handler: async (req) => {
      const { userId } = selbst(req)
      const { ref } = req.params as { ref: string }
      if (!/^[0-9a-f]{16}$/.test(ref)) throw Errors.notFound('res.session')
      const ids = await beenden(req.pool, userId, `${REF_SQL} = $2`, [ref])
      if (ids.length === 0) throw Errors.notFound('res.session')
      return { revoked: ids.length }
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/auth/sessions/revoke-others',
    permission: null,
    summary: 'Alle anderen eigenen Anmeldungen beenden',
    handler: async (req) => {
      const { userId, sessionId } = selbst(req)
      const ids = await beenden(req.pool, userId, 'us.id <> $2', [sessionId])
      return { revoked: ids.length }
    }
  })

  /**
   * Alle Anmeldungen eines Mitarbeiters beenden, ohne Kennwort: der
   * Mitarbeiter hat sein Telefon verloren, oder er ist gegangen und die
   * Rolle ist schon entzogen, aber die Sitzung laeuft noch.
   *
   * Nur fuer jemanden, der in **diesem** Haus eine Rolle hat. Hat er eine
   * Rolle im ganzen Betrieb (Inhaber, Buchhaltung), braucht es dafuer das
   * Recht im Betrieb: sonst beendete die Direktion eines Hauses den
   * Inhaber, wann immer sie wollte.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/users/:userRef/sessions/revoke',
    permission: 'user:manage',
    propertyParam: 'propertyId',
    summary: 'Alle Anmeldungen eines Mitarbeiters beenden',
    handler: async (req) => {
      const { propertyId, userRef } = req.params as { propertyId: string; userRef: string }
      const p = req.principal as Principal
      return tx(req.pool, req, async client => {
        const u = await client.query<{ id: number; account_id: number; im_betrieb: boolean }>(
          `SELECT u.id, pr.account_id,
                  EXISTS (SELECT 1 FROM user_account_role uar
                           WHERE uar.user_id = u.id AND uar.account_id = pr.account_id)
                    AS im_betrieb
             FROM app_user u
             JOIN property pr ON pr.id = $2
            WHERE u.public_ref = $1
              AND EXISTS (SELECT 1 FROM user_property_role upr
                           WHERE upr.user_id = u.id AND upr.property_id = $2)`,
          [userRef, Number(propertyId)])
        const ziel = u.rows[0]
        if (ziel === undefined) throw Errors.notFound('res.user')
        if (ziel.im_betrieb && !accountRight(p, 'user:manage', Number(ziel.account_id))) {
          throw Errors.forbidden('access.missingPermission', { permission: 'user:manage' })
        }
        // Die eigene Sitzung bleibt: wer sich selbst hinauswirft, hat sich
        // vertan, und fuer die anderen gibt es oben den eigenen Weg.
        const ids = await beenden(client, Number(ziel.id), 'us.id <> $2',
          [req.sitzung?.id ?? ''])
        await personenwechselBeenden(client, Number(ziel.id))
        return { userRef, revoked: ids.length }
      })
    }
  })
}
