import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { accountFor, type Principal } from '../platform/context.js'

/**
 * Benutzer und Rollen: wer darf was, je Haus.
 *
 * **Die Rechte werden gezeigt, wie sie sind, nicht nachgebaut.** Eine
 * Oberflaeche, die aus Rollennamen auf Rechte schliesst, liegt nach der
 * ersten eigenen Rolle eines Kunden falsch -- und zwar still. Deshalb
 * liefert die API die Rechte je Rolle mit, und die Maske zeigt sie.
 *
 * **Vorsicht mit der Mandantengrenze.** `app_user`, `role` und
 * `user_property_role` haben **keine** Zeilenrichtlinie: Benutzer gehoeren
 * keinem Haus, sondern haben Rollen in Haeusern. Die Grenze ist hier
 * deshalb von Hand gezogen -- jede Abfrage haengt an `property_id` oder
 * `account_id` aus dem Kontext, nie an einem Wert aus dem Rumpf. Wer das
 * vergisst, baut eine Benutzerliste des ganzen Systems.
 *
 * **Was hier bewusst fehlt: einen Benutzer anlegen.** Dazu gehoeren
 * Einladung, Erstkennwort und zweiter Faktor, und das ist ein eigener
 * Vorgang mit eigenen Fallstricken. Diese Routen aendern Rollen von
 * Menschen, die es im Account schon gibt.
 */

interface UserRow {
  userRef: string
  displayName: string
  email: string
  status: string
  lastLoginAt: string | null
  roles: Array<{ key: string; name: string }>
  permissions: string[]
}

export function userRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/users',
    permission: 'user:manage',
    propertyParam: 'propertyId',
    summary: 'Benutzer eines Hauses mit ihren Rollen und Rechten',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      return tx(req.pool, req, async client => {
        // Ein Aufruf je Bildschirm: Rollen und Rechte kommen als Feld mit.
        // Je Benutzer nachzufragen waere bei einem Haus mit dreissig
        // Mitarbeitern eine Runde je Zeile.
        const { rows } = await client.query<UserRow>(
          `SELECT u.public_ref AS "userRef", u.display_name AS "displayName",
                  u.email, u.status, u.last_login_at AS "lastLoginAt",
                  COALESCE(r.rollen, '[]'::jsonb) AS roles,
                  COALESCE(p.rechte, '{}'::text[]) AS permissions
             FROM app_user u
             JOIN LATERAL (
               SELECT jsonb_agg(jsonb_build_object('key', ro.key, 'name', ro.name)
                                ORDER BY ro.key) AS rollen
                 FROM user_property_role upr
                 JOIN role ro ON ro.id = upr.role_id
                WHERE upr.user_id = u.id AND upr.property_id = $1
             ) r ON r.rollen IS NOT NULL
             LEFT JOIN LATERAL (
               SELECT array_agg(DISTINCT rp.permission_key) AS rechte
                 FROM user_property_role upr
                 JOIN role_permission rp ON rp.role_id = upr.role_id
                WHERE upr.user_id = u.id AND upr.property_id = $1
             ) p ON true
            ORDER BY u.display_name, u.email`,
          [Number(propertyId)])
        return { users: rows }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/roles',
    permission: 'user:manage',
    summary: 'Rollen auf Hausebene mit ihren Rechten',
    handler: async (req) => {
      const principal = req.principal as Principal
      const q = req.query as { accountId?: string }
      const accountId = accountFor(principal,
        q.accountId === undefined ? undefined : Number(q.accountId))

      return tx(req.pool, req, async client => {
        // Systemrollen und die eigenen des Accounts. Fremde Accounts sind
        // durch die Bedingung ausgeschlossen, nicht durch eine
        // Zeilenrichtlinie -- `role` hat keine.
        const { rows } = await client.query(
          `SELECT ro.key, ro.name, ro.level, ro.is_system AS "isSystem",
                  COALESCE(array_agg(rp.permission_key ORDER BY rp.permission_key)
                             FILTER (WHERE rp.permission_key IS NOT NULL),
                           '{}'::text[]) AS permissions
             FROM role ro
             LEFT JOIN role_permission rp ON rp.role_id = ro.id
            WHERE ro.level = 'property'
              AND (ro.account_id IS NULL OR ro.account_id = $1)
            GROUP BY ro.id
            ORDER BY ro.is_system DESC, ro.key`,
          [accountId])
        return { roles: rows }
      })
    }
  })

  /**
   * Rollen eines Benutzers in einem Haus festlegen.
   *
   * Ersetzend, nicht ergaenzend: die Frage an der Rezeption lautet "was darf
   * diese Person hier", nicht "was kommt dazu". Ein Satz Rollen ist leichter
   * zu pruefen als eine Folge von Aenderungen.
   *
   * Der Benutzer muss im Account schon bekannt sein. Sonst waere diese Route
   * der Weg, einer beliebigen Benutzer-Kennung eines fremden Betriebs eine
   * Rolle im eigenen Haus zu geben -- und zugleich ein Mittel, die Existenz
   * fremder Kennungen zu erraten.
   */
  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/users/:userRef/roles',
    permission: 'user:manage',
    propertyParam: 'propertyId',
    summary: 'Rollen eines Benutzers in einem Haus festlegen',
    handler: async (req) => {
      const { propertyId, userRef } = req.params as
        { propertyId: string; userRef: string }
      const body = req.body as { roleKeys?: string[] }
      const principal = req.principal as Principal
      if (!Array.isArray(body.roleKeys)) {
        throw Errors.validation({ roleKeys: ['field.roleKeyList'] })
      }
      const gewuenscht = [...new Set(body.roleKeys)]

      return tx(req.pool, req, async client => {
        const id = Number(propertyId)
        const prop = await client.query<{ account_id: number }>(
          `SELECT account_id FROM property WHERE id = $1`, [id])
        if (prop.rowCount === 0) throw Errors.notFound('res.property')
        const accountId = prop.rows[0]!.account_id

        // Bekannt heisst: hat im selben Account bereits eine Rolle, auf
        // Account-Ebene oder in einem seiner Haeuser.
        const u = await client.query<{ id: number }>(
          `SELECT u.id FROM app_user u
            WHERE u.public_ref = $1
              AND (EXISTS (SELECT 1 FROM user_account_role uar
                            WHERE uar.user_id = u.id AND uar.account_id = $2)
                OR EXISTS (SELECT 1 FROM user_property_role upr
                             JOIN property p ON p.id = upr.property_id
                            WHERE upr.user_id = u.id AND p.account_id = $2))`,
          [userRef, accountId])
        if (u.rowCount === 0) throw Errors.notFound('res.user')
        const userId = u.rows[0]!.id

        const rollen = gewuenscht.length === 0
          ? { rows: [] as Array<{ id: number; key: string }> }
          : await client.query<{ id: number; key: string }>(
              `SELECT id, key FROM role
                WHERE level = 'property' AND key = ANY($1::text[])
                  AND (account_id IS NULL OR account_id = $2)`,
              [gewuenscht, accountId])
        if (rollen.rows.length !== gewuenscht.length) {
          const gefunden = new Set(rollen.rows.map(r => r.key))
          throw Errors.validation({ roleKeys: ['field.unknownRole'] },
            { values: gewuenscht.filter(k => !gefunden.has(k)).join(', ') })
        }

        // Wer sich selbst das Verwaltungsrecht nimmt, sperrt sich aus, und
        // zwar ohne Weg zurueck -- es gibt keinen zweiten Knopf dafuer.
        if (userId === principal.userId
            && !rollen.rows.some(r => r.key === 'hotel_director')) {
          const nochRecht = await client.query<{ n: string }>(
            `SELECT count(*)::text AS n
               FROM role_permission rp
              WHERE rp.role_id = ANY($1::bigint[])
                AND rp.permission_key = 'user:manage'`,
            [rollen.rows.map(r => r.id)])
          if (Number(nochRecht.rows[0]!.n) === 0) {
            throw Errors.conflict(
              'user.wouldLockYourselfOut')
          }
        }

        await client.query(
          `DELETE FROM user_property_role WHERE user_id = $1 AND property_id = $2`,
          [userId, id])
        if (rollen.rows.length > 0) {
          await client.query(
            `INSERT INTO user_property_role (user_id, property_id, role_id, granted_by)
             SELECT $1, $2, unnest($3::bigint[]), $4`,
            [userId, id, rollen.rows.map(r => r.id), principal.userId])
        }
        return { userRef, propertyId: id, roleKeys: rollen.rows.map(r => r.key) }
      })
    }
  })
}
