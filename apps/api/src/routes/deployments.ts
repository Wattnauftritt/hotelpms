import type { FastifyInstance } from 'fastify'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { tx } from '../platform/db.js'
import type { Principal } from '../platform/context.js'
import type { PoolClient } from '@hotelpms/db'

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

/**
 * Was laeuft, und wohin zurueckgerollt werden kann.
 *
 * **Von der Platte, nicht aus der Geschichte.** Hier stand einmal: Ziel ist,
 * was ein gegluecker Lauf des Agenten hinterlassen hat (`status = 'done'`).
 * Das Panel bot daraufhin "kein frueherer Stand" an, waehrend auf der
 * Maschine drei gebaute Staende lagen -- einer von Hand ausgerollt (keine
 * Zeile), einer nach umgelegtem Symlink am Neustart gescheitert
 * ('failed', obwohl gebaut, umgeschaltet und spaeter gelaufen). Der Agent
 * traegt seit Migration 0041 bei jedem Tick ein, was unter releases/ liegt
 * und worauf `current` zeigt (`release`). Das ist die Wahrheit; die
 * Anforderungen sind ihre Geschichte.
 *
 * Solange der Agent noch nicht mit dem neuen Skript gelaufen ist, ist die
 * Tabelle leer. Dann gilt die alte Ableitung -- erweitert um den Stand
 * **vor** jedem gegluecken Lauf, denn den hat deploy.sh nicht weggeraeumt.
 */
type Stand = { commit: string; builtAt: string | null }

async function staende(client: { query: PoolClient['query'] }):
  Promise<{ laufend: Stand | null; ziele: Stand[] }> {
  /*
   * Neueste Bauzeit zuerst: wer zurueck will, will meist einen Schritt
   * zurueck. Ohne Bauzeit (vor 0042 gemeldet) zaehlt die letzte
   * Anforderung, die den Stand nennt.
   */
  const platte = await client.query<{ commit: string; is_current: boolean
                                      built_at: string | null }>(
    `SELECT r.commit, r.is_current, r.built_at::text
       FROM release r
      WHERE r.present
      ORDER BY r.built_at DESC NULLS LAST,
               (SELECT max(d.id) FROM deploy_request d
                 WHERE d.commit_after = r.commit OR d.commit_before = r.commit)
               DESC NULLS LAST, r.commit`)
  if (platte.rowCount !== 0) {
    const alle = platte.rows.map(z => ({ commit: z.commit, builtAt: z.built_at }))
    const laufend = alle[platte.rows.findIndex(z => z.is_current)] ?? null
    return { laufend, ziele: alle.filter(z => z.commit !== laufend?.commit) }
  }

  // Ohne Zeile vom Agenten kennt nur die Geschichte eine Zeit: das Ende
  // des Laufs, der den Stand gebaut hat. Der Vorgaenger hat keine.
  const gelaufen = await client.query<{ commit_after: string | null
                                        commit_before: string | null
                                        finished_at: string | null }>(
    `SELECT commit_after, commit_before, finished_at::text FROM deploy_request
      WHERE status = 'done' ORDER BY id DESC`)
  const gebaut = new Map<string, string | null>()
  for (const z of gelaufen.rows) {
    if (z.commit_after !== null && !gebaut.has(z.commit_after)) {
      gebaut.set(z.commit_after, z.finished_at)
    }
    if (z.commit_before !== null && !gebaut.has(z.commit_before)) {
      gebaut.set(z.commit_before, null)
    }
  }
  gebaut.delete('unbekannt')
  const alle = [...gebaut].map(([commit, builtAt]) => ({ commit, builtAt }))
  const laufend = alle.find(z => z.commit === gelaufen.rows[0]?.commit_after) ?? null
  return { laufend, ziele: alle.filter(z => z.commit !== laufend?.commit).slice(0, 4) }
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
         * Angeboten wird, was auf der Platte liegt -- nicht, was die
         * Geschichte des Agenten kennt. Ein beliebiger Commit waere kein
         * Zurueckrollen, sondern ein unbemerktes Ausrollen ohne Freigabe;
         * ein gebauter Stand mit .fertig ist genau das Gegenteil davon.
         */
        const { laufend, ziele } = await staende(client)
        // Der laufende Stand zuerst: er ist kein Ziel, aber auch kein
        // unbekannter -- "laeuft schon" ist die richtige Antwort.
        if (commit === laufend?.commit) throw Errors.conflict('deploy.alreadyCurrent')
        if (!ziele.some(z => z.commit === commit)) {
          throw Errors.validation({ commit: ['deploy.unknownRelease'] })
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

      const { laufend, ziele } = await tx(req.pool, req, staende)
      return { deployments: liste,
               currentCommit: laufend?.commit ?? null,
               currentBuiltAt: laufend?.builtAt ?? null,
               rollbackTargets: ziele }
    }
  })
}
