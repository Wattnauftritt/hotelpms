import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { accountFor, type Principal } from '../platform/context.js'
import { isWebhookEventType, WEBHOOK_EVENT_TYPES } from '@hotelpms/domain'
import type { PoolClient } from '@hotelpms/db'

interface SubscriptionBody {
  accountId?: number
  url: string
  eventTypes?: string[]
  propertyIds?: number[]
}

interface SubscriptionRow {
  public_ref: string
  url: string
  event_types: string[]
  property_ids: string[] | number[]
  status: string
  disabled_at: string | null
  disabled_reason: string | null
  created_at: string
}

function present(r: SubscriptionRow): Record<string, unknown> {
  return {
    subscriptionRef: r.public_ref,
    url: r.url,
    // Leer heisst alle. Das nach aussen als leere Liste zu zeigen waere
    // missverstaendlich, deshalb steht die Bedeutung ausdruecklich dabei.
    eventTypes: r.event_types.length > 0 ? r.event_types : [...WEBHOOK_EVENT_TYPES],
    allEventTypes: r.event_types.length === 0,
    propertyIds: r.property_ids.map(Number),
    allProperties: r.property_ids.length === 0,
    status: r.status,
    disabledAt: r.disabled_at,
    disabledReason: r.disabled_reason,
    createdAt: r.created_at
  }
}

const FIELDS = `public_ref, url, event_types, property_ids, status,
                disabled_at, disabled_reason, created_at`

/** Laedt das Abonnement oder bricht ab. Die Zeilenrichtlinie filtert den Mandanten. */
async function loadSubscription(
  client: PoolClient, ref: string
): Promise<{ id: number; status: string }> {
  const { rows, rowCount } = await client.query<{ id: number; status: string }>(
    `SELECT id, status FROM webhook_subscription WHERE public_ref = $1 FOR UPDATE`, [ref])
  if (rowCount === 0) throw Errors.notFound('Abonnement')
  return rows[0]!
}

export function webhookRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/webhook-subscriptions',
    permission: 'integration:manage',
    summary: 'Abonnement fuer ausgehende Ereignisse anlegen',
    handler: async (req, reply) => {
      const body = req.body as SubscriptionBody
      const principal = req.principal as Principal
      const accountId = accountFor(principal, body.accountId)

      // https erzwingen: ueber http reist der Rumpf im Klartext, und die
      // Signatur schuetzt seine Echtheit, nicht seine Vertraulichkeit.
      if (typeof body.url !== 'string' || !body.url.startsWith('https://')) {
        throw Errors.validation({ url: ['Muss mit https:// beginnen'] })
      }

      const eventTypes = body.eventTypes ?? []
      const unbekannt = eventTypes.filter(t => !isWebhookEventType(t))
      if (unbekannt.length > 0) {
        throw Errors.validation({
          eventTypes: [`Unbekannte Ereignisart: ${unbekannt.join(', ')}`] })
      }

      // Der gemeinsame Schluessel entsteht hier und wird genau einmal
      // herausgegeben. Ihn vom Aufrufer entgegenzunehmen hiesse, schwache
      // Schluessel zuzulassen; ihn spaeter erneut zu zeigen, ihn unnoetig
      // oft ueber die Leitung zu schicken.
      const secret = randomBytes(32).toString('base64url')

      return tx(req.pool, req, async client => {
        const propertyIds = body.propertyIds ?? []
        if (propertyIds.length > 0) {
          const eigene = await client.query(
            `SELECT 1 FROM property WHERE account_id = $1 AND id = ANY($2::bigint[])`,
            [accountId, propertyIds])
          if (eigene.rowCount !== propertyIds.length) {
            throw Errors.notFound('Property')
          }
        }

        const r = await client.query<SubscriptionRow>(
          `INSERT INTO webhook_subscription
             (account_id, url, signing_secret, event_types, property_ids, created_by)
           VALUES ($1,$2,$3,$4::text[],$5::bigint[],$6)
           RETURNING ${FIELDS}`,
          [accountId, body.url, secret, eventTypes, propertyIds, principal.userId])

        reply.status(201)
        return {
          ...present(r.rows[0]!),
          signingSecret: secret,
          hinweis: 'Der Schluessel wird nur hier einmal ausgegeben. '
                 + 'Signatur: HMAC-SHA256 ueber "Zeitstempel.Rumpf".'
        }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/webhook-subscriptions',
    permission: 'integration:manage',
    summary: 'Abonnements auflisten',
    handler: async (req) => tx(req.pool, req, async client => {
      const { rows } = await client.query<SubscriptionRow>(
        `SELECT ${FIELDS} FROM webhook_subscription ORDER BY id`)
      // Der Katalog kommt mit, wie bei den Maschinenzugaengen die Scopes:
      // sonst fuehrt jeder Aufrufer eine eigene Liste, und nach der
      // naechsten neuen Ereignisart fehlt in jeder genau diese.
      return { subscriptions: rows.map(present),
               availableEventTypes: [...WEBHOOK_EVENT_TYPES] }
    })
  })

  registerRoute(app, {
    method: 'DELETE',
    url: '/v1/webhook-subscriptions/:subscriptionRef',
    permission: 'integration:manage',
    summary: 'Abonnement entfernen',
    handler: async (req) => {
      const { subscriptionRef } = req.params as { subscriptionRef: string }
      return tx(req.pool, req, async client => {
        const sub = await loadSubscription(client, subscriptionRef)
        await client.query(`DELETE FROM webhook_subscription WHERE id = $1`, [sub.id])
        return { subscriptionRef, deleted: true }
      })
    }
  })

  /**
   * Wieder in Betrieb nehmen. Gegenstueck zur Stilllegung nach dauerhaftem
   * Fehlschlag: ohne diesen Weg waere ein Abonnement nach einer Stoerung
   * beim Empfaenger endgueltig tot, und der Betreiber muesste ein neues
   * anlegen -- mit neuem Schluessel, den die Gegenseite erst wieder
   * einbauen muesste.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/webhook-subscriptions/:subscriptionRef/enable',
    permission: 'integration:manage',
    summary: 'Stillgelegtes Abonnement wieder in Betrieb nehmen',
    handler: async (req) => {
      const { subscriptionRef } = req.params as { subscriptionRef: string }
      return tx(req.pool, req, async client => {
        const sub = await loadSubscription(client, subscriptionRef)
        await client.query(
          `UPDATE webhook_subscription
              SET status = 'active', disabled_at = NULL, disabled_reason = NULL
            WHERE id = $1`, [sub.id])

        // Die gescheiterten Zustellungen bleiben gescheitert. Sie jetzt
        // nachzuholen braechte dem Empfaenger einen Schwall veralteter
        // Ereignisse; was er verpasst hat, steht im Protokoll.
        return { subscriptionRef, status: 'active' }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/webhook-subscriptions/:subscriptionRef/deliveries',
    permission: 'integration:manage',
    summary: 'Zustellungen eines Abonnements mit Versuchsprotokoll',
    handler: async (req) => {
      const { subscriptionRef } = req.params as { subscriptionRef: string }
      const { status, limit } = req.query as { status?: string; limit?: string }
      // Auch nach unten begrenzen: ein negatives LIMIT bricht die Abfrage ab.
      const max = Math.min(Math.max(Number(limit) || 50, 1), 200)

      return tx(req.pool, req, async client => {
        const s = await client.query<{ id: number }>(
          `SELECT id FROM webhook_subscription WHERE public_ref = $1`, [subscriptionRef])
        if (s.rowCount === 0) throw Errors.notFound('Abonnement')

        // Ein Aufruf je Bildschirm: die Versuche kommen als Feld mit, nicht
        // als eine Nachfrage je Zustellung.
        const { rows } = await client.query(
          `SELECT d.event_ref AS "eventRef", d.event_type AS "eventType",
                  d.status, d.attempts, d.last_status_code AS "lastStatusCode",
                  d.last_error AS "lastError", d.occurred_at AS "occurredAt",
                  d.next_attempt_at AS "nextAttemptAt", d.delivered_at AS "deliveredAt",
                  COALESCE(a.versuche, '[]'::jsonb) AS "attemptLog"
             FROM webhook_delivery d
             LEFT JOIN LATERAL (
               SELECT jsonb_agg(jsonb_build_object(
                        'attempt', t.attempt, 'statusCode', t.status_code,
                        'error', t.error, 'durationMs', t.duration_ms,
                        'attemptedAt', t.attempted_at) ORDER BY t.attempt) AS versuche
                 FROM webhook_delivery_attempt t WHERE t.delivery_id = d.id
             ) a ON true
            WHERE d.subscription_id = $1
              AND ($2::text IS NULL OR d.status = $2)
            ORDER BY d.id DESC
            LIMIT $3`,
          [s.rows[0]!.id, status ?? null, max])
        return { subscriptionRef, deliveries: rows }
      })
    }
  })
}
