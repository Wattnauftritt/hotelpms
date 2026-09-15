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
  kind: string
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
  d.id, d.kind, u.display_name AS requested_by_name, d.requested_at::text,
  d.target_ref, d.status, d.started_at::text, d.finished_at::text,
  d.commit_before, d.commit_after, d.log
  FROM deploy_request d
  LEFT JOIN app_user u ON u.id = d.requested_by`

function nachAussen(z: Zeile): Record<string, unknown> {
  return {
    id: z.id,
    kind: z.kind,
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

  /*
   * Zurueckrollen.
   *
   * **Was das kann und was nicht.** Es schaltet den Symlink auf einen Stand
   * zurueck, der noch unter releases/ liegt -- kein Bau, keine halbe Minute,
   * nur Umschalten und Neustart. Was es NICHT tut, ist Migrationen
   * zuruecknehmen: das Schema bleibt auf dem Stand des neueren Codes. Fuer
   * hinzufuegende Aenderungen ist das unproblematisch; wer eine Migration
   * schreibt, die Bestehendes wegnimmt, nimmt dem Zurueckrollen genau diese
   * Eigenschaft (Migration 0034).
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/deployments/rollback',
    permission: 'platform:operations',
    summary: 'Auf einen frueheren Stand zurueckrollen',
    handler: async (req, reply) => {
      const principal = req.principal as Principal
      const { commit } = (req.body ?? {}) as { commit?: string }
      if (typeof commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(commit)) {
        throw Errors.validation({ commit: ['field.invalid'] })
      }

      const angelegt = await tx(req.pool, req, async client => {
        const offen = await client.query(
          `SELECT 1 FROM deploy_request WHERE status IN ('pending','running')`)
        if (offen.rowCount !== 0) throw Errors.conflict('deploy.alreadyRunning')

        /*
         * Angeboten wird nur, was schon einmal geglueckt ist -- die Maschine
         * behaelt genauso viele Staende, wie hier zurueckgegeben werden.
         * Ein beliebiger Commit waere kein Zurueckrollen, sondern ein
         * unbemerktes Ausrollen ohne Freigabe.
         */
        const kandidaten = await client.query<{ commit_after: string }>(
          `SELECT DISTINCT ON (commit_after) commit_after
             FROM deploy_request
            WHERE status = 'done' AND commit_after IS NOT NULL
            ORDER BY commit_after, id DESC`)
        const erlaubt = kandidaten.rows.map(z => z.commit_after)
        if (!erlaubt.includes(commit)) {
          throw Errors.validation({ commit: ['deploy.unknownRelease'] })
        }

        const jetzt = await client.query<{ commit_after: string }>(
          `SELECT commit_after FROM deploy_request
            WHERE status = 'done' AND commit_after IS NOT NULL
            ORDER BY id DESC LIMIT 1`)
        if (jetzt.rows[0]?.commit_after === commit) {
          throw Errors.conflict('deploy.alreadyCurrent')
        }

        const r = await client.query<{ id: number }>(
          `INSERT INTO deploy_request (requested_by, target_ref, kind)
           VALUES ($1, $2, 'rollback') RETURNING id`, [principal.userId, commit])
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

      /*
       * Wohin zurueckgerollt werden kann: die Staende frueherer geglueckter
       * Laeufe, ohne den laufenden. Aus der Datenbank und nicht von der
       * Platte -- die API kaeme dort ohnehin nicht heran, und eine Liste,
       * die sie sich selbst zusammensucht, waere eine zweite Wahrheit.
       *
       * Ob das Verzeichnis wirklich noch steht, weiss nur die Maschine. Sie
       * sagt es deutlich, wenn nicht; die Zahl hier und was deploy.sh
       * behaelt, sind aufeinander abgestimmt.
       */
      const zurueck = [...new Set(rows.rows
        .filter(z => z.status === 'done' && z.commit_after !== null)
        .map(z => z.commit_after!))]
        .filter(c => c !== laufend)
        .slice(0, 4)

      return { deployments: liste, currentCommit: laufend, rollbackTargets: zurueck }
    }
  })
}
