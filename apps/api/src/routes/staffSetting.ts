import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'

/**
 * Reinigung und Fruehstueck: gemeinsam fuer den Betrieb oder je Haus
 * (Migration 0116, Sven 07.10.2026).
 *
 * Eine Einstellung des **Betriebs**, nicht des Hauses -- deshalb hinter
 * `settings:account`. Sie entscheidet, ob eine Personalrolle in einem Haus
 * auch in den anderen wirkt; das darf nicht die Direktion eines einzelnen
 * Hauses fuer alle umschalten.
 */
export function staffSettingRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/staff-setting',
    permission: 'settings:account',
    propertyParam: 'propertyId',
    summary: 'Personal gemeinsam fuer den Betrieb oder je Haus',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{ shared: boolean }>(
          `SELECT COALESCE(s.shared, false) AS shared
             FROM property p LEFT JOIN account_staff_setting s ON s.account_id = p.account_id
            WHERE p.id = $1`, [propertyId])
        return { shared: rows[0]?.shared ?? false }
      })
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/properties/:propertyId/staff-setting',
    permission: 'settings:account',
    propertyParam: 'propertyId',
    summary: 'Personal gemeinsam fuer den Betrieb oder je Haus festlegen',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const principal = req.principal as Principal
      const shared = (req.body as { shared?: unknown } | null)?.shared
      if (typeof shared !== 'boolean') throw Errors.validation({ shared: ['field.invalid'] })
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<{ shared: boolean }>(
          `INSERT INTO account_staff_setting (account_id, shared, updated_by)
           SELECT account_id, $2, $3 FROM property WHERE id = $1
           ON CONFLICT (account_id) DO UPDATE
             SET shared = EXCLUDED.shared, updated_by = EXCLUDED.updated_by, updated_at = now()
           RETURNING shared`, [propertyId, shared, principal.userId])
        return { shared: rows[0]!.shared }
      })
    }
  })
}
