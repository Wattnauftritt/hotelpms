import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { isIsoDate } from '@hotelpms/domain'
import type { Principal } from '../platform/context.js'

const STATES = ['dirty', 'clean', 'inspected', 'occupied'] as const
type HousekeepingState = (typeof STATES)[number]

export function housekeepingRoutes(app: FastifyInstance): void {
  /**
   * Der Zimmerplan des Tages in **einer** Abfrage.
   *
   * Housekeeping laeuft auf dem Telefon durchs Haus, oft ueber WLAN mit
   * schlechter Verbindung. Die Liste je Zimmer einzeln zu laden waere bei
   * 250 Zimmern 250 Runden. Zustand, Aufgabe, Abreise und Anreise kommen
   * deshalb zusammen (P-Gesetz, Dokument 04).
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/housekeeping',
    permission: 'housekeeping:read',
    propertyParam: 'propertyId',
    summary: 'Zimmerplan des Tages',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { date?: string }
      const date = q.date ?? null
      if (date !== null && !isIsoDate(date)) {
        throw Errors.validation({ date: ['Datum im Format YYYY-MM-DD erwartet'] })
      }
      return tx(req.pool, req, async client => {
        const { rows } = await client.query(
          `WITH tag AS (
             SELECT COALESCE($2::date,
                     (SELECT date FROM business_day
                       WHERE property_id = $1 AND status = 'open'
                       ORDER BY date LIMIT 1)) AS d
           )
           SELECT r.id AS "resourceId", r.code, c.code AS "categoryCode",
                  COALESCE(h.status, 'clean') AS status,
                  h.assigned_to AS "assignedTo",
                  h.updated_at::text AS "updatedAt",
                  t.kind AS "taskKind", t.status AS "taskStatus", t.id AS "taskId",
                  ab.public_ref AS "departureRef",
                  ab.departure::text AS "departureDate",
                  an.public_ref AS "arrivalRef",
                  (SELECT count(*) FROM maintenance_ticket m
                    WHERE m.resource_id = r.id AND m.status <> 'done')::int AS "openTickets"
             FROM resource r
             CROSS JOIN tag
             JOIN resource_category c ON c.id = r.category_id
             LEFT JOIN housekeeping_status h ON h.resource_id = r.id
             LEFT JOIN housekeeping_task t
                    ON t.resource_id = r.id AND t.business_date = tag.d
             LEFT JOIN reservation ab
                    ON ab.resource_id = r.id AND ab.departure = tag.d
                   AND ab.status IN ('InHouse','CheckedOut')
             LEFT JOIN reservation an
                    ON an.resource_id = r.id AND an.arrival = tag.d
                   AND an.status IN ('Confirmed','InHouse')
            WHERE r.property_id = $1 AND r.active
            ORDER BY r.code`,
          [Number(propertyId), date])
        return { date, rooms: rows }
      })
    }
  })

  registerRoute(app, {
    method: 'PUT',
    url: '/v1/housekeeping/status',
    permission: 'housekeeping:write',
    propertyParam: 'propertyId',
    summary: 'Zimmerstatus setzen, auch fuer mehrere Zimmer',
    handler: async (req) => {
      const body = req.body as {
        propertyId: number; resourceIds: number[]; status: HousekeepingState
        assignedTo?: number | null }
      const principal = req.principal as Principal
      if (!STATES.includes(body.status)) {
        throw Errors.validation({ status: [`Erlaubt: ${STATES.join(', ')}`] })
      }
      if (!Array.isArray(body.resourceIds) || body.resourceIds.length === 0) {
        throw Errors.validation({ resourceIds: ['Mindestens ein Zimmer'] })
      }
      if (body.resourceIds.length > 500) throw Errors.rangeTooLarge(500)

      return tx(req.pool, req, async client => {
        // Die Zimmer muessen zur Property gehoeren. Die Zeilenrichtlinie
        // filtert nach Mandant, nicht nach Haus; bei mehreren Haeusern im
        // Account kaeme ein fremdes Zimmer sonst durch.
        const gueltig = await client.query<{ id: number }>(
          `SELECT id FROM resource WHERE property_id = $1 AND id = ANY($2::bigint[])`,
          [body.propertyId, body.resourceIds])
        if (gueltig.rowCount !== body.resourceIds.length) {
          throw Errors.notFound('Zimmer')
        }
        const { rowCount } = await client.query(
          `INSERT INTO housekeeping_status (property_id, resource_id, status,
                                            assigned_to, updated_by)
           SELECT $1, unnest($2::bigint[]), $3, $4, $5
           ON CONFLICT (resource_id) DO UPDATE SET
             status = EXCLUDED.status,
             assigned_to = EXCLUDED.assigned_to,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
          [body.propertyId, body.resourceIds, body.status,
           body.assignedTo ?? null, principal.userId])
        return { updated: rowCount ?? 0, status: body.status }
      })
    }
  })

  /**
   * Aufgabenliste des Tages erzeugen.
   *
   * Abreise, Bleibegast, sonst nichts. Idempotent ueber den eindeutigen
   * Schluessel: ein zweiter Aufruf am selben Tag legt nichts doppelt an,
   * sondern ergaenzt nur, was seither dazugekommen ist.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/housekeeping/tasks/generate',
    permission: 'housekeeping:write',
    propertyParam: 'propertyId',
    summary: 'Aufgaben des Tages erzeugen',
    handler: async (req) => {
      const body = req.body as { propertyId: number; date?: string }
      if (body.date !== undefined && !isIsoDate(body.date)) {
        throw Errors.validation({ date: ['Datum im Format YYYY-MM-DD erwartet'] })
      }
      return tx(req.pool, req, async client => {
        const { rowCount } = await client.query(
          `WITH tag AS (
             SELECT COALESCE($2::date,
                     (SELECT date FROM business_day WHERE property_id = $1
                       AND status = 'open' ORDER BY date LIMIT 1)) AS d
           )
           INSERT INTO housekeeping_task (property_id, resource_id, business_date, kind)
           SELECT $1, res.resource_id, tag.d, res.kind FROM tag, LATERAL (
             SELECT r.resource_id,
                    CASE WHEN r.departure = tag.d THEN 'departure' ELSE 'stayover' END AS kind
               FROM reservation r
              WHERE r.property_id = $1 AND r.resource_id IS NOT NULL
                AND r.status = 'InHouse'
                AND r.arrival <= tag.d AND r.departure >= tag.d
           ) res
           ON CONFLICT (resource_id, business_date, kind) DO NOTHING`,
          [body.propertyId, body.date ?? null])
        return { created: rowCount ?? 0 }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/housekeeping/tasks/:taskId/done',
    permission: 'housekeeping:write',
    summary: 'Aufgabe abschliessen',
    handler: async (req) => {
      const { taskId } = req.params as { taskId: string }
      const principal = req.principal as Principal
      return tx(req.pool, req, async client => {
        const { rows, rowCount } = await client.query<{ resource_id: number
                                                        property_id: number }>(
          `UPDATE housekeeping_task SET status = 'done', done_at = now()
            WHERE id = $1 AND status = 'open'
            RETURNING resource_id, property_id`, [Number(taskId)])
        if (rowCount === 0) throw Errors.notFound('Aufgabe')
        // Eine erledigte Reinigung setzt den Zimmerstatus mit, sonst muss
        // die Kraft zwei Dinge tippen und tippt eines davon nicht.
        await client.query(
          `INSERT INTO housekeeping_status (property_id, resource_id, status, updated_by)
           VALUES ($1,$2,'clean',$3)
           ON CONFLICT (resource_id) DO UPDATE SET
             status = 'clean', updated_by = $3, updated_at = now()`,
          [rows[0]!.property_id, rows[0]!.resource_id, principal.userId])
        return { taskId: Number(taskId), status: 'done' }
      })
    }
  })

  registerRoute(app, {
    method: 'POST',
    url: '/v1/maintenance-tickets',
    permission: 'maintenance:write',
    propertyParam: 'propertyId',
    summary: 'Wartungsmeldung anlegen',
    handler: async (req, reply) => {
      const body = req.body as {
        propertyId: number; resourceId?: number; title: string; description?: string
        priority?: 'low' | 'normal' | 'high'
        outOfOrder?: { from: string; to: string }
        /**
         * Sperrung beider Arten. `outOfOrder` bleibt daneben bestehen: es
         * gibt Aufrufer, die es benutzen, und eine Kurzform fuer den
         * haeufigeren Fall schadet nicht.
         */
        block?: { from: string; to: string; kind?: 'out_of_order' | 'out_of_service' } }
      const principal = req.principal as Principal
      if (!body.title || body.title.trim() === '') {
        throw Errors.validation({ title: ['Pflichtfeld'] })
      }
      const sperre = body.block ?? (body.outOfOrder === undefined ? undefined
        : { ...body.outOfOrder, kind: 'out_of_order' as const })
      if (sperre !== undefined && body.resourceId === undefined) {
        // Eine Sperrung ohne Zimmer waere eine Sperrung von nichts. Still zu
        // uebergehen hiesse: der Melder glaubt, das Zimmer sei gesperrt.
        throw Errors.validation({ resourceId: ['Eine Sperrung braucht ein Zimmer'] })
      }
      return tx(req.pool, req, async client => {
        const t = await client.query<{ id: number }>(
          `INSERT INTO maintenance_ticket (property_id, resource_id, title, description,
                                           priority, created_by)
           VALUES ($1,$2,$3,$4,COALESCE($5,'normal'),$6) RETURNING id`,
          [body.propertyId, body.resourceId ?? null, body.title.trim(),
           body.description ?? null, body.priority ?? null, principal.userId])

        // Out of Order senkt die Kapazitaet, Out of Service nicht. Der
        // Trigger auf maintenance_block rechnet inventory_day nach.
        if (sperre !== undefined && body.resourceId !== undefined) {
          if (!isIsoDate(sperre.from) || !isIsoDate(sperre.to)) {
            throw Errors.validation({ block: ['Datum im Format YYYY-MM-DD erwartet'] })
          }
          await client.query(
            `INSERT INTO maintenance_block (property_id, resource_id, from_date, to_date,
                                            kind, reason)
             VALUES ($1,$2,$3::date,$4::date,COALESCE($5,'out_of_order'),$6)`,
            [body.propertyId, body.resourceId, sperre.from, sperre.to,
             sperre.kind ?? null, body.title.trim()])
        }
        reply.status(201)
        return { ticketId: t.rows[0]!.id }
      })
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/maintenance-tickets',
    permission: 'housekeeping:read',
    propertyParam: 'propertyId',
    summary: 'Offene Wartungsmeldungen',
    handler: async (req) => {
      const { propertyId } = req.params as { propertyId: string }
      const q = req.query as { status?: string }
      return tx(req.pool, req, async client => {
        // Die Sperrungen des Zimmers kommen als Feld mit. Sie je Meldung
        // nachzuladen waere eine Runde je Zeile -- und ohne sie ist an der
        // Meldung nicht zu sehen, ob das Zimmer gerade Kapazitaet kostet.
        const { rows } = await client.query(
          `SELECT m.id, m.title, m.description, m.priority, m.status,
                  m.created_at::text AS "createdAt", m.closed_at AS "closedAt",
                  m.resource_id AS "resourceId", r.code AS "roomCode",
                  COALESCE(b.sperren, '[]'::jsonb) AS blocks
             FROM maintenance_ticket m
             LEFT JOIN resource r ON r.id = m.resource_id
             LEFT JOIN LATERAL (
               SELECT jsonb_agg(jsonb_build_object(
                        'kind', mb.kind, 'from', mb.from_date::text,
                        'to', mb.to_date::text, 'reason', mb.reason)
                      ORDER BY mb.from_date) AS sperren
                 FROM maintenance_block mb
                WHERE mb.resource_id = m.resource_id
                  AND mb.to_date > current_date
             ) b ON true
            WHERE m.property_id = $1
              AND ($2::text IS NULL OR m.status = $2)
            ORDER BY CASE m.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                     m.created_at
            LIMIT 500`,
          [Number(propertyId), q.status ?? null])
        return { tickets: rows }
      })
    }
  })

  /**
   * Stand einer Wartungsmeldung aendern.
   *
   * Es gibt bewusst **keinen Loeschknopf**: eine Meldung ist die
   * Aufzeichnung eines Befundes, und wer sie loescht, loescht die Frage, ob
   * das Zimmer je in Ordnung gebracht wurde. Erledigt ist ein Zustand, kein
   * Verschwinden.
   *
   * Die Sperrung bleibt, wo sie ist. Sie mit der Meldung aufzuheben waere
   * bequem und falsch: eine Meldung wird erledigt, wenn jemand die Arbeit
   * getan hat, und ob das Zimmer wieder verkaeuflich ist, entscheidet, wer
   * hineingesehen hat -- nicht die Software.
   */
  registerRoute(app, {
    method: 'PATCH',
    url: '/v1/maintenance-tickets/:ticketId',
    permission: 'maintenance:write',
    summary: 'Wartungsmeldung in Arbeit nehmen oder erledigen',
    handler: async (req) => {
      const { ticketId } = req.params as { ticketId: string }
      const body = req.body as { status?: string; priority?: string }
      const STAENDE = ['open', 'in_progress', 'done']
      const PRIORITAETEN = ['low', 'normal', 'high']
      if (body.status !== undefined && !STAENDE.includes(body.status)) {
        throw Errors.validation({ status: [`Erlaubt: ${STAENDE.join(', ')}`] })
      }
      if (body.priority !== undefined && !PRIORITAETEN.includes(body.priority)) {
        throw Errors.validation({ priority: [`Erlaubt: ${PRIORITAETEN.join(', ')}`] })
      }

      return tx(req.pool, req, async client => {
        const { rows, rowCount } = await client.query(
          `UPDATE maintenance_ticket SET
             status = COALESCE($2, status),
             priority = COALESCE($3, priority),
             -- Der Zeitpunkt haengt am Zustand, nicht am Aufruf: ein
             -- zweites "erledigt" darf ihn nicht nach hinten schieben.
             closed_at = CASE WHEN $2 = 'done' THEN COALESCE(closed_at, now())
                              WHEN $2 IS NOT NULL THEN NULL
                              ELSE closed_at END
           WHERE id = $1
           RETURNING id, status, priority, closed_at AS "closedAt"`,
          [Number(ticketId), body.status ?? null, body.priority ?? null])
        if (rowCount === 0) throw Errors.notFound('Wartungsmeldung')
        return rows[0]!
      })
    }
  })
}
