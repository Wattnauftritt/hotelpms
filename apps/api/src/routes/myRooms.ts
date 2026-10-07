import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PoolClient } from '@hotelpms/db'
import { registerRoute } from '../platform/routes.js'
import { tx } from '../platform/db.js'
import { Errors } from '../platform/errors.js'
import type { Principal } from '../platform/context.js'
import { tagOderOffen } from './cleaningPlan.js'

/**
 * Meine Zimmer (Aufgabe 18, Baustein 3; Migration 0108).
 *
 * Was die Reinigungskraft am Telefon sieht: ihre Zimmer des Tages, und ob
 * sie hinein kann. Nur die **eigenen** -- die alte App liess jeden
 * Angemeldeten den Stand jedes Zimmers setzen. Hier sucht jede Abfrage nach
 * `assigned_to = ich`, und eine fremde Aufgabe ist schlicht nicht da (404,
 * nicht 403: dass es sie gibt, geht die Kraft nichts an).
 *
 * Das Recht ist `staff:app`. Es sagt "darf die Personal-App benutzen",
 * nicht "darf Zimmer sehen"; welche Zimmer, entscheidet der Plan. Deshalb
 * braucht es kein eigenes Recht: wer keine Zimmer zugeteilt hat, bekommt
 * eine leere Liste.
 */

const AUSGAENGE = ['cleaned', 'declined', 'was_clean'] as const
type Ausgang = (typeof AUSGAENGE)[number]

/** Ein Problem ist ein Satz oder zwei, keine Abhandlung. */
const PROBLEM_MAX = 1000

/**
 * Nur ein Mensch hat Zimmer. Ein Maschinenzugang kann `staff:app` nicht
 * tragen (`oauth.ts`), und ein Geraet traegt nur sein eigenes Recht; die
 * Pruefung steht trotzdem hier, damit nicht eine einzige Zeile anderswo
 * das Ganze haelt -- wie beim Gaesteterminal.
 */
function personVon(req: FastifyRequest): number {
  const p = req.principal as Principal
  if (p.userId === null || p.terminalDeviceId !== null) {
    throw Errors.forbidden('staff.personOnly')
  }
  return p.userId
}

interface MeinZimmer {
  taskId: number
  resourceId: number
  code: string
  categoryCode: string
  building: string | null
  floor: string | null
  kind: 'departure' | 'stayover'
  minutes: number | null
  status: 'open' | 'done' | 'skipped'
  outcome: Ausgang | null
  /**
   * Ob die Kraft hinein kann. Bei einer Abreise erst, wenn der Gast
   * ausgecheckt ist; ein Zimmer ohne abreisenden Gast (das Gemeinschaftsbad
   * im Gaestehaus, ein Zimmer, dessen Gast schon gestern ging) ist immer
   * frei. Bleiber sind frei: der Gast ist da, das ist der Normalfall.
   */
  free: boolean
  /**
   * Die Kontrolle der Hausdame (0109). Bei `rework` steht in
   * `inspectionNote`, was fehlt, und das Zimmer gehoert wieder nach oben.
   */
  inspection: 'passed' | 'rework' | null
  inspectionNote: string | null
  /** Heute kommt jemand -- dieses Zimmer zuerst. */
  arrivalToday: boolean
  /** Offene Wartungsmeldungen am Zimmer, damit niemand dasselbe zweimal meldet. */
  openProblems: number
}

/**
 * Die Liste des Tages in einer Abfrage. Reihenfolge wie im Plan: Gebaeude,
 * Etage, Nummer -- so laeuft die Kraft durchs Haus.
 */
async function liesMeineZimmer(
  client: PoolClient, propertyId: number, userId: number, date: string
): Promise<{ date: string; rooms: MeinZimmer[]; minutes: number }> {
  const { rows } = await client.query<MeinZimmer>(
    `SELECT t.id::int AS "taskId", r.id::int AS "resourceId", r.code,
            c.code AS "categoryCode", r.building, r.floor, t.kind, t.minutes,
            t.status, t.outcome, t.inspection,
            CASE WHEN t.inspection = 'rework' THEN t.inspection_note END AS "inspectionNote",
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
       JOIN resource r ON r.id = t.resource_id
       JOIN resource_category c ON c.id = r.category_id
      WHERE t.property_id = $1 AND t.assigned_to = $2 AND t.business_date = $3::date
        AND t.kind IN ('departure','stayover')
      ORDER BY r.building NULLS LAST,
               NULLIF(substring(r.floor from '^-?[0-9]+'), '')::numeric NULLS LAST, r.floor,
               NULLIF(substring(r.code from '^[0-9]+'), '')::numeric NULLS LAST, r.code`,
    [propertyId, userId, date])
  // Die Summe des Tages ist, was abgerechnet wird: nur Gereinigtes zaehlt
  // (wie in der alten App). Die Kraft sieht dieselbe Zahl wie die Leitung.
  const minutes = rows.reduce((s, z) => s + (z.outcome === 'cleaned' ? z.minutes ?? 0 : 0), 0)
  return { date, rooms: rows, minutes }
}

/** Die eigene Aufgabe von heute, gesperrt -- sonst 404. */
async function eigeneAufgabe(
  client: PoolClient, propertyId: number, userId: number, taskId: number
): Promise<{ id: number; resource_id: number; outcome: Ausgang | null; date: string
              inspection: string | null }> {
  const tag = await tagOderOffen(client, propertyId, undefined)
  const { rows } = await client.query<{
    id: number; resource_id: number; outcome: Ausgang | null; date: string
    inspection: string | null }>(
    `SELECT id::int, resource_id::int, outcome, business_date::text AS date, inspection
       FROM housekeeping_task
      WHERE id = $1 AND property_id = $2 AND assigned_to = $3
        AND business_date = $4::date AND kind IN ('departure','stayover')
      FOR UPDATE`, [taskId, propertyId, userId, tag])
  if (rows.length === 0) throw Errors.notFound('res.task')
  return rows[0]!
}

function aufgabeAusPfad(req: FastifyRequest): { propertyId: number; taskId: number } {
  const p = req.params as { propertyId: string; taskId: string }
  const taskId = Number(p.taskId)
  if (!Number.isInteger(taskId) || taskId <= 0) throw Errors.notFound('res.task')
  return { propertyId: Number(p.propertyId), taskId }
}

export function myRoomsRoutes(app: FastifyInstance): void {
  /**
   * Heute, nicht ein waehlbarer Tag: die Kraft arbeitet den Tag ab, an dem
   * sie im Haus ist. Der Tag ist der offene Geschaeftstag -- derselbe, den
   * die Hausdame plant --, nicht das Datum des Telefons.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/properties/:propertyId/my-rooms',
    permission: 'staff:app',
    propertyParam: 'propertyId',
    summary: 'Meine Zimmer des Tages (Personal-App)',
    handler: async (req) => {
      const propertyId = Number((req.params as { propertyId: string }).propertyId)
      const ich = personVon(req)
      return tx(req.pool, req, async client =>
        liesMeineZimmer(client, propertyId, ich, await tagOderOffen(client, propertyId, undefined)))
    }
  })

  /**
   * Den Ausgang setzen, oder mit `null` zuruecknehmen -- ein Fehltipp auf
   * dem Telefon soll nicht die Hausdame brauchen.
   *
   * "Gereinigt" und "war sauber" setzen das Zimmer auf sauber, damit die
   * Rezeption es sofort sieht und die Kraft nicht zweimal tippen muss.
   * "Keine Reinigung gewuenscht" laesst den Zimmerstand, wie er ist: das
   * Zimmer ist nicht gereinigt. Zuruecknehmen setzt ein von hier sauber
   * gemeldetes Zimmer wieder auf schmutzig, ein schon kontrolliertes nicht
   * -- das hat die Hausdame entschieden.
   *
   * Eine Abreise, deren Gast noch nicht ausgecheckt ist, darf trotzdem
   * gereinigt werden. Viele Haeuser checken nicht jeden Gast von Hand aus
   * (Grundregel vom 05.10.2026), und die Kraft sieht, ob das Zimmer leer
   * ist; die Oberflaeche zeigt nur den Hinweis.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/my-rooms/:taskId',
    permission: 'staff:app',
    propertyParam: 'propertyId',
    summary: 'Ausgang einer eigenen Reinigung setzen (Personal-App)',
    handler: async (req) => {
      const { propertyId, taskId } = aufgabeAusPfad(req)
      const ich = personVon(req)
      const outcome = (req.body as { outcome?: unknown } | null)?.outcome
      if (outcome !== null && !AUSGAENGE.includes(outcome as Ausgang)) {
        throw Errors.validation({ outcome: ['field.allowedValues'] },
          { values: AUSGAENGE.join(', ') })
      }
      return tx(req.pool, req, async client => {
        const aufgabe = await eigeneAufgabe(client, propertyId, ich, taskId)
        const neu = outcome as Ausgang | null
        if (neu !== aufgabe.outcome) {
          // Ein anderer Ausgang macht die Kontrolle hinfaellig: sie galt dem
          // Zimmer, wie es vorher gemeldet war.
          await client.query(
            `UPDATE housekeeping_task
                SET inspection = NULL, inspected_by = NULL, inspected_at = NULL,
                    outcome = $2,
                    status = CASE $2 WHEN 'cleaned' THEN 'done'
                                     WHEN 'declined' THEN 'skipped'
                                     WHEN 'was_clean' THEN 'skipped'
                                     ELSE 'open' END,
                    done_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
                    done_by = CASE WHEN $2::text IS NULL THEN NULL ELSE $3::bigint END
              WHERE id = $1`, [taskId, neu, ich])
          if (neu === 'cleaned' || neu === 'was_clean') {
            await client.query(
              `INSERT INTO housekeeping_status (property_id, resource_id, status, updated_by)
               VALUES ($1, $2, 'clean', $3)
               ON CONFLICT (resource_id) DO UPDATE SET
                 status = 'clean', updated_by = $3, updated_at = now()`,
              [propertyId, aufgabe.resource_id, ich])
          } else if (neu === null
                     && (aufgabe.outcome === 'cleaned' || aufgabe.outcome === 'was_clean')) {
            await client.query(
              `UPDATE housekeeping_status SET status = 'dirty', updated_by = $2, updated_at = now()
                WHERE resource_id = $1 AND status IN ('clean','inspected')`, [aufgabe.resource_id, ich])
          }
        }
        return liesMeineZimmer(client, propertyId, ich, aufgabe.date)
      })
    }
  })

  /**
   * Nachgearbeitet: die Hausdame hatte "nacharbeiten" gesagt, die Kraft war
   * noch einmal drin. Die Kontrolle faellt auf offen zurueck, das Zimmer
   * wird wieder sauber, und die Hausdame schaut noch einmal. Der Satz der
   * Hausdame bleibt stehen -- er gehoert zur Geschichte des Zimmers.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/my-rooms/:taskId/reworked',
    permission: 'staff:app',
    propertyParam: 'propertyId',
    summary: 'Nacharbeit an einem eigenen Zimmer melden (Personal-App)',
    handler: async (req) => {
      const { propertyId, taskId } = aufgabeAusPfad(req)
      const ich = personVon(req)
      return tx(req.pool, req, async client => {
        const aufgabe = await eigeneAufgabe(client, propertyId, ich, taskId)
        if (aufgabe.inspection !== 'rework') throw Errors.conflict('inspection.noRework')
        await client.query(
          `UPDATE housekeeping_task
              SET inspection = NULL, inspected_by = NULL, inspected_at = NULL
            WHERE id = $1`, [taskId])
        await client.query(
          `INSERT INTO housekeeping_status (property_id, resource_id, status, updated_by)
           VALUES ($1, $2, 'clean', $3)
           ON CONFLICT (resource_id) DO UPDATE SET
             status = 'clean', updated_by = $3, updated_at = now()`,
          [propertyId, aufgabe.resource_id, ich])
        return liesMeineZimmer(client, propertyId, ich, aufgabe.date)
      })
    }
  })

  /**
   * Ein Problem am Zimmer melden. Daraus wird eine Wartungsmeldung, die
   * Hausdame und Technik in ihrer Liste sehen. Die Reinigung selbst bleibt
   * offen: ein tropfender Hahn hindert nicht am Putzen, und wenn doch, sagt
   * die Kraft das mit dem Ausgang.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/properties/:propertyId/my-rooms/:taskId/problem',
    permission: 'staff:app',
    propertyParam: 'propertyId',
    summary: 'Problem an einem eigenen Zimmer melden (Personal-App)',
    handler: async (req, reply) => {
      const { propertyId, taskId } = aufgabeAusPfad(req)
      const ich = personVon(req)
      const text = (req.body as { text?: unknown } | null)?.text
      if (typeof text !== 'string' || text.trim() === '') {
        throw Errors.validation({ text: ['field.required'] })
      }
      if (text.length > PROBLEM_MAX) {
        throw Errors.validation({ text: ['field.maxLength'] }, { max: PROBLEM_MAX })
      }
      const sauber = text.trim()
      // Der Titel ist die erste Zeile, gekuerzt -- so steht die Meldung in
      // der Liste lesbar da, und der ganze Text in der Beschreibung.
      const erste = sauber.split('\n')[0]!.trim()
      const titel = erste.length > 120 ? `${erste.slice(0, 119)}…` : erste
      return tx(req.pool, req, async client => {
        const aufgabe = await eigeneAufgabe(client, propertyId, ich, taskId)
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO maintenance_ticket (property_id, resource_id, title, description,
                                           created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id::int`,
          [propertyId, aufgabe.resource_id, titel, sauber, ich])
        reply.code(201)
        return {
          ticketId: rows[0]!.id,
          ...(await liesMeineZimmer(client, propertyId, ich, aufgabe.date))
        }
      })
    }
  })
}
