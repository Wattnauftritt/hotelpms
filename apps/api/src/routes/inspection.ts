import type { FastifyInstance } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import { reiheUebersetzungEin } from '../platform/uebersetzung.js'
import { meldePush } from '../platform/push.js'
import type { Principal } from '../platform/context.js'
import { tagOderOffen } from './cleaningPlan.js'

/**
 * Kontrolle durch die Hausdame (Aufgabe 18, Baustein 4; Migration 0109).
 *
 * Die Hausdame sieht alle Zimmer des Tages mit der Kraft und dem Ausgang
 * und sagt "kontrolliert" oder "nacharbeiten". Kontrolliert macht das
 * Zimmer bezugsfertig (`housekeeping_status = 'inspected'`): die Rezeption
 * sieht es sofort im Zimmerplan, ohne dass jemand anruft.
 *
 * **Keine Minuten in der Antwort.** Die Hausdame sieht Zimmer und Stand,
 * nicht die Arbeitszeit der Kraefte (Plan, Abschnitt 3) -- die Minuten
 * sind die Abrechnung der Zeitarbeitsfirma. Wer planen darf, sieht sie im
 * Reinigungsplan; das ist ein anderes Recht.
 */

const ERGEBNISSE = ['passed', 'rework'] as const
type Ergebnis = (typeof ERGEBNISSE)[number]
const NOTIZ_MAX = 500

interface KontrollZimmer {
  taskId: number
  /** Ein Zimmer oder ein Bereich (0116), nie beides. */
  resourceId: number | null
  areaId: number | null
  code: string
  categoryCode: string | null
  kind: 'departure' | 'stayover'
  assignedTo: number | null
  staffName: string | null
  status: 'open' | 'done' | 'skipped'
  outcome: 'cleaned' | 'declined' | 'was_clean' | null
  inspection: Ergebnis | null
  inspectionNote: string | null
  inspectedBy: string | null
  free: boolean
  arrivalToday: boolean
  openProblems: number
}

/**
 * Alle Abreisen und Bleiber des Tages in einer Abfrage, in Gehreihenfolge.
 * `app_user` hat keine Zeilenrichtlinie; der Name kommt nur ueber eine
 * Aufgabe dieses Hauses herein, die die Richtlinie schon gefiltert hat.
 */
async function liesKontrolle(
  client: PoolClient, propertyId: number, date: string
): Promise<{ date: string; rooms: KontrollZimmer[] }> {
  const { rows } = await client.query<KontrollZimmer>(
    `SELECT t.id::int AS "taskId", r.id::int AS "resourceId", ar.id::int AS "areaId",
            COALESCE(r.code, ar.code) AS code, c.code AS "categoryCode", t.kind, t.assigned_to::int AS "assignedTo",
            u.display_name AS "staffName", t.status, t.outcome, t.inspection,
            t.inspection_note AS "inspectionNote", i.display_name AS "inspectedBy",
            (t.kind <> 'departure' OR NOT EXISTS (
               SELECT 1 FROM reservation a
                WHERE a.resource_id = r.id AND a.departure = t.business_date
                  AND a.status IN ('Confirmed','InHouse'))) AS free,
            EXISTS (SELECT 1 FROM reservation an
                     WHERE an.resource_id = r.id AND an.arrival = t.business_date
                       AND an.status IN ('Confirmed','InHouse')) AS "arrivalToday",
            (SELECT count(*)::int FROM maintenance_ticket m
              WHERE m.resource_id = r.id AND m.status <> 'done') AS "openProblems"
       FROM housekeeping_task t
       LEFT JOIN resource r ON r.id = t.resource_id
       LEFT JOIN resource_category c ON c.id = r.category_id
       LEFT JOIN cleaning_area ar ON ar.id = t.area_id
       LEFT JOIN app_user u ON u.id = t.assigned_to
       LEFT JOIN app_user i ON i.id = t.inspected_by
      WHERE t.property_id = $1 AND t.business_date = $2::date
        AND t.kind IN ('departure','stayover')
      ORDER BY COALESCE(r.building, ar.building) NULLS LAST,
               NULLIF(substring(r.floor from '^-?[0-9]+'), '')::numeric NULLS LAST,
               r.floor NULLS LAST,
               NULLIF(substring(COALESCE(r.code, ar.code) from '^[0-9]+'), '')::numeric NULLS LAST,
               code`,
    [propertyId, date])
  return { date, rooms: rows }
}

export function inspectionRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/inspection',
    permission: 'housekeeping:inspect',
    propertyParam: 'propertyId',
    summary: 'Zimmer des Tages zur Kontrolle, ohne Minuten',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      return tx(req.pool, req, async client =>
        liesKontrolle(client, propertyId, await tagOderOffen(client, propertyId, undefined)))
    }
  })

  /**
   * Kontrollieren, nacharbeiten lassen oder mit `null` zuruecknehmen.
   *
   * Nur ein Zimmer, das als gereinigt oder sauber gemeldet ist: ein offenes
   * zu kontrollieren hiesse, die Rezeption ein Zimmer als bezugsfertig
   * sehen zu lassen, in dem noch niemand war. Nur am offenen Tag -- ein
   * vergangener Tag ist abgerechnet.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/inspection/:taskId',
    permission: 'housekeeping:inspect',
    propertyParam: 'propertyId',
    summary: 'Zimmer kontrolliert oder nacharbeiten',
    handler: async (req) => {
      const p = req.params as { propertyId: string; taskId: string }
      const propertyId = Number(p.propertyId)
      const taskId = Number(p.taskId)
      if (!Number.isInteger(taskId) || taskId <= 0) throw Errors.notFound('res.task')
      const principal = req.principal as Principal
      const body = (req.body ?? {}) as { result?: unknown; note?: unknown }
      const ergebnis = body.result
      if (ergebnis !== null && !ERGEBNISSE.includes(ergebnis as Ergebnis)) {
        throw Errors.validation({ result: ['field.allowedValues'] },
          { values: ERGEBNISSE.join(', ') })
      }
      let notiz: string | null = null
      if (ergebnis === 'rework') {
        if (typeof body.note !== 'string' || body.note.trim() === '') {
          throw Errors.validation({ note: ['inspection.noteRequired'] })
        }
        notiz = body.note.trim()
        if (notiz.length > NOTIZ_MAX) {
          throw Errors.validation({ note: ['field.maxLength'] }, { max: NOTIZ_MAX })
        }
      }
      return tx(req.pool, req, async client => {
        const tag = await tagOderOffen(client, propertyId, undefined)
        const { rows } = await client.query<{ resource_id: number | null; outcome: string | null
                                              code: string; locale: string | null
                                              assigned_to: number | null }>(
          `SELECT t.resource_id::int, t.outcome, COALESCE(r.code, a.code) AS code, u.locale,
                  t.assigned_to::int
             FROM housekeeping_task t
             LEFT JOIN resource r ON r.id = t.resource_id
             LEFT JOIN cleaning_area a ON a.id = t.area_id
             LEFT JOIN app_user u ON u.id = t.assigned_to
            WHERE t.id = $1 AND t.property_id = $2 AND t.business_date = $3::date
              AND t.kind IN ('departure','stayover')
            FOR UPDATE OF t`, [taskId, propertyId, tag])
        const aufgabe = rows[0]
        if (aufgabe === undefined) throw Errors.notFound('res.task')
        if (ergebnis !== null && aufgabe.outcome !== 'cleaned' && aufgabe.outcome !== 'was_clean') {
          throw Errors.conflict('inspection.notCleaned', { room: aufgabe.code })
        }
        await client.query(
          `UPDATE housekeeping_task
              SET inspection = $2,
                  inspection_note = CASE WHEN $2::text = 'rework' THEN $3
                                         WHEN $2::text = 'passed' THEN NULL
                                         ELSE inspection_note END,
                  inspected_by = CASE WHEN $2::text IS NULL THEN NULL ELSE $4::bigint END,
                  inspected_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END
            WHERE id = $1`, [taskId, ergebnis, notiz, principal.userId])
        /*
         * Die Hausdame schreibt deutsch, die Kraft liest in ihrer Sprache.
         * Ohne gewaehlte Sprache oder bei Deutsch geht nichts an DeepL --
         * die Notiz steht dann so da, wie sie geschrieben wurde.
         */
        if (ergebnis === 'rework' && aufgabe.locale !== null
            && ['en', 'ru', 'uk'].includes(aufgabe.locale)) {
          await reiheUebersetzungEin(client, propertyId, 'inspection_note', taskId,
            [aufgabe.locale])
        }
        if (ergebnis === 'rework' && aufgabe.assigned_to !== null) {
          await meldePush(client, propertyId, [aufgabe.assigned_to], 'rework',
            { room: aufgabe.code }, `${taskId}`)
        }
        /*
         * Der Zimmerstand folgt: kontrolliert ist bezugsfertig, nacharbeiten
         * ist schmutzig, zuruecknehmen ist wieder sauber -- gereinigt war
         * das Zimmer ja, sonst kaeme man hier nicht her.
         */
        if (aufgabe.resource_id !== null
            && (aufgabe.outcome === 'cleaned' || aufgabe.outcome === 'was_clean')) {
          const stand = ergebnis === 'passed' ? 'inspected' : ergebnis === 'rework' ? 'dirty' : 'clean'
          await client.query(
            `INSERT INTO housekeeping_status (property_id, resource_id, status, updated_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (resource_id) DO UPDATE SET
               status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [propertyId, aufgabe.resource_id, stand, principal.userId])
        }
        return liesKontrolle(client, propertyId, tag)
      })
    }
  })
}
