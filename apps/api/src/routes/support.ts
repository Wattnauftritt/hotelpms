import type { FastifyInstance } from 'fastify'
import { renderSupportRequestEmail } from '@hotelpms/domain'
import { registerRoute } from '../platform/routes.js'
import { Errors } from '../platform/errors.js'
import { loadConfig } from '../platform/config.js'
import { tx } from '../platform/db.js'
import type { Principal } from '../platform/context.js'
import { isSupportLevel, supportPermissions,
         SUPPORT_MAX_STUNDEN, SUPPORT_VORGABE_STUNDEN,
         type SupportLevel } from '../platform/support.js'

const config = loadConfig()

/**
 * Support-Sitzungen (Aufgabe 13c).
 *
 * **"Anmelden, als waere man der Kunde" ist hier bewusst nicht gebaut.**
 * Plattformpersonal ohne freigegebene Sitzung bekommt einen leeren
 * Mandantenkontext; die Zeilenrichtlinie liefert dann nichts. Der Kunde gibt
 * frei, die Sitzung laeuft ab, und jede Handlung traegt im Protokoll ihre
 * `support_session_id`.
 *
 * Der Grund ist nicht Vorsicht, sondern Art. 28 DSGVO: wir sind
 * Auftragsverarbeiter, der Hotelier ist Verantwortlicher. Eine stille
 * Uebernahme waere eine Verarbeitung ohne Weisung -- und im Protokoll nicht
 * von einer Handlung des Kunden zu unterscheiden, was im Streitfall genau
 * die Frage ist, die beantwortet werden muss.
 */

interface Zeile {
  id: number
  account_id: number
  account_name: string
  platform_user_id: number
  staff_name: string
  granted_by_name: string | null
  level: SupportLevel
  reason: string
  is_emergency: boolean
  requested_at: string
  granted_at: string | null
  expires_at: string
  revoked_at: string | null
}

const SPALTEN = `
  s.id, s.account_id, a.name AS account_name, s.platform_user_id,
  u.display_name AS staff_name, g.display_name AS granted_by_name,
  s.level, s.reason, s.is_emergency,
  s.requested_at::text, s.granted_at::text, s.expires_at::text, s.revoked_at::text`

const VERBUND = `
  FROM support_session s
  JOIN account a  ON a.id = s.account_id
  JOIN app_user u ON u.id = s.platform_user_id
  LEFT JOIN app_user g ON g.id = s.granted_by`

/** Zustand fuer die Anzeige. Abgeleitet, nicht gespeichert: sonst altert er. */
function zustand(z: Zeile, jetzt: number): string {
  if (z.revoked_at !== null) return 'revoked'
  if (Date.parse(z.expires_at) <= jetzt) return 'expired'
  return z.granted_at !== null ? 'active' : 'pending'
}

function nachAussen(z: Zeile, jetzt: number): Record<string, unknown> {
  return {
    id: z.id,
    accountId: z.account_id,
    accountName: z.account_name,
    staffName: z.staff_name,
    grantedByName: z.granted_by_name,
    level: z.level,
    reason: z.reason,
    isEmergency: z.is_emergency,
    requestedAt: z.requested_at,
    grantedAt: z.granted_at,
    expiresAt: z.expires_at,
    revokedAt: z.revoked_at,
    state: zustand(z, jetzt),
    // Damit die Oberflaeche zeigen kann, was die Stufe bedeutet, ohne die
    // Liste ein zweites Mal zu fuehren.
    permissions: [...supportPermissions(z.level)].sort()
  }
}

export function supportRoutes(app: FastifyInstance): void {
  /*
   * Eine Sitzung anfragen. Plattformseite.
   *
   * Angelegt wird sie **ohne** granted_at -- sie wirkt also nicht. Erst die
   * Freigabe des Kunden macht daraus einen Zugriff.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/platform/support-sessions',
    permission: 'platform:support_session',
    summary: 'Support-Sitzung beim Kunden anfragen',
    handler: async (req, reply) => {
      const b = (req.body ?? {}) as {
        accountId?: number; reason?: string; level?: string; hours?: number }
      const principal = req.principal as Principal

      const anlass = String(b.reason ?? '').trim()
      if (anlass.length === 0) {
        throw Errors.validation({ reason: ['support.reasonRequired'] })
      }
      const level = b.level ?? 'read'
      if (!isSupportLevel(level)) {
        throw Errors.validation({ level: ['support.badLevel'] })
      }
      const stunden = Number(b.hours ?? SUPPORT_VORGABE_STUNDEN)
      if (!Number.isInteger(stunden) || stunden < 1 || stunden > SUPPORT_MAX_STUNDEN) {
        throw Errors.validation({ hours: ['support.badHours'] },
          { max: SUPPORT_MAX_STUNDEN })
      }
      const accountId = Number(b.accountId)
      if (!Number.isInteger(accountId) || accountId <= 0) {
        throw Errors.validation({ accountId: ['field.required'] })
      }

      const angelegt = await tx(req.pool, req, async client => {
        /*
         * Wer darf freigeben: jemand mit settings:account im Zielaccount.
         * Ohne einen solchen Menschen laege die Anfrage fuer immer da, und
         * der Support wartete auf eine Freigabe, die niemand sehen kann --
         * das ist eine klare Antwort wert, keine stille Zeile.
         */
        const empfaenger = await client.query<{
          id: number; email: string; display_name: string }>(
          `SELECT DISTINCT u.id, u.email, u.display_name
             FROM app_user u
             JOIN user_account_role uar ON uar.user_id = u.id
             JOIN role_permission rp    ON rp.role_id = uar.role_id
            WHERE uar.account_id = $1
              AND rp.permission_key = 'settings:account'
              AND u.status = 'active'
            ORDER BY u.id`, [accountId])
        if (empfaenger.rowCount === 0) {
          throw Errors.validation({ accountId: ['support.noApprover'] })
        }

        const s = await client.query<{ id: number }>(
          `INSERT INTO support_session
             (account_id, platform_user_id, level, reason, expires_at)
           VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval)
           RETURNING id`,
          [accountId, principal.userId, level, anlass, stunden])
        const id = s.rows[0]!.id

        const staff = await client.query<{ display_name: string }>(
          `SELECT display_name FROM app_user WHERE id = $1`, [principal.userId])

        /*
         * Jeder, der freigeben darf, bekommt die Anfrage -- nicht nur der
         * erste. An einem Haus ist der Inhaber im Urlaub, und die Anfrage
         * soll nicht bis zu seiner Rueckkehr liegen bleiben.
         */
        for (const e of empfaenger.rows) {
          const text = renderSupportRequestEmail({
            userName: e.display_name,
            staffName: staff.rows[0]?.display_name ?? 'Support',
            reason: anlass,
            levelText: level === 'write' ? 'lesen und aendern' : 'nur lesen',
            hours: stunden,
            link: `${config.publicAppUrl}/?screen=settings`
          })
          await client.query(
            `INSERT INTO platform_email (user_id, kind, to_email, to_name, subject,
                                         body_text, body_html)
             VALUES ($1,'support_request',$2,$3,$4,$5,$6)`,
            [e.id, e.email, e.display_name, text.subject, text.text, text.html])
        }

        /*
         * Zurueckgelesen ueber support_session_mine(): der Name des Kunden
         * steht in `account`, und die traegt eine Zeilenrichtlinie. Eine
         * Plattformsitzung hat keinen Mandantenkontext, ein JOIN dorthin
         * liefert also nichts -- still und ohne Fehlermeldung.
         */
        const z = await client.query<Zeile>(
          `SELECT * FROM support_session_mine() WHERE id = $1`, [id])
        return z.rows[0]!
      })

      reply.status(201)
      return nachAussen(angelegt, Date.now())
    }
  })

  /** Die eigenen Anfragen. Plattformseite. */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/platform/support-sessions',
    permission: 'platform:support_session',
    summary: 'Eigene Support-Sitzungen',
    handler: async (req) => {
      // Kein Benutzer als Parameter: die Funktion fragt app_user_id() selbst.
      // Ein Plattformbenutzer sieht damit aus Bauart nur seine eigenen
      // Sitzungen, nicht weil diese Abfrage richtig geschrieben ist.
      const rows = await tx(req.pool, req, client =>
        client.query<Zeile>(`SELECT * FROM support_session_mine()`))
      const jetzt = Date.now()
      return { sessions: rows.rows.map(z => nachAussen(z, jetzt)) }
    }
  })

  /*
   * Die Kundenseite. `settings:account`, weil das Freigeben eine Entscheidung
   * ueber den ganzen Account ist und nicht ueber ein Haus.
   *
   * Absichtlich **ohne** Mandantenkontext gelesen: support_session traegt
   * keine Zeilenrichtlinie, und die Einschraenkung auf den eigenen Account
   * steht deshalb in der Abfrage. Wer hier eine fremde accountId einsetzte,
   * bekaeme nichts -- die Liste kommt aus dem Kontext, nicht aus der Anfrage.
   */
  registerRoute(app, {
    method: 'GET',
    url: '/v1/support-sessions',
    permission: 'settings:account',
    summary: 'Support-Sitzungen am eigenen Account',
    handler: async (req) => {
      const principal = req.principal as Principal
      const rows = await tx(req.pool, req, client =>
        client.query<Zeile>(
          `SELECT ${SPALTEN} ${VERBUND}
            WHERE s.account_id = ANY($1::bigint[])
            ORDER BY s.requested_at DESC LIMIT 100`, [principal.accountIds]))
      const jetzt = Date.now()
      return { sessions: rows.rows.map(z => nachAussen(z, jetzt)) }
    }
  })

  /** Freigeben. Nur der Kunde, und nur einmal. */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/support-sessions/:id/grant',
    permission: 'settings:account',
    summary: 'Support-Sitzung freigeben',
    handler: async (req) => {
      const { id } = req.params as { id: string }
      const principal = req.principal as Principal

      return tx(req.pool, req, async client => {
        /*
         * Freigeben und pruefen in einer Anweisung. Zwei -- erst lesen, dann
         * setzen -- liessen zwei gleichzeitige Klicks beide durch; hier
         * waere das zwar folgenlos, aber die Bedingungen stuenden dann an
         * einer anderen Stelle als die Wirkung, und das faellt beim naechsten
         * Umbau auseinander.
         */
        const r = await client.query<{ id: number }>(
          `UPDATE support_session
              SET granted_at = now(), granted_by = $3
            WHERE id = $1
              AND account_id = ANY($2::bigint[])
              AND granted_at IS NULL
              AND revoked_at IS NULL
              AND expires_at > now()
            RETURNING id`,
          [Number(id), principal.accountIds, principal.userId])

        if (r.rowCount === 0) {
          // Auseinanderhalten, was der Kunde auseinanderhalten kann: gibt es
          // die Sitzung an seinem Account ueberhaupt?
          const da = await client.query<{ granted_at: string | null }>(
            `SELECT granted_at FROM support_session
              WHERE id = $1 AND account_id = ANY($2::bigint[])`,
            [Number(id), principal.accountIds])
          if (da.rows.length === 0) throw Errors.validation({ id: ['support.unknownSession'] })
          if (da.rows[0]!.granted_at !== null) {
            throw Errors.conflict('support.alreadyGranted')
          }
          throw Errors.conflict('support.notPending')
        }

        const z = await client.query<Zeile>(
          `SELECT ${SPALTEN} ${VERBUND} WHERE s.id = $1`, [Number(id)])
        return nachAussen(z.rows[0]!, Date.now())
      })
    }
  })

  /*
   * Beenden. Der Kunde jederzeit -- das ist der Widerruf der Einwilligung
   * und muss so einfach sein wie die Erteilung (Art. 7 Abs. 3 DSGVO).
   *
   * Auch eine noch nicht freigegebene Anfrage laesst sich so abraeumen: der
   * Kunde soll nein sagen koennen, nicht nur schweigen.
   */
  registerRoute(app, {
    method: 'POST',
    url: '/v1/support-sessions/:id/revoke',
    permission: 'settings:account',
    summary: 'Support-Sitzung beenden',
    handler: async (req) => {
      const { id } = req.params as { id: string }
      const principal = req.principal as Principal

      return tx(req.pool, req, async client => {
        const r = await client.query(
          `UPDATE support_session SET revoked_at = now()
            WHERE id = $1 AND account_id = ANY($2::bigint[]) AND revoked_at IS NULL`,
          [Number(id), principal.accountIds])
        if (r.rowCount === 0) {
          const da = await client.query(
            `SELECT 1 FROM support_session
              WHERE id = $1 AND account_id = ANY($2::bigint[])`,
            [Number(id), principal.accountIds])
          if (da.rowCount === 0) throw Errors.validation({ id: ['support.unknownSession'] })
          // Schon widerrufen: das Ziel ist erreicht, also kein Fehler.
        }
        const z = await client.query<Zeile>(
          `SELECT ${SPALTEN} ${VERBUND} WHERE s.id = $1`, [Number(id)])
        return nachAussen(z.rows[0]!, Date.now())
      })
    }
  })
}
