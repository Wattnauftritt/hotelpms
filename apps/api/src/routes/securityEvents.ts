import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { accountRight, can, propertyIds, type Principal } from '../platform/context.js'

/**
 * Die Sicherheitsereignisse lesen (Migration 0208, Bedrohungsanalyse
 * 23.10.2026, E3).
 *
 * Die Hinweismail sagt der Leitung, **dass** etwas geschah; hier steht, was
 * davor und danach geschah. Wer eine Mail ueber eine IBAN bekommt, die er
 * nicht geaendert hat, will als Naechstes wissen, ob dieselbe Sitzung auch
 * einen Maschinenzugang angelegt hat.
 *
 * **Wer was sieht.** Wer `user:manage` auf Betriebsebene hat, sieht den
 * ganzen Betrieb; die Hausleitung nur die Ereignisse ihrer Haeuser. Das
 * sind dieselben Menschen, die den Hinweis bekommen
 * (`security_notice_recipients`). Die Zeilenrichtlinie filtert nach
 * Account, nicht nach Haus -- deshalb die Pruefung hier.
 *
 * **Die Adresse steht ungekuerzt da** (Svens Entscheidung, 23.10.2026):
 * eine Strafanzeige und eine Sperre brauchen die volle Adresse, und der
 * Betrieb ist es, der die Anzeige stellt.
 */

const GRENZE = 200

interface Zeile {
  id: string
  account_id: number | null
  property_id: number | null
  kind: string
  actor_kind: string
  actor_user_id: number | null
  actor_name: string | null
  actor_ref: string | null
  origin: string | null
  origin_truncated: boolean
  detail: Record<string, unknown>
  created_at: Date
}

function grenze(wert: unknown): number {
  if (wert === undefined || wert === '') return 100
  const n = Number(wert)
  if (!Number.isSafeInteger(n) || n < 1 || n > GRENZE) {
    throw Errors.validation({ limit: ['field.positiveInteger'] })
  }
  return n
}

const ausgabe = (r: Zeile) => ({
  id: Number(r.id),
  accountId: r.account_id,
  propertyId: r.property_id,
  kind: r.kind,
  actorKind: r.actor_kind,
  actorUserId: r.actor_user_id,
  actorName: r.actor_name,
  actorRef: r.actor_ref,
  origin: r.origin,
  originTruncated: r.origin_truncated,
  detail: r.detail,
  createdAt: r.created_at
})

export function securityEventRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/security-events',
    permission: 'user:manage',
    summary: 'Sicherheitsereignisse des eigenen Betriebs',
    handler: async (req) => {
      const p = req.principal as Principal
      const q = req.query as { limit?: string; before?: string }
      const limit = grenze(q.limit)
      const vor = q.before === undefined || q.before === '' ? null : Number(q.before)
      if (vor !== null && (!Number.isSafeInteger(vor) || vor < 1)) {
        throw Errors.validation({ before: ['field.positiveInteger'] })
      }
      const betriebe = p.accountIds.filter(a => accountRight(p, 'user:manage', a))
      const haeuser = propertyIds(p).filter(h => can(p, 'user:manage', h))
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<Zeile>(
          `SELECT e.id, e.account_id, e.property_id, e.kind, e.actor_kind,
                  e.actor_user_id, u.display_name AS actor_name, e.actor_ref,
                  host(e.origin) AS origin, e.origin_truncated, e.detail, e.created_at
             FROM security_event e
             LEFT JOIN app_user u ON u.id = e.actor_user_id
            WHERE (e.account_id = ANY($1::bigint[]) OR e.property_id = ANY($2::bigint[]))
              AND ($3::bigint IS NULL OR e.id < $3)
            ORDER BY e.id DESC
            LIMIT $4`,
          [betriebe, haeuser, vor, limit])
        return { events: rows.map(ausgabe) }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/security-events',
    permission: 'platform:accounts',
    summary: 'Sicherheitsereignisse aller Betriebe',
    handler: async (req) => {
      const limit = grenze((req.query as { limit?: string }).limit)
      return tx(req.pool, req, async client => {
        const { rows } = await client.query<Zeile & { account_name: string | null }>(
          `SELECT id, account_id, account_name, property_id, kind, actor_kind,
                  actor_user_id, actor_name, actor_ref, origin, origin_truncated,
                  detail, created_at
             FROM platform_security_events($1)`, [limit])
        return { events: rows.map(r => ({ ...ausgabe(r), accountName: r.account_name })) }
      })
    }
  })
}
