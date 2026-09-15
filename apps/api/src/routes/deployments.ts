import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { tx } from '../platform/db.js'
import type { Principal } from '../platform/context.js'

/**
 * Ausrollen anfordern (Dokument 21 §8).
 *
 * **Die API rollt nicht aus, sie schreibt eine Zeile.** Sie laeuft unter
 * `NoNewPrivileges=true`; `sudo` ist aus dem Prozess heraus gesperrt, und
 * der Neustart der Dienste braucht genau das. Das ist keine Huerde, die man
 * umgeht, sondern der Grund, warum ein Einbruch in die Anwendung nicht
 * gleich die Maschine ist.
 *
 * Ausgefuehrt wird die Anforderung von `ops/deploy/deploy-agent.sh`, einem
 * eigenen Dienst mit eigenen Rechten. Er sieht minuetlich nach.
 *
 * **Was ausgerollt wird, entscheidet die Route nicht.** Die Maschine holt
 * den Git-Tag `produktion`, nie `main`. Wer ihn verschiebt, gibt frei --
 * dieser Knopf bestimmt nur den Zeitpunkt.
 */

const MARKER = 'produktion'

interface Zeile {
  id: number
  requested_by_name: string | null
  requested_at: string
  target_ref: string
  status: string
  started_at: string | null
  finished_at: string | null
  commit_before: string | null
  commit_after: string | null
  log: string | null
}

const SPALTEN = `
  d.id, u.display_name AS requested_by_name, d.requested_at::text,
  d.target_ref, d.status, d.started_at::text, d.finished_at::text,
  d.commit_before, d.commit_after, d.log
  FROM deploy_request d
  LEFT JOIN app_user u ON u.id = d.requested_by`

function nachAussen(z: Zeile): Record<string, unknown> {
  return {
    id: z.id,
    // Leer heisst: von Hand auf der Maschine gestartet. Das gehoert in die
    // Liste, sonst zeigt sie einen Stand, den ein Handlauf laengst
    // ueberholt hat.
    requestedBy: z.requested_by_name,
    requestedAt: z.requested_at,
    targetRef: z.target_ref,
    status: z.status,
    startedAt: z.started_at,
    finishedAt: z.finished_at,
    commitBefore: z.commit_before,
    commitAfter: z.commit_after,
    log: z.log
  }
}

export function deploymentRoutes(app: FastifyInstance): void {
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/deployments',
    permission: 'platform:operations',
    summary: 'Ausrollen des freigegebenen Standes anfordern',
    handler: async (req, reply) => {
      const principal = req.principal as Principal

      const angelegt = await tx(req.pool, req, async client => {
        /*
         * Der eindeutige Teilindex laesst nur eine offene Anforderung zu.
         * Statt den Datenbankfehler durchschlagen zu lassen, wird er hier
         * zu einer lesbaren Meldung -- der Aufrufer hat nichts falsch
         * gemacht, er war nur zu frueh.
         */
        const offen = await client.query(
          `SELECT 1 FROM deploy_request WHERE status IN ('pending','running')`)
        if (offen.rowCount !== 0) throw Errors.conflict('deploy.alreadyRunning')

        const r = await client.query<{ id: number }>(
          `INSERT INTO deploy_request (requested_by, target_ref)
           VALUES ($1, $2) RETURNING id`, [principal.userId, MARKER])
        const z = await client.query<Zeile>(
          `SELECT ${SPALTEN} WHERE d.id = $1`, [r.rows[0]!.id])
        return z.rows[0]!
      })

      reply.status(202)
      return nachAussen(angelegt)
    }
  })

  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/deployments',
    permission: 'platform:operations',
    summary: 'Ausrollvorgaenge und der laufende Stand',
    handler: async (req) => {
      const rows = await tx(req.pool, req, client =>
        client.query<Zeile>(
          `SELECT ${SPALTEN} ORDER BY d.id DESC LIMIT 20`))
      const liste = rows.rows.map(nachAussen)

      /*
       * Was gerade laeuft, ist der Stand des letzten geglueckten Laufs --
       * abgeleitet, nicht gespeichert. Ein eigenes Feld dafuer waere eine
       * zweite Wahrheit, die beim ersten Lauf von Hand danebenliegt.
       */
      const laufend = rows.rows.find(z => z.status === 'done')?.commit_after ?? null
      return { deployments: liste, currentCommit: laufend }
    }
  })
}
